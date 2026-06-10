// HTTP client to registry's admin endpoints. The verifier worker
// uses these to pull the queue and report outcomes; the discovery
// worker (Phase 6) will use a different set on the same client shape.

import { parseSkill, type Skill } from "@trusty-squire/skill-schema";

// Phase 3 follow-up — thrown by fetchSkill when the stored payload
// doesn't pass the current SkillSchema (registry was written under
// an older synthesizer or the schema package evolved). The loop
// catches this distinctly so a worker-side schema drift can't get
// counted as a skill failure and demote/retire perfectly fine skills.
export class SkillSchemaDriftError extends Error {
  readonly skill_id: string;
  constructor(skill_id: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`schema drift on skill ${skill_id}: ${msg}`);
    this.skill_id = skill_id;
    this.name = "SkillSchemaDriftError";
  }
}

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
  transition: "promoted" | "retired" | "demoted" | "quarantined" | "none";
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
    // stored row drifted from the current schema, surface it as a
    // typed error so the loop can skip without counting it as a
    // skill failure (otherwise schema drift auto-retires good
    // skills).
    try {
      return parseSkill(body.skill);
    } catch (err) {
      throw new SkillSchemaDriftError(skill_id, err);
    }
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
      most_recent_at: string | null;
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
        most_recent_at: string | null;
      }>;
    };
    if (body.ok !== true || !Array.isArray(body.items)) {
      throw new Error("fetchDiscoveryCandidates: malformed response");
    }
    return body.items;
  }

  // The set of services with an ACTIVE skill — already served by replay, so
  // the curated discovery sweep should skip them (every re-cover slot is a
  // net-new skill it didn't get). Public GET /skills?status=active; no bearer
  // needed. Returns lowercase slugs.
  async fetchActiveServices(): Promise<Set<string>> {
    const url = new URL("/skills", this.baseUrl);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "500");
    const res = await this.fetchFn(url.toString(), {});
    if (!res.ok) {
      throw new Error(`fetchActiveServices: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { ok?: boolean; skills?: Array<{ service?: string }> };
    const out = new Set<string>();
    for (const s of body.skills ?? []) {
      if (typeof s.service === "string" && s.service.length > 0) {
        out.add(s.service.toLowerCase());
      }
    }
    return out;
  }

  async postOutcome(input: {
    skill_id: string;
    kind: "success" | "failure";
    reason: string;
    // Structured failure kind for the demotion classifier (T4).
    failure_kind?: string;
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
        ...(input.failure_kind !== undefined ? { failure_kind: input.failure_kind } : {}),
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

  // T10 — report a heal-pass heartbeat so the admin dashboard can show the
  // self-healing timer is alive. Fire-and-forget at the call site.
  async postHealHeartbeat(input: {
    verified: number;
    demoted: number;
    quarantined: number;
    reskilled: number;
    needs_human: number;
    // OF#2 — the discovery success rate this pass saw, as raw counts.
    discover_attempted?: number;
    discover_succeeded?: number;
    mcp_version?: string;
  }): Promise<{ skills_active: number; hit_served: number; hit_total: number }> {
    const url = `${this.baseUrl}/admin/heal-heartbeat`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`postHealHeartbeat: ${res.status} ${res.statusText}`);
    }
    // The registry stamps + returns the server-owned objectives at heartbeat
    // time: OF#1 (active-skill count) and OF#3 (registry hit rate, served/total).
    const body = (await res.json()) as {
      skills_active?: number;
      hit_served?: number;
      hit_total?: number;
    };
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    return {
      skills_active: num(body.skills_active),
      hit_served: num(body.hit_served),
      hit_total: num(body.hit_total),
    };
  }
}
