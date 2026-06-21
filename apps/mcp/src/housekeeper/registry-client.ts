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
  transition: "promoted" | "superseded" | "retired" | "demoted" | "quarantined" | "none";
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
    // D2.C — the fresh-verify sequential-confidence sampler's converged posterior.
    // ALL OPTIONAL + ADDITIVE: the single-account replay path omits them and the
    // registry falls back to its count-based semantics. When `verdict` is
    // present the registry trusts the producer's converged verdict (promote /
    // reject) instead of re-deriving from the success count.
    verdict?: "promote" | "reject" | "hold";
    samples?: number;
    successes?: number;
    failures?: number;
    pass_rate_lcb?: number;
    pass_rate_ucb?: number;
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
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.samples !== undefined ? { samples: input.samples } : {}),
        ...(input.successes !== undefined ? { successes: input.successes } : {}),
        ...(input.failures !== undefined ? { failures: input.failures } : {}),
        ...(input.pass_rate_lcb !== undefined ? { pass_rate_lcb: input.pass_rate_lcb } : {}),
        ...(input.pass_rate_ucb !== undefined ? { pass_rate_ucb: input.pass_rate_ucb } : {}),
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
    // Output-loop (#1) fix grades from the local ledger, for the dashboard.
    fixes_graded?: number;
    fixes_improved?: number;
    fixes_regressed?: number;
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

  // ── Memory-overhaul Phase 4 — the drainable ledger (operator loop) ──────

  async listIssues(status?: IssueRow["status"]): Promise<IssueRow[]> {
    const url = new URL("/admin/issues", this.baseUrl);
    if (status !== undefined) url.searchParams.set("status", status);
    const res = await this.fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (!res.ok) throw new Error(`listIssues: ${res.status} ${res.statusText}`);
    return ((await res.json()) as { issues?: IssueRow[] }).issues ?? [];
  }

  async getIssue(id: string): Promise<IssueRow | null> {
    const url = `${this.baseUrl}/admin/issues/${encodeURIComponent(id)}`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getIssue: ${res.status} ${res.statusText}`);
    return ((await res.json()) as { issue: IssueRow }).issue;
  }

  // Returns the updated issue, or a typed gate verdict the CLI surfaces.
  private async mutateIssue(
    id: string,
    action: "claim" | "resolve" | "wall",
    body: Record<string, unknown>,
  ): Promise<IssueMutateResult> {
    const url = `${this.baseUrl}/admin/issues/${encodeURIComponent(id)}/${action}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.adminBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { kind: "ok", issue: ((await res.json()) as { issue: IssueRow }).issue };
    if (res.status === 409) {
      const j = (await res.json()) as { current?: number };
      return { kind: "version_conflict", current: j.current ?? -1 };
    }
    if (res.status === 422) {
      const j = (await res.json()) as { need?: string };
      return { kind: "missing_evidence", need: j.need ?? "?" };
    }
    if (res.status === 404) return { kind: "not_found" };
    throw new Error(`${action} ${id}: ${res.status} ${res.statusText}`);
  }

  claimIssue(id: string, actor: string, version: number): Promise<IssueMutateResult> {
    return this.mutateIssue(id, "claim", { actor, version });
  }

  resolveIssue(
    id: string,
    actor: string,
    version: number,
    resolvedRun: string,
  ): Promise<IssueMutateResult> {
    return this.mutateIssue(id, "resolve", { actor, version, resolved_run: resolvedRun });
  }

  wallIssue(
    id: string,
    actor: string,
    version: number,
    falsified: { experiment: string; result: string; evidence_ref?: string },
  ): Promise<IssueMutateResult> {
    return this.mutateIssue(id, "wall", { actor, version, falsified });
  }

  async listServiceStates(): Promise<ServiceStateRow[]> {
    const url = `${this.baseUrl}/admin/service-states`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.adminBearer}` },
    });
    if (!res.ok) throw new Error(`listServiceStates: ${res.status} ${res.statusText}`);
    return ((await res.json()) as { states?: ServiceStateRow[] }).states ?? [];
  }
}

// Wire-shapes mirrored from the registry's OpenIssue / ServiceState rows.
export interface IssueRow {
  id: string;
  service: string;
  failure_kind: string;
  status: "open" | "in_progress" | "resolved" | "wall" | "superseded";
  attempts: number;
  resolved_run: string | null;
  falsified: { experiment: string; result: string; evidence_ref?: string } | null;
  actor: string | null;
  version: number;
  updated_at: string;
}

export type IssueMutateResult =
  | { kind: "ok"; issue: IssueRow }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current: number }
  | { kind: "missing_evidence"; need: string };

export interface ServiceStateRow {
  service: string;
  status: string;
  confidence: number;
  successful_count: number;
  failed_count: number;
  last_green_at: string | null;
  last_failure_kind: string | null;
  current_diagnosis: string | null;
  wall_classification: string | null;
}
