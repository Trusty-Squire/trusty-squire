// Billing routes — Stripe Checkout + Customer Portal entry points.
//
// Both are web-session-authed (the user is in a browser on the product
// site with a ts_session cookie). The account is taken from the verified
// session — never from the request body — so a caller can't open a
// checkout/portal session against someone else's account.
//
//   POST /v1/billing/checkout → Stripe Checkout Session URL (subscribe)
//   POST /v1/billing/portal   → Stripe Billing Portal URL (manage/cancel)
//
// The webhook that actually flips `subscription_status` lives in
// stripe-webhook.ts; these routes only start the hosted Stripe flow.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountStore } from "../services/in-memory-account-store.js";
import type { StripeClient } from "../services/stripe-client.js";
import { subscriptionUnlocksQuota } from "../services/subscription-status.js";
import { verifyUpgradeToken } from "../auth/upgrade-token.js";

export interface BillingRouteDeps {
  accountStore: AccountStore;
  // null when Stripe isn't configured (STRIPE_SECRET_KEY unset) — the
  // routes register regardless and 503, matching the webhook's posture.
  stripe: StripeClient | null;
  // Base URL of the product site, for Stripe success/cancel/return redirects.
  webBaseUrl: string;
  // Verifies the pre-authenticated upgrade token on /checkout-from-token.
  sessionSecret: string;
}

export async function registerBillingRoute(
  fastify: FastifyInstance,
  opts: {
    deps: BillingRouteDeps;
    requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  },
): Promise<void> {
  const billingUrl = `${opts.deps.webBaseUrl}/billing`;

  // Current billing state for the logged-in account — drives the
  // /billing page's Upgrade-vs-Manage choice. Stripe-config-independent
  // (reads our own DB), so it works even before Stripe is wired.
  fastify.get(
    "/v1/billing/status",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const account = await opts.deps.accountStore.findAccountById(req.auth!.account_id);
      if (account === null) {
        reply.code(404).send({ error: "account_not_found" });
        return;
      }
      reply.code(200).send({
        subscription_status: account.subscription_status,
        has_customer: account.stripe_customer_id !== null,
        current_period_end:
          account.current_period_end !== null ? account.current_period_end.toISOString() : null,
        // Set when active but scheduled to cancel at period end → UI shows
        // "active — cancels <date>". null when not cancelling.
        cancel_at: account.cancel_at !== null ? account.cancel_at.toISOString() : null,
      });
    },
  );

  fastify.post(
    "/v1/billing/checkout",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const stripe = opts.deps.stripe;
      if (stripe === null) {
        reply.code(503).send({ error: "billing_not_configured" });
        return;
      }
      const account = await opts.deps.accountStore.findAccountById(req.auth!.account_id);
      if (account === null) {
        reply.code(404).send({ error: "account_not_found" });
        return;
      }
      // Already subscribed → send them to the portal instead of opening a
      // second subscription.
      if (account.subscription_status === "active") {
        reply.code(409).send({ error: "already_subscribed" });
        return;
      }

      const session = await stripe.createCheckoutSession({
        accountId: account.id,
        customerEmail: account.email,
        ...(account.stripe_customer_id !== null
          ? { customerId: account.stripe_customer_id }
          : {}),
        successUrl: `${billingUrl}?status=success`,
        cancelUrl: `${billingUrl}?status=cancelled`,
      });
      reply.code(200).send({ url: session.url });
    },
  );

  // Pre-authenticated checkout. Exchanges a short-lived upgrade token (minted
  // at the paywall, auth/upgrade-token.ts) for a Stripe Checkout URL with NO
  // web session — so the user pays in one click from the agent's link instead
  // of doing a separate browser OAuth login. The token is the auth.
  fastify.post("/v1/billing/checkout-from-token", async (req, reply) => {
    const stripe = opts.deps.stripe;
    if (stripe === null) {
      reply.code(503).send({ error: "billing_not_configured" });
      return;
    }
    const body = req.body as { token?: unknown } | null;
    const token = body !== null && typeof body.token === "string" ? body.token : null;
    if (token === null) {
      reply.code(400).send({ error: "missing_token" });
      return;
    }
    const accountId = verifyUpgradeToken(token, opts.deps.sessionSecret, Date.now());
    if (accountId === null) {
      reply.code(401).send({ error: "invalid_or_expired_token" });
      return;
    }
    const account = await opts.deps.accountStore.findAccountById(accountId);
    if (account === null) {
      reply.code(404).send({ error: "account_not_found" });
      return;
    }
    if (subscriptionUnlocksQuota(account.subscription_status)) {
      // Already on the paid tier — nothing to buy. /upgrade sends them to /billing.
      reply.code(409).send({ error: "already_subscribed" });
      return;
    }
    const session = await stripe.createCheckoutSession({
      accountId: account.id,
      customerEmail: account.email,
      ...(account.stripe_customer_id !== null ? { customerId: account.stripe_customer_id } : {}),
      successUrl: `${billingUrl}?status=success`,
      cancelUrl: `${billingUrl}?status=cancelled`,
    });
    reply.code(200).send({ url: session.url });
  });

  fastify.post(
    "/v1/billing/portal",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const stripe = opts.deps.stripe;
      if (stripe === null) {
        reply.code(503).send({ error: "billing_not_configured" });
        return;
      }
      const account = await opts.deps.accountStore.findAccountById(req.auth!.account_id);
      if (account === null) {
        reply.code(404).send({ error: "account_not_found" });
        return;
      }
      if (account.stripe_customer_id === null) {
        // No Stripe customer yet → nothing to manage. The UI should only
        // show "Manage" once the account is/was subscribed.
        reply.code(409).send({ error: "no_stripe_customer" });
        return;
      }

      const session = await stripe.createBillingPortalSession({
        customerId: account.stripe_customer_id,
        returnUrl: billingUrl,
      });
      reply.code(200).send({ url: session.url });
    },
  );
}
