/**
 * Test doubles.
 *
 * FakeClock advances virtual time instead of waiting, so a test that proves
 * "we waited 60 seconds for the token window to reset" finishes in a
 * millisecond and asserts the exact figure. Real timers would make these tests
 * slow AND flaky, which is how rate-limit handling ends up untested in
 * practice.
 */
import type { Clock } from '../src/providers/throttle.js';
import { loadConfig, type AppConfig } from '../src/shared/config.js';

export class FakeClock implements Clock {
  private current: number;
  readonly sleeps: number[] = [];

  constructor(startAt = 1_700_000_000_000) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    // Yield so other microtasks interleave as they would with a real timer.
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  get totalSlept(): number {
    return this.sleeps.reduce((sum, ms) => sum + ms, 0);
  }
}

export interface StubResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export interface FetchRecorder {
  readonly calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }>;
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly remaining: () => number;
}

/** A fetch that returns queued responses in order, recording every request. */
export function stubFetch(queue: readonly StubResponse[]): FetchRecorder {
  const pending = [...queue];
  const calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }> = [];

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    let parsedBody: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, init, body: parsedBody });

    const next = pending.shift();
    if (next === undefined) {
      throw new Error(
        `stubFetch ran out of queued responses after ${calls.length} call(s). ` +
          'The code under test made more requests than the test expected.',
      );
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };

  return { calls, fetchImpl, remaining: () => pending.length };
}

/** A successful chat-completion envelope carrying `content`. */
export function chatOk(content: unknown, usage?: Partial<{ prompt: number; completion: number }>): StubResponse {
  const promptTokens = usage?.prompt ?? 100;
  const completionTokens = usage?.completion ?? 50;
  return {
    status: 200,
    body: {
      id: 'req_test_1',
      choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
    headers: {
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '998',
      'x-ratelimit-reset-requests': '2m59.56s',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '7850',
      'x-ratelimit-reset-tokens': '7.66s',
    },
  };
}

/** A 429. `retryAfter` is the literal header value, e.g. "2" or "3600". */
export function rateLimited(retryAfter: string | null, extra?: Record<string, string>): StubResponse {
  return {
    status: 429,
    body: { error: { message: 'Rate limit reached for model', type: 'rate_limit_error' } },
    headers: {
      ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '0',
      ...extra,
    },
  };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    GROQ_API_KEY: 'test-key-not-real',
    GROQ_MODEL_PLANNING: 'test-model',
    ENABLE_AUTONOMOUS_BUILD: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** A valid AgentContributionV1 proposal, for tests that need a baseline. */
export function validProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: 'Homepage interaction strategy',
    proposal_id: 'prop-ui_ux-home-01',
    agent_role: 'ui_ux',
    contribution_type: 'proposal',
    summary: 'Use subtle CSS transitions for section reveals.',
    rationale:
      'Keeps the first contentful paint fast on mid-range phones, which is what recruiters browse on.',
    alternatives: ['Heavy 3D hero animation', 'Entirely static page'],
    risks: ['Must respect prefers-reduced-motion'],
    dependencies: ['Frontend implements the transition tokens'],
    related_proposal_id: null,
    recommended_change: null,
    evidence: [],
    severity: 'low',
    ...overrides,
  };
}
