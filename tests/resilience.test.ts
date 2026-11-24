/**
 * Rate-limit, retry and recovery behaviour (LLD 4.3, LLD 18, test T13).
 *
 * Every test here runs with a stub fetch and a fake clock: no network, no API
 * key, no waiting. That is deliberate - this is the behaviour most likely to be
 * "tested in production" otherwise, because reproducing a real daily-quota
 * exhaustion on demand is impractical.
 */
import { describe, expect, it } from 'vitest';
import { GroqProvider } from '../src/providers/groq.js';
import { RequestThrottle } from '../src/providers/throttle.js';
import { computeBackoffMs, classifyHttpError, readRateLimitSnapshot } from '../src/providers/retry.js';
import { parseGroqDuration } from '../src/shared/errors.js';
import { PROPOSAL_CONTRACT } from '../src/agents/contribution-contracts.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../src/agents/prompts.js';
import { chatOk, FakeClock, rateLimited, stubFetch, validProposal } from './helpers.js';
import type { ModelRequest } from '../src/providers/types.js';

function buildRequest(): ModelRequest<unknown> {
  return {
    purpose: 'proposal',
    agentRole: 'ui_ux',
    systemInstruction: 'You are the UI/UX Designer.',
    input: { brief: { title: 'Portfolio' } },
    userContent: `${UNTRUSTED_OPEN}\n{"title":"Portfolio"}\n${UNTRUSTED_CLOSE}`,
    contract: PROPOSAL_CONTRACT as never,
    maxOutputTokens: 1024,
    correlationId: 'test-correlation-1',
  };
}

function makeProvider(
  queue: Parameters<typeof stubFetch>[0],
  overrides: Partial<ConstructorParameters<typeof GroqProvider>[0]> = {},
): { provider: GroqProvider; clock: FakeClock; recorder: ReturnType<typeof stubFetch> } {
  const clock = new FakeClock();
  const recorder = stubFetch(queue);
  const provider = new GroqProvider({
    apiKey: 'test-key-not-real',
    modelId: 'test-model',
    throttle: new RequestThrottle({
      maxConcurrency: 1,
      maxRequestsPerMinute: 1000,
      maxTokensPerMinute: 1_000_000,
      minIntervalMs: 0,
      clock,
    }),
    clock,
    fetchImpl: recorder.fetchImpl,
    maxTransportRetries: 2,
    maxSchemaRepairs: 2,
    // Deterministic jitter so the asserted wait is exact.
    backoff: { baseMs: 500, factor: 2, capMs: 20_000, random: () => 1 },
    ...overrides,
  });
  return { provider, clock, recorder };
}

describe('parseGroqDuration', () => {
  it('reads the formats Groq actually sends', () => {
    expect(parseGroqDuration('2')).toBe(2000);
    expect(parseGroqDuration('7.66s')).toBe(7660);
    expect(parseGroqDuration('2m59.56s')).toBe(179_560);
    expect(parseGroqDuration('1h2m3s')).toBe(3_723_000);
    expect(parseGroqDuration('88ms')).toBe(88);
    expect(parseGroqDuration(null)).toBeUndefined();
    expect(parseGroqDuration('')).toBeUndefined();
    expect(parseGroqDuration('nonsense')).toBeUndefined();
  });
});

describe('429 classification', () => {
  const snapshot = (headers: Record<string, string>) => readRateLimitSnapshot(new Headers(headers));

  it('treats a short retry-after as a transient rate limit', () => {
    const error = classifyHttpError(429, snapshot({ 'retry-after': '3' }), 'slow down', {
      quotaExhaustedThresholdMs: 300_000,
      correlationId: 'c1',
    });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(3000);
  });

  it('treats a long wait as daily quota exhaustion, not something to retry', () => {
    const error = classifyHttpError(429, snapshot({ 'retry-after': '3600' }), 'quota', {
      quotaExhaustedThresholdMs: 300_000,
      correlationId: 'c1',
    });
    expect(error.code).toBe('QUOTA_EXHAUSTED');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('preserved');
  });

  it('falls back to the reset header when retry-after is absent', () => {
    const error = classifyHttpError(
      429,
      snapshot({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1h0m0s' }),
      'quota',
      { quotaExhaustedThresholdMs: 300_000, correlationId: 'c1' },
    );
    expect(error.code).toBe('QUOTA_EXHAUSTED');
  });

  it('maps the rest of the documented status codes', () => {
    const cases: Array<[number, string]> = [
      [401, 'AUTH_INVALID'],
      [403, 'AUTH_INVALID'],
      [400, 'BAD_REQUEST'],
      [404, 'BAD_REQUEST'],
      [422, 'BAD_REQUEST'],
      [413, 'PAYLOAD_TOO_LARGE'],
      [498, 'PROVIDER_UNAVAILABLE'],
      [503, 'PROVIDER_UNAVAILABLE'],
      [500, 'SERVER_ERROR'],
      [502, 'SERVER_ERROR'],
    ];
    for (const [status, code] of cases) {
      expect(
        classifyHttpError(status, snapshot({}), 'x', { quotaExhaustedThresholdMs: 1000, correlationId: 'c' }).code,
        `HTTP ${status}`,
      ).toBe(code);
    }
  });
});

describe('backoff', () => {
  it('grows exponentially and stays under the cap', () => {
    const opts = { baseMs: 500, factor: 2, capMs: 20_000, random: () => 1 };
    expect(computeBackoffMs(0, opts)).toBe(500);
    expect(computeBackoffMs(1, opts)).toBe(1000);
    expect(computeBackoffMs(2, opts)).toBe(2000);
    expect(computeBackoffMs(10, opts)).toBe(20_000);
  });

  it('applies full jitter, so parallel workers do not retry in lockstep', () => {
    const low = computeBackoffMs(3, { baseMs: 500, factor: 2, capMs: 20_000, random: () => 0 });
    const high = computeBackoffMs(3, { baseMs: 500, factor: 2, capMs: 20_000, random: () => 1 });
    expect(low).toBe(0);
    expect(high).toBe(4000);
  });
});

describe('GroqProvider recovery', () => {
  it('T13a: retries a 429 after exactly the retry-after it was given, then succeeds', async () => {
    const { provider, clock, recorder } = makeProvider([
      rateLimited('2'),
      chatOk(validProposal()),
    ]);

    const response = await provider.generateStructured(buildRequest());

    expect(response.transportAttempts).toBe(2);
    expect(recorder.calls).toHaveLength(2);
    expect(clock.sleeps).toContain(2000);
    expect((response.data as { proposal_id: string }).proposal_id).toBe('prop-ui_ux-home-01');
  });

  it('T13b: backs off exponentially when no retry-after is sent', async () => {
    const { provider, clock } = makeProvider([
      rateLimited(null, { 'x-ratelimit-remaining-requests': '5' }),
      rateLimited(null, { 'x-ratelimit-remaining-requests': '5' }),
      chatOk(validProposal()),
    ]);

    const response = await provider.generateStructured(buildRequest());

    expect(response.transportAttempts).toBe(3);
    // random() === 1 so the waits are the full ceiling: 500 then 1000.
    expect(clock.sleeps.filter((ms) => ms === 500 || ms === 1000)).toEqual([500, 1000]);
  });

  it('T13c: a daily-quota 429 ends as QUOTA_EXHAUSTED without burning retries', async () => {
    const { provider, recorder } = makeProvider([rateLimited('7200')]);

    await expect(provider.generateStructured(buildRequest())).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
      retryable: false,
    });
    // One attempt only: sitting in a loop for two hours would be a bug.
    expect(recorder.calls).toHaveLength(1);
  });

  it('gives up after the configured retry budget and reports the real cause', async () => {
    const { provider, recorder } = makeProvider([
      rateLimited('1'),
      rateLimited('1'),
      rateLimited('1'),
      rateLimited('1'),
    ]);

    await expect(provider.generateStructured(buildRequest())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // maxTransportRetries = 2 => 3 attempts total, not 4.
    expect(recorder.calls).toHaveLength(3);
  });

  it('never retries a 401, and says it is a settings problem', async () => {
    const { provider, recorder } = makeProvider([
      { status: 401, body: { error: { message: 'Invalid API Key' } } },
    ]);

    await expect(provider.generateStructured(buildRequest())).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      retryable: false,
    });
    expect(recorder.calls).toHaveLength(1);
  });

  it('retries a 500', async () => {
    const { provider, recorder } = makeProvider([
      { status: 500, body: { error: { message: 'internal' } } },
      chatOk(validProposal()),
    ]);
    const response = await provider.generateStructured(buildRequest());
    expect(response.transportAttempts).toBe(2);
    expect(recorder.calls).toHaveLength(2);
  });

  it('reports a truncated response as a token-cap problem, not a model refusal', async () => {
    const { provider } = makeProvider([
      { status: 200, body: { id: 'r', choices: [{ message: { content: '' }, finish_reason: 'length' }] } },
    ]);
    await expect(provider.generateStructured(buildRequest())).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
    });
  });

  it('NEVER substitutes another provider or model, whatever goes wrong', async () => {
    const { provider, recorder } = makeProvider([rateLimited('1'), rateLimited('1'), chatOk(validProposal())]);
    await provider.generateStructured(buildRequest());

    for (const call of recorder.calls) {
      expect(call.url).toContain('api.groq.com');
      expect((call.body as { model: string }).model).toBe('test-model');
    }
    expect(provider.name).toBe('groq');
    expect(provider.simulated).toBe(false);
  });

  it('records the provider\'s reported rate-limit facts rather than guessing them', async () => {
    const { provider } = makeProvider([chatOk(validProposal())]);
    await provider.generateStructured(buildRequest());

    const snapshot = provider.lastRateLimitSnapshot();
    expect(snapshot?.limitTokens).toBe(8000);
    expect(snapshot?.remainingTokens).toBe(7850);
    expect(snapshot?.resetTokensMs).toBe(7660);
    expect(snapshot?.retryAfterMs).toBeNull();
  });

  it('reports usage exactly as the provider gave it, and never invents a cost', async () => {
    const { provider } = makeProvider([chatOk(validProposal(), { prompt: 1234, completion: 567 })]);
    const response = await provider.generateStructured(buildRequest());
    expect(response.usage).toEqual({ inputTokens: 1234, outputTokens: 567, totalTokens: 1801 });
  });

  it('leaves usage null when the provider reports none, instead of estimating', async () => {
    const { provider } = makeProvider([
      { status: 200, body: { id: 'r', choices: [{ message: { content: JSON.stringify(validProposal()) } }] } },
    ]);
    const response = await provider.generateStructured(buildRequest());
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });
});

describe('schema repair loop (LLD 18 "targeted validation retry")', () => {
  it('recovers from a JSON object wrapped in prose and a code fence', async () => {
    const { provider } = makeProvider([
      chatOk(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify(validProposal())}\n\`\`\``),
    ]);
    const response = await provider.generateStructured(buildRequest());
    expect((response.data as { agent_role: string }).agent_role).toBe('ui_ux');
    expect(response.validationRetries).toBe(0);
  });

  it('tells the model exactly which field failed, then accepts the fix', async () => {
    const issues: string[][] = [];
    const { provider, recorder } = makeProvider(
      [chatOk(validProposal({ rationale: 'I agree' })), chatOk(validProposal())],
      { onValidationRetry: ({ issues: i }) => issues.push(i) },
    );

    const response = await provider.generateStructured(buildRequest());

    expect(response.validationRetries).toBe(1);
    expect(issues[0]?.join(' ')).toContain('rationale');

    // The repair turn must carry the failing output plus a corrective message.
    const repairBody = recorder.calls[1]?.body as { messages: Array<{ role: string; content: string }> };
    expect(repairBody.messages).toHaveLength(4);
    expect(repairBody.messages[2]?.role).toBe('assistant');
    expect(repairBody.messages[3]?.content).toContain('rationale');
    expect(repairBody.messages[3]?.content).toContain('COMPLETE corrected JSON');
  });

  it('stops after the repair budget and fails with the field list', async () => {
    const { provider, recorder } = makeProvider([
      chatOk(validProposal({ rationale: 'LGTM' })),
      chatOk(validProposal({ rationale: 'LGTM' })),
      chatOk(validProposal({ rationale: 'LGTM' })),
    ]);

    await expect(provider.generateStructured(buildRequest())).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
    });
    // maxSchemaRepairs = 2 => 3 attempts.
    expect(recorder.calls).toHaveLength(3);
  });

  it('recovers from completely unparseable output', async () => {
    const { provider } = makeProvider([chatOk('I cannot help with that.'), chatOk(validProposal())]);
    const response = await provider.generateStructured(buildRequest());
    expect(response.validationRetries).toBe(1);
  });
});

describe('request shape', () => {
  it('sends strict json_schema with our sanitised schema', async () => {
    const { provider, recorder } = makeProvider([chatOk(validProposal())]);
    await provider.generateStructured(buildRequest());

    const body = recorder.calls[0]?.body as {
      response_format: { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
      stream: boolean;
      model: string;
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.name).toBe('AgentContributionV1');
    expect(body.response_format.json_schema.schema['additionalProperties']).toBe(false);
    // Structured outputs cannot be streamed.
    expect(body.stream).toBe(false);
  });

  it('can fall back to json_object mode for models without strict support', async () => {
    const { provider, recorder } = makeProvider([chatOk(validProposal())], { structuredMode: 'json_object' });
    await provider.generateStructured(buildRequest());
    const body = recorder.calls[0]?.body as { response_format: { type: string } };
    expect(body.response_format.type).toBe('json_object');
  });

  it('keeps temperature strictly above zero, because Groq rewrites 0', async () => {
    const { provider, recorder } = makeProvider([chatOk(validProposal())], { temperature: 0 });
    await provider.generateStructured(buildRequest());
    const body = recorder.calls[0]?.body as { temperature: number };
    expect(body.temperature).toBeGreaterThan(0);
  });

  it('sends none of the fields Groq documents as unsupported', async () => {
    const { provider, recorder } = makeProvider([chatOk(validProposal())]);
    await provider.generateStructured(buildRequest());
    const body = recorder.calls[0]?.body as Record<string, unknown>;
    for (const forbidden of ['logprobs', 'logit_bias', 'top_logprobs', 'n']) {
      expect(body, `must not send ${forbidden}`).not.toHaveProperty(forbidden);
    }
    for (const message of body['messages'] as Array<Record<string, unknown>>) {
      expect(message).not.toHaveProperty('name');
    }
  });

  it('never leaks the API key into an error message', async () => {
    const { provider } = makeProvider([{ status: 401, body: { error: { message: 'Invalid API Key' } } }]);
    try {
      await provider.generateStructured(buildRequest());
      expect.unreachable('should have thrown');
    } catch (error) {
      const serialised = JSON.stringify((error as { toPublicJSON(): unknown }).toPublicJSON());
      expect(serialised).not.toContain('test-key-not-real');
      expect((error as Error).message).not.toContain('test-key-not-real');
    }
  });
});
