// End-to-end-ish API tests via fastify.inject. Cover the spec's
// integration test list:
//   - POST /v1/accounts → creates account, returns session
//   - POST /v1/runs with mandate-allowed action → running run
//   - POST /v1/runs with above-silent action → pending_approval +
//       approval_url
//   - POST /v1/approvals/:token/grant → run → PROVISIONING
//   - GET /v1/credentials/:reference → owning agent gets value;
//       other account → 403

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { issueAgentSession } from "../auth/agent.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import { makeVouchflowSigner, type VouchflowSigner } from "./_fixtures.js";
import type { Mandate } from "@trusty-squire/mandate-validator";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
  signer: VouchflowSigner;
}

async function setup(): Promise<Harness> {
  const signer = await makeVouchflowSigner(CUSTOMER_ID);
  const deps = buildInMemoryDeps({
    sessionSecret: SESSION_SECRET,
    customerId: CUSTOMER_ID,
    vouchflowVerifier: signer.verifier,
  });
  const server = await buildServer({ deps, approvalBaseUrl: "https://app.test/approve" });
  return { server, deps, signer };
}

// ── Helpers ──────────────────────────────────────────────────

function makeMandate(accountId: string, mandateId: string): Mandate {
  return {
    v: 1,
    id: mandateId,
    account_id: accountId,
    monthly_budget_cents: 50_000,
    daily_silent_max_cents: 10_000,
    per_action_silent_max_cents: 5_000,
    per_subscription_max_cents: 5_000,
    allowed_categories: ["email"],
    allowed_services: "*",
    blocked_services: [],
    step_up_triggers: {
      above_silent_max: true,
      new_category: true,
      novel_service: true,
      near_daily_limit: true,
      near_monthly_limit: true,
      velocity_anomaly: false,
      session_anomaly: true,
      recurring_commitment: true,
      cross_account_action: false,
    },
    silently_approved_services: [],
    confidence_requirements: {
      provision: "medium",
      rotate: "medium",
      cancel: "low",
      amend_mandate: "high",
      release_identity: "high",
    },
    not_before: "2026-05-01T00:00:00.000Z",
    not_after: "2027-05-01T00:00:00.000Z",
    signing_devices: [
      {
        id: "sdv_test_device",
        alg: "Ed25519",
        public_key: "stub",
        platform: "web",
        registered_at: "2026-05-01T00:00:00.000Z",
        revoked_at: null,
      },
    ],
    issuer: { domain: "trustysquire.ai", web_bot_auth_key: "ts-2026-q1" },
  };
}

// Inject the session cookie + plant the active mandate so a test can
// skip the multi-step registration ceremony and focus on the run flow.
async function quickProvision(h: Harness, opts: { email?: string } = {}): Promise<{
  accountId: string;
  cookie: string;
  mandateId: string;
}> {
  const email = opts.email ?? "user@example.test";
  const account = await h.deps.accountStore.createAccount(email, "Test User");

  const { issueSession } = await import("../auth/session.js");
  const { signSessionJwt, SESSION_COOKIE_NAME } = await import("../auth/session.js");
  const { record, jwt } = issueSession({
    account_id: account.id,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  await h.deps.sessionStore.insert(record);
  const token = signSessionJwt(jwt, SESSION_SECRET);
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const mandateId = ulid();
  await h.deps.accountStore.setActiveMandate({
    account_id: account.id,
    mandate: makeMandate(account.id, mandateId),
    signed_by_device: "sdv_test_device",
    vouchflow_device_token: "dvt_test",
    session_id: "ses_pretest",
    installed_at: new Date(),
  });
  return { accountId: account.id, cookie, mandateId };
}

async function issueAgentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

// ── Tests ────────────────────────────────────────────────────

describe("/v1/accounts", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("creates an account and issues a session cookie", async () => {
    const bundle = await h.signer.signBundle({
      context: "account_register",
      payload: { email: "new@example.test", display_name: "New User" },
      confidence: "medium",
    });
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { bundle },
    });
    expect(res.statusCode).toBe(201);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    expect(String(setCookie)).toContain("ts_session=");
    const body = res.json() as { account: { email: string } };
    expect(body.account.email).toBe("new@example.test");
  });

  it("rejects a malformed payload", async () => {
    const bundle = await h.signer.signBundle({
      context: "account_register",
      payload: { email: "not-an-email" },
      confidence: "medium",
    });
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { bundle },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a wrong-context bundle", async () => {
    const bundle = await h.signer.signBundle({
      context: "login",
      payload: { email: "x@y.com", display_name: "X" },
      confidence: "medium",
    });
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { bundle },
    });
    // 'login' is not 'account_register' nor 'account_register_with_mandate' →
    // rejected at the context-routing layer.
    expect(res.statusCode).toBe(400);
  });

  it("creates account + mandate atomically on account_register_with_mandate", async () => {
    const expiresAt = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const bundle = await h.signer.signBundle({
      context: "account_register_with_mandate",
      payload: {
        email: "combined@example.test",
        display_name: "Combined User",
        policy: {
          spend_limit_cents_per_month: 50_000,
          allowed_categories: ["email-api"],
          silent_signup: { max_monthly_cost_cents: 1000, allow_free: true },
          approval_required_categories: [],
          confidence_requirements: {
            login: "low",
            mandate_signing: "high",
            delta_mandate_signing: "high",
            provision_silent: "low",
            provision_approved: "medium",
            amend_mandate: "high",
            cancel: "low",
            rotate: "medium",
            release_identity: "high",
          },
        },
        expires_at: expiresAt,
      },
      confidence: "high",
    });
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { bundle },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      account: { id: string; email: string };
      mandate: { id: string; not_before: string; not_after: string };
    };
    expect(body.account.email).toBe("combined@example.test");
    expect(body.mandate.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.mandate.not_after).toBe(expiresAt);

    // Server actually stored an active mandate against the new account.
    const active = await h.deps.accountStore.getActiveMandate(body.account.id);
    expect(active).not.toBeNull();
    expect(active?.mandate.monthly_budget_cents).toBe(50_000);
  });

  it("rejects account_register_with_mandate at medium confidence", async () => {
    const bundle = await h.signer.signBundle({
      context: "account_register_with_mandate",
      payload: {
        email: "low@example.test",
        display_name: "Low",
        policy: {
          spend_limit_cents_per_month: 50_000,
          allowed_categories: [],
          silent_signup: { max_monthly_cost_cents: 0, allow_free: false },
          approval_required_categories: [],
          confidence_requirements: {
            login: "low",
            mandate_signing: "high",
            delta_mandate_signing: "high",
            provision_silent: "low",
            provision_approved: "medium",
            amend_mandate: "high",
            cancel: "low",
            rotate: "medium",
            release_identity: "high",
          },
        },
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
      confidence: "medium",
    });
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { bundle },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("/v1/runs (silent path)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("free signup at allowed cost → silent decision, run in PROVISIONING", async () => {
    const { cookie } = await quickProvision(h);
    // Pre-populate provisioned-service so novel_service doesn't fire.
    h.deps.validatorDeps.getProvisionedServices = async () => ["resend"];
    h.deps.validatorDeps.getProvisionedCategories = async () => ["email"];

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie },
      payload: {
        service: "resend",
        plan: "free",
        project_name: "demo",
        category: "email",
        cost_cents: 0,
        recurrence: "none",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { decision: string; run: { state: string } };
    expect(body.decision).toBe("silent");
    expect(body.run.state).toBe("PROVISIONING");
  });

  it("no session → 401", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/runs",
      payload: { service: "x", plan: "free", project_name: "x", category: "x", cost_cents: 0, recurrence: "none" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("/v1/runs (needs_approval path)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("above-silent action → needs_approval response with approval_url", async () => {
    const { cookie } = await quickProvision(h);
    h.deps.validatorDeps.getProvisionedServices = async () => ["resend"];
    h.deps.validatorDeps.getProvisionedCategories = async () => ["email"];

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie },
      payload: {
        service: "resend",
        plan: "pro",
        project_name: "demo",
        category: "email",
        // exceeds per_action_silent_max_cents (5000)
        cost_cents: 9_000,
        recurrence: "monthly",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      decision: string;
      approval_url?: string;
      run: { state: string };
    };
    expect(body.decision).toBe("needs_approval");
    expect(body.run.state).toBe("PENDING_APPROVAL");
    expect(body.approval_url).toMatch(/^https:\/\/app\.test\/approve\//);
  });
});

describe("/v1/approvals/:token/grant", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("valid signed delta → run transitions to PROVISIONING", async () => {
    const { cookie, accountId, mandateId } = await quickProvision(h);
    h.deps.validatorDeps.getProvisionedServices = async () => ["resend"];
    h.deps.validatorDeps.getProvisionedCategories = async () => ["email"];

    const createRes = await h.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie },
      payload: {
        service: "resend",
        plan: "pro",
        project_name: "demo",
        category: "email",
        cost_cents: 9_000,
        recurrence: "monthly",
      },
    });
    const runBody = createRes.json() as {
      run: { id: string };
      approval_url: string;
    };
    const token = runBody.approval_url.split("/").pop()!;

    // Build a delta whose run_binding matches the action.
    const { computeRunBinding } = await import("@trusty-squire/mandate-validator");
    const action = {
      type: "provision" as const,
      run_id: runBody.run.id,
      service: "resend",
      plan: "pro",
      cost_cents: 9_000,
      recurrence: "monthly" as const,
    };
    const delta = {
      v: 1,
      id: ulid(),
      mandate_id: mandateId,
      account_id: accountId,
      action,
      remember: null,
      not_before: "2026-05-10T00:00:00.000Z",
      not_after: "2027-05-10T00:00:00.000Z",
      nonce: ulid(),
      run_binding: computeRunBinding(action),
    };

    const bundle = await h.signer.signBundle({
      context: "delta_mandate_signing",
      payload: delta,
      confidence: "high",
    });

    const grant = await h.server.inject({
      method: "POST",
      url: `/v1/approvals/${token}/grant`,
      headers: { cookie },
      payload: { bundle },
    });
    expect(grant.statusCode).toBe(200);
    const grantBody = grant.json() as { run: { state: string } };
    expect(grantBody.run.state).toBe("PROVISIONING");
  });

  it("delta with mismatched run_id → 400", async () => {
    const { cookie, accountId, mandateId } = await quickProvision(h);
    h.deps.validatorDeps.getProvisionedServices = async () => ["resend"];
    h.deps.validatorDeps.getProvisionedCategories = async () => ["email"];

    const createRes = await h.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie },
      payload: {
        service: "resend",
        plan: "pro",
        project_name: "demo",
        category: "email",
        cost_cents: 9_000,
        recurrence: "monthly",
      },
    });
    const runBody = createRes.json() as { run: { id: string }; approval_url: string };
    const token = runBody.approval_url.split("/").pop()!;

    const { computeRunBinding } = await import("@trusty-squire/mandate-validator");
    const action = {
      type: "provision" as const,
      run_id: "01HOTHERRUNZZZZZZZZZZZZZZZ",
      service: "resend",
      plan: "pro",
      cost_cents: 9_000,
      recurrence: "monthly" as const,
    };
    const delta = {
      v: 1,
      id: ulid(),
      mandate_id: mandateId,
      account_id: accountId,
      action,
      remember: null,
      not_before: "2026-05-10T00:00:00.000Z",
      not_after: "2027-05-10T00:00:00.000Z",
      nonce: ulid(),
      run_binding: computeRunBinding(action),
    };
    const bundle = await h.signer.signBundle({
      context: "delta_mandate_signing",
      payload: delta,
      confidence: "high",
    });
    const grant = await h.server.inject({
      method: "POST",
      url: `/v1/approvals/${token}/grant`,
      headers: { cookie },
      payload: { bundle },
    });
    expect(grant.statusCode).toBe(400);
  });
});

describe("/v1/credentials/:reference (agent)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("agent fetches a credential owned by its account", async () => {
    const { accountId } = await quickProvision(h);

    // Plant a credential in the vault scoped to this account.
    const entry = await h.deps.vault.store({
      account_id: accountId,
      subscription_id: "sub_test",
      type: "api_key",
      value: "sk_secret_xyz",
      env_var_suggestion: "TEST_API_KEY",
      metadata: {},
    });

    const agentToken = await issueAgentToken(h.deps, accountId);
    const res = await h.server.inject({
      method: "GET",
      url: `/v1/credentials/${encodeURIComponent(entry.reference)}?purpose=test`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { value: string };
    expect(body.value).toBe("sk_secret_xyz");
  });

  it("another account's agent → 403 / 404 (cannot read someone else's credential)", async () => {
    const owner = await quickProvision(h, { email: "owner@x.test" });
    // Wait a tick so ULID order is stable, then create the intruder.
    await new Promise((r) => setTimeout(r, 2));
    const intruder = await quickProvision(h, { email: "intruder@x.test" });

    const ownersEntry = await h.deps.vault.store({
      account_id: owner.accountId,
      subscription_id: "sub_owner",
      type: "api_key",
      value: "do-not-leak",
      env_var_suggestion: null,
      metadata: {},
    });
    const intruderToken = await issueAgentToken(h.deps, intruder.accountId);
    const res = await h.server.inject({
      method: "GET",
      url: `/v1/credentials/${encodeURIComponent(ownersEntry.reference)}?purpose=probe`,
      headers: { authorization: `Bearer ${intruderToken}` },
    });
    // The reference begins with vault://<owner_account_id>/... so the
    // route's ownership prefix check rejects with 403.
    expect([403, 404]).toContain(res.statusCode);
  });

  it("no agent token → 401", async () => {
    const res = await h.server.inject({
      method: "GET",
      url: "/v1/credentials/foo?purpose=probe",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("/v1/usage + /v1/ledger + /v1/mandates/active", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("usage exposes monthly + daily budgets", async () => {
    const { cookie } = await quickProvision(h);
    const res = await h.server.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      monthly: { budget_cents: number; remaining_cents: number };
      daily: { silent_max_cents: number };
    };
    expect(body.monthly.budget_cents).toBe(50_000);
    expect(body.daily.silent_max_cents).toBe(10_000);
  });

  it("ledger returns the user's runs", async () => {
    const { cookie } = await quickProvision(h);
    const res = await h.server.inject({
      method: "GET",
      url: "/v1/ledger",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("active mandate is returned", async () => {
    const { cookie, mandateId } = await quickProvision(h);
    const res = await h.server.inject({
      method: "GET",
      url: "/v1/mandates/active",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mandate: { id: string } };
    expect(body.mandate.id).toBe(mandateId);
  });
});

describe("/health", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("returns 200", async () => {
    const res = await h.server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

