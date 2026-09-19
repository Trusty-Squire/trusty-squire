// Jev — TypeSafe's System One decision model (api.typesafe.ai).
//
// Default transport is the platform route (`api.decide` → POST /v1/decide):
// the API holds the TypeSafe key. A user who has stored their own `typesafe`
// vault credential keeps the existing `useCredential` path (BYOK). Detection
// is one `listCredentials` call per ApiClient, cached for JEV_BYOK_CACHE_TTL_MS
// — an ApiClient outlives a session (one per server process, one per broker
// client), so the cache has to expire or a credential vaulted mid-run is never
// seen. The same listing captcha-solve.ts uses for a vaulted 2captcha key.
// Retry and error classes are unchanged. See docs/DESIGN-jev-platform-route.md.

import { ApiCallError, type ApiClient } from "../api-client.js";

export const JEV_SERVICE = "typesafe";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

// Retry policy: fixed budget, exponential backoff. Stated here (not a config
// knob) so callers can reason about worst-case latency: 4 waits of
// 400/800/1600/3200ms ≈ 6s of backoff inside a 15s wall-clock budget, 5
// attempts total.
export const JEV_RETRY_MAX_ATTEMPTS = 5;
export const JEV_RETRY_BUDGET_MS = 15_000;
export const JEV_RETRY_BACKOFF_BASE_MS = 400;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option key -> description. NEVER an `options` array (the API 422s on it). */
  criteria: Record<string, string>;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model?: string;
  usage?: JevUsage;
}

export interface JevCallOutcome {
  result: JevResult;
  attempts: number;
  elapsedMs: number;
}

export class JevUnavailableError extends Error {
  constructor(
    message: string,
    readonly statuses: number[],
    readonly attempts: number,
    readonly elapsedMs: number,
  ) {
    super(message);
    this.name = "JevUnavailableError";
  }
}

export class JevRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JevRequestError";
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new Error("operator_request_cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("operator_request_cancelled"));
      },
      { once: true },
    );
  });
}

function bodySnippet(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

export function isTransientJevStatus(status: number): boolean {
  // 503 model_unavailable, 529 system_overloaded (measured bodies:
  // {"detail":{"error_type":..., "message":...}}). Platform 503
  // jev_unconfigured takes the same path — an outage as far as the caller
  // is concerned.
  return status === 503 || status === 529;
}

export const JEV_BYOK_CACHE_TTL_MS = 60_000;

const typesafeByokCache = new WeakMap<ApiClient, { has: boolean; expiresAt: number }>();

async function accountHasTypesafeCredential(api: ApiClient): Promise<boolean> {
  const cached = typesafeByokCache.get(api);
  if (cached !== undefined && Date.now() < cached.expiresAt) return cached.has;
  try {
    const { credentials } = await api.listCredentials();
    const has = credentials.some((c) => (c.service ?? "").toLowerCase() === JEV_SERVICE);
    typesafeByokCache.set(api, { has, expiresAt: Date.now() + JEV_BYOK_CACHE_TTL_MS });
    return has;
  } catch {
    return false;
  }
}

async function callJev(
  api: ApiClient,
  byok: boolean,
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<{ status: number; body: string }> {
  if (byok) {
    try {
      const res = await api.useCredential({
        service: JEV_SERVICE,
        http: {
          method: "POST",
          url: JEV_ENDPOINT,
          headers: {
            authorization: "Bearer ${SECRET}",
            "content-type": "application/json",
          },
          body: JSON.stringify({ state, model: JEV_MODEL, questions }),
        },
      });
      return { status: res.response.status, body: res.response.body };
    } catch (err) {
      // The credential was deleted since detection. That is "no BYOK", not a
      // failed decision — drop the stale cache and serve this same call
      // through the platform route.
      if (!(err instanceof ApiCallError) || err.status !== 404) throw err;
      typesafeByokCache.delete(api);
    }
  }
  // The platform route's /v1/decide schema pins `state` to a string, while
  // operate_drive sends structured state (the measured BYOK wire shape). A
  // non-string state is serialized exactly once here so the drive loop works
  // through both transports; string states pass through unchanged.
  return api.decide(typeof state === "string" ? state : JSON.stringify(state), questions);
}

/**
 * Ask Jev one batch of named questions against string or structured page
 * context. Transport encoding is owned by callJev above. Retries 503/529
 * with exponential backoff inside JEV_RETRY_BUDGET_MS; any other non-200 is an immediate honest failure.
 */
export async function askJev(
  api: ApiClient,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<JevCallOutcome> {
  const byok = await accountHasTypesafeCredential(api);
  const started = Date.now();
  const deadline = started + JEV_RETRY_BUDGET_MS;
  const statuses: number[] = [];

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
    const { status, body } = await callJev(api, byok, state, questions);
    if (status === 200) {
      return {
        result: parseJevResult(body),
        attempts: attempt,
        elapsedMs: Date.now() - started,
      };
    }
    if (status === 504) {
      throw new JevUnavailableError(
        `jev_unavailable: TypeSafe System One (Jev) returned HTTP 504` +
          ` on 1 attempt over ${Date.now() - started}ms` +
          ` (jev_timeout). NO decision was made.` +
          ` Do not guess: retry shortly, or decide from the observation yourself.`,
        [504],
        attempt,
        Date.now() - started,
      );
    }
    if (!isTransientJevStatus(status)) {
      throw new JevRequestError(
        `jev_request_failed: TypeSafe System One returned HTTP ${status}: ${bodySnippet(body)}`,
        status,
      );
    }
    statuses.push(status);
    const exhausted =
      attempt >= JEV_RETRY_MAX_ATTEMPTS
        ? `retry attempt limit (${JEV_RETRY_MAX_ATTEMPTS}) reached`
        : Date.now() >= deadline
          ? "retry budget exhausted"
          : undefined;
    if (exhausted !== undefined) {
      throw new JevUnavailableError(
        `jev_unavailable: TypeSafe System One (Jev) returned HTTP ${statuses.join("/")}` +
          ` on ${statuses.length} attempt${statuses.length === 1 ? "" : "s"} over ${Date.now() - started}ms` +
          ` (${exhausted}, budget ${JEV_RETRY_BUDGET_MS}ms). NO decision was made.` +
          ` Do not guess: retry shortly, or decide from the observation yourself.`,
        statuses,
        attempt,
        Date.now() - started,
      );
    }
    const backoff = JEV_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const wait = Math.min(backoff, deadline - Date.now());
    if (wait <= 0) {
      // The deadline check above guards the common case; this catches a
      // backoff slice that would still overshoot the budget.
      throw new JevUnavailableError(
        `jev_unavailable: TypeSafe System One (Jev) returned HTTP ${statuses.join("/")}` +
          ` on ${statuses.length} attempt${statuses.length === 1 ? "" : "s"} over ${Date.now() - started}ms` +
          ` (retry budget exhausted, budget ${JEV_RETRY_BUDGET_MS}ms). NO decision was made.` +
          ` Do not guess: retry shortly, or decide from the observation yourself.`,
        statuses,
        attempt,
        Date.now() - started,
      );
    }
    await sleep(wait, signal);
  }
}

function parseJevResult(body: string): JevResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `jev_invalid_response: TypeSafe System One returned non-JSON body: ${bodySnippet(body)}`,
    );
  }
  const answers = (parsed as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) {
    throw new Error(
      `jev_invalid_response: TypeSafe System One response has no answers object: ${bodySnippet(body)}`,
    );
  }
  const record = answers as Record<string, unknown>;
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(
        `jev_invalid_response: answer ${JSON.stringify(name)} is not an object: ${bodySnippet(body)}`,
      );
    }
  }
  return {
    answers: record as Record<string, JevAnswer>,
    ...((parsed as { model?: string }).model !== undefined
      ? { model: (parsed as { model: string }).model }
      : {}),
    ...((parsed as { usage?: JevUsage }).usage !== undefined
      ? { usage: (parsed as { usage: JevUsage }).usage }
      : {}),
  };
}
