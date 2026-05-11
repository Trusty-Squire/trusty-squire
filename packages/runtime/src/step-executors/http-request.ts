// HTTP request step executor.
//
// Tier-1 implementation: interpolates the templated request, performs a
// network capability check on the resolved hostname, fires the request
// (with an idempotency-key header on non-GET methods), validates the
// response, extracts values into the run context, and emits side
// effects with fully-concrete reverse-action templates.

import { ulid } from "ulid";
import type {
  AdapterCapabilities,
  HttpRequestStepDef,
  ReverseAction,
  ReverseAuth,
  SideEffectEmission,
} from "@trusty-squire/adapter-sdk";
import { computeStepIdempotencyKey } from "../run-store.js";
import {
  InterpolationError,
  buildScope,
  extractByPath,
  interpolateDeep,
  interpolateString,
} from "./interpolate.js";
import type { Run, SideEffect, StepError, StepRecord, Tier } from "../types.js";

export interface StepExecutorContext {
  index: number;
  attempt: number;
  tier: Tier;
  capabilities: AdapterCapabilities;
  fetch?: typeof fetch;
  now?: () => string;
}

export type StepResult =
  | { kind: "success"; step: StepRecord; new_side_effects: SideEffect[] }
  | { kind: "failure"; step: StepRecord; error: StepError };

export class CapabilityViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityViolationError";
  }
}

export async function executeHttpRequest(
  stepDef: HttpRequestStepDef,
  run: Run,
  ctx: StepExecutorContext,
): Promise<StepResult> {
  const fetchImpl = ctx.fetch ?? fetch;
  const nowFn = ctx.now ?? (() => new Date().toISOString());
  const startedAt = nowFn();

  const scope = buildScope(run);

  // ── Phase 1: interpolate request ─────────────────────────────
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  try {
    url = interpolateString(stepDef.request.url_template, scope);
    headers = stepDef.request.headers
      ? (interpolateDeep(stepDef.request.headers, scope) as Record<string, string>)
      : {};
    body =
      stepDef.request.body_template !== undefined
        ? interpolateDeep(stepDef.request.body_template, scope)
        : undefined;
  } catch (err) {
    return failureFromError(stepDef, ctx, startedAt, nowFn(), err, {
      capability_violation: false,
      causes_tier_escalation: false,
      retryable: false,
    });
  }

  // ── Phase 2: capability check ────────────────────────────────
  const capCheck = checkNetworkCapability(url, ctx.capabilities.network.allowed_domains);
  if (!capCheck.ok) {
    return failureFromError(
      stepDef,
      ctx,
      startedAt,
      nowFn(),
      new CapabilityViolationError(capCheck.reason),
      // Capability violation is the magic flag the state machine uses
      // to short-circuit retry/escalate and go straight to COMPENSATING.
      { capability_violation: true, causes_tier_escalation: false, retryable: false },
    );
  }

  // ── Phase 3: build request ───────────────────────────────────
  const method = stepDef.request.method;
  const sentHeaders: Record<string, string> = { ...headers };
  if (method !== "GET") {
    sentHeaders["Idempotency-Key"] = computeStepIdempotencyKey(run.id, stepDef.id, ctx.attempt);
  }
  if (body !== undefined && sentHeaders["Content-Type"] === undefined) {
    sentHeaders["Content-Type"] = "application/json";
  }

  // ── Phase 4: execute ─────────────────────────────────────────
  let response: Response;
  try {
    // exactOptionalPropertyTypes: only set body/signal when present
    // (RequestInit doesn't union them with undefined).
    const init: RequestInit = { method, headers: sentHeaders };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (stepDef.request.timeout_ms !== undefined) {
      init.signal = AbortSignal.timeout(stepDef.request.timeout_ms);
    }
    response = await fetchImpl(url, init);
  } catch (err) {
    // Network errors (DNS, TCP reset, timeouts) are retryable — the
    // server hasn't necessarily seen the request, but the idempotency
    // key on the retry makes a second send safe.
    return failureFromError(stepDef, ctx, startedAt, nowFn(), err, {
      capability_violation: false,
      causes_tier_escalation: false,
      retryable: true,
    });
  }

  // ── Phase 5: parse response ──────────────────────────────────
  const responseBody = await safeJson(response);

  // ── Phase 6: validate status ────────────────────────────────
  if (!statusMatches(response.status, stepDef.expect.status)) {
    const cls = classifyHttpStatus(response.status);
    return {
      kind: "failure",
      step: makeStepRecord(stepDef, ctx, startedAt, nowFn(), "failure", {
        request: { method, url, headers: redactSensitiveHeaders(sentHeaders), body },
        response: { status: response.status, body: responseBody },
      }),
      error: {
        message: `HTTP ${response.status} did not match expected ${JSON.stringify(stepDef.expect.status)}`,
        capability_violation: false,
        causes_tier_escalation: cls.causes_tier_escalation,
        retryable: cls.retryable,
        detail: { status: response.status, body: responseBody },
      },
    };
  }

  // ── Phase 7: body assertions ─────────────────────────────────
  if (stepDef.expect.body_includes !== undefined) {
    const text = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    for (const fragment of stepDef.expect.body_includes) {
      if (!text.includes(fragment)) {
        return {
          kind: "failure",
          step: makeStepRecord(stepDef, ctx, startedAt, nowFn(), "failure", {
            request: { method, url, headers: redactSensitiveHeaders(sentHeaders), body },
            response: { status: response.status, body: responseBody },
          }),
          error: {
            message: `response body missing expected fragment: '${fragment}'`,
            capability_violation: false,
            causes_tier_escalation: false,
            retryable: false,
          },
        };
      }
    }
  }

  // ── Phase 8: extract into context ────────────────────────────
  const extracted: Record<string, unknown> = {
    status: response.status,
    body: responseBody,
  };
  if (stepDef.expect.extract !== undefined) {
    try {
      const responseScope = { status: response.status, body: responseBody };
      for (const [name, jsonPath] of Object.entries(stepDef.expect.extract)) {
        extracted[name] = extractByPath(responseScope, jsonPath);
      }
    } catch (err) {
      return failureFromError(stepDef, ctx, startedAt, nowFn(), err, {
        capability_violation: false,
        causes_tier_escalation: false,
        retryable: false,
      });
    }
  }

  // ── Phase 9: side effect with concrete reverse action ────────
  const sideEffects: SideEffect[] = [];
  if (stepDef.emit_side_effect !== undefined) {
    try {
      const effectScope = buildScope(run, { status: response.status, body: responseBody });
      const reference = interpolateString(
        stepDef.emit_side_effect.reference_template,
        effectScope,
      );
      const reverse = interpolateReverseAction(stepDef.emit_side_effect, effectScope);
      sideEffects.push({
        id: ulid(),
        type: stepDef.emit_side_effect.type,
        reference,
        reversible: stepDef.emit_side_effect.reversible,
        reverse_action: reverse,
        emitted_at: nowFn(),
      });
    } catch (err) {
      return failureFromError(stepDef, ctx, startedAt, nowFn(), err, {
        capability_violation: false,
        causes_tier_escalation: false,
        retryable: false,
      });
    }
  }

  return {
    kind: "success",
    step: makeStepRecord(stepDef, ctx, startedAt, nowFn(), "success", {
      request: { method, url, headers: redactSensitiveHeaders(sentHeaders), body },
      response: { status: response.status, body: responseBody, extracted },
    }),
    new_side_effects: sideEffects,
  };
}

// ── Helpers ──────────────────────────────────────────────────

interface RecordPayload {
  request: unknown;
  response: unknown;
}

function makeStepRecord(
  stepDef: HttpRequestStepDef,
  ctx: StepExecutorContext,
  startedAt: string,
  completedAt: string,
  status: "success" | "failure",
  payload: RecordPayload,
): StepRecord {
  return {
    index: ctx.index,
    step_id: stepDef.id,
    type: stepDef.type,
    attempt: ctx.attempt,
    tier: ctx.tier,
    started_at: startedAt,
    completed_at: completedAt,
    status,
    request: payload.request,
    response: payload.response,
    error: null,
    fixture_uri: null,
  };
}

function failureFromError(
  stepDef: HttpRequestStepDef,
  ctx: StepExecutorContext,
  startedAt: string,
  completedAt: string,
  err: unknown,
  flags: Pick<StepError, "capability_violation" | "causes_tier_escalation" | "retryable">,
): StepResult {
  const message = err instanceof Error ? err.message : String(err);
  const error: StepError = {
    message,
    capability_violation: flags.capability_violation,
    causes_tier_escalation: flags.causes_tier_escalation,
    retryable: flags.retryable,
    detail: err instanceof InterpolationError ? { kind: "interpolation_error" } : undefined,
  };
  return {
    kind: "failure",
    step: makeStepRecord(stepDef, ctx, startedAt, completedAt, "failure", {
      request: null,
      response: null,
    }),
    error,
  };
}

export function classifyHttpStatus(status: number): {
  causes_tier_escalation: boolean;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { causes_tier_escalation: true, retryable: false };
  }
  if (status === 429) return { causes_tier_escalation: false, retryable: true };
  if (status >= 500 && status < 600) return { causes_tier_escalation: false, retryable: true };
  return { causes_tier_escalation: false, retryable: false };
}

export function statusMatches(actual: number, expected: number | number[]): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

export function checkNetworkCapability(
  url: string,
  allowed: string[],
): { ok: true } | { ok: false; reason: string } {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `unparseable URL: ${url}` };
  }
  for (const pattern of allowed) {
    const p = pattern.toLowerCase();
    if (p === host) return { ok: true };
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      // *.x.com matches sub.x.com and a.b.x.com but not x.com itself.
      if (host !== base && host.endsWith("." + base)) return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `host '${host}' not in allowed_domains: ${JSON.stringify(allowed)}`,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|cookie|proxy-authorization)$/i;

function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

function interpolateReverseAction(
  emission: SideEffectEmission,
  scope: ReturnType<typeof buildScope>,
): ReverseAction {
  const reverse = emission.reverse_action;
  switch (reverse.kind) {
    case "http_request": {
      const url_template = interpolateString(reverse.url_template, scope);
      if (reverse.auth === undefined) {
        return { kind: "http_request", method: reverse.method, url_template };
      }
      const auth: ReverseAuth = {
        source: reverse.auth.source,
        reference_template: interpolateString(reverse.auth.reference_template, scope),
        ...(reverse.auth.scheme !== undefined ? { scheme: reverse.auth.scheme } : {}),
        ...(reverse.auth.header_name !== undefined
          ? { header_name: reverse.auth.header_name }
          : {}),
      };
      return {
        kind: "http_request",
        method: reverse.method,
        url_template,
        auth,
      };
    }
    case "stripe_refund":
      return {
        kind: "stripe_refund",
        charge_id_template: interpolateString(reverse.charge_id_template, scope),
      };
    case "vault_delete":
      return {
        kind: "vault_delete",
        reference_template: interpolateString(reverse.reference_template, scope),
      };
    case "noop":
      return { kind: "noop", reason: reverse.reason };
  }
}
