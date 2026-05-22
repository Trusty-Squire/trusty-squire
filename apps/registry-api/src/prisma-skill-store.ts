// Prisma-backed SkillStore. Used by the production server. Tests
// use InMemorySkillStore. Mirrors prisma-store.ts (the manifest
// equivalent).

import { parseSkill, type Skill } from "@trusty-squire/adapter-sdk";
import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  type InsertCaptureInput,
  type InsertSkillInput,
  type ListSkillsFilter,
  type RecordReplayInput,
  type RecordReplayResult,
  type SkillCaptureRecord,
  type SkillReplayRecord,
  type SkillStore,
  type SkillStoreRecord,
  SkillConflictError,
} from "./skill-store.js";
import { triggersHumanReview } from "./skill-store-memory.js";

const DEMOTION_THRESHOLD = 3;

export class PrismaSkillStore implements SkillStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaSkillStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaSkillStore(client);
  }

  static fromClient(client: RegistryPrismaClient): PrismaSkillStore {
    // For tests + the registry-api server which already maintains a
    // single PrismaClient. Skipping $connect — the caller owns the
    // lifecycle.
    return new PrismaSkillStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async insert(input: InsertSkillInput): Promise<SkillStoreRecord> {
    const { skill, signature, signed_at, signed_by } = input;

    // T26 — Human-review gate (C11). If an active skill already
    // exists for this service, decide whether the new submission
    // changes a phishing-vector field (signup_url / oauth_provider)
    // and force pending-review if so.
    let effectiveStatus = skill.status;
    if (skill.status === "active") {
      const existingActive = await this.findActiveByService(skill.service);
      if (existingActive !== null && triggersHumanReview(existingActive.payload, skill)) {
        effectiveStatus = "pending-review";
      }
    }
    const payloadForStorage: Skill = { ...skill, status: effectiveStatus };

    try {
      const row = await this.client.skillRecord.create({
        data: {
          skill_id: skill.skill_id,
          service: skill.service,
          version: skill.version,
          payload_json: payloadForStorage,
          signature,
          signed_at,
          signed_by,
          status: effectiveStatus,
          replays_succeeded: skill.replays_succeeded,
          replays_failed: skill.replays_failed,
          consecutive_failures: skill.consecutive_failures,
          last_replayed_at: skill.last_replayed_at ? new Date(skill.last_replayed_at) : null,
          superseded_at: skill.superseded_at ? new Date(skill.superseded_at) : null,
          deleted_at: skill.deleted_at ? new Date(skill.deleted_at) : null,
        },
      });
      return toSkillStoreRecord(row as PrismaSkillRow);
    } catch (err) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2002"
      ) {
        throw new SkillConflictError(skill.skill_id);
      }
      throw err;
    }
  }

  async findById(skill_id: string): Promise<SkillStoreRecord | null> {
    const row = await this.client.skillRecord.findUnique({ where: { skill_id } });
    return row ? toSkillStoreRecord(row as PrismaSkillRow) : null;
  }

  async findActiveByService(service: string): Promise<SkillStoreRecord | null> {
    // Pick the most recently created active row. Uses the
    // (service, status) hot-path index.
    const row = await this.client.skillRecord.findFirst({
      where: { service, status: "active", deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    return row ? toSkillStoreRecord(row as PrismaSkillRow) : null;
  }

  async listSkills(filter: ListSkillsFilter): Promise<SkillStoreRecord[]> {
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    const where: Record<string, unknown> = { deleted_at: null };
    if (filter.service !== undefined) where.service = filter.service;
    if (filter.status !== undefined) where.status = filter.status;
    const rows = await this.client.skillRecord.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return rows.map((row) => toSkillStoreRecord(row as PrismaSkillRow));
  }

  async recordReplayOutcome(input: RecordReplayInput): Promise<RecordReplayResult> {
    // Atomic increment via $transaction. The naive approach (read,
    // mutate, write) would lose updates under concurrent replays —
    // exactly the race E3 calls out.
    //
    // We use a SQL-level conditional UPDATE to bump counters in one
    // statement, then read back the updated row + write the replay
    // history entry. The transaction wraps it so a failed read-back
    // doesn't leave orphaned counter increments.
    const isSuccess = input.outcome === "ok" || input.outcome === "dry_pass";

    return this.client.$transaction(async (tx) => {
      // Atomic increment via Prisma's `increment` operator — works
      // even under concurrent writes because Prisma compiles this
      // to a single SQL UPDATE ... SET x = x + 1.
      const skill: PrismaSkillRow = isSuccess
        ? (await tx.skillRecord.update({
            where: { skill_id: input.skill_id },
            data: {
              replays_succeeded: { increment: 1 },
              consecutive_failures: 0,
              last_replayed_at: new Date(),
            },
          })) as unknown as PrismaSkillRow
        : ((await tx.skillRecord.update({
            where: { skill_id: input.skill_id },
            data: {
              replays_failed: { increment: 1 },
              consecutive_failures: { increment: 1 },
              last_replayed_at: new Date(),
            },
          })) as unknown as PrismaSkillRow);

      // Auto-demotion check happens in the same transaction so we
      // never observe an intermediate state where a skill has
      // crossed the threshold but is still marked active.
      let demoted = false;
      if (
        skill.consecutive_failures >= DEMOTION_THRESHOLD &&
        skill.status === "active"
      ) {
        await tx.skillRecord.update({
          where: { skill_id: input.skill_id },
          data: { status: "demoted" },
        });
        demoted = true;
      }

      const replay = await tx.skillReplayRecord.create({
        data: {
          skill_id: input.skill_id,
          outcome: input.outcome,
          reason: input.reason,
          account_id: input.account_id,
          step_index: input.step_index,
        },
      });

      return {
        replay: toReplayRecord(replay as PrismaReplayRow),
        demoted,
        consecutive_failures: skill.consecutive_failures,
        replays_succeeded: skill.replays_succeeded,
        replays_failed: skill.replays_failed,
      };
    });
  }

  async listReplays(skill_id: string, limit: number): Promise<SkillReplayRecord[]> {
    const rows = await this.client.skillReplayRecord.findMany({
      where: { skill_id },
      orderBy: { replayed_at: "desc" },
      take: limit,
    });
    return rows.map((row) => toReplayRecord(row as PrismaReplayRow));
  }

  async manuallyDemote(skill_id: string, reason: string): Promise<SkillStoreRecord | null> {
    void reason; // see InMemorySkillStore — no demotion_reason column yet
    try {
      const row = await this.client.skillRecord.update({
        where: { skill_id },
        data: { status: "demoted" },
      });
      return toSkillStoreRecord(row as PrismaSkillRow);
    } catch (err) {
      // P2025 = "record to update not found"
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2025"
      ) {
        return null;
      }
      throw err;
    }
  }

  async approveReview(skill_id: string): Promise<SkillStoreRecord | null> {
    // Atomic: flip pending-review → active AND supersede any older
    // active row for the same service. Wrapped in $transaction so a
    // crash mid-update doesn't leave two active rows for one service.
    return this.client.$transaction(async (tx) => {
      const current = (await tx.skillRecord.findUnique({ where: { skill_id } })) as
        | PrismaSkillRow
        | null;
      if (current === null) return null;
      if (current.status !== "pending-review") {
        return toSkillStoreRecord(current);
      }
      const now = new Date();
      await tx.skillRecord.updateMany({
        where: {
          service: current.service,
          status: "active",
          NOT: { skill_id },
        },
        data: { status: "superseded", superseded_at: now },
      });
      const updated = await tx.skillRecord.update({
        where: { skill_id },
        data: { status: "active" },
      });
      return toSkillStoreRecord(updated as PrismaSkillRow);
    });
  }

  async reactivate(skill_id: string): Promise<{
    record: SkillStoreRecord;
    previously: string;
  } | null> {
    return this.client.$transaction(async (tx) => {
      const current = (await tx.skillRecord.findUnique({ where: { skill_id } })) as
        | PrismaSkillRow
        | null;
      if (current === null) return null;
      const previously = current.status;
      if (previously === "active") {
        // Idempotent — caller sees previously === status.
        return { record: toSkillStoreRecord(current), previously };
      }
      // Mirror approveReview: supersede any active row for the same
      // service before flipping this one to active.
      const now = new Date();
      await tx.skillRecord.updateMany({
        where: {
          service: current.service,
          status: "active",
          NOT: { skill_id },
        },
        data: { status: "superseded", superseded_at: now },
      });
      const updated = await tx.skillRecord.update({
        where: { skill_id },
        data: { status: "active", consecutive_failures: 0 },
      });
      return {
        record: toSkillStoreRecord(updated as PrismaSkillRow),
        previously,
      };
    });
  }

  async deleteSkill(skill_id: string): Promise<boolean> {
    try {
      // Captures are NOT on a Prisma cascade — only the replay table is
      // (schema.prisma:106). Delete captures explicitly first; the
      // skill row's removal triggers the replay cascade.
      await this.client.$transaction(async (tx) => {
        await tx.skillCaptureRecord.deleteMany({ where: { skill_id } });
        await tx.skillRecord.delete({ where: { skill_id } });
      });
      return true;
    } catch (err) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2025"
      ) {
        return false;
      }
      throw err;
    }
  }

  async countRecentReplaysByAccount(account_id: string, since: Date): Promise<number> {
    return this.client.skillReplayRecord.count({
      where: { account_id, replayed_at: { gte: since } },
    });
  }

  // ── T19: capture sidecars ────────────────────────────────────────

  async insertCapture(input: InsertCaptureInput): Promise<SkillCaptureRecord> {
    const existing = await this.client.skillCaptureRecord.findUnique({
      where: { content_hash: input.content_hash },
    });
    if (existing !== null) return toCaptureRecord(existing as PrismaCaptureRow);

    const payloadJson = input.payload;
    const byteSize = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
    const row = await this.client.skillCaptureRecord.create({
      data: {
        content_hash: input.content_hash,
        skill_id: input.skill_id,
        run_id: input.run_id,
        round_index: input.round_index,
        payload_json: payloadJson,
        byte_size: byteSize,
        uploaded_by: input.uploaded_by,
      },
    });
    return toCaptureRecord(row as PrismaCaptureRow);
  }

  async listCapturesForSkill(skill_id: string): Promise<SkillCaptureRecord[]> {
    const rows = await this.client.skillCaptureRecord.findMany({
      where: { skill_id },
      orderBy: [{ run_id: "asc" }, { round_index: "asc" }],
    });
    return rows.map((row) => toCaptureRecord(row as PrismaCaptureRow));
  }

  async findCaptureByHash(content_hash: string): Promise<SkillCaptureRecord | null> {
    const row = await this.client.skillCaptureRecord.findUnique({ where: { content_hash } });
    return row ? toCaptureRecord(row as PrismaCaptureRow) : null;
  }
}

type PrismaCaptureRow = {
  content_hash: string;
  skill_id: string;
  run_id: string;
  round_index: number;
  payload_json: unknown;
  byte_size: number;
  uploaded_at: Date;
  uploaded_by: string;
};

function toCaptureRecord(row: PrismaCaptureRow): SkillCaptureRecord {
  return {
    content_hash: row.content_hash,
    skill_id: row.skill_id,
    run_id: row.run_id,
    round_index: row.round_index,
    payload: row.payload_json,
    byte_size: row.byte_size,
    uploaded_at: row.uploaded_at,
    uploaded_by: row.uploaded_by,
  };
}

// ── Row → domain conversion ─────────────────────────────────────────

type PrismaSkillRow = {
  skill_id: string;
  service: string;
  version: string;
  payload_json: unknown;
  signature: string;
  signed_at: Date;
  signed_by: string;
  status: string;
  replays_succeeded: number;
  replays_failed: number;
  consecutive_failures: number;
  created_at: Date;
  last_replayed_at: Date | null;
  superseded_at: Date | null;
  deleted_at: Date | null;
};

function toSkillStoreRecord(row: PrismaSkillRow): SkillStoreRecord {
  // The payload was validated at insert time; we re-parse on read to
  // catch schema drift between writer and reader (E2). If the row was
  // written under an older synthesizer and the current SkillSchema
  // rejects it, we surface the error rather than serving stale data.
  const payload: Skill = parseSkill(row.payload_json as unknown);
  return {
    skill_id: row.skill_id,
    service: row.service,
    version: row.version,
    payload,
    signature: row.signature,
    signed_at: row.signed_at,
    signed_by: row.signed_by,
    status: row.status,
    replays_succeeded: row.replays_succeeded,
    replays_failed: row.replays_failed,
    consecutive_failures: row.consecutive_failures,
    created_at: row.created_at,
    last_replayed_at: row.last_replayed_at,
    superseded_at: row.superseded_at,
    deleted_at: row.deleted_at,
  };
}

type PrismaReplayRow = {
  id: string;
  skill_id: string;
  outcome: string;
  reason: string;
  account_id: string;
  step_index: number | null;
  replayed_at: Date;
};

function toReplayRecord(row: PrismaReplayRow): SkillReplayRecord {
  return {
    id: row.id,
    skill_id: row.skill_id,
    outcome: row.outcome,
    reason: row.reason,
    account_id: row.account_id,
    step_index: row.step_index,
    replayed_at: row.replayed_at,
  };
}
