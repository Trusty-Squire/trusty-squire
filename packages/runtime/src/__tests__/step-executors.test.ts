// Step-executor tests — one suite per executor.
//
// Email-related executors use the real InboxService against in-memory
// stores so we get behaviour fidelity (polling cadence, alias gates,
// dedupe). TOTP uses a real otplib + a fixed seed; delay uses an
// injected sleep.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator } from "otplib";
import type {
  AdapterCapabilities,
  ClickLinkInEmailStepDef,
  DelayStepDef,
  TotpGenerateStepDef,
  WaitForEmailStepDef,
  WaitForEmailWithCodeStepDef,
} from "@trusty-squire/adapter-sdk";
import {
  executeClickLinkInEmail,
  executeDelay,
  executeTotpGenerate,
  executeWaitForEmail,
  executeWaitForEmailWithCode,
} from "../index.js";
import type { Run, Tier } from "../types.js";
import { MockVault } from "./_test-vault.js";
import { makeInboxHarness } from "./_test-inbox.js";

const NOW = "2026-05-10T08:00:00.000Z";
const RUN_ID = "01HRUNAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    account_id: ACCOUNT,
    idempotency_key: "k",
    service: "test-svc",
    plan: "free",
    project_name: "demo",
    user_facing_purpose: null,
    state: "ADAPTER_EXECUTING",
    state_entered_at: NOW,
    retry_count: 0,
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
    delta_mandate_id: null,
    adapter_id: "test-svc",
    adapter_version: "0.1.0",
    current_tier: 1,
    steps: [],
    side_effects: [],
    context: {
      email_alias: "harness@test.local",
      project_name: "demo",
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

const BASE_CTX = { index: 0, attempt: 1, tier: 1 as Tier, now: () => NOW };

const CAPS: AdapterCapabilities = {
  payment: { max_authorize_cents: 0, recurrence: "none" },
  email: { receive_from: ["test.local"] },
  network: { allowed_domains: ["test.local", "*.test.local"] },
  vault_writes: [],
};

// ── wait_for_email ───────────────────────────────────────────

describe("executeWaitForEmail", () => {
  it("matching email → success with parsed metadata in the response", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { subject: "Verify your account" });
    const stepDef: WaitForEmailStepDef = {
      id: "wait_verify",
      type: "wait_for_email",
      match: { from: "test.local", subject_pattern: "Verify" },
      timeout_seconds: 5,
    };
    const r = await executeWaitForEmail(stepDef, makeRun({ context: { ...makeRun().context, email_alias: alias } }), {
      ...BASE_CTX,
      inbox: h.inbox,
    });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    const resp = r.step.response as { from: string; subject: string; codes: string[] };
    expect(resp.from).toBe("noreply@test.local");
    expect(resp.subject).toBe("Verify your account");
    expect(resp.codes).toContain("482915");
  });

  it("timeout → failure with EMAIL_TIMEOUT", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    const stepDef: WaitForEmailStepDef = {
      id: "wait_verify",
      type: "wait_for_email",
      match: { from: "test.local" },
      // pollIntervalMs=1; under 100ms is enough to time out instantly
      timeout_seconds: 0,
    };
    const r = await executeWaitForEmail(stepDef, makeRun({ context: { ...makeRun().context, email_alias: alias } }), {
      ...BASE_CTX,
      inbox: h.inbox,
    });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/EMAIL_TIMEOUT/);
    expect(r.error.retryable).toBe(false);
  });

  it("from-array matches via regex translation", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { from_address: "no-reply@stripe.com", from_domain: "stripe.com" });
    const stepDef: WaitForEmailStepDef = {
      id: "wait",
      type: "wait_for_email",
      match: { from: ["postmark.com", "stripe.com"] },
      timeout_seconds: 2,
    };
    const r = await executeWaitForEmail(stepDef, makeRun({ context: { ...makeRun().context, email_alias: alias } }), {
      ...BASE_CTX,
      inbox: h.inbox,
    });
    expect(r.kind).toBe("success");
  });
});

// ── wait_for_email_with_code ─────────────────────────────────

describe("executeWaitForEmailWithCode", () => {
  it("code extracted → success with generated_updates set", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { parsed_codes: ["482915"] });
    const stepDef: WaitForEmailWithCodeStepDef = {
      id: "wait_code",
      type: "wait_for_email_with_code",
      match: { from: "test.local" },
      code_pattern: "",
      extract_to: "otp_code",
      timeout_seconds: 5,
    };
    const r = await executeWaitForEmailWithCode(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      { ...BASE_CTX, inbox: h.inbox },
    );
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.generated_updates.otp_code).toBe("482915");
    // The code MUST NOT appear in the persisted step response.
    expect(JSON.stringify(r.step.response)).not.toContain("482915");
  });

  it("no code → failure with STEP_PARSE_FAILED + tier-escalation flag", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    // Email with no extractable code AND a body that doesn't match
    // any default OTP pattern.
    await h.deliver(alias, {
      parsed_codes: [],
      body_text: "no numbers here at all just words",
    });
    const stepDef: WaitForEmailWithCodeStepDef = {
      id: "wait_code",
      type: "wait_for_email_with_code",
      match: { from: "test.local" },
      code_pattern: "",
      extract_to: "otp",
      timeout_seconds: 5,
    };
    const r = await executeWaitForEmailWithCode(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      { ...BASE_CTX, inbox: h.inbox },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/STEP_PARSE_FAILED/);
    expect(r.error.causes_tier_escalation).toBe(true);
  });

  it("timeout → EMAIL_TIMEOUT failure (no code path entered)", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    const stepDef: WaitForEmailWithCodeStepDef = {
      id: "wait_code",
      type: "wait_for_email_with_code",
      match: { from: "test.local" },
      code_pattern: "",
      extract_to: "otp",
      timeout_seconds: 0,
    };
    const r = await executeWaitForEmailWithCode(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      { ...BASE_CTX, inbox: h.inbox },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/EMAIL_TIMEOUT/);
  });

  it("custom code_pattern overrides default OTP heuristics", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, {
      parsed_codes: [],
      body_text: "Token: ABC-DEF-XYZ123 do not share",
    });
    const stepDef: WaitForEmailWithCodeStepDef = {
      id: "wait_code",
      type: "wait_for_email_with_code",
      match: { from: "test.local" },
      code_pattern: "Token:\\s+([A-Z0-9-]+)",
      extract_to: "magic_token",
      timeout_seconds: 5,
    };
    const r = await executeWaitForEmailWithCode(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      { ...BASE_CTX, inbox: h.inbox },
    );
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.generated_updates.magic_token).toBe("ABC-DEF-XYZ123");
  });
});

// ── click_link_in_email ──────────────────────────────────────

describe("executeClickLinkInEmail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("link succeeds (200) → success", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { parsed_links: ["https://test.local/verify?u=42"] });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "verify",
      follow_redirects: true,
      timeout_seconds: 5,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 → failure classified as retryable", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias);
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500 }));
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "",
      follow_redirects: true,
      timeout_seconds: 5,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/HTTP_500/);
    expect(r.error.retryable).toBe(true);
  });

  it("no link in email → failure (LINK_NOT_FOUND)", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, {
      parsed_links: [],
      body_text: "no urls in body",
      body_html: null,
    });
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "",
      follow_redirects: true,
      timeout_seconds: 5,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/LINK_NOT_FOUND/);
  });

  it("network error on fetch → retryable failure (LINK_NETWORK_ERROR)", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { parsed_links: ["https://test.local/verify"] });
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "",
      follow_redirects: true,
      timeout_seconds: 5,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/LINK_NETWORK_ERROR/);
    expect(r.error.retryable).toBe(true);
  });

  it("timeout (no email arrives) → EMAIL_TIMEOUT failure", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "",
      follow_redirects: true,
      timeout_seconds: 0,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/EMAIL_TIMEOUT/);
  });

  it("link points outside allowed_domains → capability_violation, no fetch", async () => {
    const h = makeInboxHarness();
    const alias = await h.inbox.createAlias({
      account_id: ACCOUNT,
      run_id: RUN_ID,
      service: "test",
    });
    await h.deliver(alias, { parsed_links: ["https://evil.example.com/x"] });
    const stepDef: ClickLinkInEmailStepDef = {
      id: "click",
      type: "click_link_in_email",
      match: { from: "test.local" },
      link_pattern: "",
      follow_redirects: true,
      timeout_seconds: 5,
    };
    const r = await executeClickLinkInEmail(
      stepDef,
      makeRun({ context: { ...makeRun().context, email_alias: alias } }),
      {
        ...BASE_CTX,
        inbox: h.inbox,
        capabilities: CAPS,
        fetch: fetchMock as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.capability_violation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── totp_generate ────────────────────────────────────────────

describe("executeTotpGenerate", () => {
  it("produces a TOTP code that authenticator.check verifies", async () => {
    const vault = new MockVault();
    // Pre-stash the seed so retrieveForRuntime returns it.
    const seed = authenticator.generateSecret();
    const seedRef = "vault://test/totp_seed";
    // MockVault has no direct "stash by ref" helper — store an entry
    // and use its returned reference.
    const stored = await vault.store({
      account_id: ACCOUNT,
      subscription_id: "sub",
      type: "totp_seed",
      value: seed,
      env_var_suggestion: null,
      metadata: {},
    });

    const stepDef: TotpGenerateStepDef = {
      id: "gen_totp",
      type: "totp_generate",
      seed_reference: stored.reference,
      extract_to: "totp",
    };
    const r = await executeTotpGenerate(stepDef, makeRun(), { ...BASE_CTX, vault });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    const code = r.generated_updates.totp;
    expect(code).toMatch(/^\d{6}$/);
    expect(authenticator.check(code!, seed)).toBe(true);
    // No code material in persisted response.
    expect(JSON.stringify(r.step.response)).not.toContain(code!);
    // Seed reference allowed lookup
    void seedRef;
  });

  it("authenticator.generate throwing → TOTP_GENERATE_FAILED failure", async () => {
    const vault = new MockVault();
    const stored = await vault.store({
      account_id: ACCOUNT,
      subscription_id: "sub",
      type: "totp_seed",
      value: authenticator.generateSecret(),
      env_var_suggestion: null,
      metadata: {},
    });
    // Force authenticator.generate to throw mid-step so the catch path
    // is exercised. Restored after the test by vi.restoreAllMocks().
    const spy = vi.spyOn(authenticator, "generate").mockImplementation(() => {
      throw new Error("simulated otplib failure");
    });
    const stepDef: TotpGenerateStepDef = {
      id: "gen",
      type: "totp_generate",
      seed_reference: stored.reference,
      extract_to: "totp",
    };
    const r = await executeTotpGenerate(stepDef, makeRun(), { ...BASE_CTX, vault });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/TOTP_GENERATE_FAILED/);
    spy.mockRestore();
  });

  it("missing seed → failure (TOTP_SEED_MISSING)", async () => {
    const vault = new MockVault({ throwOnMissingRetrieve: true });
    const stepDef: TotpGenerateStepDef = {
      id: "gen_totp",
      type: "totp_generate",
      seed_reference: "vault://does-not-exist",
      extract_to: "totp",
    };
    const r = await executeTotpGenerate(stepDef, makeRun(), { ...BASE_CTX, vault });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.message).toMatch(/TOTP_SEED_MISSING/);
  });
});

// ── delay ────────────────────────────────────────────────────

describe("executeDelay", () => {
  it("sleeps for seconds × 1000ms via injected sleep", async () => {
    const sleep = vi.fn(async () => {});
    const stepDef: DelayStepDef = { id: "wait", type: "delay", seconds: 5 };
    const r = await executeDelay(stepDef, makeRun(), {
      ...BASE_CTX,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });
    expect(r.kind).toBe("success");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("seconds > 60 → capability_violation", async () => {
    const stepDef: DelayStepDef = { id: "wait", type: "delay", seconds: 120 };
    const r = await executeDelay(stepDef, makeRun(), { ...BASE_CTX });
    expect(r.kind).toBe("failure");
    if (r.kind !== "failure") return;
    expect(r.error.capability_violation).toBe(true);
    expect(r.error.message).toMatch(/DELAY_TOO_LONG/);
  });

  it("negative or NaN seconds → capability_violation", async () => {
    const r1 = await executeDelay({ id: "x", type: "delay", seconds: -1 }, makeRun(), { ...BASE_CTX });
    const r2 = await executeDelay({ id: "x", type: "delay", seconds: Number.NaN }, makeRun(), { ...BASE_CTX });
    expect(r1.kind).toBe("failure");
    expect(r2.kind).toBe("failure");
  });
});
