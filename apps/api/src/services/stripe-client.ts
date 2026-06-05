// Stripe integration surface.
//
// A thin interface over the three Stripe operations the billing flow
// needs — open a Checkout Session, open a Billing Portal session, and
// verify + parse an inbound webhook. Routes depend on the INTERFACE so
// tests inject a fake; production wires the SDK-backed impl from env.
//
// Why the SDK and not raw fetch: webhook signature verification is the
// one place hand-rolled crypto is genuinely dangerous (replay window +
// constant-time compare), and `stripe.webhooks.constructEvent` gets it
// right. Session creation is one typed call each.

import Stripe from "stripe";

export interface CheckoutSessionInput {
  accountId: string;
  customerEmail: string;
  // Reuse an existing Stripe customer when the account already has one
  // (avoids a duplicate customer per upgrade); omit to let Stripe make one.
  customerId?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalSessionInput {
  customerId: string;
  returnUrl: string;
}

export interface StripeClient {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string }>;
  createBillingPortalSession(input: PortalSessionInput): Promise<{ url: string }>;
  // Verify the Stripe-Signature header against the raw body and return the
  // parsed event. Throws if the signature is invalid or outside the
  // tolerance window — callers turn that into a 400.
  constructWebhookEvent(rawBody: string, signature: string): Stripe.Event;
}

export class SdkStripeClient implements StripeClient {
  constructor(
    private readonly stripe: Stripe,
    private readonly priceId: string,
    private readonly webhookSecret: string,
  ) {}

  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.priceId, quantity: 1 }],
      // client_reference_id ties the completed-checkout webhook back to our
      // account; it's the only account identifier Stripe echoes for us.
      client_reference_id: input.accountId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.customerId !== undefined
        ? { customer: input.customerId }
        : { customer_email: input.customerEmail }),
    });
    if (session.url === null) {
      throw new Error("stripe checkout session returned no url");
    }
    return { url: session.url };
  }

  async createBillingPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}

// Build the SDK-backed client from env, or null when Stripe isn't
// configured (STRIPE_SECRET_KEY unset) — the routes register either way
// and return 503 when the client is null, mirroring the resend webhook's
// fail-closed posture. STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET fall back
// to empty strings so a partial config still surfaces as a loud runtime
// error at the relevant call rather than a boot crash.
export function stripeClientFromEnv(env: NodeJS.ProcessEnv = process.env): StripeClient | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (secretKey === undefined || secretKey.length === 0) return null;
  const stripe = new Stripe(secretKey);
  return new SdkStripeClient(
    stripe,
    env.STRIPE_PRICE_ID ?? "",
    env.STRIPE_WEBHOOK_SECRET ?? "",
  );
}
