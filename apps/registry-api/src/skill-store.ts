// Storage layer for Tier-2 Learned Skills (0.7.0). Mirrors store.ts
// (the manifest equivalent) but for the SkillRecord + SkillReplayRecord
// tables. Two implementations live alongside this interface:
//
//   - InMemorySkillStore   (apps/registry-api/src/skill-store-memory.ts)
//   - PrismaSkillStore     (apps/registry-api/src/prisma-skill-store.ts)
//
// Tests use the in-memory store; production wires up Prisma.

import type { Skill } from "@trusty-squire/adapter-sdk";

// What the store hands back. The payload IS the full Skill (parsed),
// not the raw JSON — callers always want it parsed and signature
// verification happens in the route layer, not here.
export interface SkillStoreRecord {
  skill_id: string;
  service: string;
  version: string;
  payload: Skill;
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
}

// One replay outcome row. The route layer composes these into the
// response for GET /skills/:service/replays.
export interface SkillReplayRecord {
  id: string;
  skill_id: string;
  outcome: string;
  reason: string;
  account_id: string;
  step_index: number | null;
  replayed_at: Date;
}

// Inputs to writes. Separate from SkillStoreRecord so callers can't
// accidentally fabricate counters or timestamps the store should own.
export interface InsertSkillInput {
  skill: Skill;
  signature: string;
  signed_at: Date;
  signed_by: string;
}

export interface RecordReplayInput {
  skill_id: string;
  outcome: string;
  reason: string;
  account_id: string;
  step_index: number | null;
}

// The result of recordReplayOutcome — surfaces whether the demotion
// threshold was reached so the route layer can react (e.g. log a
// webhook in Phase 4 follow-up, T20).
export interface RecordReplayResult {
  replay: SkillReplayRecord;
  // True when this outcome caused the skill to be auto-demoted
  // (consecutive_failures crossed ≥3 with this update).
  demoted: boolean;
  // The new counter values after the atomic update.
  consecutive_failures: number;
  replays_succeeded: number;
  replays_failed: number;
}

// Thrown when an insert collides on skill_id. Mirrors ManifestConflictError
// in the existing store layer.
export class SkillConflictError extends Error {
  constructor(public readonly skill_id: string) {
    super(`Skill ${skill_id} already exists`);
    this.name = "SkillConflictError";
  }
}

export interface SkillStore {
  /**
   * Insert a new skill. Throws SkillConflictError if a row with the
   * same skill_id already exists. Use the (service, version) pair to
   * supersede an existing active skill — that's a separate flow that
   * marks the old row `superseded` and inserts the new one.
   */
  insert(input: InsertSkillInput): Promise<SkillStoreRecord>;

  /**
   * Find a skill by its ULID. Returns null when not found.
   */
  findById(skill_id: string): Promise<SkillStoreRecord | null>;

  /**
   * Find the currently-active skill for a service. Returns null when
   * no active skill exists (caller falls through to the manifest
   * lookup or the universal bot).
   */
  findActiveByService(service: string): Promise<SkillStoreRecord | null>;

  /**
   * Record a replay outcome and atomically update the counters on
   * the parent skill (E3). When this outcome pushes consecutive
   * failures to ≥3, the skill is auto-demoted to status=demoted in
   * the same transaction.
   *
   * Idempotency: there is no `outcome_id` parameter — every call
   * creates a new replay row. The router shouldn't retry these.
   */
  recordReplayOutcome(input: RecordReplayInput): Promise<RecordReplayResult>;

  /**
   * Recent replay outcomes for a skill, newest first. Powers
   * GET /skills/:service/replays.
   */
  listReplays(skill_id: string, limit: number): Promise<SkillReplayRecord[]>;

  /**
   * Manually demote a skill via skill:demote CLI. Bypasses the
   * auto-demotion threshold; useful when an operator knows the
   * skill is wrong even though it hasn't failed enough yet.
   */
  manuallyDemote(skill_id: string, reason: string): Promise<SkillStoreRecord | null>;

  /**
   * Count replay-outcome writes for an account in a recent window.
   * Backs the 60/min rate limit on POST /skills/:id/replay-outcome
   * (C9). Returns the count; the route layer decides whether to 429.
   */
  countRecentReplaysByAccount(account_id: string, since: Date): Promise<number>;
}
