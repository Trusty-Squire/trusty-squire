// Prisma-backed UniversalBotFailureRecord store. Production wires
// this; tests use the in-memory variant.

import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import type {
  BotFailureStore,
  DiscoveryCandidate,
  InsertBotFailureInput,
  ListDiscoveryCandidatesOpts,
  UniversalBotFailureRecord,
} from "./bot-failure-store.js";

export class PrismaBotFailureStore implements BotFailureStore {
  private client: RegistryPrismaClient;

  constructor(client: RegistryPrismaClient) {
    this.client = client;
  }

  static async fromEnv(): Promise<PrismaBotFailureStore> {
    return new PrismaBotFailureStore(createRegistryPrismaClient());
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async insert(input: InsertBotFailureInput): Promise<UniversalBotFailureRecord> {
    const row = await this.client.universalBotFailureRecord.create({
      data: {
        service: input.service,
        error_kind: input.error_kind,
        reason: input.reason,
        account_id: input.account_id,
        mcp_version: input.mcp_version,
      },
    });
    return {
      id: row.id,
      service: row.service,
      error_kind: row.error_kind,
      reason: row.reason,
      account_id: row.account_id,
      mcp_version: row.mcp_version,
      reported_at: row.reported_at,
    };
  }

  async listDiscoveryCandidates(
    opts: ListDiscoveryCandidatesOpts,
  ): Promise<DiscoveryCandidate[]> {
    const now = opts.now ?? new Date();
    const sinceDays = opts.sinceDays ?? 14;
    const minDistinct = opts.minDistinct ?? 3;
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const cutoff = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

    // Aggregation runs in Postgres for scalability — a raw SQL
    // query keeps this readable next to the in-memory variant.
    // Casting because the registry Prisma client wraps any-typed
    // raw helpers; we trust the column names.
    const rows = (await this.client.$queryRawUnsafe(
      `
      SELECT
        service,
        COUNT(DISTINCT account_id) AS distinct_failures,
        MODE() WITHIN GROUP (ORDER BY error_kind) AS top_error_kind,
        MAX(reported_at) AS most_recent_at
      FROM "UniversalBotFailureRecord"
      WHERE reported_at >= $1
      GROUP BY service
      HAVING COUNT(DISTINCT account_id) >= $2
      ORDER BY distinct_failures DESC, most_recent_at DESC
      LIMIT $3
      `,
      cutoff,
      minDistinct,
      limit,
    )) as Array<{
      service: string;
      distinct_failures: number | bigint;
      top_error_kind: string;
      most_recent_at: Date;
    }>;

    // Filter excludeServices in app code — keeping the WHERE clause
    // simple (the alternative is a NOT IN against a parameterized
    // array, which Prisma's $queryRawUnsafe doesn't bind cleanly).
    return rows
      .filter((r) => !opts.excludeServices.has(r.service))
      .map((r) => ({
        service: r.service,
        distinct_failures: Number(r.distinct_failures),
        top_error_kind: r.top_error_kind,
        most_recent_at: r.most_recent_at,
      }));
  }

  async countRecentByAccount(account_id: string, since: Date): Promise<number> {
    return await this.client.universalBotFailureRecord.count({
      where: {
        account_id,
        reported_at: { gte: since },
      },
    });
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const result = await this.client.universalBotFailureRecord.deleteMany({
      where: { reported_at: { lt: cutoff } },
    });
    return result.count;
  }
}
