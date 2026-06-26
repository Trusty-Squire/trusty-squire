// Thin HTTP client to the registry's admin endpoints — only what the verify
// loop needs: pull the queue, resolve a skill's signup_url, report an outcome.
// No bot deps, no LLM, no Prisma. The registry owns the promote/demote rule;
// this client just reports the boolean outcome and surfaces the transition.

export interface VerifyQueueItem {
  skill_id: string;
  service: string;
  status: string;
  consecutive_verifier_failures: number;
}

export interface VerifierOutcomeResponse {
  transition: "promoted" | "superseded" | "retired" | "demoted" | "quarantined" | "none";
  status: string;
  consecutive_verifier_failures: number;
}

export interface PostOutcomeInput {
  skill_id: string;
  kind: "success" | "failure";
  reason: string;
  failure_kind?: string;
  duration_ms?: number;
}

export interface RegistryClientOpts {
  baseUrl: string;
  adminBearer: string;
  fetchFn?: typeof globalThis.fetch;
}

export class HousekeeperRegistryClient {
  private readonly baseUrl: string;
  private readonly adminBearer: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: RegistryClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.adminBearer = opts.adminBearer;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.adminBearer}` };
  }

  // The verifier queue: pending-review (promotion candidates) + freshness-due
  // active skills (demotion candidates), ordered by the registry.
  async fetchQueue(limit: number): Promise<VerifyQueueItem[]> {
    const url = `${this.baseUrl}/admin/verifier/queue?limit=${limit}`;
    const res = await this.fetchFn(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`fetchQueue: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { ok?: boolean; items?: VerifyQueueItem[] };
    if (body.ok !== true || !Array.isArray(body.items)) {
      throw new Error("fetchQueue: malformed response (expected { ok, items })");
    }
    return body.items;
  }

  // Resolve where codex should point the signup. We read signup_url straight off
  // the stored payload (no strict parseSkill) so a schema-drifted-but-routable
  // skill still gets verified instead of erroring out of the loop.
  async fetchSkillSignupUrl(skill_id: string): Promise<string | null> {
    const url = `${this.baseUrl}/skills/by-id/${encodeURIComponent(skill_id)}`;
    const res = await this.fetchFn(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`fetchSkill ${skill_id}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { ok?: boolean; skill?: { signup_url?: unknown } };
    const signup = body.skill?.signup_url;
    return typeof signup === "string" && signup.length > 0 ? signup : null;
  }

  // Report the verify outcome. We deliberately send ONLY {kind, reason,
  // failure_kind?, duration_ms?} — NOT the old sampler fields (verdict/samples/
  // pass_rate_*). With those omitted the registry uses its count-based rule:
  // a success promotes, the 3rd consecutive real failure demotes. That count
  // rule IS the mechanical rule this design wants.
  async postOutcome(input: PostOutcomeInput): Promise<VerifierOutcomeResponse> {
    const url = `${this.baseUrl}/admin/skills/${encodeURIComponent(input.skill_id)}/verifier-outcome`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
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
}
