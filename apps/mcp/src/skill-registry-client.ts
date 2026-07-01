// skill-registry-client.ts — HTTP client for the Tier-2 skill
// registry. Sits between the operator-driver tools and the registry
// endpoints. Three responsibilities:
//
//   1. Fetch the active skill for a service (`GET /skills/:service`),
//      validate the signed payload via the SkillSchema, and return a
//      parsed `Skill` or null. Failures fail-open — registry
//      unreachable or returning bad data must never block a signup,
//      it just means the router falls through to the universal bot.
//
//   2. Post replay outcomes back (`POST /skills/:skill_id/replay-
//      outcome`) so the registry can age skills, demote bad ones,
//      and surface counters on subsequent fetches. Fire-and-forget:
//      the router doesn't await success.
//
//   3. Carry the `provision_id` correlation ID through both calls so
//      a debug session can trace a single signup attempt all the way
//      from MCP tool entry to registry write (D8).
//
// **Sensitive to test environments.** Production sets the registry
// URL via env; tests inject a base URL pointing at a Fastify inject
// adapter. The exported client class accepts both.
//
// LRU cache lives here so the MCP process amortises registry calls
// across multiple signups (C6, ~5min TTL). Cache-bust on a failed
// replay so the next attempt re-fetches in case a remediation was
// just published.

import {
  canonicalizeServiceSlug,
  parseSkill,
  type Skill,
} from "@trusty-squire/skill-schema";
import type { ProvisionServiceState } from "./provision-gate.js";

// ── Public API ───────────────────────────────────────────────────────

export interface SkillRegistryClientOpts {
  /** Base URL for the registry. e.g. https://registry.trustysquire.com */
  baseUrl: string;
  /**
   * Request timeout in ms. Default 3s — short enough that a
   * registry outage doesn't add measurable latency to a signup. We
   * fail open well before this bites in practice.
   */
  timeoutMs?: number;
  /**
   * Account ID for replay-outcome attribution + rate-limit
   * accounting. In production this is the MCP user's account; tests
   * usually inject a fixed value.
   */
  accountId: string;
  /**
   * Cache TTL in ms. Default 5 minutes. Cache entries past their TTL
   * are dropped on the next get(). Set to 0 to disable caching
   * (tests use this for predictable behaviour).
   */
  cacheTtlMs?: number;
  /**
   * Override the global `fetch`. Tests inject a function that
   * dispatches through Fastify's inject() helper without going
   * through the network.
   */
  fetchFn?: typeof globalThis.fetch;
}

export interface FetchSkillResult {
  /** Parsed skill, ready for the replay engine. */
  skill: Skill;
  /** Signed_by from the response — for audit log. */
  signed_by: string;
  /** Server's view of the counters at fetch time. */
  counters: {
    replays_succeeded: number;
    replays_failed: number;
    consecutive_failures: number;
  };
}

export type SkillFetchOutcome =
  | { kind: "found"; result: FetchSkillResult }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string };

// Adapt a registry client into the `lookupSkillUrl` the universal bot's
// resolveSignupUrl injects: a service's promoted-skill `signup_url`, or null
// when there's no active skill / the registry is unavailable. signup_url is a
// required, replay-verified field ("the URL must produce a recognizable
// page"), so it's the verified-by-construction cache — the bot reads it before
// asking the LLM, and a service that's succeeded once reuses its known-good
// URL instead of re-resolving it.
export function makeSkillUrlLookup(
  client: Pick<SkillRegistryClient, "fetchActiveSkill">,
  provisionId: string,
): (service: string) => Promise<string | null> {
  return async (service) => {
    const outcome = await client.fetchActiveSkill(service, provisionId);
    return outcome.kind === "found" ? outcome.result.skill.signup_url : null;
  };
}

export interface PostReplayOutcomeInput {
  skill_id: string;
  outcome:
    | "ok"
    | "step_failed"
    | "validator_failed"
    | "extraction_failed"
    | "needs_login"
    | "skill_demoted"
    | "dry_pass";
  reason: string;
  step_index?: number;
  /** Carry the correlation ID through to the registry (D8). */
  provision_id: string;
}

export interface PostReplayOutcomeResult {
  kind: "ok" | "rate_limited" | "skill_not_found" | "unavailable";
  reason?: string;
  demoted?: boolean;
}

// T44 — compatibility-score response from /v1/services/:slug/health.
// Shape mirrors the registry route exactly so a malformed cast
// here turns into a JSON parse error, not a silently-wrong feature.
export interface ServiceHealthAlternate {
  service: string;
  state: "skill-active" | "working" | "struggling" | "hard-block";
  compat_score: number;
  has_active_skill: boolean;
}

export interface ServiceHealthResponse {
  service: string;
  state: "skill-active" | "working" | "struggling" | "hard-block";
  compat_score: number;
  has_active_skill: boolean;
  successful_count: number;
  failed_count: number;
  last_attempt_at: string | null;
  alternates: ServiceHealthAlternate[];
}

export type ServiceHealthOutcome =
  | { kind: "ok"; health: ServiceHealthResponse }
  | { kind: "unavailable"; reason: string };

// ── Client ───────────────────────────────────────────────────────────

interface CacheEntry {
  result: FetchSkillResult;
  expiresAt: number;
}

// Parse a /skills/* response body into a SkillFetchOutcome. Shared by the
// by-service and by-host fetchers. Defensive: a version mismatch or bad deploy
// fails open (unavailable) rather than throwing.
async function parseSkillBody(response: Response): Promise<SkillFetchOutcome> {
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) {
    return { kind: "unavailable", reason: `registry returned HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("skill" in body) ||
    !("signed_by" in body)
  ) {
    return { kind: "unavailable", reason: "response missing skill or signed_by fields" };
  }
  const envelope = body as {
    ok?: boolean;
    skill: unknown;
    signed_by: string;
    counters?: {
      replays_succeeded?: number;
      replays_failed?: number;
      consecutive_failures?: number;
    };
  };
  let skill: Skill;
  try {
    skill = parseSkill(envelope.skill);
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `skill failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    kind: "found",
    result: {
      skill,
      signed_by: envelope.signed_by,
      counters: {
        replays_succeeded: envelope.counters?.replays_succeeded ?? 0,
        replays_failed: envelope.counters?.replays_failed ?? 0,
        consecutive_failures: envelope.counters?.consecutive_failures ?? 0,
      },
    },
  };
}

export class SkillRegistryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly accountId: string;
  private readonly cacheTtlMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cache: Map<string, CacheEntry>;

  constructor(opts: SkillRegistryClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.accountId = opts.accountId;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.cache = new Map();
  }

  /**
   * Look up the active skill for a service. Returns:
   *
   *   - `{kind:"found",result}`   — registry returned a valid signed skill
   *   - `{kind:"not_found"}`      — no active skill for this service
   *   - `{kind:"unavailable",..}` — network error, timeout, malformed
   *                                  response, schema-invalid payload,
   *                                  or any other reason the client
   *                                  couldn't produce a parseable skill
   *
   * Callers MUST treat `unavailable` as "fall through to the universal
   * bot." This client never throws on transport-level failures.
   */
  async fetchActiveSkill(
    service: string,
    provisionId: string,
  ): Promise<SkillFetchOutcome> {
    const serviceSlug = canonicalizeServiceSlug(service);
    // Cache check first. A registry-unavailable outcome is NOT cached
    // — we want the next call to try again.
    const cached = this.readCache(serviceSlug);
    if (cached !== null) {
      return { kind: "found", result: cached };
    }

    const url = `${this.baseUrl}/skills/${encodeURIComponent(serviceSlug)}`;
    const attempt = await this.fetchGetWithRetry(url, {
      "x-account-id": this.accountId,
      "x-provision-id": provisionId,
    });
    if (attempt.kind === "err") {
      return { kind: "unavailable", reason: attempt.reason };
    }
    const outcome = await parseSkillBody(attempt.response);
    if (outcome.kind === "found") this.writeCache(serviceSlug, outcome.result);
    return outcome;
  }

  /**
   * Resolve a skill by its signup_url HOST rather than its slug — so an
   * end-user provisioning https://x.ai reaches the "xai-grok" skill whose slug
   * doesn't derive from the URL. Returns the best available skill (active >
   * pending-review) for HINT purposes. Not cached by slug (the host→skill
   * mapping is the registry's to own).
   */
  async fetchSkillByHost(host: string, provisionId: string): Promise<SkillFetchOutcome> {
    const url = `${this.baseUrl}/skills/by-host?host=${encodeURIComponent(host)}`;
    const attempt = await this.fetchGetWithRetry(url, {
      "x-account-id": this.accountId,
      "x-provision-id": provisionId,
    });
    if (attempt.kind === "err") {
      return { kind: "unavailable", reason: attempt.reason };
    }
    return await parseSkillBody(attempt.response);
  }

  /**
   * Post a replay outcome back to the registry. Fire-and-forget at
   * the caller level — failures here don't affect the signup result,
   * they just mean the registry's view of this skill's health doesn't
   * get the latest data point.
   */
  async postReplayOutcome(input: PostReplayOutcomeInput): Promise<PostReplayOutcomeResult> {
    const url = `${this.baseUrl}/skills/${encodeURIComponent(input.skill_id)}/replay-outcome`;
    const attempt = await this.fetchPostWithRetry(
      url,
      {
        "content-type": "application/json",
        "x-account-id": this.accountId,
        "x-provision-id": input.provision_id,
      },
      JSON.stringify({
        outcome: input.outcome,
        reason: input.reason,
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
      }),
    );
    if (attempt.kind === "err") {
      return { kind: "unavailable", reason: attempt.reason };
    }
    const response = attempt.response;

    if (response.status === 429) {
      return { kind: "rate_limited" };
    }
    if (response.status === 404) {
      return { kind: "skill_not_found" };
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        reason: `registry returned HTTP ${response.status}`,
      };
    }

    // On success we may also learn the skill was just auto-demoted.
    // Surface that so the router can cache-bust and log appropriately.
    try {
      const body = (await response.json()) as { demoted?: boolean };
      return { kind: "ok", demoted: body.demoted === true };
    } catch {
      return { kind: "ok" };
    }
  }

  // Publish a synthesized skill as pending-review. The registry gates
  // activation on the verifier replay, not on this upload (it accepts any
  // signature), so this is a best-effort fire: a failure never disrupts the
  // provision that produced the skill.
  async publishSkill(
    skill: Skill,
    signature: string,
  ): Promise<
    | { kind: "ok"; skill_id: string; status: string }
    | { kind: "unavailable"; reason: string }
  > {
    const attempt = await this.fetchPostWithRetry(
      `${this.baseUrl}/skills`,
      { "content-type": "application/json", "x-account-id": this.accountId },
      JSON.stringify({ skill, signature }),
    );
    if (attempt.kind === "err") return { kind: "unavailable", reason: attempt.reason };
    const response = attempt.response;
    if (!response.ok) {
      return { kind: "unavailable", reason: `registry returned HTTP ${response.status}` };
    }
    try {
      const body = (await response.json()) as { skill_id?: string; status?: string };
      return { kind: "ok", skill_id: body.skill_id ?? "", status: body.status ?? "pending-review" };
    } catch {
      return { kind: "ok", skill_id: "", status: "pending-review" };
    }
  }

  /**
   * Drop a cached skill entry so the next fetch re-queries the
   * registry. Used after a replay failure to make sure a freshly-
   * published correction (skill v2, say) is picked up immediately.
   */
  invalidateCache(service: string): void {
    this.cache.delete(canonicalizeServiceSlug(service));
  }

  /**
   * T44 — fetch compatibility-score health for a service, optionally
   * with category-peer alternates. Fire-and-forget: failures here
   * mean "no recommendation this run," not "abort the provision."
   */
  async fetchServiceHealth(
    service: string,
    peers: readonly string[] = [],
  ): Promise<ServiceHealthOutcome> {
    const serviceSlug = canonicalizeServiceSlug(service);
    const peersQuery =
      peers.length > 0 ? `?peers=${peers.map(encodeURIComponent).join(",")}` : "";
    const url =
      `${this.baseUrl}/v1/services/${encodeURIComponent(serviceSlug)}/health${peersQuery}`;
    const attempt = await this.fetchGetWithRetry(url, {
      "x-account-id": this.accountId,
    });
    if (attempt.kind === "err") {
      return { kind: "unavailable", reason: attempt.reason };
    }
    if (!attempt.response.ok) {
      return {
        kind: "unavailable",
        reason: `registry returned HTTP ${attempt.response.status}`,
      };
    }
    try {
      const body = (await attempt.response.json()) as ServiceHealthResponse;
      return { kind: "ok", health: body };
    } catch (e) {
      return {
        kind: "unavailable",
        reason: `malformed health response: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Refuse-walled pre-flight: fetch the registry's materialized
   * ServiceState (the `state` half of the dossier) for the refuse gate.
   * FAIL-OPEN — any transport/parse trouble returns null, which the gate
   * treats as "allow" (a registry gap must never block a real provision).
   * Public-readish endpoint (no admin bearer), same surface as /health.
   */
  async fetchServiceState(service: string): Promise<ProvisionServiceState | null> {
    const serviceSlug = canonicalizeServiceSlug(service);
    const url = `${this.baseUrl}/v1/services/${encodeURIComponent(serviceSlug)}/dossier`;
    const attempt = await this.fetchGetWithRetry(url, {
      "x-account-id": this.accountId,
    });
    if (attempt.kind === "err" || !attempt.response.ok) return null;
    try {
      const body = (await attempt.response.json()) as {
        state?: ProvisionServiceState | null;
      };
      return body.state ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Record one provision event (any dispatch path). Fire-and-forget;
   * a 4xx/5xx here only means the dashboard/score won't reflect it.
   * Posts to the historical /attempts route (URL unchanged so already-
   * installed clients keep working); the server upserts on provision_id.
   */
  async recordProvisionEvent(input: {
    service: string;
    status: "success" | "failed";
    // Dispatch model (Decision 10). Omitted by older clients; the sink
    // blind-defaults the strategy legs to bot.
    initialStrategy?: "replay" | "bot";
    finalStrategy?: "replay" | "bot";
    replayOutcome?: "ok" | "miss" | "na";
    finalOutcome?: "ok" | "failed" | "blocked";
    failureKind?: string;
    signupUrl?: string;
    // Memory-overhaul Phase 1 — housekeeper context ("discover"|"verify"|
    // "replay") + captcha summary (partial fold). Optional.
    mode?: "discover" | "verify" | "replay";
    captchaKind?: string;
    captchaVariant?: string;
    captchaBlocked?: boolean;
    mcpVersion: string;
    // T45 — correlation id linking this event to the
    // ExtractFailureSnapshot rows uploaded during the same run. Also the
    // idempotency key (the server upserts on it).
    provisionId?: string;
    // T45 — serialized step trail (newline-joined ctx.stepsSink) for
    // failures that bail before the post-verify loop and therefore
    // upload no per-round snapshots. Truncated server-side past 32KB.
    stepTrail?: string;
    // Cost telemetry (Decision 3). Replay rows send 0; the bot path
    // leaves these unset (USD cost is tracked server-side, not here).
    llmCost?: number;
    captchaCost?: number;
    durationMs?: number;
  }): Promise<{ kind: "ok" } | { kind: "unavailable"; reason: string }> {
    const url = `${this.baseUrl}/v1/services/${encodeURIComponent(input.service)}/attempts`;
    const attempt = await this.fetchPostWithRetry(
      url,
      {
        "content-type": "application/json",
        "x-account-id": this.accountId,
      },
      JSON.stringify({
        status: input.status,
        ...(input.initialStrategy !== undefined ? { initial_strategy: input.initialStrategy } : {}),
        ...(input.finalStrategy !== undefined ? { final_strategy: input.finalStrategy } : {}),
        ...(input.replayOutcome !== undefined ? { replay_outcome: input.replayOutcome } : {}),
        ...(input.finalOutcome !== undefined ? { final_outcome: input.finalOutcome } : {}),
        // The registry's /attempts schema caps failure_kind at 120 chars
        // and REJECTS (zod 400) anything longer — and the bot's verbose
        // error strings (e.g. the full verification_not_sent message) blow
        // past that, which silently dropped almost every ProvisionEvent
        // (a non-2xx returns {kind:"unavailable"}, no throw, no row). Cap
        // it client-side so failed-run events actually land.
        ...(input.failureKind !== undefined
          ? { failure_kind: input.failureKind.slice(0, 120) }
          : {}),
        ...(input.signupUrl !== undefined ? { signup_url: input.signupUrl } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.captchaKind !== undefined ? { captcha_kind: input.captchaKind.slice(0, 40) } : {}),
        ...(input.captchaVariant !== undefined ? { captcha_variant: input.captchaVariant.slice(0, 40) } : {}),
        ...(input.captchaBlocked !== undefined ? { captcha_blocked: input.captchaBlocked } : {}),
        ...(input.provisionId !== undefined ? { provision_id: input.provisionId } : {}),
        ...(input.stepTrail !== undefined ? { step_trail: input.stepTrail } : {}),
        ...(input.llmCost !== undefined ? { llm_cost: input.llmCost } : {}),
        ...(input.captchaCost !== undefined ? { captcha_cost: input.captchaCost } : {}),
        ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
        mcp_version: input.mcpVersion,
      }),
    );
    if (attempt.kind === "err") {
      return { kind: "unavailable", reason: attempt.reason };
    }
    if (!attempt.response.ok) {
      return {
        kind: "unavailable",
        reason: `registry returned HTTP ${attempt.response.status}`,
      };
    }
    return { kind: "ok" };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private readCache(service: string): FetchSkillResult | null {
    if (this.cacheTtlMs === 0) return null;
    const entry = this.cache.get(service);
    if (entry === undefined) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(service);
      return null;
    }
    return entry.result;
  }

  private writeCache(service: string, result: FetchSkillResult): void {
    if (this.cacheTtlMs === 0) return;
    this.cache.set(service, {
      result,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`registry call timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // GET retry: idempotent, so retry on any transient class — network
  // error, timeout, or 5xx — with jittered exponential backoff. 3
  // attempts total (0ms, ~250ms, ~1000ms) keeps total worst-case under
  // ~2.3s with the default 3s timeout. The caller still treats final
  // failure as "fall through to the universal bot."
  private async fetchGetWithRetry(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ kind: "ok"; response: Response } | { kind: "err"; reason: string }> {
    const delays = [0, 250, 1000];
    let lastReason = "";
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      if (delay > 0) {
        const jitter = Math.floor(Math.random() * 100);
        await new Promise<void>((r) => setTimeout(r, delay + jitter));
      }
      let response: Response;
      try {
        response = await this.withTimeout(
          this.fetchFn(url, { method: "GET", headers }),
        );
      } catch (err) {
        lastReason = `network error: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
      if (response.status >= 500 && response.status < 600) {
        lastReason = `registry returned HTTP ${response.status}`;
        continue;
      }
      // Any non-5xx response (200, 404, 401, etc.) is deterministic —
      // hand back to the caller, retry buys nothing.
      return { kind: "ok", response };
    }
    return { kind: "err", reason: lastReason };
  }

  // POST retry: NOT fully idempotent (replay-outcome increments a
  // counter that drives auto-demotion at 3 consecutive failures). To
  // avoid double-counting, retry ONLY on outright fetch-throws — the
  // request couldn't leave the client, so it didn't reach the server.
  // Skip retry on timeouts and 5xx (the request may have been processed
  // server-side; a retry would double-record the outcome). Two attempts
  // total with a small backoff.
  private async fetchPostWithRetry(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ kind: "ok"; response: Response } | { kind: "err"; reason: string }> {
    const delays = [0, 250];
    let lastReason = "";
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      if (delay > 0) {
        const jitter = Math.floor(Math.random() * 100);
        await new Promise<void>((r) => setTimeout(r, delay + jitter));
      }
      let response: Response;
      try {
        response = await this.withTimeout(
          this.fetchFn(url, { method: "POST", headers, body }),
        );
        return { kind: "ok", response };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastReason = msg;
        // A timeout means the request MAY have reached the server;
        // a retry could double-count. Bail rather than risk it.
        if (msg.includes("timed out")) break;
      }
    }
    return { kind: "err", reason: lastReason };
  }
}

// ── Factory + provision_id helper ───────────────────────────────────

/**
 * Build a SkillRegistryClient from env. Returns null when no registry
 * URL is configured — callers must treat this as "skip the router
 * tier entirely."
 */
export function clientFromEnv(accountId: string): SkillRegistryClient | null {
  const baseUrl = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
  if (baseUrl === undefined || baseUrl.trim().length === 0) return null;
  return new SkillRegistryClient({ baseUrl, accountId });
}

/**
 * Generate a fresh correlation ID for a single provision
 * invocation. Encoded so log entries are easy to grep — short prefix
 * + monotonic timestamp + random tail.
 */
export function generateProvisionId(): string {
  const ts = Date.now().toString(36);
  const tail = Math.random().toString(36).slice(2, 8);
  return `prov_${ts}_${tail}`;
}
