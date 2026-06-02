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
import { isWallFailure } from "@trusty-squire/skill-schema";

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

// Wall classification (terminal captcha/anti-bot — the demand damper
// down-weights services dominated by these) now comes from the shared
// failure taxonomy in @trusty-squire/skill-schema, so this damper, the
// demotion classifier, and the mcp signup telemetry can't drift apart.
// Re-exported for existing registry call sites. Unknown kinds are still
// NOT walls (skill-schema defaults them to transient).
export { isWallFailure };

// Cache-hit 3-way breakdown over a window (design Decision 10 partition).
export interface CacheHitBreakdown {
  replay_served: number; // final_strategy=replay (implies outcome ok)
  fell_back: number; // initial=replay, final=bot
  no_skill_bot: number; // final=bot, initial=bot (incl. legacy rows)
  total: number;
}

// Per-service demand + wall signal for the harvest loop + dashboard.
export interface DemandRow {
  service: string;
  volume: number; // total provisions in the window
  failed: number; // of which failed
  wall_failed: number; // of the failures, how many were wall kinds
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
  /** Cache-hit 3-way breakdown over the window (dashboard Panel 2). */
  cacheHitBreakdown(sinceMs: number): Promise<CacheHitBreakdown>;
  /** Top services by total provision volume in the window, desc.
   *  Caller applies active-skill exclusion + wall damper. */
  demandByService(sinceMs: number, limit: number): Promise<DemandRow[]>;
  /** Panel 1 funnel: distinct accounts with ANY event in the trailing
   *  window (activated / WAU / MAU depending on the window passed). */
  activeAccounts(sinceMs: number): Promise<number>;
  /** Panel 1 funnel: distinct accounts with a SUCCESS in the trailing
   *  window. NOT first-ever success (that needs all-time history) —
   *  "succeeded ≥1 in window". */
  succeededAccounts(sinceMs: number): Promise<number>;
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

  async cacheHitBreakdown(sinceMs: number): Promise<CacheHitBreakdown> {
    const cutoff = Date.now() - sinceMs;
    let replay_served = 0;
    let fell_back = 0;
    let no_skill_bot = 0;
    let total = 0;
    for (const r of this.rows) {
      if (r.occurred_at.getTime() < cutoff) continue;
      total++;
      if (r.final_strategy === "replay") replay_served++;
      else if (r.initial_strategy === "replay") fell_back++;
      else no_skill_bot++; // final=bot & initial=bot (or legacy nulls)
    }
    return { replay_served, fell_back, no_skill_bot, total };
  }

  async demandByService(sinceMs: number, limit: number): Promise<DemandRow[]> {
    const cutoff = Date.now() - sinceMs;
    const buckets = new Map<string, { volume: number; failed: number; wall_failed: number }>();
    for (const r of this.rows) {
      if (r.occurred_at.getTime() < cutoff) continue;
      const b = buckets.get(r.service) ?? { volume: 0, failed: 0, wall_failed: 0 };
      b.volume++;
      if (r.status === "failed") {
        b.failed++;
        if (r.failure_kind !== null && isWallFailure(r.failure_kind)) b.wall_failed++;
      }
      buckets.set(r.service, b);
    }
    return [...buckets.entries()]
      .map(([service, b]) => ({ service, ...b }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, Math.max(1, limit));
  }

  async activeAccounts(sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    const seen = new Set<string>();
    for (const r of this.rows) {
      if (r.occurred_at.getTime() >= cutoff) seen.add(r.account_id);
    }
    return seen.size;
  }

  async succeededAccounts(sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    const seen = new Set<string>();
    for (const r of this.rows) {
      if (r.occurred_at.getTime() >= cutoff && r.status === "success") seen.add(r.account_id);
    }
    return seen.size;
  }
}
