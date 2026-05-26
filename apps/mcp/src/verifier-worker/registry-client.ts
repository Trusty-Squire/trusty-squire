// HTTP client to registry-api's admin endpoints. The verifier worker
// uses these to pull the queue and report outcomes; the discovery
// worker (Phase 6) will use a different set on the same client shape.

import { parseSkill, type Skill } from "@trusty-squire/adapter-sdk";

export interface VerifierQueueItem {
  skill_id: string;
  service: string;
  version: string;
  status: string;
  verifier_succeeded: number;
  verifier_failed: number;
  consecutive_verifier_failures: number;
  last_verified_at: string | null;
  next_freshness_due_at: string | null;
}

export interface VerifierOutcomeResponse {
  transition: "promoted" | "retired" | "demoted" | "none";
  status: string;
  verifier_succeeded: number;
  verifier_failed: number;
  consecutive_verifier_failures: number;
  next_freshness_due_at: string | null;
}

export interface VerifierRegistryClientOpts {
  baseUrl: string;
  adminBearer: string;
  fetchFn?: typeof globalThis.fetch;
}

export class VerifierRegistryClient {
  private readonly baseUrl: string;
  private readonly adminBearer: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: VerifierRegistryClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.adminBearer = opts.adminBearer;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async fetchQueue(limit = 20): Promise<VerifierQueueItem[]> {
    const url = `${this.baseUrl}/admin/verifier/queue?limit=${limit}`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (!res.ok) {
      throw new Error(
        `fetchQueue: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { ok: boolean; items?: VerifierQueueItem[] };
    if (body.ok !== true || !Array.isArray(body.items)) {
      throw new Error("fetchQueue: malformed response (expected { ok, items })");
    }
    return body.items;
  }

  async fetchSkill(skill_id: string): Promise<Skill> {
    const url = `${this.baseUrl}/skills/by-id/${encodeURIComponent(skill_id)}`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (!res.ok) {
      throw new Error(
        `fetchSkill ${skill_id}: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { ok: boolean; skill?: unknown };
    if (body.ok !== true || body.skill === undefined) {
      throw new Error(`fetchSkill ${skill_id}: malformed response`);
    }
    // parseSkill is the same trust gate the router uses — if the
    // stored row drifted from the current schema, surface it now
    // rather than crashing deeper in replaySkill.
    return parseSkill(body.skill);
  }

  // Closed-loop Phase 6: discovery candidates.
  async fetchDiscoveryCandidates(opts: {
    limit?: number;
    sinceDays?: number;
    minDistinct?: number;
  }): Promise<
    Array<{
      service: string;
      distinct_failures: number;
      top_error_kind: string;
      most_recent_at: string;
    }>
  > {
    const url = new URL("/admin/discovery-candidates", this.baseUrl);
    if (opts.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
    if (opts.sinceDays !== undefined) url.searchParams.set("since_days", String(opts.sinceDays));
    if (opts.minDistinct !== undefined)
      url.searchParams.set("min_distinct", String(opts.minDistinct));
    const res = await this.fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (!res.ok) {
      throw new Error(
        `fetchDiscoveryCandidates: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      ok: boolean;
      items?: Array<{
        service: string;
        distinct_failures: number;
        top_error_kind: string;
        most_recent_at: string;
      }>;
    };
    if (body.ok !== true || !Array.isArray(body.items)) {
      throw new Error("fetchDiscoveryCandidates: malformed response");
    }
    return body.items;
  }

  async postOutcome(input: {
    skill_id: string;
    kind: "success" | "failure";
    reason: string;
    duration_ms?: number;
  }): Promise<VerifierOutcomeResponse> {
    const url = `${this.baseUrl}/admin/skills/${encodeURIComponent(input.skill_id)}/verifier-outcome`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: input.kind,
        reason: input.reason,
        ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `postOutcome ${input.skill_id}: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`,
      );
    }
    return (await res.json()) as VerifierOutcomeResponse;
  }
}
