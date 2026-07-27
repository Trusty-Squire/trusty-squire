import { createHash, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import type { CheckoutCard, CheckoutSubmitResult, CheckoutSummary } from "./browser.js";
import { generateOperatorKeypair, openSealed } from "./payment-hpke.js";

export interface OperatePayArgs {
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  // Absent = JIT add-card ceremony: the approval is minted card-less and the
  // card the user adds is bound SERVER-SIDE. On resume the operator reads that
  // bound card_ref back from the approval — never args.card_ref, which does not
  // exist in the JIT branch.
  card_ref?: string;
  item?: string;
  reason?: string;
  three_ds_wait_seconds?: number;
}

export interface PaymentBrowser {
  readCheckoutSummary(fallbackCurrency?: string): Promise<CheckoutSummary>;
  fillAndSubmitCheckout(card: CheckoutCard): Promise<CheckoutSubmitResult>;
  waitForThreeDsResolution(timeoutMs: number): Promise<"succeeded" | "failed" | "timeout">;
  currentUrl(): string;
}

interface PayDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  webBase: string;
  vouchflowApiBase: string;
  vouchflowExpectedAudience: string | undefined;
  approvalTimeoutMs: number;
  // JIT add-card ceremony wait budget. Longer than the normal has-card wait:
  // the first purchase is a first-time card+billing form plus one or more
  // WebAuthn prompts, so the operator waits ~15-20 min (bounded by the server
  // approval TTL). Only used when args.card_ref is absent.
  jitApprovalTimeoutMs: number;
  pollIntervalMs: number;
  surfaceApprovalUrl: (url: string) => void | Promise<void>;
}

const cardSchema = z.object({
  pan: z.string().min(12).max(32),
  exp_month: z.union([z.string(), z.number()]).transform(String),
  exp_year: z.union([z.string(), z.number()]).transform(String),
  name: z.string().min(1).max(256),
  cvv: z.string().regex(/^\d{3,4}$/),
  billing: z.object({
    line1: z.string().min(1).max(256),
    line2: z.string().max(256).optional(),
    city: z.string().min(1).max(128),
    state: z.string().max(128).optional(),
    postal_code: z.string().min(1).max(32),
    country: z.string().min(2).max(64),
  }),
});

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodePayloadHash(claim: unknown): Uint8Array {
  if (typeof claim !== "string") throw new Error("missing_payload_sha256");
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(claim)) {
    bytes = new Uint8Array(Buffer.from(claim, "hex"));
  } else if (/^[A-Za-z0-9_-]{43}$/.test(claim)) {
    bytes = fromBase64Url(claim);
  } else {
    throw new Error("invalid_payload_sha256");
  }
  if (bytes.byteLength !== 32) throw new Error("invalid_payload_sha256");
  return bytes;
}

function normalizeCard(value: unknown): CheckoutCard {
  const parsed = cardSchema.parse(value);
  const pan = parsed.pan.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(pan)) throw new Error("invalid_card_pan");
  const month = Number(parsed.exp_month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("invalid_card_expiry");
  }
  const year = parsed.exp_year.trim();
  if (!/^\d{2}(?:\d{2})?$/.test(year)) throw new Error("invalid_card_expiry");
  return {
    pan,
    exp_month: String(month).padStart(2, "0"),
    exp_year: year,
    name: parsed.name,
    cvv: parsed.cvv,
    billing: {
      line1: parsed.billing.line1,
      city: parsed.billing.city,
      postal_code: parsed.billing.postal_code,
      country: parsed.billing.country,
      ...(parsed.billing.line2 !== undefined ? { line2: parsed.billing.line2 } : {}),
      ...(parsed.billing.state !== undefined ? { state: parsed.billing.state } : {}),
    },
  };
}

// Web passkeys are inherently rated "low" in Vouchflow (platform:"web" is
// capped low regardless of biometric), so a web-based approval can never
// reach medium. The mandate's assurance therefore rests on user-presence +
// single-use nonce + amount/recipient/origin/item binding, not the confidence
// tier — so the floor accepts any of the three tiers. Must match the phone's
// signPayload minConfidence (apps/web/app/vault/pay/[id]/page.tsx).
function confidenceAtLeastLow(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high";
}

async function verifyMandate(
  jws: string,
  expectedHash: Uint8Array,
  vouchflowApiBase: string,
  expectedAudience: string,
  fetchImpl: typeof fetch,
): Promise<JWTPayload> {
  const jwksUrl = `${vouchflowApiBase.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetchImpl(jwksUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? "jwks_fetch_timeout" : "jwks_fetch_failed");
  }
  if (!response.ok) throw new Error("jwks_fetch_failed");
  const body = (await response.json()) as unknown;
  if (
    body === null ||
    typeof body !== "object" ||
    !("keys" in body) ||
    !Array.isArray((body as { keys: unknown }).keys)
  ) {
    throw new Error("invalid_jwks");
  }
  const { payload } = await jwtVerify(jws, createLocalJWKSet(body as JSONWebKeySet), {
    issuer: "https://vouchflow.dev",
    audience: expectedAudience,
  });
  const signedHash = decodePayloadHash(payload.payload_sha256);
  if (!timingSafeEqual(Buffer.from(expectedHash), Buffer.from(signedHash))) {
    throw new Error("payload_hash_mismatch");
  }
  if (payload.context !== "purchase") throw new Error("invalid_mandate_context");
  if (!confidenceAtLeastLow(payload.confidence)) {
    throw new Error("insufficient_mandate_confidence");
  }
  return payload;
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    "jwks_fetch_failed",
    "jwks_fetch_timeout",
    "vouchflow_expected_audience_unset",
    "invalid_jwks",
    "missing_payload_sha256",
    "invalid_payload_sha256",
    "payload_hash_mismatch",
    "invalid_mandate_context",
    "insufficient_mandate_confidence",
    "invalid_card_pan",
    "invalid_card_expiry",
  ];
  return known.includes(message) ? message : "mandate_verification_failed";
}

// A card_ref counts as "bound" only when it is a non-blank string. Used for
// both the timeout classification (no card → card_required) and the resume
// guard (never canonicalize over an empty/whitespace ref), so the two agree.
function hasBoundCard(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ref.trim().length > 0;
}

// Terminal for every JIT path that ends without a card on file (link expired
// before a card was added, add-card failed, or abandoned before card entry).
// Extends the host-facing needs_user.wall vocabulary with "card_required".
function cardRequiredResult(
  approvalUrl: string,
  checkout: CheckoutSummary,
  reason: string,
): Record<string, unknown> {
  return {
    status: "payment_card_required",
    approval_url: approvalUrl,
    merchant: checkout.merchant,
    amount_cents: checkout.amount_cents,
    currency: checkout.currency,
    needs_user: {
      wall: "card_required",
      reason,
      message: `No payment card is on file — ${reason}. Re-run the payment to get a fresh add-card link.`,
      resume: "operate_pay",
    },
  };
}

function defaultDependencies(): PayDependencies {
  return {
    fetch,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    webBase: process.env.TRUSTY_SQUIRE_WEB_BASE ?? "https://trustysquire.ai",
    vouchflowApiBase: process.env.VOUCHFLOW_API_BASE ?? "https://api.vouchflow.dev",
    vouchflowExpectedAudience: process.env.VOUCHFLOW_EXPECTED_AUDIENCE?.trim() || undefined,
    approvalTimeoutMs: 5 * 60 * 1000,
    jitApprovalTimeoutMs: 18 * 60 * 1000,
    pollIntervalMs: 3_000,
    surfaceApprovalUrl: (url) => {
      process.stderr.write(
        `${JSON.stringify({ marker: "payment-approval", approval_url: url })}\n`,
      );
    },
  };
}

export async function executeOperatePay(
  args: OperatePayArgs,
  api: ApiClient,
  browser: PaymentBrowser,
  overrides: Partial<PayDependencies> = {},
): Promise<Record<string, unknown>> {
  const deps = { ...defaultDependencies(), ...overrides };
  const threeDsWaitMs = Math.min(Math.max(args.three_ds_wait_seconds ?? 180, 0), 600) * 1000;
  let keypair = await generateOperatorKeypair();
  let cardBytes: Uint8Array | undefined;
  let card: CheckoutCard | undefined;

  try {
    const apiAudience =
      deps.vouchflowExpectedAudience === undefined
        ? (await api.getPaymentConfig()).vouchflow_audience?.trim()
        : undefined;
    const expectedAudience = deps.vouchflowExpectedAudience ?? apiAudience;
    if (expectedAudience === undefined || expectedAudience.length === 0) {
      return {
        status: "payment_configuration_error",
        reason: "vouchflow_expected_audience_unset",
        configuration: "Set VOUCHFLOW_CUSTOMER_ID on the Trusty Squire API.",
      };
    }

    let checkout: CheckoutSummary;
    try {
      checkout = await browser.readCheckoutSummary(args.currency);
    } catch (error) {
      if (
        !(error instanceof Error && error.message === "payment_checkout_total_not_found") ||
        args.merchant === undefined ||
        args.amount_cents === undefined ||
        args.currency === undefined
      ) {
        throw error;
      }
      checkout = {
        merchant: args.merchant,
        checkout_origin: new URL(browser.currentUrl()).origin,
        amount_cents: args.amount_cents,
        currency: args.currency.toUpperCase(),
      };
    }

    const item = args.item ?? "";
    const reason = args.reason ?? "";
    // JIT add-card ceremony: no card on file, so mint the approval card-less
    // and read the SERVER-BOUND card_ref back on resume. The has-card path
    // (args.card_ref present) is entirely untouched by this flag.
    const jit = args.card_ref === undefined;

    const created = await api.createPaymentApproval({
      ...checkout,
      ...(args.card_ref !== undefined ? { card_ref: args.card_ref } : {}),
      operator_pubkey: keypair.publicKey,
      item,
      reason,
    });
    const approvalUrl = `${deps.webBase.replace(/\/+$/, "")}/vault/pay/${encodeURIComponent(created.id)}`;
    await deps.surfaceApprovalUrl(approvalUrl);

    // A JIT ceremony (first-time card form + passkey) needs a longer wait than
    // a tap-to-approve on a card already on file. Both are still bounded by the
    // server-issued approval TTL (expires_at) below.
    const waitBudgetMs = jit ? deps.jitApprovalTimeoutMs : deps.approvalTimeoutMs;
    const deadline = Math.min(
      deps.now() + waitBudgetMs,
      Number.isFinite(Date.parse(created.expires_at))
        ? Date.parse(created.expires_at)
        : Number.POSITIVE_INFINITY,
    );

    // In the JIT branch, the approval starts card-less; the card is bound
    // server-side mid-ceremony. Track the latest binding so a timeout/expiry
    // can distinguish "no card was ever added" (card_required) from "card was
    // stored but never approved" (payment_approval_timeout, card persists).
    let boundCardRef: string | null = args.card_ref ?? null;
    const timeoutResult = (): Record<string, unknown> => {
      if (jit && !hasBoundCard(boundCardRef)) {
        return cardRequiredResult(
          approvalUrl,
          checkout,
          "the add-card link expired before a card was added",
        );
      }
      const base: Record<string, unknown> = {
        status: "payment_approval_timeout",
        approval_url: approvalUrl,
        merchant: checkout.merchant,
        amount_cents: checkout.amount_cents,
        currency: checkout.currency,
      };
      // JIT + a bound card = the user added a card but never approved. The card
      // stays in the vault, so the retry is a fast has-card approval.
      return jit ? { ...base, card_persisted: true } : base;
    };

    let approved: { jws: string; sealed_card: string; card_ref: string | null } | undefined;
    while (deps.now() < deadline) {
      const approval = await api.getPaymentApproval(created.id);
      boundCardRef = approval.card_ref;
      if (approval.status === "expired") {
        return timeoutResult();
      }
      if (
        approval.status === "approved" &&
        typeof approval.jws === "string" &&
        typeof approval.sealed_card === "string"
      ) {
        approved = {
          jws: approval.jws,
          sealed_card: approval.sealed_card,
          card_ref: approval.card_ref,
        };
        break;
      }
      if (approval.status === "approved") {
        return {
          status: "payment_mandate_rejected",
          reason: "invalid_approval_payload",
          approval_url: approvalUrl,
        };
      }
      await deps.sleep(deps.pollIntervalMs);
    }
    if (approved === undefined) {
      return timeoutResult();
    }

    // [P1] Canonicalize with the SERVER-BOUND card_ref. In the has-card path
    // args.card_ref is present and identical to the echoed binding, so the
    // canonical bytes are byte-for-byte what they were before this branch
    // existed. In the JIT path args.card_ref is absent, so the operator MUST
    // use the card_ref the ceremony bound — anything else hash-mismatches
    // verifyMandate and silently rejects every JIT payment.
    const cardRef = args.card_ref ?? approved.card_ref;
    if (!hasBoundCard(cardRef)) {
      // The server 409s an approve on a null card_ref, so a JIT approval can
      // only reach "approved" with a bound card. Fail closed if that invariant
      // is ever violated rather than canonicalize with an empty ref.
      return {
        status: "payment_mandate_rejected",
        reason: "card_ref_unbound",
        approval_url: approvalUrl,
      };
    }

    const publicKeyBytes = fromBase64Url(keypair.publicKey);
    const recipientHash = createHash("sha256").update(publicKeyBytes).digest();
    const canonical = canonicalize({
      merchant: checkout.merchant,
      checkout_origin: checkout.checkout_origin,
      amount_cents: checkout.amount_cents,
      currency: checkout.currency,
      nonce: created.nonce,
      card_ref: cardRef,
      recipient_pubkey_hash: toBase64Url(recipientHash),
      item,
      reason,
      agent: created.agent,
    });
    if (canonical === undefined) {
      return {
        status: "payment_mandate_rejected",
        reason: "canonicalization_failed",
        approval_url: approvalUrl,
      };
    }
    const aad = new Uint8Array(createHash("sha256").update(canonical, "utf8").digest());

    let claims: JWTPayload;
    try {
      claims = await verifyMandate(
        approved.jws,
        aad,
        deps.vouchflowApiBase,
        expectedAudience,
        deps.fetch,
      );
    } catch (error) {
      return {
        status: "payment_mandate_rejected",
        reason: safeFailureReason(error),
        approval_url: approvalUrl,
      };
    }

    try {
      cardBytes = await openSealed(keypair.privateKey, approved.sealed_card, aad);
      card = normalizeCard(JSON.parse(new TextDecoder().decode(cardBytes)) as unknown);
    } catch {
      return {
        status: "payment_card_open_failed",
        approval_url: approvalUrl,
      };
    }

    const last4 = card.pan.slice(-4);
    const mandateId =
      typeof claims.mandate_id === "string"
        ? claims.mandate_id
        : typeof claims.session_id === "string"
          ? claims.session_id
          : typeof claims.jti === "string"
            ? claims.jti
            : undefined;
    // [#13][P1] JIT nearly doubles the window between reading the checkout and
    // filling it, so a mid-ceremony navigation could swap the merchant, origin,
    // or total out from under the signed mandate. Re-read the live checkout
    // immediately before filling (smallest possible time-of-check→time-of-use
    // gap) and refuse if ANY signed field the mandate binds — merchant, origin,
    // amount, currency — drifted. The card was opened above but is never
    // submitted on a mismatch; the outer finally zeroes it. The has-card path
    // (jit === false) skips this entirely — its behavior is unchanged.
    if (jit) {
      let live: CheckoutSummary | undefined;
      try {
        live = await browser.readCheckoutSummary(args.currency);
      } catch {
        live = undefined;
      }
      if (
        live === undefined ||
        live.amount_cents !== checkout.amount_cents ||
        live.currency !== checkout.currency ||
        live.merchant !== checkout.merchant ||
        live.checkout_origin !== checkout.checkout_origin
      ) {
        return {
          status: "payment_amount_mismatch",
          approval_url: approvalUrl,
          merchant: checkout.merchant,
          mandate_amount_cents: checkout.amount_cents,
          mandate_currency: checkout.currency,
          ...(live !== undefined
            ? {
                live_amount_cents: live.amount_cents,
                live_currency: live.currency,
                live_merchant: live.merchant,
                live_checkout_origin: live.checkout_origin,
              }
            : {}),
        };
      }
    }

    let paymentStatus = "payment_submitted";
    let submitResult: CheckoutSubmitResult = { three_ds_required: false };
    try {
      submitResult = await browser.fillAndSubmitCheckout(card);
      if (submitResult.three_ds_required) paymentStatus = "payment_3ds_required";
    } catch (error) {
      paymentStatus = "payment_checkout_failed";
      let audit_recorded = true;
      try {
        await api.auditPayment({
          ...checkout,
          last4,
          status: paymentStatus,
          ...(mandateId !== undefined ? { mandate_id: mandateId } : {}),
        });
      } catch {
        audit_recorded = false;
      }
      return {
        status: paymentStatus,
        audit_recorded,
        reason:
          error instanceof Error && /^payment_[a-z_]+(?::[a-z_]+)?$/.test(error.message)
            ? error.message
            : "payment_checkout_failed",
        approval_url: approvalUrl,
      };
    } finally {
      cardBytes?.fill(0);
      cardBytes = undefined;
      card = undefined;
    }

    if (submitResult.three_ds_required && threeDsWaitMs > 0) {
      void api.notifyThreeDs(created.id).catch(() => undefined);
      const resolution = await browser.waitForThreeDsResolution(threeDsWaitMs);
      if (resolution === "succeeded") paymentStatus = "payment_submitted";
      if (resolution === "failed") paymentStatus = "payment_declined";
    }

    let auditRecorded = true;
    try {
      await api.auditPayment({
        ...checkout,
        last4,
        status: paymentStatus,
        ...(mandateId !== undefined ? { mandate_id: mandateId } : {}),
      });
    } catch {
      auditRecorded = false;
    }
    if (paymentStatus === "payment_3ds_required") {
      return {
        status: paymentStatus,
        audit_recorded: auditRecorded,
        approval_url: approvalUrl,
        ...(submitResult.challenge_url !== undefined
          ? { challenge_url: submitResult.challenge_url }
          : {}),
        needs_user: {
          wall: "3ds",
          message:
            "The issuer requires 3-D Secure authentication. Complete it in the open checkout.",
          resume: "checkout",
          ...(submitResult.challenge_url !== undefined ? { url: submitResult.challenge_url } : {}),
        },
      };
    }
    if (paymentStatus === "payment_declined") {
      return {
        status: paymentStatus,
        audit_recorded: auditRecorded,
        approval_url: approvalUrl,
      };
    }
    return {
      status: paymentStatus,
      audit_recorded: auditRecorded,
      approval_url: approvalUrl,
      merchant: checkout.merchant,
      amount_cents: checkout.amount_cents,
      currency: checkout.currency,
    };
  } finally {
    cardBytes?.fill(0);
    cardBytes = undefined;
    card = undefined;
    keypair.privateKey = "";
    keypair = { publicKey: "", privateKey: "" };
  }
}
