// In-memory implementation of SkillStore. Used by tests and any
// non-production deployment that doesn't want Postgres on the
// critical path. Mirrors the in-memory ManifestStore that
// store.ts ships.

import { randomUUID } from "node:crypto";
import type {
  InsertCaptureInput,
  InsertSkillInput,
  RecordReplayInput,
  RecordReplayResult,
  SkillCaptureRecord,
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

    // T26 — Human-review gate (C11). If the same service already has
    // an active skill and the new submission changes signup_url OR
    // oauth_provider (the two phishing-vector fields), force status
    // to pending-review. Other field edits (steps, credentials,
    // validators) go straight to active. Approval is via a separate
    // operator action (POST /skills/:skill_id/approve-review).
    let effectiveStatus = skill.status;
    if (skill.status === "active") {
      const existingActive = await this.findActiveByService(skill.service);
      if (existingActive !== null && triggersHumanReview(existingActive.payload, skill)) {
        effectiveStatus = "pending-review";
      }
    }

    // Deep-clone the payload so subsequent mutations to the stored
    // record's counters don't bleed back into the caller's Skill
    // object — Zod-parsed objects share references for nested
    // structures, which would otherwise let a test's fixture see
    // mutations from this store's bookkeeping.
    const payload = JSON.parse(JSON.stringify(skill)) as typeof skill;
    payload.status = effectiveStatus;
    const record: SkillStoreRecord = {
      skill_id: skill.skill_id,
      service: skill.service,
      version: skill.version,
      payload,
      signature,
      signed_at,
      signed_by,
      status: effectiveStatus,
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

  async approveReview(skill_id: string): Promise<SkillStoreRecord | null> {
    const record = this.skills.get(skill_id);
    if (record === undefined) return null;
    if (record.status !== "pending-review") {
      // Idempotent — already approved or in another state, no change.
      return record;
    }
    // Promote to active AND supersede any older active row for the
    // same service (mirrors the natural supersession path).
    const now = new Date();
    for (const other of this.skills.values()) {
      if (
        other.skill_id !== skill_id &&
        other.service === record.service &&
        other.status === "active"
      ) {
        other.status = "superseded";
        other.superseded_at = now;
        other.payload.status = "superseded";
        other.payload.superseded_at = now.toISOString();
      }
    }
    record.status = "active";
    record.payload.status = "active";
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

  // ── T19: capture sidecars ────────────────────────────────────────

  private captures: Map<string, SkillCaptureRecord> = new Map();

  async insertCapture(input: InsertCaptureInput): Promise<SkillCaptureRecord> {
    const existing = this.captures.get(input.content_hash);
    if (existing !== undefined) {
      // Idempotent — same content already uploaded. Return as-is.
      return existing;
    }
    const payload = JSON.parse(JSON.stringify(input.payload)) as unknown;
    const byteSize = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const record: SkillCaptureRecord = {
      content_hash: input.content_hash,
      skill_id: input.skill_id,
      run_id: input.run_id,
      round_index: input.round_index,
      payload,
      byte_size: byteSize,
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
    };
    this.captures.set(input.content_hash, record);
    return record;
  }

  async listCapturesForSkill(skill_id: string): Promise<SkillCaptureRecord[]> {
    const matching: SkillCaptureRecord[] = [];
    for (const record of this.captures.values()) {
      if (record.skill_id === skill_id) matching.push(record);
    }
    matching.sort((a, b) => {
      const runCmp = a.run_id.localeCompare(b.run_id);
      if (runCmp !== 0) return runCmp;
      return a.round_index - b.round_index;
    });
    return matching;
  }

  async findCaptureByHash(content_hash: string): Promise<SkillCaptureRecord | null> {
    return this.captures.get(content_hash) ?? null;
  }
}

// ── T26 helper ───────────────────────────────────────────────────────

/**
 * Returns true when a proposed skill update should hit the
 * pending-review gate instead of going active immediately. Triggers
 * on the two phishing-vector fields: signup_url and oauth_provider.
 * Everything else (steps, credential validators, etc.) goes straight
 * to active.
 *
 * Exported for unit testing.
 */
export function triggersHumanReview(
  existing: { signup_url: string; oauth_provider: "google" | "github" | null },
  incoming: { signup_url: string; oauth_provider: "google" | "github" | null },
): boolean {
  if (existing.signup_url !== incoming.signup_url) return true;
  if (existing.oauth_provider !== incoming.oauth_provider) return true;
  return false;
}
