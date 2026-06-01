import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  STEP_TRAIL_MAX_BYTES,
  type CacheHitBreakdown,
  type DemandRow,
  type ProvisionEventInput,
  type ProvisionEventRecord,
  type ProvisionEventStore,
} from "./provision-event-store.js";

export class PrismaProvisionEventStore implements ProvisionEventStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaProvisionEventStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaProvisionEventStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async record(input: ProvisionEventInput): Promise<{ id: string }> {
    const trailRaw = input.step_trail ?? null;
    const step_trail =
      trailRaw === null
        ? null
        : Buffer.byteLength(trailRaw, "utf8") > STEP_TRAIL_MAX_BYTES
          ? trailRaw.slice(0, STEP_TRAIL_MAX_BYTES) + "\n[…truncated]"
          : trailRaw;
    // Column payload shared by create + upsert-update.
    const data = {
      service: input.service,
      status: input.status,
      initial_strategy: input.initial_strategy ?? null,
      final_strategy: input.final_strategy ?? null,
      replay_outcome: input.replay_outcome ?? null,
      final_outcome: input.final_outcome ?? null,
      failure_kind: input.failure_kind ?? null,
      signup_url: input.signup_url ?? null,
      provision_id: input.provision_id ?? null,
      step_trail,
      llm_cost: input.llm_cost ?? null,
      captcha_cost: input.captcha_cost ?? null,
      duration_ms: input.duration_ms ?? null,
      account_id: input.account_id,
      mcp_version: input.mcp_version,
    };
    // Idempotency (Decision 11): upsert on a non-null provision_id so a
    // retried fire-and-forget emit overwrites rather than double-counts.
    // A null provision_id can't key an upsert (NULLs are distinct), so
    // those fall through to a plain create.
    if (input.provision_id !== undefined && input.provision_id !== null) {
      const row = await this.client.provisionEvent.upsert({
        where: { provision_id: input.provision_id },
        create: data,
        update: data,
        select: { id: true },
      });
      return { id: row.id };
    }
    const row = await this.client.provisionEvent.create({
      data,
      select: { id: true },
    });
    return { id: row.id };
  }

  async listRecentFailures(limit = 50): Promise<ProvisionEventRecord[]> {
    const rows = await this.client.provisionEvent.findMany({
      where: { status: "failed" },
      orderBy: { occurred_at: "desc" },
      take: Math.min(limit, 200),
    });
    return rows.map(mapRow);
  }

  async listByService(service: string, sinceMs: number): Promise<ProvisionEventRecord[]> {
    const cutoff = new Date(Date.now() - sinceMs);
    const rows = await this.client.provisionEvent.findMany({
      where: { service, occurred_at: { gte: cutoff } },
      orderBy: { occurred_at: "desc" },
    });
    return rows.map(mapRow);
  }

  async cacheHitBreakdown(sinceMs: number): Promise<CacheHitBreakdown> {
    const cutoff = new Date(Date.now() - sinceMs);
    // no_skill_bot is derived as total - replay_served - fell_back so the
    // three buckets always partition the total (legacy rows with a NULL
    // strategy fall into no_skill_bot without a special FILTER).
    const rows = (await this.client.$queryRawUnsafe(
      `
      SELECT
        COUNT(*) FILTER (WHERE final_strategy = 'replay') AS replay_served,
        COUNT(*) FILTER (WHERE final_strategy = 'bot' AND initial_strategy = 'replay') AS fell_back,
        COUNT(*) AS total
      FROM "ProvisionEvent"
      WHERE occurred_at >= $1
      `,
      cutoff,
    )) as Array<{ replay_served: number | bigint; fell_back: number | bigint; total: number | bigint }>;
    const r = rows[0] ?? { replay_served: 0, fell_back: 0, total: 0 };
    const replay_served = Number(r.replay_served);
    const fell_back = Number(r.fell_back);
    const total = Number(r.total);
    return { replay_served, fell_back, no_skill_bot: total - replay_served - fell_back, total };
  }

  async demandByService(sinceMs: number, limit: number): Promise<DemandRow[]> {
    const cutoff = new Date(Date.now() - sinceMs);
    // Wall-kind list is inlined as a literal (a fixed constant, not user
    // input → injection-safe) to avoid Postgres array-param binding.
    // MUST stay in sync with isWallFailure() in provision-event-store.ts.
    const rows = (await this.client.$queryRawUnsafe(
      `
      SELECT
        service,
        COUNT(*) AS volume,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (
          WHERE status = 'failed'
            AND failure_kind IN ('captcha_blocked', 'anti_bot_blocked', 'captcha')
        ) AS wall_failed
      FROM "ProvisionEvent"
      WHERE occurred_at >= $1
      GROUP BY service
      ORDER BY volume DESC
      LIMIT $2
      `,
      cutoff,
      Math.max(1, limit),
    )) as Array<{
      service: string;
      volume: number | bigint;
      failed: number | bigint;
      wall_failed: number | bigint;
    }>;
    return rows.map((r) => ({
      service: r.service,
      volume: Number(r.volume),
      failed: Number(r.failed),
      wall_failed: Number(r.wall_failed),
    }));
  }
}

// Maps a raw Prisma row to ProvisionEventRecord. New dispatch/cost
// columns are read defensively (optional in the runtime row type) so
// pre-migration rows — which lack them — don't crash the mapper.
function mapRow(r: {
  id: string;
  service: string;
  status: string;
  failure_kind: string | null;
  signup_url: string | null;
  artifacts_uri: string | null;
  provision_id?: string | null;
  step_trail?: string | null;
  initial_strategy?: string | null;
  final_strategy?: string | null;
  replay_outcome?: string | null;
  final_outcome?: string | null;
  llm_cost?: number | null;
  captcha_cost?: number | null;
  duration_ms?: number | null;
  account_id: string;
  mcp_version: string;
  occurred_at: Date;
}): ProvisionEventRecord {
  return {
    id: r.id,
    service: r.service,
    status: r.status as "success" | "failed",
    initial_strategy: (r.initial_strategy ?? null) as ProvisionEventRecord["initial_strategy"],
    final_strategy: (r.final_strategy ?? null) as ProvisionEventRecord["final_strategy"],
    replay_outcome: (r.replay_outcome ?? null) as ProvisionEventRecord["replay_outcome"],
    final_outcome: (r.final_outcome ?? null) as ProvisionEventRecord["final_outcome"],
    failure_kind: r.failure_kind,
    signup_url: r.signup_url,
    artifacts_uri: r.artifacts_uri,
    provision_id: r.provision_id ?? null,
    step_trail: r.step_trail ?? null,
    llm_cost: r.llm_cost ?? null,
    captcha_cost: r.captcha_cost ?? null,
    duration_ms: r.duration_ms ?? null,
    account_id: r.account_id,
    mcp_version: r.mcp_version,
    occurred_at: r.occurred_at,
  };
}
