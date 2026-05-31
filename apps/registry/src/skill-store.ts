// Storage layer for Tier-2 Learned Skills (0.7.0). Mirrors store.ts
// (the manifest equivalent) but for the SkillRecord + SkillReplayRecord
// tables. Two implementations live alongside this interface:
//
//   - InMemorySkillStore   (apps/registry/src/skill-store-memory.ts)
//   - PrismaSkillStore     (apps/registry/src/prisma-skill-store.ts)
//
// Tests use the in-memory store; production wires up Prisma.

import type { Skill } from "@trusty-squire/skill-schema";

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
  // Two-tier registry counters (closed-loop strategy). Tracked
  // separately from replays_* so verifier sweeps don't contaminate
  // user-facing replay-success metrics. Backfilled to 2/null/2 for
  // legacy skills (see prisma migration 20260526163000).
  verifier_succeeded: number;
  verifier_failed: number;
  consecutive_verifier_failures: number;
  last_verified_at: Date | null;
  next_freshness_due_at: Date | null;
  freshness_budget_cents: number;
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
   * List skills with optional filters. Powers the `skill list` CLI
   * subcommand and operator-console pagination (Phase 7).
   *
   * Filters:
   *   - service: exact-match service slug
   *   - status:  exact-match status string (active, demoted, etc.)
   *
   * Pass empty filter object to list every skill in the registry.
   * Results are ordered by created_at descending (newest first).
   * Limit defaults to 100; max 500.
   */
  listSkills(filter: ListSkillsFilter): Promise<SkillStoreRecord[]>;

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
   * Approve a pending-review skill (T26). Flips status from
   * pending-review to active and supersedes any older active row
   * for the same service. Returns null when the skill_id doesn't
   * exist; idempotent (returns the record unchanged) when the
   * skill is already in another state. Backs
   * POST /skills/:skill_id/approve-review (C11).
   */
  approveReview(skill_id: string): Promise<SkillStoreRecord | null>;

  /**
   * Reactivate a demoted skill (Phase 7). Flips status from `demoted`
   * back to `active` and resets `consecutive_failures` to 0. Returns
   * the updated record, or `null` when no such skill_id exists.
   * Idempotent: a no-op when the skill is already active (returns
   * record unchanged with `previously === status`). When reactivating
   * would create a second active row for the same service, the
   * existing active row is superseded so the (service, status=active)
   * uniqueness invariant holds.
   */
  reactivate(skill_id: string): Promise<{
    record: SkillStoreRecord;
    previously: string;
  } | null>;

  /**
   * Hard-delete a skill (Phase 7). Removes the skill row AND every
   * linked capture sidecar; replay rows are removed by FK cascade in
   * the DB. Returns true when a row was deleted, false when nothing
   * matched. Backs DELETE /skills/:skill_id; the CLI requires
   * --confirm because this is irreversible.
   */
  deleteSkill(skill_id: string): Promise<boolean>;

  /**
   * Pull the verifier worker's queue. Returns skills the worker should
   * re-test next, in priority order:
   *   1. pending-review skills awaiting promotion (the staging gate)
   *   2. active skills whose next_freshness_due_at has passed
   *      (the freshness sweep)
   *
   * Excludes deleted/superseded rows. Limit defaults to 20 to keep
   * each worker pass bounded and avoid one app monopolizing the
   * queue when multiple verifier replicas run.
   */
  listVerifierQueue(opts: {
    limit?: number;
    now?: Date;
  }): Promise<SkillStoreRecord[]>;

  /**
   * Record a verifier outcome. Atomically updates verifier_*
   * counters; auto-promotes pending-review → active when
   * verifier_succeeded reaches the promotion threshold (1 today);
   * auto-retires pending-review when consecutive_verifier_failures
   * reaches 3 (the skill never validates); auto-demotes active →
   * demoted when consecutive_verifier_failures reaches 3 (the skill
   * regressed under freshness sweep).
   *
   * Returns the post-update record + a `transition` describing what
   * happened ('promoted' | 'retired' | 'demoted' | 'none'), so the
   * route layer can fire the existing demotion webhook + step trail
   * with consistent semantics.
   */
  recordVerifierOutcome(input: RecordVerifierOutcomeInput): Promise<RecordVerifierOutcomeResult>;

  /**
   * Count replay-outcome writes for an account in a recent window.
   * Backs the 60/min rate limit on POST /skills/:id/replay-outcome
   * (C9). Returns the count; the route layer decides whether to 429.
   */
  countRecentReplaysByAccount(account_id: string, since: Date): Promise<number>;

  /**
   * Persist a capture sidecar (T19, D1). The content_hash is the
   * idempotency key — uploading the same content twice is a no-op
   * (returns the existing row). Backs
   * POST /skills/:skill_id/captures.
   */
  insertCapture(input: InsertCaptureInput): Promise<SkillCaptureRecord>;

  /**
   * List captures for a skill, ordered by (run_id, round_index)
   * ascending so replay-trace can walk them in chain order.
   */
  listCapturesForSkill(skill_id: string): Promise<SkillCaptureRecord[]>;

  /**
   * Fetch a single capture by its content hash. Returns null when
   * the capture isn't in the registry.
   */
  findCaptureByHash(content_hash: string): Promise<SkillCaptureRecord | null>;
}

export interface ListSkillsFilter {
  service?: string;
  status?: string;
  limit?: number;
}

// Inputs to recordVerifierOutcome.
export interface RecordVerifierOutcomeInput {
  skill_id: string;
  kind: "success" | "failure";
  // Free-text from the worker. Capped at 2000 chars by the route.
  reason: string;
  // Optional duration metric for cost tracking.
  duration_ms?: number;
  // Optional now() override for deterministic tests.
  now?: Date;
}

export interface RecordVerifierOutcomeResult {
  record: SkillStoreRecord;
  // Describes the side effect (if any) the outcome caused.
  transition:
    | "promoted"      // pending-review reached 1 success → active
    | "retired"       // pending-review reached 3 consecutive failures → deleted
    | "demoted"       // active reached 3 consecutive verifier failures → demoted
    | "none";         // counters bumped, no status change
}

// Promotion threshold — see DESIGN-skill-promoter.md and the
// closed-loop strategy. ONE verifier success flips pending-review
// → active. The verifier IS the trust signal: a single full
// browser replay that ended in a validator-passing credential is
// strong evidence the skill works against the live service.
// Waiting for N=2 added latency without adding meaningful safety
// (a flaky service still flakes on the second pass too) and meant
// the closed loop stalled with skills sitting at succ=1 forever
// when the queue cycle didn't naturally bring them back.
//
// Demotion still requires 3 consecutive failures — symmetric
// boldness on entry vs symmetric caution on exit.
export const VERIFIER_PROMOTION_THRESHOLD = 1;

// Three consecutive failures retire (pending-review) or demote
// (active). Matches the existing replay-based demotion threshold.
export const VERIFIER_FAILURE_THRESHOLD = 3;

export interface InsertCaptureInput {
  content_hash: string;
  skill_id: string;
  run_id: string;
  round_index: number;
  payload: unknown;
  uploaded_by: string;
}

export interface SkillCaptureRecord {
  content_hash: string;
  skill_id: string;
  run_id: string;
  round_index: number;
  payload: unknown;
  byte_size: number;
  uploaded_at: Date;
  uploaded_by: string;
}
