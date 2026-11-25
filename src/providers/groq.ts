/**
 * GroqProvider - the only file in the codebase that knows Groq exists.
 *
 * Implemented against the OpenAI-compatible endpoint
 * (https://api.groq.com/openai/v1) with plain fetch rather than a vendor SDK.
 * Two reasons: one less dependency to pin, and an injectable `fetchImpl` makes
 * every 429 / 401 / malformed-JSON path testable with zero network and zero
 * API key - which is what lets M0 prove its recovery behaviour honestly.
 *
 * Verified against docs on 24 Nov 2026:
 *   - unsupported fields that 400: logprobs, logit_bias, top_logprobs,
 *     messages[].name, n != 1                     (docs/openai)
 *   - temperature 0 is silently converted to 1e-8 (docs/openai)
 *   - strict json_schema works on openai/gpt-oss-120b, openai/gpt-oss-20b,
 *     qwen/qwen3.8-27b, meta-models/muse-spark-open  (docs/structured-outputs)
 *   - streaming is NOT supported together with structured outputs
 *   - 429 returns retry-after only on 429; x-ratelimit-* always present
 *     (docs/rate-limits)
 *
 * OPEN ITEM, flagged rather than guessed: the compatibility page does not say
 * whether the field is `max_tokens` or `max_completion_tokens`. Default follows
 * the wording in Groq's model table (`max_completion_tokens`) and is
 * overridable via GROQ_MAX_TOKENS_FIELD. Confirm on the first real call.
 */
import { DevOfficeError } from '../shared/errors.js';
import type { Clock } from './throttle.js';
import { RequestThrottle, systemClock } from './throttle.js';
import type { BackoffOptions } from './retry.js';
import { classifyHttpError, readRateLimitSnapshot, withTransportRetry } from './retry.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderAvailability,
  RateLimitSnapshot,
  TextRequest,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GroqProviderOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly structuredMode?: 'json_schema' | 'json_object';
  readonly maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxTransportRetries?: number;
  readonly maxSchemaRepairs?: number;
  readonly quotaExhaustedThresholdMs?: number;
  readonly throttle: RequestThrottle;
  readonly clock?: Clock;
  readonly backoff?: BackoffOptions;
  readonly fetchImpl?: FetchLike;
  /** Hooks so the caller can persist events without this file knowing about storage. */
  readonly onRetry?: (info: { attempt: number; waitMs: number; code: string; message: string }) => void;
  readonly onValidationRetry?: (info: { attempt: number; schemaName: string; issues: string[] }) => void;
  readonly onRateLimitWait?: (info: { waitMs: number; reason: string }) => void;
}

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export class GroqProvider implements ModelProvider {
  readonly name = 'groq';
  readonly simulated = false;
  readonly modelId: string;

  private readonly options: GroqProviderOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private snapshot: RateLimitSnapshot | null = null;

  constructor(options: GroqProviderOptions) {
    if (options.apiKey.trim() === '') {
      throw new DevOfficeError('CONFIG_INVALID', 'GROQ_API_KEY is empty.');
    }
    if (options.modelId.trim() === '') {
      throw new DevOfficeError(
        'CONFIG_INVALID',
        'No model id configured. Run `npm run models` and set GROQ_MODEL_PLANNING.',
      );
    }
    this.options = options;
    this.modelId = options.modelId;
    this.baseUrl = (options.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? systemClock;
  }

  lastRateLimitSnapshot(): RateLimitSnapshot | null {
    return this.snapshot;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          available: false,
          provider: this.name,
          reason: 'AUTH_INVALID',
          detail: 'Groq rejected the API key. Check GROQ_API_KEY.',
        };
      }
      if (!response.ok) {
        return {
          available: false,
          provider: this.name,
          reason: `HTTP_${response.status}`,
          detail: await this.safeBodyText(response),
        };
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
      if (!ids.includes(this.modelId)) {
        return {
          available: false,
          provider: this.name,
          reason: 'MODEL_NOT_AVAILABLE',
          detail:
            `GROQ_MODEL_PLANNING="${this.modelId}" is not in the ${ids.length} models this ` +
            `account can reach. Available: ${ids.slice(0, 12).join(', ')}`,
        };
      }
      return {
        available: true,
        provider: this.name,
        modelId: this.modelId,
        detail: `Account can reach ${ids.length} models; "${this.modelId}" is one of them.`,
      };
    } catch (error) {
      return {
        available: false,
        provider: this.name,
        reason: 'NETWORK',
        detail: String((error as Error)?.message ?? error),
      };
    }
  }

  async generateStructured<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    const startedAt = this.clock.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: request.systemInstruction },
      // Verbatim: the fence around untrusted project data is already applied.
      { role: 'user', content: request.userContent },
    ];

    let validationRetries = 0;
    let transportAttempts = 0;
    const maxRepairs = this.options.maxSchemaRepairs ?? 2;

    for (let repair = 0; repair <= maxRepairs; repair += 1) {
      const estimated = estimateTokens(messages) + request.maxOutputTokens;

      let raw: { content: string; usage: ModelUsage; requestId: string | null };
      try {
        raw = await this.options.throttle.run(estimated, async (reconcile) => {
          const result = await withTransportRetry(
            async () => this.postChatCompletion(messages, request.maxOutputTokens, request),
            {
              maxRetries: this.options.maxTransportRetries ?? 2,
              clock: this.clock,
              ...(this.options.backoff !== undefined ? { backoff: this.options.backoff } : {}),
              onRetry: ({ attempt, waitMs, error }) => {
                this.options.onRetry?.({ attempt, waitMs, code: error.code, message: error.message });
              },
            },
          );
          transportAttempts += result.attempts;
          reconcile(result.value.usage.totalTokens);
          return result.value;
        });
      } catch (error) {
        if (!isProviderValidationError(error)) throw error;

        // The provider checked the model's JSON against our schema and said no.
        // Treat it exactly like a Zod failure: tell the model what was wrong
        // and ask again, within the same repair budget.
        transportAttempts += 1;
        validationRetries += 1;
        const issues = [`schema check failed: ${error.details.issue}`];

        if (repair === maxRepairs) {
          throw new DevOfficeError(
            'SCHEMA_INVALID',
            `Model output failed ${request.contract.schemaName} validation at the provider after ` +
              `${maxRepairs + 1} attempts:\n  ${error.details.issue}`,
            { correlationId: request.correlationId, details: { issues } },
          );
        }

        this.options.onValidationRetry?.({
          attempt: validationRetries,
          schemaName: request.contract.schemaName,
          issues,
        });

        // The failed output is deliberately NOT echoed back. It can be
        // thousands of tokens, and on a free tier with a ~6-8K per-minute
        // ceiling, original prompt + failed answer + new answer would not fit
        // in one request. The provider's error already pinpoints the field.
        messages.push({ role: 'user', content: retryAfterProviderRejection(error.details.issue) });
        continue;
      }

      const parsed = parseJsonLoosely(raw.content);
      if (!parsed.ok) {
        validationRetries += 1;
        if (repair === maxRepairs) {
          throw new DevOfficeError(
            'SCHEMA_INVALID',
            `Model did not return parseable JSON for ${request.contract.schemaName} after ` +
              `${maxRepairs + 1} attempts.`,
            { correlationId: request.correlationId, details: { lastError: parsed.error } },
          );
        }
        this.options.onValidationRetry?.({
          attempt: validationRetries,
          schemaName: request.contract.schemaName,
          issues: [`not valid JSON: ${parsed.error}`],
        });
        messages.push({ role: 'assistant', content: raw.content });
        messages.push({ role: 'user', content: repairPrompt([`Output was not valid JSON: ${parsed.error}`]) });
        continue;
      }

      const validated = request.contract.validator.safeParse(parsed.value);
      if (validated.success) {
        return {
          provider: this.name,
          modelId: this.modelId,
          data: validated.data,
          usage: raw.usage,
          requestId: raw.requestId,
          latencyMs: this.clock.now() - startedAt,
          transportAttempts,
          validationRetries,
          simulated: false,
        };
      }

      const issues = validated.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      validationRetries += 1;

      if (repair === maxRepairs) {
        throw new DevOfficeError(
          'SCHEMA_INVALID',
          `Model output failed ${request.contract.schemaName} validation after ` +
            `${maxRepairs + 1} attempts:\n${issues.map((i) => `  ${i}`).join('\n')}`,
          { correlationId: request.correlationId, details: { issues } },
        );
      }

      // Targeted validation retry (LLD 18): show the model exactly what broke.
      this.options.onValidationRetry?.({
        attempt: validationRetries,
        schemaName: request.contract.schemaName,
        issues,
      });
      messages.push({ role: 'assistant', content: raw.content });
      messages.push({ role: 'user', content: repairPrompt(issues) });
    }

    throw new DevOfficeError('SCHEMA_INVALID', 'Repair loop ended without a valid result.', {
      correlationId: request.correlationId,
    });
  }

  async generateText(request: TextRequest): Promise<ModelResponse<string>> {
    const startedAt = this.clock.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: request.systemInstruction },
      { role: 'user', content: request.prompt },
    ];
    const estimated = estimateTokens(messages) + request.maxOutputTokens;

    const raw = await this.options.throttle.run(estimated, async (reconcile) => {
      const result = await withTransportRetry(
        async () => this.postChatCompletion(messages, request.maxOutputTokens, null),
        {
          maxRetries: this.options.maxTransportRetries ?? 2,
          clock: this.clock,
          ...(this.options.backoff !== undefined ? { backoff: this.options.backoff } : {}),
          onRetry: ({ attempt, waitMs, error }) => {
            this.options.onRetry?.({ attempt, waitMs, code: error.code, message: error.message });
          },
        },
      );
      reconcile(result.value.usage.totalTokens);
      return { ...result.value, attempts: result.attempts };
    });

    return {
      provider: this.name,
      modelId: this.modelId,
      data: raw.content,
      usage: raw.usage,
      requestId: raw.requestId,
      latencyMs: this.clock.now() - startedAt,
      transportAttempts: raw.attempts,
      validationRetries: 0,
      simulated: false,
    };
  }

  private headers(): Record<string, string> {
    return {
      // Never logged anywhere: see redactConfig() and toPublicJSON().
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async postChatCompletion<T>(
    messages: readonly ChatMessage[],
    maxOutputTokens: number,
    request: ModelRequest<T> | null,
  ): Promise<{ content: string; usage: ModelUsage; requestId: string | null }> {
    const tokensField = this.options.maxTokensField ?? 'max_completion_tokens';
    const mode = this.options.structuredMode ?? 'json_schema';

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      // Groq converts temperature 0 to 1e-8; we keep it strictly above 0.
      temperature: Math.max(1e-8, request?.temperature ?? this.options.temperature ?? 0.3),
      [tokensField]: maxOutputTokens,
      // Structured outputs cannot be streamed (docs/structured-outputs).
      stream: false,
    };

    if (request !== null) {
      body['response_format'] =
        mode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: {
                name: request.contract.schemaName,
                schema: request.contract.jsonSchema,
                strict: true,
              },
            }
          : { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    this.snapshot = readRateLimitSnapshot(response.headers);
    this.options.throttle.applyRateLimitHeaders(this.snapshot);

    if (!response.ok) {
      const body = await this.readErrorBody(response);
      const message = body.message;

      // Groq reports two MODEL-side failures as HTTP 400, which would
      // otherwise be misread as "we sent a malformed request, never retry".
      // Found on the first real B2 run; see docs/M0-REPORT.md.
      if (response.status === 400 && TRUNCATION_PATTERN.test(message)) {
        throw new DevOfficeError(
          'OUTPUT_TRUNCATED',
          `The answer was cut off at the ${maxOutputTokens}-token limit before it was ` +
            'complete. Raise MODEL_MAX_OUTPUT_TOKENS in .env, then resume the run. ' +
            `Provider said: ${message}`,
          { httpStatus: 400, correlationId: request?.correlationId, retryable: false },
        );
      }
      if (
        response.status === 400 &&
        request !== null &&
        (body.code === 'json_validate_failed' || PROVIDER_SCHEMA_PATTERN.test(message))
      ) {
        // Strict mode is documented as guaranteed, yet the provider sometimes
        // still rejects the model's output. That is a model slip, so it goes
        // to the repair loop - the same treatment as a Zod failure.
        const details: ProviderValidationDetails = { providerValidation: true, issue: message };
        throw new DevOfficeError('SCHEMA_INVALID', `Provider rejected the generated JSON: ${message}`, {
          httpStatus: 400,
          correlationId: request.correlationId,
          retryable: false,
          details,
        });
      }

      const error = classifyHttpError(response.status, this.snapshot, message, {
        quotaExhaustedThresholdMs: this.options.quotaExhaustedThresholdMs ?? 300_000,
        correlationId: request?.correlationId ?? 'n/a',
      });
      if (error.code === 'RATE_LIMITED' || error.code === 'QUOTA_EXHAUSTED') {
        this.options.onRateLimitWait?.({
          waitMs: error.retryAfterMs ?? 0,
          reason: error.code,
        });
      }
      throw error;
    }

    const payload = (await response.json()) as GroqChatResponse;
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;

    if (typeof content !== 'string' || content.trim() === '') {
      if (choice?.finish_reason === 'length') {
        throw new DevOfficeError(
          'OUTPUT_TRUNCATED',
          `The answer was cut off at the ${maxOutputTokens}-token limit before it was ` +
            'complete. Raise MODEL_MAX_OUTPUT_TOKENS in .env, then resume the run.',
          { retryable: false },
        );
      }
      throw new DevOfficeError('MODEL_REFUSED', 'Model returned no content.', {
        details: { finishReason: choice?.finish_reason ?? null },
      });
    }

    return {
      content,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? null,
        outputTokens: payload.usage?.completion_tokens ?? null,
        totalTokens: payload.usage?.total_tokens ?? null,
      },
      requestId: payload.id ?? null,
    };
  }

  private async safeBodyText(response: Response): Promise<string> {
    return (await this.readErrorBody(response)).message;
  }

  /**
   * Read the provider's error envelope in full.
   *
   * Groq puts the useful parts in `error.code` (e.g. "json_validate_failed")
   * and `error.failed_generation`, not only in `error.message`. The first
   * version kept the message and threw the rest away, which is why a
   * recoverable schema miss looked identical to a genuinely malformed request.
   */
  private async readErrorBody(response: Response): Promise<ProviderErrorBody> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { message: '(no response body)', code: null };
    }
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      return {
        message: parsed.error?.message ?? text.slice(0, 500),
        code: typeof parsed.error?.code === 'string' ? parsed.error.code : null,
      };
    } catch {
      return { message: text.slice(0, 500), code: null };
    }
  }
}

interface ProviderErrorBody {
  readonly message: string;
  readonly code: string | null;
}

/** Details attached when the PROVIDER, not Zod, rejected the model's JSON. */
interface ProviderValidationDetails {
  readonly providerValidation: true;
  readonly issue: string;
}

function isProviderValidationError(error: unknown): error is DevOfficeError & { details: ProviderValidationDetails } {
  return (
    error instanceof DevOfficeError &&
    error.code === 'SCHEMA_INVALID' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { providerValidation?: unknown }).providerValidation === true
  );
}

/** Groq's wording when strict output was cut off by max_completion_tokens. */
const TRUNCATION_PATTERN = /max completion tokens reached|truncated to fit max_completion_tokens/i;

/** Groq's wording when the model's own output failed the strict schema. */
const PROVIDER_SCHEMA_PATTERN =
  /generated json does not match|failed to generate json|failed to validate json/i;

interface GroqChatResponse {
  readonly id?: string;
  readonly choices?: Array<{
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

/**
 * Rough token estimate for pacing only, ~4 characters per token.
 *
 * This is explicitly an ESTIMATE and is never reported as usage: the sliding
 * window is corrected with the provider's real total_tokens as soon as the
 * response arrives (see reconcile in throttle.run).
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  const characters = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(characters / 4) + 16 * messages.length;
}

/** Models sometimes wrap JSON in prose or a code fence. Recover what we can. */
export function parseJsonLoosely(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [text.trim()];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let lastError = 'empty input';
  for (const candidate of candidates) {
    if (candidate === '') continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      lastError = String((error as Error)?.message ?? error);
    }
  }
  return { ok: false, error: lastError };
}

function retryAfterProviderRejection(issue: string): string {
  return [
    'Your previous attempt at this answer was rejected by the schema check:',
    `- ${issue}`,
    '',
    'Produce the COMPLETE JSON object again from the start, following the output',
    'contract exactly. Every item in an array of objects must itself be an object',
    'with all of its fields - never a plain string.',
    'Do not apologise, do not explain, do not wrap it in a code fence.',
  ].join('\n');
}

function repairPrompt(issues: readonly string[]): string {
  return [
    'Your previous reply did not satisfy the output contract.',
    'Fix exactly these problems:',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Return the COMPLETE corrected JSON object and nothing else.',
    'Do not apologise, do not explain, do not wrap it in a code fence.',
  ].join('\n');
}
