import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  STEP_TRAIL_MAX_BYTES,
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
