/**
 * Configuration, loaded once at startup and validated.
 *
 * Hard rules encoded here:
 *   - GROQ_API_KEY is server-side only and never logged.
 *   - Model IDs come from configuration, never hardcoded in agent logic
 *     (LLD 4.1). A wrong/retired model ID must be a config change, not a
 *     code change.
 *   - Rate limits are NOT baked in as promises. Values here are a safety
 *     ceiling we impose on ourselves; the provider's own headers always win.
 *   - ENABLE_AUTONOMOUS_BUILD defaults to false. M0-M3 is Planning Lab.
 */
import 'dotenv/config';
import { z } from 'zod';
import { DevOfficeError } from './errors.js';

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const ConfigSchema = z.object({
  GROQ_API_KEY: z.string().min(1).nullable().default(null),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  /**
   * Model used for planning calls. Left deliberately EMPTY by default so the
   * operator must run `npm run models` and choose one their account can
   * actually reach. See docs/ADRs/ADR-0002 for why no default is shipped.
   */
  GROQ_MODEL_PLANNING: z.string().min(1).nullable().default(null),

  /** Structured-output mode. 'json_schema' = strict; 'json_object' = best effort. */
  GROQ_STRUCTURED_MODE: z.enum(['json_schema', 'json_object']).default('json_schema'),

  WORKER_MAX_CONCURRENCY: positiveInt.default(1),
  MODEL_REQUEST_MAX_RETRIES: nonNegativeInt.default(2),
  SCHEMA_REPAIR_MAX_RETRIES: nonNegativeInt.default(2),
  MEETING_MAX_ROUNDS: positiveInt.max(3).default(3),

  /** Self-imposed pacing ceilings. Set below your account's real limits. */
  THROTTLE_MAX_REQUESTS_PER_MINUTE: positiveInt.default(25),
  THROTTLE_MAX_TOKENS_PER_MINUTE: positiveInt.default(5000),
  THROTTLE_MIN_INTERVAL_MS: nonNegativeInt.default(0),

  /**
   * A 429 asking us to wait longer than this is treated as a long-term quota
   * problem (QUOTA_EXHAUSTED) instead of something to sit in a loop for.
   */
  QUOTA_EXHAUSTED_THRESHOLD_MS: positiveInt.default(300_000),

  /**
   * 2048 was the original default and it was too small: on benchmark B2 (seven
   * roles) the Tech Lead's synthesis was cut off before its last two required
   * fields. 4096 completed it, and was accepted by the provider on the free
   * tier, so it is the measured value rather than a guess.
   */
  MODEL_MAX_OUTPUT_TOKENS: positiveInt.default(4096),
  MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  REQUEST_TIMEOUT_MS: positiveInt.default(90_000),

  ENABLE_AUTONOMOUS_BUILD: booleanish.default(false),

  RUNS_DIR: z.string().default('./runs'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Treat an empty environment variable as absent.
 *
 * `.env` files are written by humans, and the normal way to say "I have not
 * chosen this yet" is to leave the value blank:
 *
 *     GROQ_MODEL_PLANNING=
 *
 * dotenv hands that over as the empty string, which is a PRESENT value, so a
 * Zod `.default(...)` never fires and `.min(1)` rejects it. The result was a
 * chicken-and-egg failure: `npm run models` - the command whose entire job is
 * to tell you which model to put there - refused to start until you had
 * already put one there.
 *
 * Stripping blanks first makes blank mean unset everywhere, for every setting,
 * rather than patching one field.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(withoutBlanks(source));
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new DevOfficeError(
      'CONFIG_INVALID',
      `Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example.`,
      { details: result.error.issues },
    );
  }

  const config = result.data;

  // Planning Lab guard. M0-M3 must never be able to start a build.
  if (config.ENABLE_AUTONOMOUS_BUILD) {
    throw new DevOfficeError(
      'CONFIG_INVALID',
      'ENABLE_AUTONOMOUS_BUILD=true is rejected at M0. Autonomous build belongs to ' +
        'M4/M5 and requires a sandbox plus Product Owner approval (HLD 12, LLD 2.2).',
    );
  }

  return config;
}

/** Redact anything secret before a config is logged or written to an event. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const { GROQ_API_KEY, ...safe } = config;
  return {
    ...safe,
    GROQ_API_KEY: GROQ_API_KEY === null ? null : `set (${GROQ_API_KEY.length} chars, redacted)`,
  };
}
