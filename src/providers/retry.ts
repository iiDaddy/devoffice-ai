/**
 * Transport error classification and bounded retry (LLD 4.3 items 3-5, LLD 18).
 *
 * The decision that matters here: a 429 is NOT one thing.
 *
 *   - "you sent too many this minute"  -> RATE_LIMITED, wait seconds, retry
 *   - "you are out of requests today"  -> QUOTA_EXHAUSTED, stop, keep state,
 *                                         let a human resume later
 *
 * Both arrive as HTTP 429. We tell them apart by how long the provider asks us
 * to wait: anything beyond QUOTA_EXHAUSTED_THRESHOLD_MS is a quota wall, not a
 * burst, and sitting in a retry loop for hours would be a bug that looks like
 * patience. Groq's own headers are the source (retry-after,
 * x-ratelimit-reset-requests / -tokens) - never a guessed number.
 *
 * What this module will never do: switch provider, upgrade model, or spend
 * money (HLD 10, LLD 17 "No hidden paid fallback").
 */
import { DevOfficeError, parseGroqDuration } from '../shared/errors.js';
import type { Clock } from './throttle.js';
import { systemClock } from './throttle.js';
import type { RateLimitSnapshot } from './types.js';

export function readRateLimitSnapshot(headers: Headers): RateLimitSnapshot {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    resetRequestsMs: parseGroqDuration(headers.get('x-ratelimit-reset-requests')) ?? null,
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    resetTokensMs: parseGroqDuration(headers.get('x-ratelimit-reset-tokens')) ?? null,
    retryAfterMs: parseGroqDuration(headers.get('retry-after')) ?? null,
  };
}

export interface ClassifyOptions {
  readonly quotaExhaustedThresholdMs: number;
  readonly correlationId: string;
}

/** Map an HTTP response to a DevOfficeError. Reference: LLD 18. */
export function classifyHttpError(
  status: number,
  snapshot: RateLimitSnapshot,
  bodyMessage: string,
  options: ClassifyOptions,
): DevOfficeError {
  const base = {
    httpStatus: status,
    correlationId: options.correlationId,
    details: { rateLimit: snapshot },
  };

  if (status === 429) {
    // Prefer retry-after; fall back to whichever window the provider says is
    // empty. If nothing is reported we assume a short burst, not a quota wall.
    const hinted =
      snapshot.retryAfterMs ??
      (snapshot.remainingRequests === 0 ? snapshot.resetRequestsMs : null) ??
      (snapshot.remainingTokens === 0 ? snapshot.resetTokensMs : null);

    if (hinted !== null && hinted >= options.quotaExhaustedThresholdMs) {
      return new DevOfficeError(
        'QUOTA_EXHAUSTED',
        `Provider quota exhausted; it will not reset for ${Math.round(hinted / 1000)}s. ` +
          'Run state is preserved - resume manually once quota returns.',
        { ...base, retryAfterMs: hinted, retryable: false },
      );
    }
    return new DevOfficeError('RATE_LIMITED', `Rate limited (429): ${bodyMessage}`, {
      ...base,
      retryAfterMs: hinted ?? undefined,
      retryable: true,
    });
  }

  if (status === 401 || status === 403) {
    return new DevOfficeError(
      'AUTH_INVALID',
      'Provider rejected the API key (401/403). Stopping all provider calls; ' +
        'this is a settings problem, not something to retry.',
      base,
    );
  }
  if (status === 413) {
    return new DevOfficeError('PAYLOAD_TOO_LARGE', `Request body too large (413): ${bodyMessage}`, base);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new DevOfficeError('BAD_REQUEST', `Provider rejected the request (${status}): ${bodyMessage}`, base);
  }
  if (status === 498 || status === 503) {
    return new DevOfficeError(
      'PROVIDER_UNAVAILABLE',
      `Provider temporarily unavailable (${status}): ${bodyMessage}`,
      base,
    );
  }
  if (status >= 500) {
    return new DevOfficeError('SERVER_ERROR', `Provider server error (${status}): ${bodyMessage}`, base);
  }
  return new DevOfficeError('PROVIDER_UNAVAILABLE', `Unexpected status ${status}: ${bodyMessage}`, base);
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly factor: number;
  readonly capMs: number;
  /** Injected for deterministic tests. Returns [0,1). */
  readonly random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  factor: 2,
  capMs: 20_000,
  random: Math.random,
};

/**
 * Full-jitter exponential backoff. Jitter is not decoration: without it every
 * queued worker retries on the same tick and recreates the burst that caused
 * the 429.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF): number {
  const ceiling = Math.min(options.capMs, options.baseMs * options.factor ** Math.max(0, attempt));
  return Math.round(options.random() * ceiling);
}

export interface RetryContext {
  readonly attempt: number;
  readonly error: DevOfficeError;
  readonly waitMs: number;
}

export interface TransportRetryOptions {
  readonly maxRetries: number;
  readonly clock?: Clock;
  readonly backoff?: BackoffOptions;
  readonly onRetry?: (context: RetryContext) => void;
  readonly onGiveUp?: (error: DevOfficeError, attempts: number) => void;
}

export interface TransportRetryResult<T> {
  readonly value: T;
  readonly attempts: number;
}

/**
 * Run `fn`, retrying only errors marked retryable, at most maxRetries times.
 * Returns how many attempts it took so usage logging can report the truth.
 */
export async function withTransportRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: TransportRetryOptions,
): Promise<TransportRetryResult<T>> {
  const clock = options.clock ?? systemClock;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let lastError: DevOfficeError | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt + 1 };
    } catch (error) {
      const wrapped =
        error instanceof DevOfficeError
          ? error
          : new DevOfficeError('PROVIDER_UNAVAILABLE', `Network failure: ${String((error as Error)?.message ?? error)}`, {
              retryable: true,
              cause: error,
            });
      lastError = wrapped;

      if (!wrapped.retryable || attempt === options.maxRetries) {
        options.onGiveUp?.(wrapped, attempt + 1);
        throw wrapped;
      }

      // Honour the provider's own instruction when it gave one.
      const waitMs = wrapped.retryAfterMs ?? computeBackoffMs(attempt, backoff);
      options.onRetry?.({ attempt: attempt + 1, error: wrapped, waitMs });
      await clock.sleep(waitMs);
    }
  }

  throw lastError ?? new DevOfficeError('PROVIDER_UNAVAILABLE', 'Retry loop ended without a result');
}
