// In-memory BotFailureStore for tests. Mirrors the Prisma version's
// aggregation semantics: ≥N distinct accounts in the lookback window,
// services with active skills excluded.

import { randomUUID } from "node:crypto";
import type {
  BotFailureStore,
  DiscoveryCandidate,
  InsertBotFailureInput,
  ListDiscoveryCandidatesOpts,
  UniversalBotFailureRecord,
} from "./bot-failure-store.js";

export class InMemoryBotFailureStore implements BotFailureStore {
  private rows: UniversalBotFailureRecord[];

  constructor() {
    this.rows = [];
  }

  async insert(input: InsertBotFailureInput): Promise<UniversalBotFailureRecord> {
    const row: UniversalBotFailureRecord = {
      id: randomUUID(),
      service: input.service,
      error_kind: input.error_kind,
      reason: input.reason,
      account_id: input.account_id,
      mcp_version: input.mcp_version,
      reported_at: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async listDiscoveryCandidates(
    opts: ListDiscoveryCandidatesOpts,
  ): Promise<DiscoveryCandidate[]> {
    const now = opts.now ?? new Date();
    const sinceDays = opts.sinceDays ?? 14;
    const minDistinct = opts.minDistinct ?? 3;
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const cutoff = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

    // Bucket failures by service, accumulate distinct accounts +
    // error_kind frequency.
    const buckets = new Map<
      string,
      {
        accounts: Set<string>;
        errorKindCounts: Map<string, number>;
        mostRecent: Date;
      }
    >();
    for (const row of this.rows) {
      if (row.reported_at < cutoff) continue;
      if (opts.excludeServices.has(row.service)) continue;
      let bucket = buckets.get(row.service);
      if (bucket === undefined) {
        bucket = {
          accounts: new Set(),
          errorKindCounts: new Map(),
          mostRecent: row.reported_at,
        };
        buckets.set(row.service, bucket);
      }
      bucket.accounts.add(row.account_id);
      bucket.errorKindCounts.set(
        row.error_kind,
        (bucket.errorKindCounts.get(row.error_kind) ?? 0) + 1,
      );
      if (row.reported_at > bucket.mostRecent) bucket.mostRecent = row.reported_at;
    }

    const candidates: DiscoveryCandidate[] = [];
    for (const [service, bucket] of buckets.entries()) {
      if (bucket.accounts.size < minDistinct) continue;
      let topKind = "";
      let topCount = -1;
      for (const [kind, count] of bucket.errorKindCounts.entries()) {
        if (count > topCount) {
          topKind = kind;
          topCount = count;
        }
      }
      candidates.push({
        service,
        distinct_failures: bucket.accounts.size,
        top_error_kind: topKind,
        most_recent_at: bucket.mostRecent,
      });
    }
    // Sort: most distinct failures first; tiebreak by recency.
    candidates.sort((a, b) => {
      if (a.distinct_failures !== b.distinct_failures) {
        return b.distinct_failures - a.distinct_failures;
      }
      return b.most_recent_at.getTime() - a.most_recent_at.getTime();
    });
    return candidates.slice(0, limit);
  }

  async countRecentByAccount(account_id: string, since: Date): Promise<number> {
    return this.rows.filter(
      (r) => r.account_id === account_id && r.reported_at >= since,
    ).length;
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.reported_at >= cutoff);
    return before - this.rows.length;
  }
}
