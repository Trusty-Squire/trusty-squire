// T44 — ProvisionAttempt store. One row per universal-bot signup
// outcome (success OR failure). Together with SkillRecord, this is
// the source of truth for /v1/services/:slug/health.
//
// In-memory implementation lives here; the Prisma-backed variant
// lives in prisma-provision-attempt-store.ts. Tests use in-memory;
// production wires the Prisma store via server.ts.

import { randomUUID } from "node:crypto";

export interface ProvisionAttemptInput {
  service: string;
  status: "success" | "failed";
  failure_kind?: string | null;
  signup_url?: string | null;
  account_id: string;
  mcp_version: string;
  // T45 — correlation id the MCP sends along with each
  // ExtractFailureSnapshot upload from the same provision call, so
  // the admin dashboard can JOIN them for a per-attempt view.
  provision_id?: string | null;
  // T45 — serialized step trail for failures that bail before any
  // ExtractFailureSnapshot rows get uploaded. Capped on insert.
  step_trail?: string | null;
}

// Inline step-trail cap. A typical full trail is a few hundred bytes;
// a maximally chatty trail caps out around 8KB. 32KB is comfortably
// above the worst case without burdening Postgres rows.
export const STEP_TRAIL_MAX_BYTES = 32 * 1024;

export interface ProvisionAttemptRecord {
  id: string;
  service: string;
  status: "success" | "failed";
  failure_kind: string | null;
  signup_url: string | null;
  artifacts_uri: string | null;
  provision_id: string | null;
  step_trail: string | null;
  account_id: string;
  mcp_version: string;
  occurred_at: Date;
}

export interface ProvisionAttemptStore {
  /** Insert one attempt; returns the assigned id. */
  record(input: ProvisionAttemptInput): Promise<{ id: string }>;
  /** Recent attempts for ONE service, newest first. `sinceMs` capped to a
   *  reasonable window — score derivation walks rows in O(N) and weights
   *  by age, so feeding a year of data is wasteful (>30 days is noise
   *  with a 14-day half-life). Callers should pass ~60d worst-case. */
  listByService(service: string, sinceMs: number): Promise<ProvisionAttemptRecord[]>;
  /** T45 — admin dashboard view: recent FAILED attempts across all
   *  services, newest first. Capped to `limit` (default 50). */
  listRecentFailures(limit?: number): Promise<ProvisionAttemptRecord[]>;
}

export class InMemoryProvisionAttemptStore implements ProvisionAttemptStore {
  private readonly rows: ProvisionAttemptRecord[] = [];

  async record(input: ProvisionAttemptInput): Promise<{ id: string }> {
    const id = randomUUID();
    const trailRaw = input.step_trail ?? null;
    const step_trail =
      trailRaw === null
        ? null
        : Buffer.byteLength(trailRaw, "utf8") > STEP_TRAIL_MAX_BYTES
          ? trailRaw.slice(0, STEP_TRAIL_MAX_BYTES) + "\n[…truncated]"
          : trailRaw;
    this.rows.push({
      id,
      service: input.service,
      status: input.status,
      failure_kind: input.failure_kind ?? null,
      signup_url: input.signup_url ?? null,
      artifacts_uri: null,
      provision_id: input.provision_id ?? null,
      step_trail,
      account_id: input.account_id,
      mcp_version: input.mcp_version,
      occurred_at: new Date(),
    });
    return { id };
  }

  async listByService(service: string, sinceMs: number): Promise<ProvisionAttemptRecord[]> {
    const cutoff = Date.now() - sinceMs;
    return this.rows
      .filter((r) => r.service === service && r.occurred_at.getTime() >= cutoff)
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  }

  async listRecentFailures(limit = 50): Promise<ProvisionAttemptRecord[]> {
    return this.rows
      .filter((r) => r.status === "failed")
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
      .slice(0, Math.min(limit, 200));
  }
}
