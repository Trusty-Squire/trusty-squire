// Jev — TypeSafe's System One decision model (api.typesafe.ai), called through
// the vaulted `typesafe` credential. The raw key NEVER crosses to the agent:
// the request goes out via `api.useCredential` and the vault substitutes
// ${SECRET} server-side, exactly like every other proxied credential call.
//
// Measured request shapes (scout drive1-3, report ts-jev-navigation-latency):
//   - Choice questions are {"type":"choice","instructions",criteria} where
//     criteria maps option-key -> description. An `options` ARRAY 422s.
//   - Noul (yes/no validation) questions are {"type":"noul","instructions"}.
//   - Answers arrive as answers.<name>.choice / .confidence / .probabilities
//     (choice) and answers.<name>.noul (noul).
// Upstream 503 `model_unavailable` / 529 `system_overloaded` are transient
// (measured 503 storms inside the launch window). They are retried with
// bounded backoff under a stated budget; when the budget is exhausted the
// caller gets an honest error naming what was retried — never a fallback
// guess, because the whole value of the primitive is that its confidence
// numbers are the model's, not ours.

import type { ApiClient } from "../api-client.js";

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
  // {"detail":{"error_type":..., "message":...}}).
  return status === 503 || status === 529;
}

/**
 * Ask Jev one batch of named questions against `state` (the page context
 * string). Retries 503/529 with exponential backoff inside
 * JEV_RETRY_BUDGET_MS; any other non-200 is an immediate honest failure.
 */
export async function askJev(
  api: ApiClient,
  state: string,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<JevCallOutcome> {
  const body = JSON.stringify({ state, model: JEV_MODEL, questions });
  const started = Date.now();
  const deadline = started + JEV_RETRY_BUDGET_MS;
  const statuses: number[] = [];

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
    const res = await api.useCredential({
      service: JEV_SERVICE,
      http: {
        method: "POST",
        url: JEV_ENDPOINT,
        headers: {
          authorization: "Bearer ${SECRET}",
          "content-type": "application/json",
        },
        body,
      },
    });
    const { status } = res.response;
    if (status === 200) {
      return {
        result: parseJevResult(res.response.body),
        attempts: attempt,
        elapsedMs: Date.now() - started,
      };
    }
    if (!isTransientJevStatus(status)) {
      throw new JevRequestError(
        `jev_request_failed: TypeSafe System One returned HTTP ${status}: ${bodySnippet(res.response.body)}`,
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
          ` Do not guess: retry operate_decide shortly, or decide from the observation yourself.`,
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
          ` Do not guess: retry operate_decide shortly, or decide from the observation yourself.`,
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
