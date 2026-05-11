// HTTP step executor tests. fetch is stubbed via vi.stubGlobal so each
// test owns its own response shape and we can assert on the request that
// went out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterCapabilities, HttpRequestStepDef } from "@trusty-squire/adapter-sdk";
import {
  checkNetworkCapability,
  classifyHttpStatus,
  executeHttpRequest,
  statusMatches,
  type StepExecutorContext,
} from "../step-executors/http-request.js";
import type { Run } from "../types.js";

const NOW = "2026-05-10T08:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "01HRUNAAAAAAAAAAAAAAAAAAAA",
    account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
    idempotency_key: "key-1",
    service: "resend",
    plan: "free",
    project_name: "demo",
    user_facing_purpose: null,
    state: "PROVISIONING",
    state_entered_at: NOW,
    retry_count: 0,
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
    delta_mandate_id: null,
    adapter_id: "resend",
    adapter_version: "0.1.0",
    current_tier: 1,
    steps: [],
    side_effects: [],
    context: {
      email_alias: "demo@inbox.trustysquire.ai",
      project_name: "Demo Project",
      user_display_name: null,
      generated: {},
      steps: {},
      vault: {},
    },
    subscription_id: null,
    credentials: null,
    failure_reason: null,
    failure_detail: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

const CAPS: AdapterCapabilities = {
  payment: { max_authorize_cents: 0, recurrence: "none" },
  email: { receive_from: [] },
  network: { allowed_domains: ["api.resend.com"] },
  vault_writes: [],
};

function makeCtx(overrides: Partial<StepExecutorContext> = {}): StepExecutorContext {
  return {
    index: 0,
    attempt: 1,
    tier: 1,
    capabilities: CAPS,
    now: () => NOW,
    ...overrides,
  };
}

const POST_STEP: HttpRequestStepDef = {
  id: "create_account",
  type: "http_request",
  request: {
    method: "POST",
    url_template: "https://api.resend.com/v1/accounts",
    headers: { "Content-Type": "application/json" },
    body_template: { email: "${context.email_alias}" },
  },
  expect: {
    status: [200, 201],
    extract: { account_id: "$.body.id" },
  },
};

describe("executeHttpRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("interpolates body from context, sends Idempotency-Key, returns success", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "acc_123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await executeHttpRequest(POST_STEP, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });

    expect(r.kind).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/v1/accounts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "demo@inbox.trustysquire.ai" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "01HRUNAAAAAAAAAAAAAAAAAAAA.step.create_account.attempt.1",
    );
  });

  it("extract pulls JSONPath value into recorded response.extracted", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "acc_123", name: "demo" }), { status: 200 }),
    );
    const r = await executeHttpRequest(POST_STEP, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    const response = r.step.response as { extracted: { account_id: string } };
    expect(response.extracted.account_id).toBe("acc_123");
  });

  it("missing JSONPath value yields a non-retryable failure", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const r = await executeHttpRequest(POST_STEP, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/undefined reference/);
  });

  it("emits side effect with concrete reverse_action templates (response interpolated)", async () => {
    const stepWithEffect: HttpRequestStepDef = {
      ...POST_STEP,
      emit_side_effect: {
        type: "saas_account",
        reference_template: "resend:${response.body.id}",
        reversible: true,
        reverse_action: {
          kind: "http_request",
          method: "DELETE",
          url_template: "https://api.resend.com/v1/accounts/${response.body.id}",
          auth: {
            source: "vault",
            reference_template: "vault://${context.email_alias}/resend/api_key",
            scheme: "bearer",
          },
        },
      },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "acc_xyz" }), { status: 201 }));
    const r = await executeHttpRequest(stepWithEffect, makeRun(), {
      ...makeCtx(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.new_side_effects).toHaveLength(1);
    const effect = r.new_side_effects[0]!;
    expect(effect.reference).toBe("resend:acc_xyz");
    expect(effect.reverse_action).toMatchObject({
      kind: "http_request",
      method: "DELETE",
      url_template: "https://api.resend.com/v1/accounts/acc_xyz",
      auth: {
        reference_template: "vault://demo@inbox.trustysquire.ai/resend/api_key",
        scheme: "bearer",
      },
    });
  });

  it("403 response → failure with causes_tier_escalation=true, retryable=false", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 403 }));
    const r = await executeHttpRequest(POST_STEP, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.causes_tier_escalation).toBe(true);
    expect(r.error.retryable).toBe(false);
  });

  it("network error → failure with retryable=true", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await executeHttpRequest(POST_STEP, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.retryable).toBe(true);
    expect(r.error.causes_tier_escalation).toBe(false);
  });

  it("undeclared domain → capability_violation failure (no fetch issued)", async () => {
    const offDomain: HttpRequestStepDef = {
      ...POST_STEP,
      request: {
        ...POST_STEP.request,
        url_template: "https://evil.example.com/v1/accounts",
      },
    };
    const r = await executeHttpRequest(offDomain, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.capability_violation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GET request does not include Idempotency-Key header", async () => {
    const getStep: HttpRequestStepDef = {
      id: "fetch_status",
      type: "http_request",
      request: {
        method: "GET",
        url_template: "https://api.resend.com/v1/account",
      },
      expect: { status: 200 },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await executeHttpRequest(getStep, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("Authorization header is redacted in the recorded request", async () => {
    const authStep: HttpRequestStepDef = {
      ...POST_STEP,
      request: {
        ...POST_STEP.request,
        headers: { ...POST_STEP.request.headers, Authorization: "Bearer secret-token" },
      },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    const r = await executeHttpRequest(authStep, makeRun(), { ...makeCtx(), fetch: fetchMock as unknown as typeof fetch });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    const recorded = r.step.request as { headers: Record<string, string> };
    expect(recorded.headers.Authorization).toBe("[REDACTED]");
  });
});

describe("classifyHttpStatus", () => {
  it.each([
    [401, { causes_tier_escalation: true, retryable: false }],
    [403, { causes_tier_escalation: true, retryable: false }],
    [429, { causes_tier_escalation: false, retryable: true }],
    [500, { causes_tier_escalation: false, retryable: true }],
    [502, { causes_tier_escalation: false, retryable: true }],
    [422, { causes_tier_escalation: false, retryable: false }],
    [400, { causes_tier_escalation: false, retryable: false }],
  ])("status %i → %j", (status, expected) => {
    expect(classifyHttpStatus(status)).toEqual(expected);
  });
});

describe("statusMatches", () => {
  it("scalar match", () => {
    expect(statusMatches(200, 200)).toBe(true);
    expect(statusMatches(201, 200)).toBe(false);
  });
  it("array match", () => {
    expect(statusMatches(201, [200, 201])).toBe(true);
    expect(statusMatches(204, [200, 201])).toBe(false);
  });
});

describe("checkNetworkCapability", () => {
  it("exact host match", () => {
    expect(checkNetworkCapability("https://api.resend.com/v1/x", ["api.resend.com"])).toEqual({
      ok: true,
    });
  });
  it("wildcard subdomain match", () => {
    expect(
      checkNetworkCapability("https://eu.api.resend.com/v1/x", ["*.resend.com"]),
    ).toEqual({ ok: true });
  });
  it("wildcard does not match base domain", () => {
    expect(checkNetworkCapability("https://resend.com/", ["*.resend.com"]).ok).toBe(false);
  });
  it("non-matching host fails with reason", () => {
    const r = checkNetworkCapability("https://evil.com/x", ["api.resend.com"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("evil.com");
  });
  it("unparseable URL fails", () => {
    const r = checkNetworkCapability("not-a-url", ["api.resend.com"]);
    expect(r.ok).toBe(false);
  });
});
