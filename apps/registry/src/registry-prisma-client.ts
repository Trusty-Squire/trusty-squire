import { createRequire } from "node:module";

export interface RegistryPrismaClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(fn: (tx: RegistryPrismaTransaction) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...args: unknown[]): Promise<T>;
  skillRecord: SkillRecordDelegate;
  skillReplayRecord: SkillReplayDelegate;
  skillCaptureRecord: SkillCaptureDelegate;
  extractFailureSnapshot: ExtractFailureSnapshotDelegate;
  // Closed-loop Phase 5: telemetry for the discovery worker.
  universalBotFailureRecord: UniversalBotFailureRecordDelegate;
  // Per-provision event rows: compat-score endpoint + dashboard
  // cache-hit/demand views. Renamed from provisionAttempt.
  provisionEvent: ProvisionEventDelegate;
  // T10 — closed-loop heal-pass heartbeats for the admin status panel.
  healRun: HealRunDelegate;
}

interface HealRunRow {
  id: string;
  ran_at: Date;
  verified: number;
  demoted: number;
  quarantined: number;
  reskilled: number;
  needs_human: number;
  discover_attempted: number;
  discover_succeeded: number;
  skills_active: number;
  hit_served: number;
  hit_total: number;
  mcp_version: string | null;
}

interface HealRunDelegate {
  create(args: { data: Record<string, unknown> }): Promise<HealRunRow>;
  findFirst(args: { orderBy?: Record<string, unknown> }): Promise<HealRunRow | null>;
  findMany(args: {
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<HealRunRow[]>;
}

export type RegistryPrismaTransaction = Omit<
  RegistryPrismaClient,
  "$connect" | "$disconnect" | "$transaction"
>;

interface SkillRecordDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  delete(args: { where: Record<string, unknown> }): Promise<unknown>;
}

interface SkillReplayDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

interface SkillCaptureDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Array<Record<string, unknown>>;
  }): Promise<unknown[]>;
  deleteMany(args: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

interface UniversalBotFailureRecordDelegate {
  create(args: { data: Record<string, unknown> }): Promise<{
    id: string;
    service: string;
    error_kind: string;
    reason: string;
    account_id: string;
    mcp_version: string;
    reported_at: Date;
  }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

interface ProvisionEventDelegate {
  create(args: {
    data: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<{ id: string }>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<{ id: string }>;
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<
    Array<{
      id: string;
      service: string;
      status: string;
      failure_kind: string | null;
      signup_url: string | null;
      artifacts_uri: string | null;
      // Optional in the runtime type so older rows (pre-migration)
      // don't crash the mapper.
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
    }>
  >;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

interface ExtractFailureSnapshotDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export function createRegistryPrismaClient(): RegistryPrismaClient {
  const req = createRequire(import.meta.url);
  type Ctor = new () => RegistryPrismaClient;
  const mod = req("../node_modules/.prisma/registry-client/index.js") as {
    PrismaClient: Ctor;
  };
  return new mod.PrismaClient();
}
