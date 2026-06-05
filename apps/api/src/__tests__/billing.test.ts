// Stripe billing — the paid tier end to end, with a fake StripeClient
// (no live Stripe, no real signatures). Covers the three things that
// actually touch money state:
//   1. the quota gate: an active subscription on the token's BOUND
//      account lifts the free-signup 402;
//   2. the webhook: checkout.session.completed activates, subscription
//      .deleted cancels — and the lift/loss follows;
//   3. the checkout/portal routes: guards + URL hand-off.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { buildServer } from "../server.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { defaultQuota } from "../services/machine-tokens.js";
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
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, customerId: CUSTOMER_ID });
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

// Issue a machine token, bind it to `accountId`, and push its signup
// count to the free quota so the next alias-create would be gated.
async function overQuotaToken(deps: ApiDeps, app: FastifyInstance, accountId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/install" });
  const token = (res.json() as { machine_token: string }).machine_token;
  await deps.machineTokenStore.markPaired(token, accountId);
  for (let i = 0; i < defaultQuota(); i++) {
    await deps.machineTokenStore.incrementUsage(token, new Date());
  }
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

describe("billing — quota gate", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("an over-quota token on a FREE account is 402'd", async () => {
    const acct = await h.deps.accountStore.createAccount("free@test.dev", "Free");
    const token = await overQuotaToken(h.deps, h.app, acct.id);
    const res = await createAlias(h.app, token);
    expect(res.statusCode).toBe(402);
    expect((res.body as { error: string }).error).toBe("payment_required");
  });

  it("an active subscription on the bound account lifts the 402", async () => {
    const acct = await h.deps.accountStore.createAccount("paid@test.dev", "Paid");
    const token = await overQuotaToken(h.deps, h.app, acct.id);
    await h.deps.accountStore.setSubscription(acct.id, { subscription_status: "active" });
    const res = await createAlias(h.app, token);
    expect(res.statusCode).toBe(201);
  });

  it("a canceled subscription does NOT lift the 402", async () => {
    const acct = await h.deps.accountStore.createAccount("ex@test.dev", "Ex");
    const token = await overQuotaToken(h.deps, h.app, acct.id);
    await h.deps.accountStore.setSubscription(acct.id, { subscription_status: "canceled" });
    const res = await createAlias(h.app, token);
    expect(res.statusCode).toBe(402);
  });

  it("the paid bypass keys off the bound account, NOT the request body", async () => {
    // Paid account exists, but the token is bound to a DIFFERENT free
    // account; passing the paid id in the body must not grant the bypass.
    const paid = await h.deps.accountStore.createAccount("real-paid@test.dev", "Paid");
    await h.deps.accountStore.setSubscription(paid.id, { subscription_status: "active" });
    const free = await h.deps.accountStore.createAccount("attacker@test.dev", "Free");
    const token = await overQuotaToken(h.deps, h.app, free.id);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "content-type": "application/json", "x-machine-token": token },
      payload: { account_id: paid.id, service: "resend", run_id: "run-1" },
    });
    expect(res.statusCode).toBe(402);
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
});
