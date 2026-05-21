// Prisma-backed SkillStore. Used by the production server. Tests
// use InMemorySkillStore. Mirrors prisma-store.ts (the manifest
// equivalent).

import { PrismaClient, type Prisma } from "@prisma/client";
import { parseSkill, type Skill } from "@trusty-squire/adapter-sdk";
import {
  type InsertSkillInput,
  type RecordReplayInput,
  type RecordReplayResult,
  type SkillReplayRecord,
  type SkillStore,
  type SkillStoreRecord,
  SkillConflictError,
} from "./skill-store.js";

const DEMOTION_THRESHOLD = 3;

export class PrismaSkillStore implements SkillStore {
  private constructor(private readonly client: PrismaClient) {}

  static async fromEnv(): Promise<PrismaSkillStore> {
    const client = new PrismaClient();
    await client.$connect();
    return new PrismaSkillStore(client);
  }

  static fromClient(client: PrismaClient): PrismaSkillStore {
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
    try {
      const row = await this.client.skillRecord.create({
        data: {
          skill_id: skill.skill_id,
          service: skill.service,
          version: skill.version,
          payload_json: skill as unknown as Prisma.InputJsonValue,
          signature,
          signed_at,
          signed_by,
          status: skill.status,
          replays_succeeded: skill.replays_succeeded,
          replays_failed: skill.replays_failed,
          consecutive_failures: skill.consecutive_failures,
          last_replayed_at: skill.last_replayed_at ? new Date(skill.last_replayed_at) : null,
          superseded_at: skill.superseded_at ? new Date(skill.superseded_at) : null,
          deleted_at: skill.deleted_at ? new Date(skill.deleted_at) : null,
        },
      });
      return toSkillStoreRecord(row);
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
    return row ? toSkillStoreRecord(row) : null;
  }

  async findActiveByService(service: string): Promise<SkillStoreRecord | null> {
    // Pick the most recently created active row. Uses the
    // (service, status) hot-path index.
    const row = await this.client.skillRecord.findFirst({
      where: { service, status: "active", deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    return row ? toSkillStoreRecord(row) : null;
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
        replay: toReplayRecord(replay),
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
    return rows.map(toReplayRecord);
  }

  async manuallyDemote(skill_id: string, reason: string): Promise<SkillStoreRecord | null> {
    void reason; // see InMemorySkillStore — no demotion_reason column yet
    try {
      const row = await this.client.skillRecord.update({
        where: { skill_id },
        data: { status: "demoted" },
      });
      return toSkillStoreRecord(row);
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

  async countRecentReplaysByAccount(account_id: string, since: Date): Promise<number> {
    return this.client.skillReplayRecord.count({
      where: { account_id, replayed_at: { gte: since } },
    });
  }
}

// ── Row → domain conversion ─────────────────────────────────────────

type PrismaSkillRow = {
  skill_id: string;
  service: string;
  version: string;
  payload_json: Prisma.JsonValue;
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
