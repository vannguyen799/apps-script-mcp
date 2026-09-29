export type Clock = () => number;

/** Fixed-window counter: at most `limit` hits per `windowMs` per key. */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    return { allowed: e.count <= this.limit, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Counts failures per key; once `maxFailures` happen inside the window the key is blocked until it expires. */
export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: Clock = Date.now,
  ) {}

  /** Returns seconds to wait when blocked, else 0. */
  blockedFor(key: string): number {
    const e = this.failures.get(key);
    const t = this.now();
    if (!e || e.resetAt <= t) return 0;
    return e.count >= this.maxFailures ? Math.max(1, Math.ceil((e.resetAt - t) / 1000)) : 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= t) this.failures.delete(k);
    }
    const e = this.failures.get(key);
    if (!e || e.resetAt <= t) this.failures.set(key, { count: 1, resetAt: t + this.windowMs });
    else e.count += 1;
  }

  /** Withdraws one failure recorded for an attempt that turned out to succeed. */
  forgive(key: string): void {
    const e = this.failures.get(key);
    if (e && e.resetAt > this.now() && e.count > 0) e.count -= 1;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
