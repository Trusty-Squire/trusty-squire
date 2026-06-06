// Stripe webhook — the only writer of Account billing state.
//
//   Stripe → POST /v1/webhooks/stripe
//   → verify Stripe-Signature against the raw body (SDK, replay-window +
//     constant-time inside constructEvent)
//   → flip subscription_status on the mapped account
//
// Events handled:
//   checkout.session.completed     — first subscribe. client_reference_id
//                                    is our account id; stamp customer +
//                                    subscription + active.
//   customer.subscription.updated  — renew / status change / trial end.
//     /.deleted                     map customer→account, store status.
//
// Unknown event types are acked-and-ignored (Stripe fans many event types
// at one endpoint). The handler is idempotent — Stripe retries on non-2xx
// and may deliver duplicates, and every write is a last-writer-wins set.

import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import type { AccountStore, SubscriptionPatch } from "../services/in-memory-account-store.js";
import type { StripeClient } from "../services/stripe-client.js";

export interface StripeWebhookDeps {
  accountStore: AccountStore;
  // null when Stripe isn't configured — the route 503s, same as billing.ts.
  stripe: StripeClient | null;
}

export async function registerStripeWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: StripeWebhookDeps },
): Promise<void> {
  fastify.post("/v1/webhooks/stripe", async (req, reply) => {
    const stripe = opts.deps.stripe;
    if (stripe === null) {
      fastify.log.error("Stripe webhook rejected — Stripe not configured");
      reply.code(503).send({ error: "billing_not_configured" });
      return;
    }

    const signature = headerValue(req.headers["stripe-signature"]);
    if (signature === undefined) {
      reply.code(400).send({ error: "missing_stripe_signature" });
      return;
    }

    // Exact bytes Stripe signed. The application/json content-type parser
    // (server.ts) stashes them on req.rawBody.
    const reqAny = req as unknown as { rawBody?: string };
    const rawBody =
      typeof reqAny.rawBody === "string"
        ? reqAny.rawBody
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});

    let event: Stripe.Event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      fastify.log.warn({ err }, "Stripe webhook rejected — signature verification failed");
      reply.code(400).send({ error: "invalid_signature" });
      return;
    }

    try {
      await handleEvent(event, opts.deps.accountStore, fastify);
    } catch (err) {
      // A handler failure (e.g. DB blip) returns 500 so Stripe retries.
      fastify.log.error({ err, type: event.type }, "Stripe webhook handler failed");
      reply.code(500).send({ error: "handler_failed" });
      return;
    }

    reply.code(200).send({ received: true });
  });
}

async function handleEvent(
  event: Stripe.Event,
  accountStore: AccountStore,
  fastify: FastifyInstance,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const accountId = session.client_reference_id;
      if (accountId === null) {
        fastify.log.warn("checkout.session.completed without client_reference_id — ignored");
        return;
      }
      const patch: SubscriptionPatch = {
        subscription_status: "active",
        // Fresh checkout → clear any stale cancellation schedule from a prior sub.
        cancel_at: null,
        ...(stringId(session.customer) !== null
          ? { stripe_customer_id: stringId(session.customer)! }
          : {}),
        ...(stringId(session.subscription) !== null
          ? { subscription_id: stringId(session.subscription)! }
          : {}),
      };
      await accountStore.setSubscription(accountId, patch);
      fastify.log.info({ accountId }, "subscription activated via checkout");
      return;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = stringId(sub.customer);
      if (customerId === null) return;
      const account = await accountStore.findAccountByStripeCustomerId(customerId);
      if (account === null) {
        fastify.log.warn({ customerId }, "subscription event for unknown customer — ignored");
        return;
      }
      // On delete Stripe still reports the sub's last status; force "canceled"
      // so the account loses the paid tier regardless.
      const deleted = event.type === "customer.subscription.deleted";
      const status = deleted ? "canceled" : sub.status;
      // cancel_at is set when the user schedules a cancel-at-period-end (stays
      // active until then); null once the sub is gone or the cancel is undone.
      await accountStore.setSubscription(account.id, {
        subscription_status: status,
        subscription_id: sub.id,
        current_period_end: periodEnd(sub),
        cancel_at: deleted ? null : cancelAt(sub),
      });
      fastify.log.info(
        { accountId: account.id, status, cancelAt: cancelAt(sub)?.toISOString() ?? null },
        "subscription status updated",
      );
      return;
    }

    default:
      // Acked-and-ignored — Stripe sends many event types to one endpoint.
      return;
  }
}

// Stripe fields like `customer` / `subscription` are `string | {id} | null`
// depending on expansion. We never expand, so they arrive as ids — but
// narrow defensively.
function stringId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (value !== null && value !== undefined && typeof value.id === "string") return value.id;
  return null;
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  // current_period_end moved from the subscription to the item in newer API
  // versions (2026-04-22 returns it on items.data[0]); read both.
  const s = sub as unknown as {
    current_period_end?: number;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  const raw = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return typeof raw === "number" ? new Date(raw * 1000) : null;
}

// When the subscription is scheduled to cancel (cancel-at-period-end), Stripe
// sets `cancel_at` to the effective end. null = not scheduled to cancel.
function cancelAt(sub: Stripe.Subscription): Date | null {
  const raw = (sub as unknown as { cancel_at?: number | null }).cancel_at;
  return typeof raw === "number" ? new Date(raw * 1000) : null;
}

function headerValue(h: unknown): string | undefined {
  if (typeof h === "string") return h;
  if (Array.isArray(h) && typeof h[0] === "string") return h[0];
  return undefined;
}
