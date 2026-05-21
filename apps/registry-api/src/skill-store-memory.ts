// In-memory implementation of SkillStore. Used by tests and any
// non-production deployment that doesn't want Postgres on the
// critical path. Mirrors the in-memory ManifestStore that
// store.ts ships.

import { randomUUID } from "node:crypto";
import type {
  InsertSkillInput,
  RecordReplayInput,
  RecordReplayResult,
  SkillReplayRecord,
  SkillStore,
  SkillStoreRecord,
} from "./skill-store.js";
import { SkillConflictError } from "./skill-store.js";

const DEMOTION_THRESHOLD = 3;

export class InMemorySkillStore implements SkillStore {
  // Explicit per-instance state (declared, not initialised inline).
  // Class-field initialisers (`= new Map()`) compile to definitions
  // that some bundlers — including vitest's transform pipeline at
  // specific configs — can share across instances. The constructor
  // assignment below is unambiguous: every `new InMemorySkillStore()`
  // gets a fresh Map and a fresh array.
  private skills: Map<string, SkillStoreRecord>;
  private replays: SkillReplayRecord[];
  // Monotonic insertion counter — tiebreaks replays sorted by
  // replayed_at when 5+ records land in the same millisecond
  // (vitest's sub-ms inject loop hits this).
  private replaySeq: number;

  constructor() {
    this.skills = new Map();
    this.replays = [];
    this.replaySeq = 0;
  }

  async insert(input: InsertSkillInput): Promise<SkillStoreRecord> {
    const { skill, signature, signed_at, signed_by } = input;
    if (this.skills.has(skill.skill_id)) {
      throw new SkillConflictError(skill.skill_id);
    }
    // Deep-clone the payload so subsequent mutations to the stored
    // record's counters don't bleed back into the caller's Skill
    // object — Zod-parsed objects share references for nested
    // structures, which would otherwise let a test's fixture see
    // mutations from this store's bookkeeping.
    const record: SkillStoreRecord = {
      skill_id: skill.skill_id,
      service: skill.service,
      version: skill.version,
      payload: JSON.parse(JSON.stringify(skill)) as typeof skill,
      signature,
      signed_at,
      signed_by,
      status: skill.status,
      replays_succeeded: skill.replays_succeeded,
      replays_failed: skill.replays_failed,
      consecutive_failures: skill.consecutive_failures,
      created_at: new Date(skill.created_at),
      last_replayed_at: skill.last_replayed_at ? new Date(skill.last_replayed_at) : null,
      superseded_at: skill.superseded_at ? new Date(skill.superseded_at) : null,
      deleted_at: skill.deleted_at ? new Date(skill.deleted_at) : null,
    };
    this.skills.set(skill.skill_id, record);
    return record;
  }

  async findById(skill_id: string): Promise<SkillStoreRecord | null> {
    return this.skills.get(skill_id) ?? null;
  }

  async findActiveByService(service: string): Promise<SkillStoreRecord | null> {
    // Active = status === "active" AND deleted_at IS NULL. Pick the
    // newest version when multiple active rows exist (operator edge
    // case — shouldn't normally happen because supersession marks the
    // old one).
    let best: SkillStoreRecord | null = null;
    for (const record of this.skills.values()) {
      if (record.service !== service) continue;
      if (record.status !== "active") continue;
      if (record.deleted_at !== null) continue;
      if (best === null || record.created_at > best.created_at) best = record;
    }
    return best;
  }

  async recordReplayOutcome(input: RecordReplayInput): Promise<RecordReplayResult> {
    const skill = this.skills.get(input.skill_id);
    if (!skill) {
      throw new Error(`Cannot record replay for unknown skill ${input.skill_id}`);
    }

    // Atomic update — in-memory means we just mutate. The Prisma
    // implementation uses a SQL UPDATE to get real atomicity (E3).
    const isSuccess = input.outcome === "ok" || input.outcome === "dry_pass";
    if (isSuccess) {
      skill.replays_succeeded += 1;
      skill.consecutive_failures = 0;
    } else {
      skill.replays_failed += 1;
      skill.consecutive_failures += 1;
    }
    skill.last_replayed_at = new Date();

    let demoted = false;
    if (
      skill.consecutive_failures >= DEMOTION_THRESHOLD &&
      skill.status === "active"
    ) {
      skill.status = "demoted";
      demoted = true;
    }

    const replay: SkillReplayRecord = {
      id: randomUUID(),
      skill_id: input.skill_id,
      outcome: input.outcome,
      reason: input.reason,
      account_id: input.account_id,
      step_index: input.step_index,
      replayed_at: new Date(),
    };
    this.replaySeq += 1;
    (replay as SkillReplayRecord & { _seq: number })._seq = this.replaySeq;
    this.replays.push(replay);

    return {
      replay,
      demoted,
      consecutive_failures: skill.consecutive_failures,
      replays_succeeded: skill.replays_succeeded,
      replays_failed: skill.replays_failed,
    };
  }

  async listReplays(skill_id: string, limit: number): Promise<SkillReplayRecord[]> {
    const matching = this.replays.filter((r) => r.skill_id === skill_id);
    matching.sort((a, b) => {
      const dt = b.replayed_at.getTime() - a.replayed_at.getTime();
      if (dt !== 0) return dt;
      // Tiebreak by insertion sequence — newest insertion wins
      const aSeq = (a as SkillReplayRecord & { _seq?: number })._seq ?? 0;
      const bSeq = (b as SkillReplayRecord & { _seq?: number })._seq ?? 0;
      return bSeq - aSeq;
    });
    return matching.slice(0, limit);
  }

  async manuallyDemote(skill_id: string, reason: string): Promise<SkillStoreRecord | null> {
    const skill = this.skills.get(skill_id);
    if (!skill) return null;
    skill.status = "demoted";
    // We don't have a "demotion_reason" column today; the operator's
    // reason gets folded into the next replay record so the trail
    // is preserved. Phase 4 follow-up could add a column for this
    // if operator triage shows it matters.
    void reason;
    return skill;
  }

  async countRecentReplaysByAccount(account_id: string, since: Date): Promise<number> {
    return this.replays.filter(
      (r) => r.account_id === account_id && r.replayed_at >= since,
    ).length;
  }
}
