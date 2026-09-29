import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { StateStore } from "../store/state-store.js";

/** DESIGN.md 10.2: calls and errors per UTC day and tool, kept for 30 days. Never anything about what a call touched. */
export const USAGE_RETENTION_DAYS = 30;
export const USAGE_FLUSH_MS = 60_000;
const DAY_MS = 86_400_000;

export interface UsageRow {
  /** UTC day, YYYY-MM-DD */
  day: string;
  tool: string;
  calls: number;
  errors: number;
}

/** What the tool wrapper needs. It must never throw. */
export interface UsageRecorder {
  record(tool: string, ok: boolean): void;
}

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** The first day still kept: today and the 29 before it. */
const oldestDay = (now: number): string => dayOf(now - (USAGE_RETENTION_DAYS - 1) * DAY_MS);

/**
 * Counters live in memory and are merged into `state.usage[day][tool]` every 60 s and on shutdown, so a busy server does not
 * rewrite the state file (or database row) on every call. A crash loses at most the last minute of counts.
 */
export class UsageService implements UsageRecorder {
  private pending = new Map<string, { day: string; tool: string; calls: number; errors: number }>();
  private timer: NodeJS.Timeout | undefined;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly store: StateStore,
    opts: { logger?: Logger; now?: () => number } = {},
  ) {
    this.log = opts.logger ?? nullLogger;
    this.now = opts.now ?? (() => Date.now());
  }

  record(tool: string, ok: boolean): void {
    try {
      const day = dayOf(this.now());
      const key = `${day}\n${tool}`;
      const e = this.pending.get(key) ?? { day, tool, calls: 0, errors: 0 };
      e.calls += 1;
      if (!ok) e.errors += 1;
      this.pending.set(key, e);
    } catch {
      /* usage must never break a tool call */
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), USAGE_FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Merges the counters into the state (and prunes old days). Never rejects. */
  async flush(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending = new Map();
    const oldest = oldestDay(this.now());
    const stale = Object.keys(this.store.state.usage).some((d) => d < oldest);
    if (batch.length === 0 && !stale) return;
    try {
      // The mutation is applied to memory synchronously; if persisting fails the counts are still in the state and go out
      // with the next write, so nothing is lost and nothing is counted twice.
      await this.store.update((s) => {
        for (const e of batch) {
          const day = (s.usage[e.day] ??= {});
          const t = (day[e.tool] ??= { calls: 0, errors: 0 });
          t.calls += e.calls;
          t.errors += e.errors;
        }
        for (const d of Object.keys(s.usage)) if (d < oldest) delete s.usage[d];
      });
    } catch (e) {
      this.log.warn("usage_flush_failed", { reason: e instanceof Error ? e.name : "unknown" });
    }
  }

  /** Last 30 days (stored plus not yet flushed), newest day first, then by tool. */
  rows(): UsageRow[] {
    const oldest = oldestDay(this.now());
    const merged = new Map<string, UsageRow>();
    const add = (day: string, tool: string, calls: number, errors: number) => {
      if (day < oldest) return;
      const k = `${day}\n${tool}`;
      const r = merged.get(k) ?? { day, tool, calls: 0, errors: 0 };
      r.calls += calls;
      r.errors += errors;
      merged.set(k, r);
    };
    for (const [day, tools] of Object.entries(this.store.state.usage)) for (const [tool, c] of Object.entries(tools)) add(day, tool, c.calls, c.errors);
    for (const e of this.pending.values()) add(e.day, e.tool, e.calls, e.errors);
    return [...merged.values()].sort((a, b) => (a.day === b.day ? a.tool.localeCompare(b.tool) : a.day < b.day ? 1 : -1));
  }
}
