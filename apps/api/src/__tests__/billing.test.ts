// Stripe billing — the paid tier end to end, with a fake StripeClient
// (no live Stripe, no real signatures). Covers:
//   1. provisioning is free — no signup quota / 402 (beta);
//   2. the webhook: checkout.session.completed activates, subscription
//      .deleted cancels — and the status follows;
//   3. the checkout/portal routes: guards + URL hand-off, including the
//      free-during-beta kill-switch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { buildServer } from "../server.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import type {
  StripeClient,
  CheckoutSessionInput,
  PortalSessionInput,
} from "../services/stripe-client.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const CUSTOMER_ID = "ts-test";

// Fake Stripe: records inputs, returns canned URLs, and turns the POSTed
// webhook body straight into the "verified" event (signature ignored).
class FakeStripe implements StripeClient {
  lastCheckout: CheckoutSessionInput | null = null;
  lastPortal: PortalSessionInput | null = null;

  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string }> {
    this.lastCheckout = input;
    return { url: "https://checkout.stripe.test/session" };
  }
  async createBillingPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
    this.lastPortal = input;
    return { url: "https://portal.stripe.test/session" };
  }
  constructWebhookEvent(rawBody: string): Stripe.Event {
    return JSON.parse(rawBody) as Stripe.Event;
  }
}

interface Harness {
  app: FastifyInstance;
  deps: ApiDeps;
  stripe: FakeStripe;
}

async function setup(stripe: FakeStripe | null = new FakeStripe()): Promise<Harness> {
  // These tests exercise the real checkout flow, so the free-during-beta
  // kill-switch must be ON. (A dedicated test below covers the OFF default.)
  process.env.BILLING_ENABLED = "true";
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
  const app = await buildServer({
    deps,
    ...(stripe !== null ? { stripeClient: stripe } : {}),
  });
  return { app, deps, stripe: stripe ?? new FakeStripe() };
}

async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({ account_id: accountId, ip: null, user_agent: null, now: new Date() });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

// Issue a machine token and bind it to `accountId`. There's no signup
// quota anymore — provisioning is free during beta.
async function pairedToken(deps: ApiDeps, app: FastifyInstance, accountId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/install" });
  const token = (res.json() as { machine_token: string }).machine_token;
  await deps.machineTokenStore.markPaired(token, accountId);
  return token;
}

function createAlias(app: FastifyInstance, token: string): Promise<{ statusCode: number; body: unknown }> {
  return app
    .inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "content-type": "application/json", "x-machine-token": token },
      payload: { account_id: "acct-body-ignored", service: "resend", run_id: "run-1" },
    })
    .then((r) => ({ statusCode: r.statusCode, body: r.json() }));
}

describe("provisioning is free — no signup quota (beta)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("a paired token creates aliases freely — many signups, no 402", async () => {
    const acct = await h.deps.accountStore.createAccount("free@test.dev", "Free");
    const token = await pairedToken(h.deps, h.app, acct.id);
    // Well past the old free limit (10): every signup still succeeds. Unique
    // run_id per call so each is a distinct alias, not a duplicate.
    for (let i = 0; i < 13; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/inbox/aliases",
        headers: { "content-type": "application/json", "x-machine-token": token },
        payload: { account_id: "acct-body-ignored", service: "resend", run_id: `run-${i}` },
      });
      expect(res.statusCode, `iteration ${i}`).toBe(201);
    }
  });

  it("a canceled/free account is not paywalled either", async () => {
    const acct = await h.deps.accountStore.createAccount("ex@test.dev", "Ex");
    const token = await pairedToken(h.deps, h.app, acct.id);
    await h.deps.accountStore.setSubscription(acct.id, { subscription_status: "canceled" });
    const res = await createAlias(h.app, token);
    expect(res.statusCode).toBe(201);
  });
});

describe("billing — Stripe webhook", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  function postEvent(event: unknown): Promise<{ statusCode: number }> {
    return h.app
      .inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=fake" },
        payload: JSON.stringify(event),
      })
      .then((r) => ({ statusCode: r.statusCode }));
  }

  it("checkout.session.completed activates the referenced account", async () => {
    const acct = await h.deps.accountStore.createAccount("buyer@test.dev", "Buyer");
    const res = await postEvent({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: acct.id, customer: "cus_123", subscription: "sub_123" } },
    });
    expect(res.statusCode).toBe(200);
    const after = await h.deps.accountStore.findAccountById(acct.id);
    expect(after?.subscription_status).toBe("active");
    expect(after?.stripe_customer_id).toBe("cus_123");
    expect(after?.subscription_id).toBe("sub_123");
  });

  it("subscription.deleted cancels the mapped customer's account", async () => {
    const acct = await h.deps.accountStore.createAccount("churned@test.dev", "Churn");
    await h.deps.accountStore.setSubscription(acct.id, {
      subscription_status: "active",
      stripe_customer_id: "cus_churn",
      subscription_id: "sub_churn",
    });
    const res = await postEvent({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_churn", customer: "cus_churn", status: "active" } },
    });
    expect(res.statusCode).toBe(200);
    const after = await h.deps.accountStore.findAccountById(acct.id);
    expect(after?.subscription_status).toBe("canceled");
  });

  it("subscription.updated with a scheduled cancel records cancel_at, stays active", async () => {
    const acct = await h.deps.accountStore.createAccount("cancelling@test.dev", "Cancelling");
    await h.deps.accountStore.setSubscription(acct.id, {
      subscription_status: "active",
      stripe_customer_id: "cus_cxl",
      subscription_id: "sub_cxl",
    });
    const cancelAtUnix = 1783339629; // 2026-07-06
    const res = await postEvent({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_cxl", customer: "cus_cxl", status: "active", cancel_at: cancelAtUnix } },
    });
    expect(res.statusCode).toBe(200);
    const after = await h.deps.accountStore.findAccountById(acct.id);
    // Still active (keeps access to term) but the cancel date is now recorded.
    expect(after?.subscription_status).toBe("active");
    expect(after?.cancel_at?.getTime()).toBe(cancelAtUnix * 1000);
  });

  it("an unknown event type is acked-and-ignored", async () => {
    const res = await postEvent({ type: "invoice.paid", data: { object: {} } });
    expect(res.statusCode).toBe(200);
  });

  it("a missing stripe-signature header is 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "x", data: { object: {} } }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("billing — checkout + portal routes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("checkout returns a Stripe URL with the account stamped as client_reference_id", async () => {
    const acct = await h.deps.accountStore.createAccount("co@test.dev", "Co");
    const cookie = await webCookie(h.deps, acct.id);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toContain("checkout.stripe.test");
    expect(h.stripe.lastCheckout?.accountId).toBe(acct.id);
  });

  it("checkout is 409 when already subscribed", async () => {
    const acct = await h.deps.accountStore.createAccount("already@test.dev", "Already");
    await h.deps.accountStore.setSubscription(acct.id, { subscription_status: "active" });
    const cookie = await webCookie(h.deps, acct.id);
    const res = await h.app.inject({ method: "POST", url: "/v1/billing/checkout", headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it("portal is 409 without a Stripe customer, 200 with one", async () => {
    const acct = await h.deps.accountStore.createAccount("portal@test.dev", "Portal");
    const cookie = await webCookie(h.deps, acct.id);

    const noCust = await h.app.inject({ method: "POST", url: "/v1/billing/portal", headers: { cookie } });
    expect(noCust.statusCode).toBe(409);

    await h.deps.accountStore.setSubscription(acct.id, {
      subscription_status: "active",
      stripe_customer_id: "cus_portal",
    });
    const withCust = await h.app.inject({ method: "POST", url: "/v1/billing/portal", headers: { cookie } });
    expect(withCust.statusCode).toBe(200);
    expect((withCust.json() as { url: string }).url).toContain("portal.stripe.test");
  });

  it("checkout requires a web session (401 unauthenticated)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/billing/checkout" });
    expect(res.statusCode).toBe(401);
  });

  it("503s when Stripe is unconfigured", async () => {
    const unconfigured = await setup(null);
    try {
      const acct = await unconfigured.deps.accountStore.createAccount("nostripe@test.dev", "NoStripe");
      const cookie = await webCookie(unconfigured.deps, acct.id);
      const res = await unconfigured.app.inject({
        method: "POST",
        url: "/v1/billing/checkout",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfigured.app.close();
    }
  });

  it("checkout is 503 billing_disabled when the beta kill-switch is off — even with Stripe live", async () => {
    // The free-during-beta default: no one can be billed by a stray Upgrade
    // click, regardless of a configured Stripe key.
    const prev = process.env.BILLING_ENABLED;
    delete process.env.BILLING_ENABLED;
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET});
    const app = await buildServer({ deps, stripeClient: new FakeStripe() });
    try {
      const acct = await deps.accountStore.createAccount("beta@test.dev", "Beta");
      const cookie = await webCookie(deps, acct.id);
      const res = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: { cookie } });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe("billing_disabled");
    } finally {
      await app.close();
      if (prev !== undefined) process.env.BILLING_ENABLED = prev;
    }
  });
});
