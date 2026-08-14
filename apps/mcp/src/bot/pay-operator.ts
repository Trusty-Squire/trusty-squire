import { createHash, timingSafeEqual } from "node:crypto";
import {
  classifyPaymentCandidateBinding,
  type PaymentCandidateHash,
  type PaymentCandidateKind,
} from "@trusty-squire/skill-schema";
import canonicalize from "canonicalize";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import { ApiCallError, type ApiClient, type PaymentApproval } from "../api-client.js";
import type { CheckoutCard, CheckoutSubmitResult, CheckoutSummary } from "./browser.js";
import { PaymentCardFillCleanupError, UnrecognizedPaymentFrameError } from "./browser.js";
import { generateOperatorKeypair, openSealed, type OperatorKeypair } from "./payment-hpke.js";

export interface OperatePayArgs {
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  // Absent = JIT add-card ceremony: the approval is minted card-less and the
  // card the user adds is bound SERVER-SIDE. On resume the operator reads that
  // bound card_ref back from the approval — never args.card_ref, which does not
  // exist in the JIT branch.
  card_ref?: string;
  item: string;
  reason: string;
  three_ds_wait_seconds?: number;
  // "fill_card" = split-checkout card entry: a SINGLE amount-bound approval
  // (one human passkey tap) both releases the vaulted card and authorizes the
  // eventual charge up to that amount, then fills payment fields WITHOUT
  // submitting. confirm later charges within that same approval — never a
  // second tap — and fails closed if the final total exceeds it.
  // Absent = the single-page fill+charge.
  phase?: "fill_card";
}

export interface PaymentBrowser {
  isPayPalHostedCheckout(): Promise<boolean>;
  readCheckoutSummary(fallbackCurrency?: string): Promise<CheckoutSummary>;
  readCheckoutConfirmSummary(): Promise<CheckoutSummary>;
  fillAndSubmitCheckout(card: CheckoutCard): Promise<CheckoutSubmitResult>;
  fillCheckoutCardFields(card: CheckoutCard): Promise<void>;
  submitFilledCheckout(): Promise<CheckoutSubmitResult>;
  clearSealedPaymentFields(): Promise<void>;
  clearCheckoutCardFields?(): Promise<void>;
  waitForThreeDsResolution(timeoutMs: number): Promise<"succeeded" | "failed" | "timeout">;
  currentUrl(): string;
}

// Everything the confirm step needs from a completed fill_card step. Held by
// the session layer (never the model): the raw card is NOT here — it was
// zeroed after the fill; the page holds the only copy until the charge.
export interface PendingCardFill {
  approval_id: string;
  approval_url: string;
  checkout: CheckoutSummary;
  card_ref: string;
  last4: string;
  mandate_id?: string;
}

export interface CartCheckoutObservation {
  checkout: CheckoutSummary;
  url: string;
  observedAt: number;
}

// Non-blocking approval [P0]: everything a LATER operate_pay call needs to
// validate and potentially resume the SAME approval. Held by the session layer
// only (never the model) — it carries the operator keypair's PRIVATE half. A
// live resumed approval must reuse that keypair because its sealed card was
// HPKE-encrypted to it; a stale approval is discarded with the key before a
// fresh approval is minted.
export interface PendingApprovalWait {
  approval_id: string;
  approval_url: string;
  nonce: string;
  agent: string;
  checkout: CheckoutSummary;
  jit: boolean;
  boundCardRef: string | null;
  // Absolute epoch ms — the OVERALL approval deadline, fixed at creation and
  // never extended on resume.
  deadline: number;
  rejectedCandidates: string[];
  // True after a legacy review-bound candidate was cryptographically verified.
  // It is resumable state only: review verification never authorizes a charge.
  reviewVerified?: boolean;
  keypair: OperatorKeypair;
  item: string;
  reason: string;
  cardRef?: string;
  phase?: "fill_card";
  three_ds_wait_seconds?: number;
}

interface PayDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  webBase: string;
  vouchflowApiBase: string;
  vouchflowExpectedAudience: string | undefined;
  approvalTimeoutMs: number;
  jitApprovalTimeoutMs: number;
  pollIntervalMs: number;
  surfaceApprovalUrl: (url: string) => void | Promise<void>;
  onCardResolved: (cardRef: string) => void;
  // fill_card only: hands the session layer what the later confirm step needs.
  onCardFilled: (pending: PendingCardFill) => void;
  onCardFillCleanupFailed: () => void;
  onSubmitStarted: () => void;
  // fill_card only, and only consulted when the live card-entry page itself
  // has no readable total (Rakuten-style split checkouts). The most recent
  // successfully-parsed checkout total observed earlier in THIS session (the
  // cart page), scoped to the same origin. Never sourced from tool input —
  // the approval still binds to a real, browser-read amount, never a
  // caller-supplied one.
  cartFallbackCheckout?: CartCheckoutObservation;
  // [P0] Resume a previously-created, still-pending approval instead of
  // minting a new one. Set by the MCP tool layer from session state when a
  // prior call on this checkout already returned approval_pending. When
  // present, args' merchant/amount/currency/card_ref/item/reason/phase are
  // IGNORED in favor of the resumed values — a later call can never mutate
  // the terms of an approval already presented to the human for signing.
  resumeFrom?: PendingApprovalWait;
  // [P0] How long (ms, from this call's start) THIS invocation will actively
  // poll for approval before giving up and returning approval_pending,
  // bounded by the overall approval deadline. Undefined = the legacy
  // behavior of waiting for the full approval/JIT timeout (used by direct
  // executeOperatePay callers, e.g. unit tests). The MCP tool layer passes a
  // short bound (0) so operate_pay never blocks the RPC waiting on a human.
  pollBudgetMs?: number;
  // [P0] Fired when a call ends still-pending (poll budget exhausted, human
  // hasn't responded yet) so the session layer can persist resumable state.
  onApprovalPending: (state: PendingApprovalWait) => void;
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

function candidateHash(bytes: Uint8Array): PaymentCandidateHash {
  return {
    base64url: Buffer.from(bytes).toString("base64url"),
    hex: Buffer.from(bytes).toString("hex"),
  };
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

interface PaymentCandidateBindingTerms {
  approvalId: string;
  checkout: CheckoutSummary;
  nonce: string;
  cardRef: string;
  operatorPublicKey: string;
  item: string;
  reason: string;
  agent: string;
}

interface PaymentCandidateBindingContext {
  kind: PaymentCandidateKind;
  approvalAad?: Uint8Array;
  reviewAad?: Uint8Array;
}

function paymentCandidateBindingContext(
  candidate: { jws: string | null; sealed_card: string | null },
  terms: PaymentCandidateBindingTerms | null,
): PaymentCandidateBindingContext {
  if (candidate.jws === null && candidate.sealed_card === null) return { kind: "none" };
  if (terms === null) return { kind: "invalid" };
  try {
    const recipientHash = createHash("sha256")
      .update(fromBase64Url(terms.operatorPublicKey))
      .digest();
    const canonical = canonicalize({
      approval_id: terms.approvalId,
      merchant: terms.checkout.merchant,
      checkout_origin: terms.checkout.checkout_origin,
      amount_cents: terms.checkout.amount_cents,
      currency: terms.checkout.currency,
      nonce: terms.nonce,
      card_ref: terms.cardRef,
      recipient_pubkey_hash: toBase64Url(recipientHash),
      item: terms.item,
      reason: terms.reason,
      agent: terms.agent,
    });
    if (canonical === undefined) return { kind: "invalid" };
    const approvalAad = new Uint8Array(createHash("sha256").update(canonical, "utf8").digest());
    const reviewCanonical = canonicalize({
      approval_id: terms.approvalId,
      approval_payload_sha256: toBase64Url(approvalAad),
      card_ref: terms.cardRef,
      recipient_pubkey_hash: toBase64Url(recipientHash),
    });
    if (reviewCanonical === undefined) return { kind: "invalid" };
    const reviewAad = new Uint8Array(createHash("sha256").update(reviewCanonical, "utf8").digest());
    let claimedPayloadHash: unknown;
    try {
      claimedPayloadHash =
        candidate.jws === null ? undefined : decodeJwt(candidate.jws).payload_sha256;
    } catch {
      claimedPayloadHash = undefined;
    }
    return {
      kind: classifyPaymentCandidateBinding({
        jws: candidate.jws,
        sealedCard: candidate.sealed_card,
        claimedPayloadHash,
        approvalPayloadHash: candidateHash(approvalAad),
        reviewPayloadHash: candidateHash(reviewAad),
      }),
      approvalAad,
      reviewAad,
    };
  } catch {
    return { kind: "invalid" };
  }
}

export function classifyApprovalCandidate(
  approval: Pick<PaymentApproval, "jws" | "sealed_card" | "card_ref">,
  state: PendingApprovalWait,
): PaymentCandidateKind {
  const cardRef = state.cardRef ?? approval.card_ref;
  return paymentCandidateBindingContext(
    { jws: approval.jws, sealed_card: approval.sealed_card },
    hasBoundCard(cardRef)
      ? {
          approvalId: state.approval_id,
          checkout: state.checkout,
          nonce: state.nonce,
          cardRef,
          operatorPublicKey: state.keypair.publicKey,
          item: state.item,
          reason: state.reason,
          agent: state.agent,
        }
      : null,
  ).kind;
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

// [P1] A bare payment_checkout_total_not_found left the host with no next
// step (friction audit finding). Name the exact safe action instead — go
// observe the page that shows the payable total — never a bare error string.
// This never substitutes a fallback amount itself; it only fires when no
// fallback was usable, so it changes the ERROR SHAPE, not what gets approved.
function needsCartTotalResult(
  phase: "fill_card" | undefined,
  cartUrl?: string,
): Record<string, unknown> {
  return {
    status: "needs_cart_total",
    reason: "checkout_total_not_on_page",
    next: {
      tool: "operate_observe",
      ...(cartUrl !== undefined ? { url: cartUrl } : {}),
      hint:
        phase === "fill_card"
          ? "No cart total has been observed yet this session for this checkout's origin. " +
            "Navigate to the cart or order-summary page that shows the payable total, call " +
            'operate_observe there, then retry operate_pay with phase="fill_card".'
          : "This checkout page has no readable total. If this is a split checkout (a separate " +
            "card-entry step whose total was shown earlier, e.g. on the cart page), retry with " +
            'phase="fill_card" after observing that total. Otherwise navigate to the page that ' +
            "shows the payable total and observe it first.",
    },
  };
}

function isLiveResumableApproval(
  approval: PaymentApproval,
  resume: PendingApprovalWait,
  now: number,
): boolean {
  if (approval.id !== resume.approval_id) return false;
  // The API always sends expires_at. Falling back to the deadline preserves
  // compatibility with narrowly mocked clients while still using the
  // server-issued expiry in production.
  const expiresAt = Date.parse(approval.expires_at);
  const deadline = Number.isFinite(expiresAt) ? expiresAt : resume.deadline;
  if (!Number.isFinite(deadline) || deadline <= now) return false;
  // "approved" is still resumable only while it carries the signed candidate
  // that this operator must verify and spend. An approved record without that
  // candidate is terminal and cannot safely authorize a retry.
  return (
    approval.status === "pending" ||
    (approval.status === "approved" &&
      typeof approval.jws === "string" &&
      typeof approval.sealed_card === "string")
  );
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
    onCardResolved: () => undefined,
    onCardFilled: () => undefined,
    onCardFillCleanupFailed: () => undefined,
    onSubmitStarted: () => undefined,
    onApprovalPending: () => undefined,
  };
}

function logPaymentReviewLifecycle(event: Record<string, string>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function logPaymentCandidateLifecycle(
  approvalId: string,
  candidateKind: PaymentCandidateKind,
  transitionOutcome: string,
  failureCode?: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "payment_candidate_lifecycle",
      approval_id: approvalId,
      candidate_kind: candidateKind,
      transition_outcome: transitionOutcome,
      ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    })}\n`,
  );
}

/** The signed-payment drift check, reusable before the approval ceremony begins. */
export function checkoutSummaryMatches(
  expected: CheckoutSummary,
  observed: CheckoutSummary | undefined,
): boolean {
  return (
    observed !== undefined &&
    observed.amount_cents === expected.amount_cents &&
    observed.currency === expected.currency &&
    observed.merchant === expected.merchant &&
    observed.checkout_origin === expected.checkout_origin
  );
}

export async function executeOperatePay(
  args: OperatePayArgs,
  api: ApiClient,
  browser: PaymentBrowser,
  overrides: Partial<PayDependencies> = {},
): Promise<Record<string, unknown>> {
  const deps = { ...defaultDependencies(), ...overrides };
  let resume = deps.resumeFrom;
  let keypair = resume !== undefined ? resume.keypair : await generateOperatorKeypair();
  let keypairHandedOff = resume !== undefined;
  let cardBytes: Uint8Array | undefined;
  let card: CheckoutCard | undefined;
  const initialResume = resume;
  let reviewVerified = resume?.reviewVerified ?? false;
  let resumableState: (() => PendingApprovalWait) | undefined =
    initialResume !== undefined ? () => initialResume : undefined;
  const rejectedCandidates = new Set<string>(resume?.rejectedCandidates ?? []);

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

    if (resume !== undefined) {
      let reusable = false;
      if (deps.now() < resume.deadline) {
        try {
          const live = await api.getPaymentApproval(resume.approval_id);
          reusable = isLiveResumableApproval(live, resume, deps.now());
        } catch (error) {
          if (!(error instanceof ApiCallError && error.code === "payment_approval_not_found")) {
            throw error;
          }
        }
      }
      if (!reusable) {
        // Never re-surface a stale capability URL or retain the private half
        // of a terminal approval's keypair. The fresh ceremony below mints a
        // new approval and surfaces its URL instead.
        resume.keypair.privateKey = "";
        resume = undefined;
        keypair = await generateOperatorKeypair();
        keypairHandedOff = false;
        resumableState = undefined;
        rejectedCandidates.clear();
        reviewVerified = false;
      }
    }

    const threeDsWaitSeconds =
      resume !== undefined ? resume.three_ds_wait_seconds : args.three_ds_wait_seconds;
    const threeDsWaitMs = Math.min(Math.max(threeDsWaitSeconds ?? 180, 0), 600) * 1000;

    let checkout: CheckoutSummary;
    let item: string;
    let reason: string;
    let jit: boolean;
    let approvalId: string;
    let nonce: string;
    let agent: string;
    let approvalUrl: string;
    let deadline: number;
    let boundCardRef: string | null;
    const cardRefArg = resume !== undefined ? resume.cardRef : args.card_ref;
    const phaseArg = resume !== undefined ? resume.phase : args.phase;

    if (resume !== undefined) {
      checkout = resume.checkout;
      item = resume.item;
      reason = resume.reason;
      jit = resume.jit;
      approvalId = resume.approval_id;
      nonce = resume.nonce;
      agent = resume.agent;
      approvalUrl = resume.approval_url;
      deadline = resume.deadline;
      boundCardRef = resume.boundCardRef;
    } else {
      try {
        checkout = await browser.readCheckoutSummary(args.currency);
      } catch (error) {
        if (error instanceof Error && error.message === "payment_checkout_currency_unresolved") {
          return {
            status: "payment_checkout_currency_unresolved",
            reason: "checkout_currency_unrecognized",
          };
        }
        if (
          error instanceof Error &&
          error.message === "payment_checkout_currency_unresolved_scale_mismatch"
        ) {
          // A page amount with fractional precision cannot be relabelled using an
          // agent hint for a zero- (or lower-) precision currency. Unlike a
          // missing total, this is an observed contradiction, so never mint an
          // approval from agent-supplied values.
          return {
            status: "payment_checkout_currency_unresolved",
            reason: "fallback_currency_scale_mismatch",
          };
        }
        if (error instanceof Error && error.message === "payment_checkout_total_not_found") {
          // Rakuten-style split checkouts show no total on the card-entry page
          // itself. Only for fill_card, fall back to the most recent total this
          // SAME session actually read from a real page (the cart step) — never
          // an agent-supplied amount. Any other reader failure above still fails.
          if (args.phase === "fill_card" && deps.cartFallbackCheckout !== undefined) {
            checkout = deps.cartFallbackCheckout.checkout;
          } else {
            return needsCartTotalResult(args.phase, deps.cartFallbackCheckout?.url);
          }
        } else {
          throw error;
        }
      }

      item = args.item;
      reason = args.reason;
      // JIT add-card ceremony: no card on file, so mint the approval card-less
      // and read the SERVER-BOUND card_ref back on resume. The has-card path
      // (args.card_ref present) is entirely untouched by this flag.
      jit = args.card_ref === undefined;

      const created = await api.createPaymentApproval({
        ...checkout,
        ...(args.card_ref !== undefined ? { card_ref: args.card_ref } : {}),
        operator_pubkey: keypair.publicKey,
        item,
        reason,
      });
      approvalId = created.id;
      nonce = created.nonce;
      agent = created.agent;
      approvalUrl = `${deps.webBase.replace(/\/+$/, "")}/vault/pay/${encodeURIComponent(created.id)}`;
      const waitBudgetMs = jit ? deps.jitApprovalTimeoutMs : deps.approvalTimeoutMs;
      const serverDeadline = Date.parse(created.expires_at);
      deadline = Number.isFinite(serverDeadline) ? serverDeadline : deps.now() + waitBudgetMs;
      boundCardRef = args.card_ref ?? null;
    }

    resumableState = () => ({
      approval_id: approvalId,
      approval_url: approvalUrl,
      nonce,
      agent,
      checkout,
      jit,
      boundCardRef,
      deadline,
      rejectedCandidates: [...rejectedCandidates],
      ...(reviewVerified ? { reviewVerified: true } : {}),
      keypair,
      item,
      reason,
      ...(cardRefArg !== undefined ? { cardRef: cardRefArg } : {}),
      ...(phaseArg === "fill_card" ? { phase: "fill_card" as const } : {}),
      ...(threeDsWaitSeconds !== undefined ? { three_ds_wait_seconds: threeDsWaitSeconds } : {}),
    });
    await deps.surfaceApprovalUrl(approvalUrl);

    // [P0] This call's own wait budget, bounded by the server approval expiry.
    // Undefined pollBudgetMs (direct executeOperatePay callers) = no additional
    // bound, i.e. the legacy full-deadline blocking behavior.
    const callDeadline =
      deps.pollBudgetMs === undefined
        ? deadline
        : Math.min(deadline, deps.now() + deps.pollBudgetMs);
    // True once this call's (not the overall) budget is exhausted with no
    // resolution — distinguishes "still pending, ask again" from "expired".
    let budgetExhausted = false;
    const shouldKeepPolling = (): boolean => {
      const now = deps.now();
      if (now >= deadline) return false;
      if (now >= callDeadline) {
        budgetExhausted = true;
        return false;
      }
      return true;
    };

    // In the JIT branch, the approval starts card-less; the card is bound
    // server-side mid-ceremony. Track the latest binding so a timeout/expiry
    // can distinguish "no card was ever added" (card_required) from "card was
    // stored but never approved" (payment_approval_timeout, card persists).
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
    let claims: JWTPayload | undefined;
    // Always runs at least once — a fresh call must make one live check
    // before ever reporting pending, and a resumed call with a zero poll
    // budget must too. Two things gate every re-entry to the top: (1) right
    // before each sleep, shouldKeepPolling() skips the sleep entirely when
    // the budget is already exhausted, so a not-yet-resolved call never
    // blocks on a real wait before returning; (2) the iteration>0 check
    // here re-validates AFTER that sleep (real time — or a mocked clock —
    // may have advanced past the deadline during it) so the loop never
    // spends one more live poll call past the budget it just decided to
    // respect.
    let iteration = 0;
    let immediateReviewFollowup = false;
    while (true) {
      if (iteration > 0 && !immediateReviewFollowup && !shouldKeepPolling()) break;
      immediateReviewFollowup = false;
      iteration++;
      const approval = await api.getPaymentApproval(
        approvalId,
        deps.now() < callDeadline ? true : "immediate",
      );
      boundCardRef = approval.card_ref;
      if (approval.status === "expired") {
        resumableState = undefined;
        keypairHandedOff = false;
        return timeoutResult();
      }
      const hasCandidate =
        typeof approval.jws === "string" && typeof approval.sealed_card === "string";
      if (approval.status === "approved" && !hasCandidate) {
        return {
          status: "payment_mandate_rejected",
          reason: "invalid_approval_payload",
          approval_url: approvalUrl,
        };
      }
      if (typeof approval.jws === "string" && typeof approval.sealed_card === "string") {
        const candidate = {
          jws: approval.jws,
          sealed_card: approval.sealed_card,
          card_ref: approval.card_ref,
        };
        const candidateKey = createHash("sha256")
          .update(JSON.stringify([candidate.jws, candidate.sealed_card]))
          .digest("base64url");
        if (!rejectedCandidates.has(candidateKey)) {
          rejectedCandidates.add(candidateKey);
          const cardRef = cardRefArg ?? candidate.card_ref;
          if (!hasBoundCard(cardRef)) {
            logPaymentCandidateLifecycle(approvalId, "invalid", "rejected", "card_ref_unbound");
            return {
              status: "payment_mandate_rejected",
              reason: "card_ref_unbound",
              candidate_kind: "invalid",
              approval_url: approvalUrl,
            };
          } else {
            const binding = paymentCandidateBindingContext(candidate, {
              approvalId,
              checkout,
              nonce,
              cardRef,
              operatorPublicKey: keypair.publicKey,
              item,
              reason,
              agent,
            });
            logPaymentCandidateLifecycle(approvalId, binding.kind, "observed");
            if (binding.kind === "invalid" || binding.kind === "none") {
              logPaymentCandidateLifecycle(
                approvalId,
                binding.kind,
                "rejected",
                "payload_hash_mismatch",
              );
              return {
                status: "payment_mandate_rejected",
                reason: "payload_hash_mismatch",
                candidate_kind: binding.kind,
                approval_url: approvalUrl,
              };
            }
            const candidateAad =
              binding.kind === "review" ? binding.reviewAad : binding.approvalAad;
            if (candidateAad === undefined) {
              logPaymentCandidateLifecycle(
                approvalId,
                binding.kind,
                "rejected",
                "canonicalization_failed",
              );
              return {
                status: "payment_mandate_rejected",
                reason: "canonicalization_failed",
                candidate_kind: binding.kind,
                approval_url: approvalUrl,
              };
            }
            let verifiedClaims: JWTPayload;
            try {
              verifiedClaims = await verifyMandate(
                candidate.jws,
                candidateAad,
                deps.vouchflowApiBase,
                expectedAudience,
                deps.fetch,
              );
            } catch (error) {
              const failureReason = safeFailureReason(error);
              logPaymentCandidateLifecycle(
                approvalId,
                binding.kind,
                "verification_failed",
                failureReason,
              );
              if (binding.kind === "review") {
                logPaymentReviewLifecycle({
                  event: "review_candidate_rejected",
                  approval_id: approvalId,
                  candidate_fingerprint: candidateKey,
                  failure_code: failureReason,
                });
                return {
                  status: "payment_review_verification_failed",
                  reason: failureReason,
                  candidate_kind: "review",
                  approval_url: approvalUrl,
                };
              }
              return {
                status:
                  approval.status === "approved"
                    ? "payment_mandate_rejected"
                    : "payment_mandate_verification_failed",
                reason: failureReason,
                candidate_kind: "approval",
                approval_url: approvalUrl,
              };
            }

            let candidateCardBytes: Uint8Array | undefined;
            let candidateCard: CheckoutCard;
            try {
              candidateCardBytes = await openSealed(
                keypair.privateKey,
                candidate.sealed_card,
                candidateAad,
              );
              candidateCard = normalizeCard(
                JSON.parse(new TextDecoder().decode(candidateCardBytes)) as unknown,
              );
            } catch {
              candidateCardBytes?.fill(0);
              logPaymentCandidateLifecycle(
                approvalId,
                binding.kind,
                "card_open_failed",
                "card_open_failed",
              );
              if (binding.kind === "review") {
                logPaymentReviewLifecycle({
                  event: "review_candidate_rejected",
                  approval_id: approvalId,
                  candidate_fingerprint: candidateKey,
                  failure_code: "card_open_failed",
                });
                return {
                  status: "payment_review_verification_failed",
                  reason: "card_open_failed",
                  candidate_kind: "review",
                  approval_url: approvalUrl,
                };
              }
              return {
                status: "payment_card_open_failed",
                reason: "card_open_failed",
                candidate_kind: "approval",
                approval_url: approvalUrl,
              };
            }

            if (binding.kind === "review") {
              try {
                const confirmation = await api.confirmPaymentApproval(approvalId, candidate);
                if (confirmation.status !== "verified") {
                  throw new Error("review_confirmation_failed");
                }
              } catch (error) {
                candidateCardBytes.fill(0);
                const failureReason =
                  error instanceof Error && /404|409/.test(error.message)
                    ? "confirm_status"
                    : "confirm_failed";
                logPaymentCandidateLifecycle(
                  approvalId,
                  "review",
                  "confirmation_failed",
                  failureReason,
                );
                logPaymentReviewLifecycle({
                  event: "review_candidate_rejected",
                  approval_id: approvalId,
                  candidate_fingerprint: candidateKey,
                  failure_code: failureReason,
                });
                return {
                  status: "payment_review_verification_failed",
                  reason: failureReason,
                  candidate_kind: "review",
                  approval_url: approvalUrl,
                };
              }
              reviewVerified = true;
              logPaymentCandidateLifecycle(approvalId, "review", "verified_final_required");
              logPaymentReviewLifecycle({
                event: "review_candidate_verified",
                approval_id: approvalId,
                candidate_fingerprint: candidateKey,
                failure_code: "ok",
              });
              candidateCardBytes.fill(0);
              immediateReviewFollowup = true;
              continue;
            }

            if (approval.status === "pending") {
              try {
                const confirmation = await api.confirmPaymentApproval(approvalId, candidate);
                if (confirmation.status !== "approved") throw new Error("confirm_status");
              } catch (error) {
                try {
                  const reconciliation = await api.confirmPaymentApproval(approvalId, candidate);
                  if (reconciliation.status !== "approved") throw error;
                } catch {
                  candidateCardBytes.fill(0);
                  logPaymentCandidateLifecycle(
                    approvalId,
                    "approval",
                    "confirmation_failed",
                    "confirm_failed",
                  );
                  throw error;
                }
              }
            }
            logPaymentCandidateLifecycle(approvalId, "approval", "ready_to_charge");
            cardBytes = candidateCardBytes;
            card = candidateCard;
            claims = verifiedClaims;
            approved = candidate;
            break;
          }
        }
      }
      if (!shouldKeepPolling()) break;
      await deps.sleep(deps.pollIntervalMs);
    }
    if (approved === undefined) {
      if (reviewVerified && budgetExhausted) {
        const state = resumableState();
        keypairHandedOff = true;
        deps.onApprovalPending(state);
        return {
          status: "approval_pending_final_signature",
          approval_id: approvalId,
          approval_url: approvalUrl,
          expires_at: new Date(deadline).toISOString(),
          phase: phaseArg ?? null,
          approved_amount_cents: checkout.amount_cents,
          currency: checkout.currency,
          merchant: checkout.merchant,
          candidate_kind: "review",
          ready_to_charge: false,
          next: {
            tool: "operate_payment_await",
            max_wait_seconds: 15,
            message:
              "The review signature was verified, but final payment approval is still required. " +
              "Refresh the approval page if it does not advance to the final approval prompt.",
          },
        };
      }
      if (budgetExhausted) {
        const state = resumableState();
        keypairHandedOff = true;
        deps.onApprovalPending(state);
        return {
          status: "approval_pending",
          approval_id: approvalId,
          approval_url: approvalUrl,
          expires_at: new Date(deadline).toISOString(),
          phase: phaseArg ?? null,
          approved_amount_cents: checkout.amount_cents,
          currency: checkout.currency,
          merchant: checkout.merchant,
          candidate_kind: "none",
          ready_to_charge: false,
          next: { tool: "operate_payment_await", max_wait_seconds: 15 },
        };
      }
      if (jit) {
        try {
          const final = await api.getPaymentApproval(approvalId);
          boundCardRef = final.card_ref;
        } catch {}
      }
      resumableState = undefined;
      keypairHandedOff = false;
      return timeoutResult();
    }

    if (claims === undefined || card === undefined) {
      resumableState = undefined;
      keypairHandedOff = false;
      return timeoutResult();
    }
    resumableState = undefined;
    keypairHandedOff = false;

    const cardRef = cardRefArg ?? approved.card_ref;
    if (!hasBoundCard(cardRef)) {
      return {
        status: "payment_mandate_rejected",
        reason: "card_ref_unbound",
        approval_url: approvalUrl,
      };
    }
    deps.onCardResolved(cardRef);

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
    // submitted on a mismatch; the outer finally zeroes it. Fresh has-card
    // calls retain their prior behavior; resumed has-card calls recheck too.
    if (phaseArg !== "fill_card" && (jit || resume !== undefined)) {
      let live: CheckoutSummary | undefined;
      try {
        live = await browser.readCheckoutSummary(args.currency);
      } catch {
        live = undefined;
      }
      if (!checkoutSummaryMatches(checkout, live)) {
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

    // Split-checkout card entry (phase="fill_card"): the human approval above
    // is a SINGLE amount-bound approval (one passkey tap) that both releases
    // the card here and authorizes the eventual charge up to checkout's
    // amount_cents — executeOperatePayConfirm charges within it, never a
    // second approval. The live check still needed here (the ceremony can
    // take minutes, and the fill targets the CURRENT page) is that the
    // browser remains on the origin the approval was signed for.
    if (phaseArg === "fill_card") {
      let liveOrigin: string | null;
      try {
        liveOrigin = new URL(browser.currentUrl()).origin;
      } catch {
        liveOrigin = null;
      }
      if (liveOrigin !== checkout.checkout_origin) {
        return {
          status: "payment_checkout_origin_mismatch",
          approval_url: approvalUrl,
          mandate_checkout_origin: checkout.checkout_origin,
          ...(liveOrigin !== null ? { live_checkout_origin: liveOrigin } : {}),
        };
      }
      try {
        await browser.fillCheckoutCardFields(card);
      } catch (error) {
        const frameOrigin =
          error instanceof UnrecognizedPaymentFrameError
            ? error.frameOrigin
            : error instanceof PaymentCardFillCleanupError
              ? error.frameOrigin
              : undefined;
        if (error instanceof PaymentCardFillCleanupError) {
          deps.onCardFillCleanupFailed();
        }
        if (frameOrigin !== undefined) {
          return {
            status: "payment_frame_not_recognized",
            frame_origin: frameOrigin,
            approval_url: approvalUrl,
            ...(error instanceof PaymentCardFillCleanupError
              ? { payment_fields_cleared: false }
              : {}),
            reason:
              "The card fields live in a cross-origin frame that is not a recognized " +
              "payment-provider surface; the vaulted card is never filled into an " +
              "unrecognized frame.",
          };
        }
        return {
          status: "payment_card_fill_failed",
          approval_url: approvalUrl,
          ...(error instanceof PaymentCardFillCleanupError
            ? { payment_fields_cleared: false }
            : {}),
          reason:
            error instanceof Error && /^payment_[a-z_]+(?::[a-z_]+)?$/.test(error.message)
              ? error.message
              : "payment_card_fill_failed",
        };
      } finally {
        cardBytes?.fill(0);
        cardBytes = undefined;
        card = undefined;
      }
      deps.onCardFilled({
        approval_id: approvalId,
        approval_url: approvalUrl,
        checkout,
        card_ref: cardRef,
        last4,
        ...(mandateId !== undefined ? { mandate_id: mandateId } : {}),
      });
      return {
        status: "payment_card_filled",
        approval_url: approvalUrl,
        merchant: checkout.merchant,
        amount_cents: checkout.amount_cents,
        currency: checkout.currency,
        last4,
        next:
          "Nothing was charged. Drive the checkout to the order-confirmation step (the page " +
          'showing the final total), then call operate_pay {phase:"confirm"} — it reads the ' +
          "final total and places the order if it does not exceed the amount already approved " +
          "here, with no further approval needed. A final total above the approved amount is " +
          "refused, never re-approved. Never click the pay/place-order control yourself.",
      };
    }

    let paymentStatus = "payment_submitted";
    let submitResult: CheckoutSubmitResult = { three_ds_required: false, order_confirmed: false };
    try {
      submitResult = await browser.fillAndSubmitCheckout(card);
      if (submitResult.three_ds_required) paymentStatus = "payment_3ds_required";
      else if (!submitResult.order_confirmed) paymentStatus = "payment_outcome_unknown";
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
      void api.notifyThreeDs(approvalId).catch(() => undefined);
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
  } catch (error) {
    if (resumableState !== undefined) {
      const state = resumableState();
      keypairHandedOff = true;
      deps.onApprovalPending(state);
    }
    throw error;
  } finally {
    cardBytes?.fill(0);
    cardBytes = undefined;
    card = undefined;
    if (!keypairHandedOff) {
      keypair.privateKey = "";
      keypair = { publicKey: "", privateKey: "" };
    }
  }
}

// The charge half of a split checkout: the card was filled by phase="fill_card"
// and the host has driven the checkout to its order-confirmation step. THIS is
// where the money moves, so the total-verification gate lives here: the live
// page must show a readable final total before the pay/place-order control is
// clicked. There is exactly ONE human approval per purchase (minted at fill) —
// confirm charges within that same approved amount and never mints a second
// one. A drifted origin/currency, or a final total above the approved amount,
// refuses closed instead.
export async function executeOperatePayConfirm(
  pending: PendingCardFill,
  args: { three_ds_wait_seconds?: number },
  api: ApiClient,
  browser: PaymentBrowser,
  overrides: { onSubmitStarted?: () => void } = {},
): Promise<Record<string, unknown>> {
  const threeDsWaitMs = Math.min(Math.max(args.three_ds_wait_seconds ?? 180, 0), 600) * 1000;
  const checkout = pending.checkout;
  const approvalUrl = pending.approval_url;

  let live: CheckoutSummary;
  try {
    live = await browser.readCheckoutConfirmSummary();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "payment_checkout_total_not_found") {
      // Confirmation fails closed when the live total disappears; the
      // approved amount is never used as a substitute at charge time.
      return {
        status: "payment_checkout_total_not_found",
        approval_url: approvalUrl,
        reason:
          "The confirm step requires the order total to be visible on the live page. " +
          "Navigate to the order-confirmation step, then retry.",
      };
    }
    if (message === "payment_checkout_currency_unresolved") {
      return {
        status: "payment_checkout_currency_unresolved",
        reason: "checkout_currency_unrecognized",
      };
    }
    if (message === "payment_checkout_currency_unresolved_scale_mismatch") {
      return {
        status: "payment_checkout_currency_unresolved",
        reason: "fallback_currency_scale_mismatch",
      };
    }
    if (message === "payment_checkout_total_conflict") {
      return {
        status: "payment_amount_mismatch",
        approval_url: approvalUrl,
        reason: "conflicting_checkout_totals",
      };
    }
    throw error;
  }
  // Merchant is deliberately NOT compared: it derives from the page title,
  // which legitimately changes between checkout steps ("Payment" → "Review
  // order"). Origin and currency are exact trust anchors — both were read for
  // real (the amount-bound approval at fill), never a caller-supplied value.
  if (live.checkout_origin !== checkout.checkout_origin || live.currency !== checkout.currency) {
    return {
      status: "payment_amount_mismatch",
      approval_url: approvalUrl,
      merchant: checkout.merchant,
      mandate_amount_cents: checkout.amount_cents,
      mandate_currency: checkout.currency,
      live_amount_cents: live.amount_cents,
      live_currency: live.currency,
      live_merchant: live.merchant,
      live_checkout_origin: live.checkout_origin,
    };
  }

  // Exactly one human approval per purchase: the fill-time approval already
  // authorizes a charge up to checkout.amount_cents. A live total at or below
  // it charges under that SAME approval — no second tap. A live total above
  // it refuses closed; there is deliberately no reapproval path here.
  if (live.amount_cents > checkout.amount_cents) {
    return {
      status: "payment_amount_exceeds_approval",
      approval_url: approvalUrl,
      merchant: checkout.merchant,
      approved_amount_cents: checkout.amount_cents,
      approved_currency: checkout.currency,
      live_amount_cents: live.amount_cents,
      live_currency: live.currency,
    };
  }

  let paymentStatus = "payment_submitted";
  let submitResult: CheckoutSubmitResult = { three_ds_required: false, order_confirmed: false };
  const clearPaymentFields = async (): Promise<boolean> => {
    try {
      if (browser.clearCheckoutCardFields !== undefined) {
        await browser.clearCheckoutCardFields();
      } else {
        await browser.clearSealedPaymentFields();
      }
      return true;
    } catch {
      return false;
    }
  };
  try {
    overrides.onSubmitStarted?.();
    submitResult = await browser.submitFilledCheckout();
    if (submitResult.three_ds_required) paymentStatus = "payment_3ds_required";
    else if (!submitResult.order_confirmed) paymentStatus = "payment_outcome_unknown";
  } catch (error) {
    const submitNotFound = error instanceof Error && error.message === "payment_submit_not_found";
    paymentStatus = submitNotFound ? "payment_checkout_failed" : "payment_outcome_unknown";
    const paymentFieldsCleared = submitNotFound ? false : await clearPaymentFields();
    let audit_recorded = true;
    try {
      await api.auditPayment({
        merchant: checkout.merchant,
        amount_cents: live.amount_cents,
        currency: live.currency,
        last4: pending.last4,
        status: paymentStatus,
        ...(pending.mandate_id !== undefined ? { mandate_id: pending.mandate_id } : {}),
      });
    } catch {
      audit_recorded = false;
    }
    return {
      status: paymentStatus,
      audit_recorded,
      reason: submitNotFound ? "payment_submit_not_found" : "payment_submit_outcome_unknown",
      approval_url: approvalUrl,
      ...(!submitNotFound ? { payment_fields_cleared: paymentFieldsCleared } : {}),
    };
  }
  // Submission serialized the card values; clear them from the page now, the
  // same point the single-page flow clears them.
  const paymentFieldsCleared = await clearPaymentFields();

  if (submitResult.three_ds_required && threeDsWaitMs > 0) {
    void api.notifyThreeDs(pending.approval_id).catch(() => undefined);
    const resolution = await browser.waitForThreeDsResolution(threeDsWaitMs);
    if (resolution === "succeeded") paymentStatus = "payment_submitted";
    if (resolution === "failed") paymentStatus = "payment_declined";
  }

  let auditRecorded = true;
  try {
    await api.auditPayment({
      merchant: checkout.merchant,
      amount_cents: live.amount_cents,
      currency: live.currency,
      last4: pending.last4,
      status: paymentStatus,
      ...(pending.mandate_id !== undefined ? { mandate_id: pending.mandate_id } : {}),
    });
  } catch {
    auditRecorded = false;
  }
  if (paymentStatus === "payment_3ds_required") {
    return {
      status: paymentStatus,
      audit_recorded: auditRecorded,
      approval_url: approvalUrl,
      payment_fields_cleared: paymentFieldsCleared,
      ...(submitResult.challenge_url !== undefined
        ? { challenge_url: submitResult.challenge_url }
        : {}),
      needs_user: {
        wall: "3ds",
        message: "The issuer requires 3-D Secure authentication. Complete it in the open checkout.",
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
      payment_fields_cleared: paymentFieldsCleared,
    };
  }
  return {
    status: paymentStatus,
    audit_recorded: auditRecorded,
    approval_url: approvalUrl,
    merchant: checkout.merchant,
    amount_cents: live.amount_cents,
    currency: live.currency,
    payment_fields_cleared: paymentFieldsCleared,
  };
}
