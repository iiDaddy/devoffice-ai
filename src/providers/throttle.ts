/**
 * Request pacing (LLD 4.3 items 1-2).
 *
 * Two independent ceilings, because Groq enforces both and the token one is
 * what actually bites. At the time of writing the docs show openai/gpt-oss-120b
 * on the base Developer plan at 30 RPM but only 8K TPM - a single planning call
 * with a brief plus a system prompt can be 2-3K tokens, so roughly THREE calls
 * per minute, not thirty. A request-only limiter would sail past the real limit
 * and collect 429s.
 *
 * Those numbers are NOT compiled in as truth. They come from config as a
 * self-imposed ceiling, and whatever the provider reports in its headers
 * overrides our guess via applyRateLimitHeaders().
 *
 * The clock is injected so tests can prove pacing behaviour in milliseconds
 * instead of waiting a real minute.
 */
import type { RateLimitSnapshot } from './types.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type WaitReason =
  | 'concurrency'
  | 'requests_per_minute'
  | 'tokens_per_minute'
  | 'min_interval'
  | 'provider_cooldown';

export interface ThrottleOptions {
  readonly maxConcurrency: number;
  readonly maxRequestsPerMinute: number;
  readonly maxTokensPerMinute: number;
  readonly minIntervalMs: number;
  readonly clock?: Clock;
  /** Called before each wait so the caller can emit a rate_limit_wait event. */
  readonly onWait?: (waitMs: number, reason: WaitReason) => void;
}

interface WindowEntry {
  at: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

export class RequestThrottle {
  private readonly options: Required<Omit<ThrottleOptions, 'onWait'>> & Pick<ThrottleOptions, 'onWait'>;
  private readonly clock: Clock;
  private readonly window: WindowEntry[] = [];
  private active = 0;
  private waiters: Array<() => void> = [];
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private cooldownUntil = 0;

  constructor(options: ThrottleOptions) {
    this.clock = options.clock ?? systemClock;
    this.options = { ...options, clock: this.clock };
  }

  /**
   * Run `fn` once the pacing rules allow it.
   *
   * `fn` receives a `reconcile` callback: call it with the provider's reported
   * total_tokens so the sliding window holds the real number instead of our
   * estimate. The next caller then waits on fact rather than on a guess.
   */
  async run<T>(
    estimatedTokens: number,
    fn: (reconcile: (actualTokens: number | null) => void) => Promise<T>,
  ): Promise<T> {
    await this.acquireSlot();
    try {
      const reserved = await this.waitForBudget(estimatedTokens);
      const reconcile = (actualTokens: number | null): void => {
        if (actualTokens !== null && actualTokens >= 0) reserved.tokens = actualTokens;
      };
      return await fn(reconcile);
    } finally {
      this.releaseSlot();
    }
  }

  /** Let provider headers override our self-imposed ceiling. */
  applyRateLimitHeaders(snapshot: RateLimitSnapshot): void {
    const now = this.clock.now();

    if (snapshot.retryAfterMs !== null && snapshot.retryAfterMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + snapshot.retryAfterMs);
      return;
    }

    // Nearly out of tokens for this window: sit out until it resets rather
    // than firing a request we know will 429.
    if (
      snapshot.remainingTokens !== null &&
      snapshot.resetTokensMs !== null &&
      snapshot.limitTokens !== null &&
      snapshot.remainingTokens <= Math.max(1, Math.floor(snapshot.limitTokens * 0.02))
    ) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + snapshot.resetTokensMs);
      return;
    }

    if (
      snapshot.remainingRequests !== null &&
      snapshot.resetRequestsMs !== null &&
      snapshot.remainingRequests <= 0
    ) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + snapshot.resetRequestsMs);
    }
  }

  /** Diagnostics for the CLI and dashboards. */
  stats(): { requestsInWindow: number; tokensInWindow: number; cooldownRemainingMs: number } {
    const now = this.clock.now();
    this.prune(now);
    return {
      requestsInWindow: this.window.length,
      tokensInWindow: this.window.reduce((sum, e) => sum + e.tokens, 0),
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
    };
  }

  private async acquireSlot(): Promise<void> {
    // Queue ahead of the limit check: if anyone is already waiting, a newcomer
    // must queue behind them. Without this, a caller arriving in the window
    // between releaseSlot() decrementing and the woken waiter resuming would
    // take the freed slot and jump the queue - which under steady load starves
    // the waiter indefinitely.
    if (this.waiters.length === 0 && this.active < this.options.maxConcurrency) {
      this.active += 1;
      return;
    }
    this.options.onWait?.(0, 'concurrency');
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // The slot was handed over directly by releaseSlot, which is why `active`
    // is NOT incremented again here.
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot straight to the next in line, keeping `active` at its
      // current value so no third party can slip in between.
      next();
      return;
    }
    this.active -= 1;
  }

  private async waitForBudget(estimatedTokens: number): Promise<WindowEntry> {
    // Loop because sleeping can make a *different* ceiling the binding one.
    for (;;) {
      const now = this.clock.now();
      this.prune(now);

      const wait = this.computeWait(now, estimatedTokens);
      if (wait === null) {
        const entry: WindowEntry = { at: now, tokens: estimatedTokens };
        this.window.push(entry);
        // Stamped at start, not at completion: min-interval is about how often
        // we FIRE requests, independent of how long each one takes.
        this.lastStartedAt = now;
        return entry;
      }

      this.options.onWait?.(wait.ms, wait.reason);
      await this.clock.sleep(wait.ms);
    }
  }

  private computeWait(now: number, estimatedTokens: number): { ms: number; reason: WaitReason } | null {
    if (this.cooldownUntil > now) {
      return { ms: this.cooldownUntil - now, reason: 'provider_cooldown' };
    }

    const sinceLast = now - this.lastStartedAt;
    if (this.options.minIntervalMs > 0 && sinceLast < this.options.minIntervalMs) {
      return { ms: this.options.minIntervalMs - sinceLast, reason: 'min_interval' };
    }

    if (this.window.length >= this.options.maxRequestsPerMinute) {
      const oldest = this.window[0];
      if (oldest !== undefined) {
        return { ms: Math.max(1, oldest.at + WINDOW_MS - now), reason: 'requests_per_minute' };
      }
    }

    const tokensUsed = this.window.reduce((sum, e) => sum + e.tokens, 0);
    if (tokensUsed + estimatedTokens > this.options.maxTokensPerMinute) {
      const oldest = this.window[0];
      if (oldest !== undefined) {
        return { ms: Math.max(1, oldest.at + WINDOW_MS - now), reason: 'tokens_per_minute' };
      }
      // A single request larger than the whole per-minute budget would block
      // forever. Let it through and let the provider be the authority.
    }

    return null;
  }

  private prune(now: number): void {
    while (this.window.length > 0) {
      const first = this.window[0];
      if (first !== undefined && first.at <= now - WINDOW_MS) this.window.shift();
      else break;
    }
  }
}
