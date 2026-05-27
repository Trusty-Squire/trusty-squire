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
}

export interface ProvisionAttemptRecord {
  id: string;
  service: string;
  status: "success" | "failed";
  failure_kind: string | null;
  signup_url: string | null;
  artifacts_uri: string | null;
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
}

export class InMemoryProvisionAttemptStore implements ProvisionAttemptStore {
  private readonly rows: ProvisionAttemptRecord[] = [];

  async record(input: ProvisionAttemptInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.rows.push({
      id,
      service: input.service,
      status: input.status,
      failure_kind: input.failure_kind ?? null,
      signup_url: input.signup_url ?? null,
      artifacts_uri: null,
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
}
