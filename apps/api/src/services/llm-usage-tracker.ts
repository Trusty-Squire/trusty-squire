// Per-machine-token rolling LLM-call counter.
//
// The bot's own MAX_LLM_CALLS_PER_SIGNUP caps spend per run, but a
// malicious/buggy client could ignore that cap and burn through a lot
// of $0.005 calls fast. This module enforces a server-side ceiling
// independent of the bot's behaviour. The window is rolling: we keep a
// small ring buffer of timestamps per token and drop entries older than
// the window.
//
// In-memory backing for v1. The state is best-effort — losing it on
// restart means a noisy user gets a brief grace period, which is fine.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_LIMIT = Number.parseInt(process.env.LLM_HOURLY_LIMIT ?? "150", 10);

export interface LLMUsageTracker {
  // Returns true if the call should proceed; false if the caller is
  // over the rolling limit. Calling code records the timestamp ONLY
  // when it decides to proceed.
  shouldAllow(token: string, now: Date): boolean;
  record(token: string, now: Date): void;
  // Inspection helpers for /v1/install/status and debugging.
  countInWindow(token: string, now: Date): number;
  limit(): number;
}

export class InMemoryLLMUsageTracker implements LLMUsageTracker {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly hourlyLimit: number;

  constructor(opts: { windowMs?: number; hourlyLimit?: number } = {}) {
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.hourlyLimit = opts.hourlyLimit ?? DEFAULT_LIMIT;
  }

  shouldAllow(token: string, now: Date): boolean {
    return this.countInWindow(token, now) < this.hourlyLimit;
  }

  record(token: string, now: Date): void {
    const entries = this.windows.get(token) ?? [];
    entries.push(now.getTime());
    // Drop old entries lazily — keep the array bounded.
    const cutoff = now.getTime() - this.windowMs;
    const fresh = entries.filter((t) => t >= cutoff);
    this.windows.set(token, fresh);
  }

  countInWindow(token: string, now: Date): number {
    const entries = this.windows.get(token);
    if (entries === undefined) return 0;
    const cutoff = now.getTime() - this.windowMs;
    return entries.filter((t) => t >= cutoff).length;
  }

  limit(): number {
    return this.hourlyLimit;
  }
}
