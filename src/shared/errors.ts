/**
 * Error taxonomy for DevOffice AI.
 *
 * Every failure that crosses a layer boundary becomes a DevOfficeError with a
 * stable `code`. The worker/state machine decides what to do based on `code`
 * and `retryable` ONLY - never by string-matching a provider message.
 *
 * Reference: LLD section 18 (Error Matrix & Recovery).
 */

export type ErrorCode =
  /** 401 - API key missing/invalid. Never retry. Operator must fix settings. */
  | 'AUTH_INVALID'
  /** 400/422 - we sent something malformed. Never retry blindly. */
  | 'BAD_REQUEST'
  /** 413 - request body too large. Reduce context, then retry once. */
  | 'PAYLOAD_TOO_LARGE'
  /** 429 - short-term rate limit (per-minute). Retryable after a short wait. */
  | 'RATE_LIMITED'
  /** 429 - long-term quota (per-day) exhausted. NOT retryable in this run. */
  | 'QUOTA_EXHAUSTED'
  /** 503/498 or network failure - provider temporarily unusable. */
  | 'PROVIDER_UNAVAILABLE'
  /** 500/502 - provider internal error. Retryable with backoff. */
  | 'SERVER_ERROR'
  /** Model returned JSON that failed Zod validation after all repair attempts. */
  | 'SCHEMA_INVALID'
  /** Model explicitly refused to answer. Not a transport problem. */
  | 'MODEL_REFUSED'
  /** Operator or owner cancelled the run. */
  | 'CANCELLED'
  /** Environment/config is wrong - fail fast at startup. */
  | 'CONFIG_INVALID'
  /** A caller tried to start coding while autonomous build is disabled. */
  | 'BUILD_NOT_ENABLED';

export interface DevOfficeErrorOptions {
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly correlationId?: string | undefined;
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class DevOfficeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;
  readonly correlationId: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: DevOfficeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DevOfficeError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterMs = options.retryAfterMs;
    this.httpStatus = options.httpStatus;
    this.correlationId = options.correlationId;
    this.details = options.details;
  }

  /** Safe to persist in an event log: no secrets, no stack. */
  toPublicJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retry_after_ms: this.retryAfterMs ?? null,
      http_status: this.httpStatus ?? null,
      correlation_id: this.correlationId ?? null,
    };
  }
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  AUTH_INVALID: false,
  BAD_REQUEST: false,
  PAYLOAD_TOO_LARGE: false,
  RATE_LIMITED: true,
  QUOTA_EXHAUSTED: false,
  PROVIDER_UNAVAILABLE: true,
  SERVER_ERROR: true,
  SCHEMA_INVALID: false,
  MODEL_REFUSED: false,
  CANCELLED: false,
  CONFIG_INVALID: false,
  BUILD_NOT_ENABLED: false,
};

export function isDevOfficeError(value: unknown): value is DevOfficeError {
  return value instanceof DevOfficeError;
}

/**
 * Parse Groq's rate-limit duration strings.
 *
 * Groq returns human-readable durations in `x-ratelimit-reset-*`, for example
 * "7.66s", "2m59.56s", "1h2m3s", "88ms". `retry-after` is plain seconds.
 * Returns milliseconds, or undefined when unparseable.
 */
export function parseGroqDuration(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (text === '') return undefined;

  // Plain number => seconds (the `retry-after` convention).
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.round(Number.parseFloat(text) * 1000);
  }

  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    const amount = Number.parseFloat(match[1] as string);
    const unit = match[2] as string;
    matched = true;
    if (unit === 'ms') total += amount;
    else if (unit === 's') total += amount * 1000;
    else if (unit === 'm') total += amount * 60_000;
    else if (unit === 'h') total += amount * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}
