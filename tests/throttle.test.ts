/**
 * Request pacing (LLD 4.3 items 1-2).
 *
 * The token ceiling matters more than the request ceiling on a free tier: the
 * docs show gpt-oss-120b at 30 RPM but 8K TPM, so a request limiter alone would
 * let three times too much through and collect 429s.
 */
import { describe, expect, it } from 'vitest';
import { RequestThrottle } from '../src/providers/throttle.js';
import { FakeClock } from './helpers.js';

/** A promise plus its resolver, so a test can hold a call open on demand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the microtask queue so async-but-instant code paths complete. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const base = {
  maxConcurrency: 1,
  maxRequestsPerMinute: 1000,
  maxTokensPerMinute: 1_000_000,
  minIntervalMs: 0,
};

describe('RequestThrottle', () => {
  it('lets a request straight through when there is budget', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, clock });
    const result = await throttle.run(100, async () => 'done');
    expect(result).toBe('done');
    expect(clock.sleeps).toHaveLength(0);
  });

  it('serialises calls at concurrency 1, as LLD 4.3 requires by default', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, clock });
    const order: string[] = [];

    const gate = deferred();
    const first = throttle.run(10, async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });

    const second = throttle.run(10, async () => {
      order.push('second:start');
    });

    // Let every pending microtask settle. acquireSlot and waitForBudget are
    // both async, so a single Promise.resolve() is not enough to reach fn.
    await flushMicrotasks();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('makes a newcomer queue behind an existing waiter instead of barging in', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, clock });
    const order: string[] = [];

    const gate = deferred();
    const first = throttle.run(10, async () => {
      order.push('first');
      await gate.promise;
    });
    await flushMicrotasks();

    const second = throttle.run(10, async () => {
      order.push('second');
    });
    await flushMicrotasks();

    const third = throttle.run(10, async () => {
      order.push('third');
    });
    await flushMicrotasks();

    gate.resolve();
    await Promise.all([first, second, third]);

    // FIFO. If the slot were simply decremented and re-contended, "third"
    // could take it before "second" ever woke up.
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('waits for the window to roll when the request ceiling is reached', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, maxRequestsPerMinute: 2, clock });

    await throttle.run(10, async () => 1);
    await throttle.run(10, async () => 2);
    expect(clock.sleeps).toHaveLength(0);

    await throttle.run(10, async () => 3);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBe(60_000);
  });

  it('waits on the TOKEN ceiling even when requests are nowhere near the limit', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, maxTokensPerMinute: 8000, clock });

    await throttle.run(3000, async () => 1);
    await throttle.run(3000, async () => 2);
    expect(clock.sleeps).toHaveLength(0);

    // 3000 + 3000 + 3000 > 8000, so this one has to wait.
    await throttle.run(3000, async () => 3);
    expect(clock.sleeps[0]).toBe(60_000);
    expect(throttle.stats().requestsInWindow).toBe(1);
  });

  it('corrects the window with the provider\'s real token count', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, maxTokensPerMinute: 8000, clock });

    // Estimated 5000, actually used 500.
    await throttle.run(5000, async (reconcile) => {
      reconcile(500);
    });
    expect(throttle.stats().tokensInWindow).toBe(500);

    // With the correction applied there is still room, so no wait.
    await throttle.run(5000, async (reconcile) => reconcile(500));
    expect(clock.sleeps).toHaveLength(0);
  });

  it('honours a minimum interval between request starts', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, minIntervalMs: 2000, clock });

    await throttle.run(10, async () => 1);
    await throttle.run(10, async () => 2);

    expect(clock.sleeps).toEqual([2000]);
  });

  it('sits out the window when headers say tokens are nearly gone', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, clock });

    throttle.applyRateLimitHeaders({
      limitRequests: 1000,
      remainingRequests: 900,
      resetRequestsMs: 1000,
      limitTokens: 8000,
      remainingTokens: 10,
      resetTokensMs: 45_000,
      retryAfterMs: null,
    });

    await throttle.run(100, async () => 'ok');
    expect(clock.sleeps[0]).toBe(45_000);
  });

  it('obeys retry-after above everything else', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, clock });

    throttle.applyRateLimitHeaders({
      limitRequests: null,
      remainingRequests: null,
      resetRequestsMs: null,
      limitTokens: null,
      remainingTokens: null,
      resetTokensMs: null,
      retryAfterMs: 12_000,
    });

    await throttle.run(10, async () => 'ok');
    expect(clock.sleeps[0]).toBe(12_000);
  });

  it('reports which ceiling caused each wait, so the UI can say so honestly', async () => {
    const clock = new FakeClock();
    const reasons: string[] = [];
    const throttle = new RequestThrottle({
      ...base,
      maxTokensPerMinute: 1000,
      clock,
      onWait: (_ms, reason) => reasons.push(reason),
    });

    await throttle.run(900, async () => 1);
    await throttle.run(900, async () => 2);
    expect(reasons).toContain('tokens_per_minute');
  });

  it('does not deadlock on a request bigger than the whole per-minute budget', async () => {
    const clock = new FakeClock();
    const throttle = new RequestThrottle({ ...base, maxTokensPerMinute: 100, clock });
    // Nothing in the window to wait for, so the provider becomes the authority.
    await expect(throttle.run(5000, async () => 'through')).resolves.toBe('through');
  });
});
