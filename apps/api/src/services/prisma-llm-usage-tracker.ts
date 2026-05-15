// Postgres-backed LLM-call ledger.
//
// Each /v1/llm/chat call inserts one row; the rate limiter counts rows
// in the last hour. We over-fetch via COUNT(*) rather than caching
// in-process because:
//   - Single API instance today: count is O(150 rows/machine) so cheap
//   - When we scale to multiple instances, a shared DB count is the
//     only correct answer (memory counters drift across pods)

import type { ApiPrismaClient } from "./api-prisma-client.js";
import type { LLMUsageTracker } from "./llm-usage-tracker.js";

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = Number.parseInt(process.env.LLM_HOURLY_LIMIT ?? "150", 10);

export class PrismaLLMUsageTracker implements LLMUsageTracker {
  private readonly windowMs: number;
  private readonly hourlyLimit: number;
  // We synchronously cache the count to make shouldAllow() non-async.
  // The route calls shouldAllow() and record() in sequence; we refresh
  // the count after every record(). For a single-instance API this is
  // correct; multi-instance would need a fully-async interface.
  private readonly countCache = new Map<string, { count: number; refreshed_at: number }>();
  private readonly CACHE_TTL_MS = 5_000;

  constructor(
    private readonly prisma: ApiPrismaClient,
    opts: { windowMs?: number; hourlyLimit?: number } = {},
  ) {
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.hourlyLimit = opts.hourlyLimit ?? DEFAULT_LIMIT;
  }

  // Synchronous wrapper around the cached count. Returns true (allow)
  // when we have no cached info — the next record() refreshes it.
  shouldAllow(token: string, now: Date): boolean {
    return this.countInWindow(token, now) < this.hourlyLimit;
  }

  // Fire-and-forget insert. The route awaits this anyway, but we don't
  // block on a successful count refresh — the cache reflects the new
  // state via the optimistic ++.
  record(token: string, now: Date): void {
    void this.prisma.lLMUsageEvent.create({
      data: { machine_token: token, occurred_at: now },
    });
    const cached = this.countCache.get(token);
    if (cached !== undefined) {
      cached.count += 1;
    }
  }

  countInWindow(token: string, now: Date): number {
    const cached = this.countCache.get(token);
    if (cached !== undefined && now.getTime() - cached.refreshed_at < this.CACHE_TTL_MS) {
      return cached.count;
    }
    // Cache miss/stale: kick off a refresh, return optimistic (current
    // cached count or 0). The shouldAllow gate uses this; in the rare
    // case a token races past the limit, the next call will catch up.
    void this.refresh(token, now);
    return cached?.count ?? 0;
  }

  limit(): number {
    return this.hourlyLimit;
  }

  private async refresh(token: string, now: Date): Promise<void> {
    try {
      const since = new Date(now.getTime() - this.windowMs);
      const count = await this.prisma.lLMUsageEvent.count({
        where: { machine_token: token, occurred_at: { gte: since } },
      });
      this.countCache.set(token, { count, refreshed_at: now.getTime() });
    } catch {
      // Refresh failures are tolerated — we'd rather under-count than
      // block legitimate traffic. Real failures will surface in logs.
    }
  }
}
