// ProvisionEvent store. One row per provision request across ALL
// dispatch paths (replay-served, replay-fell-back, no-skill-bot).
// Renamed + widened from ProvisionAttempt (bot-only) — see
// docs/DESIGN-provision-event-dashboard.md.
//
// Together with SkillRecord this is the source of truth for
// /v1/services/:slug/health AND the new operator dashboard's cache-hit
// + demand views. The preserved `status` field keeps the compat-score
// derivation (compat-score.ts) untouched.
//
// In-memory implementation lives here; the Prisma-backed variant lives
// in prisma-provision-event-store.ts. Tests use in-memory; production
// wires the Prisma store via server.ts.

import { randomUUID } from "node:crypto";

// Dispatch model (Decision 10). Strategy = which path; outcome = result.
export type ProvisionStrategy = "replay" | "bot";
export type ReplayOutcomeTag = "ok" | "miss" | "na";
export type FinalOutcomeTag = "ok" | "failed" | "blocked";

export interface ProvisionEventInput {
  service: string;
  status: "success" | "failed";
  // Dispatch subfields. Optional: old MCP clients post none and the
  // sink blind-defaults them to bot (Decision 12).
  initial_strategy?: ProvisionStrategy;
  final_strategy?: ProvisionStrategy;
  replay_outcome?: ReplayOutcomeTag;
  final_outcome?: FinalOutcomeTag;
  failure_kind?: string | null;
  signup_url?: string | null;
  account_id: string;
  mcp_version: string;
  // Correlation id linking this event to ExtractFailureSnapshot rows
  // from the same provision call. Also the idempotency key: a repeated
  // post with the same provision_id upserts (Decision 11).
  provision_id?: string | null;
  // Serialized step trail for failures that bail before any
  // ExtractFailureSnapshot rows get uploaded. Capped on insert.
  step_trail?: string | null;
  // Cost telemetry (Decision 3). Replay rows carry 0 (known-zero);
  // null = not measured.
  llm_cost?: number | null;
  captcha_cost?: number | null;
  duration_ms?: number | null;
}

// Inline step-trail cap. A typical full trail is a few hundred bytes;
// a maximally chatty trail caps out around 8KB. 32KB is comfortably
// above the worst case without burdening Postgres rows.
export const STEP_TRAIL_MAX_BYTES = 32 * 1024;

export interface ProvisionEventRecord {
  id: string;
  service: string;
  status: "success" | "failed";
  initial_strategy: ProvisionStrategy | null;
  final_strategy: ProvisionStrategy | null;
  replay_outcome: ReplayOutcomeTag | null;
  final_outcome: FinalOutcomeTag | null;
  failure_kind: string | null;
  signup_url: string | null;
  artifacts_uri: string | null;
  provision_id: string | null;
  step_trail: string | null;
  llm_cost: number | null;
  captcha_cost: number | null;
  duration_ms: number | null;
  account_id: string;
  mcp_version: string;
  occurred_at: Date;
}

export interface ProvisionEventStore {
  /** Insert one event; returns the assigned id. Idempotent on a
   *  non-null provision_id — a repeat upserts rather than double-counts. */
  record(input: ProvisionEventInput): Promise<{ id: string }>;
  /** Recent events for ONE service, newest first. `sinceMs` capped to a
   *  reasonable window — score derivation walks rows in O(N) and weights
   *  by age, so feeding a year of data is wasteful (>30 days is noise
   *  with a 14-day half-life). Callers should pass ~60d worst-case. */
  listByService(service: string, sinceMs: number): Promise<ProvisionEventRecord[]>;
  /** Admin dashboard view: recent FAILED events across all services,
   *  newest first. Capped to `limit` (default 50). */
  listRecentFailures(limit?: number): Promise<ProvisionEventRecord[]>;
}

function capTrail(trailRaw: string | null): string | null {
  if (trailRaw === null) return null;
  return Buffer.byteLength(trailRaw, "utf8") > STEP_TRAIL_MAX_BYTES
    ? trailRaw.slice(0, STEP_TRAIL_MAX_BYTES) + "\n[…truncated]"
    : trailRaw;
}

export class InMemoryProvisionEventStore implements ProvisionEventStore {
  private readonly rows: ProvisionEventRecord[] = [];

  async record(input: ProvisionEventInput): Promise<{ id: string }> {
    const provision_id = input.provision_id ?? null;
    const row: ProvisionEventRecord = {
      id: randomUUID(),
      service: input.service,
      status: input.status,
      initial_strategy: input.initial_strategy ?? null,
      final_strategy: input.final_strategy ?? null,
      replay_outcome: input.replay_outcome ?? null,
      final_outcome: input.final_outcome ?? null,
      failure_kind: input.failure_kind ?? null,
      signup_url: input.signup_url ?? null,
      artifacts_uri: null,
      provision_id,
      step_trail: capTrail(input.step_trail ?? null),
      llm_cost: input.llm_cost ?? null,
      captcha_cost: input.captcha_cost ?? null,
      duration_ms: input.duration_ms ?? null,
      account_id: input.account_id,
      mcp_version: input.mcp_version,
      occurred_at: new Date(),
    };
    // Idempotency: upsert on a non-null provision_id (Decision 11).
    // NULL provision_ids never dedupe — they're distinct events.
    if (provision_id !== null) {
      const existing = this.rows.findIndex((r) => r.provision_id === provision_id);
      if (existing !== -1) {
        // Preserve the original id + occurred_at; overwrite the payload.
        const prior = this.rows[existing]!;
        this.rows[existing] = { ...row, id: prior.id, occurred_at: prior.occurred_at };
        return { id: prior.id };
      }
    }
    this.rows.push(row);
    return { id: row.id };
  }

  async listByService(service: string, sinceMs: number): Promise<ProvisionEventRecord[]> {
    const cutoff = Date.now() - sinceMs;
    return this.rows
      .filter((r) => r.service === service && r.occurred_at.getTime() >= cutoff)
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  }

  async listRecentFailures(limit = 50): Promise<ProvisionEventRecord[]> {
    return this.rows
      .filter((r) => r.status === "failed")
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
      .slice(0, Math.min(limit, 200));
  }
}
