import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  STEP_TRAIL_MAX_BYTES,
  type ProvisionAttemptInput,
  type ProvisionAttemptRecord,
  type ProvisionAttemptStore,
} from "./provision-attempt-store.js";

export class PrismaProvisionAttemptStore implements ProvisionAttemptStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaProvisionAttemptStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaProvisionAttemptStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async record(input: ProvisionAttemptInput): Promise<{ id: string }> {
    const trailRaw = input.step_trail ?? null;
    const step_trail =
      trailRaw === null
        ? null
        : Buffer.byteLength(trailRaw, "utf8") > STEP_TRAIL_MAX_BYTES
          ? trailRaw.slice(0, STEP_TRAIL_MAX_BYTES) + "\n[…truncated]"
          : trailRaw;
    const row = await this.client.provisionAttempt.create({
      data: {
        service: input.service,
        status: input.status,
        failure_kind: input.failure_kind ?? null,
        signup_url: input.signup_url ?? null,
        provision_id: input.provision_id ?? null,
        step_trail,
        account_id: input.account_id,
        mcp_version: input.mcp_version,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  async listRecentFailures(limit = 50): Promise<ProvisionAttemptRecord[]> {
    const rows = await this.client.provisionAttempt.findMany({
      where: { status: "failed" },
      orderBy: { occurred_at: "desc" },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      service: r.service,
      status: r.status as "success" | "failed",
      failure_kind: r.failure_kind,
      signup_url: r.signup_url,
      artifacts_uri: r.artifacts_uri,
      provision_id: (r as { provision_id?: string | null }).provision_id ?? null,
      step_trail: (r as { step_trail?: string | null }).step_trail ?? null,
      account_id: r.account_id,
      mcp_version: r.mcp_version,
      occurred_at: r.occurred_at,
    }));
  }

  async listByService(service: string, sinceMs: number): Promise<ProvisionAttemptRecord[]> {
    const cutoff = new Date(Date.now() - sinceMs);
    const rows = await this.client.provisionAttempt.findMany({
      where: { service, occurred_at: { gte: cutoff } },
      orderBy: { occurred_at: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      service: r.service,
      status: r.status as "success" | "failed",
      failure_kind: r.failure_kind,
      signup_url: r.signup_url,
      artifacts_uri: r.artifacts_uri,
      provision_id: (r as { provision_id?: string | null }).provision_id ?? null,
      step_trail: (r as { step_trail?: string | null }).step_trail ?? null,
      account_id: r.account_id,
      mcp_version: r.mcp_version,
      occurred_at: r.occurred_at,
    }));
  }
}
