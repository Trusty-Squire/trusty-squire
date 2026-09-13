import { createHash, timingSafeEqual } from "node:crypto";
import {
  classifyPaymentCandidateBinding,
  type PaymentCandidateHash,
  type PaymentCandidateKind,
} from "@trusty-squire/skill-schema";
import canonicalize from "canonicalize";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import {
  ApiCallError,
  isPaymentApprovalTransportTimeout,
  type ApiClient,
  type PaymentApproval,
} from "../api-client.js";
import type {
  CheckoutCard,
  CheckoutSummary,
} from "./browser.js";
import { generateOperatorKeypair, openSealed, type OperatorKeypair } from "./payment-hpke.js";

export interface InjectCardApprovalArgs {
  merchant: string;
  amount_cents: number;
  currency: string;
  card_ref: string;
  item: string;
  reason: string;
}

export type TerminalPaymentApprovalStatus = "denied" | "expired" | "payment_confirmation_failed";

export interface CardReleaseBrowser {
  fillCheckoutCardFields(card: CheckoutCard, options?: { deadline?: number }): Promise<void>;
  currentUrl(): string;
}

// Approved terms and card identity returned after the operator opens the card.
// The raw card is handed to the browser callback and never appears here.
export interface ReleasedCardApproval {
  approval_id: string;
  approval_url: string;
  checkout: CheckoutSummary;
  card_ref: string;
  last4: string;
  mandate_id?: string;
  deadline?: number;
}

// Resumable approval state: everything a later inject_card call needs to
// validate and continue the SAME approval after a bounded wait. Held by the
// session layer only (never the model) — it carries the operator keypair's
// PRIVATE half. A live resumed approval must reuse that keypair because its
// sealed card was HPKE-encrypted to it; denial or expiry scrubs the key and
// retains terminal custody instead of minting a replacement approval.
export interface PendingApprovalWait {
  approval_id: string;
  approval_url: string;
  nonce: string;
  agent: string;
  account_binding: string;
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
}

interface CardReleaseDependencies {
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
  // Hands the session layer the approved card identity and terms.
  onCardFilled: (pending: ReleasedCardApproval) => void;
  // [P0] Resume a previously-created, still-pending approval instead of
  // minting a new one. Set by the MCP tool layer from session state when a
  // prior call on this checkout already returned approval_pending. When
  // present, args' merchant/amount/currency/card_ref/item/reason/phase are
  // IGNORED in favor of the resumed values — a later call can never mutate
  // the terms of an approval already presented to the human for signing.
  resumeFrom?: PendingApprovalWait;
  // [P0] How long (ms, from this call's start) THIS invocation will actively
  // wait for approval before giving up and returning approval_pending,
  // bounded by the overall approval deadline. Undefined = the legacy
  // behavior of waiting for the full approval/JIT timeout (used by direct
  // executeCardReleaseApproval callers, e.g. unit tests). The MCP tool layer passes a
  // bounded human-response window so approval detection belongs to the system,
  // while an exhausted client call can resume this same approval cleanly.
  pollBudgetMs?: number;
  // [P0] Fired when a call ends still-pending (poll budget exhausted, human
  // hasn't responded yet) so the session layer can persist resumable state.
  onApprovalPending: (state: PendingApprovalWait) => void;
  // Terminal approval outcomes retain session custody so a later call cannot
  // automatically mint another approval for the same attempt.
  onApprovalTerminal: (
    state: PendingApprovalWait,
    terminalStatus: TerminalPaymentApprovalStatus,
  ) => void;
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
  accountBinding: string;
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
      account_binding: terms.accountBinding,
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
          accountBinding: state.account_binding,
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

const MAX_PREVERIFIED_MANDATE_RELAY_MS = 18 * 60 * 1_000;

function isJwtExpired(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_JWT_EXPIRED"
  );
}

async function verifyRelayedAssertion(
  jws: string,
  jwks: ReturnType<typeof createLocalJWKSet>,
  expectedAudience: string,
): Promise<JWTPayload> {
  const options = {
    issuer: "https://vouchflow.dev",
    audience: expectedAudience,
  } as const;
  try {
    return (await jwtVerify(jws, jwks, options)).payload;
  } catch (error) {
    if (!isJwtExpired(error)) throw error;
    const decoded = decodeJwt(jws);
    const issuedAt = decoded.iat;
    const expiresAt = decoded.exp;
    const now = Date.now();
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt! <= issuedAt! ||
      now - expiresAt! * 1_000 > MAX_PREVERIFIED_MANDATE_RELAY_MS
    ) {
      throw new Error("mandate_assertion_expired");
    }
    return (
      await jwtVerify(jws, jwks, {
        ...options,
        currentDate: new Date((expiresAt! - 1) * 1_000),
      })
    ).payload;
  }
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
  // Every candidate returned by this authenticated relay was already checked
  // at phone submission. Re-check all cryptographic and binding properties,
  // while allowing only that exact candidate's short-lived assertion to age
  // within the still-live approval window.
  const payload = await verifyRelayedAssertion(
    jws,
    createLocalJWKSet(body as JSONWebKeySet),
    expectedAudience,
  );
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
    "mandate_assertion_expired",
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
      resume: "inject_card",
    },
  };
}

function approvalDeniedResult(
  approvalId: string,
  approvalUrl: string,
  checkout: CheckoutSummary,
): Record<string, unknown> {
  return {
    status: "payment_approval_denied",
    approval_id: approvalId,
    approval_url: approvalUrl,
    merchant: checkout.merchant,
    amount_cents: checkout.amount_cents,
    currency: checkout.currency,
  };
}

function approvalExpiredResult(
  approvalUrl: string,
  checkout: CheckoutSummary,
  jit: boolean,
  boundCardRef: string | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    status: "payment_approval_timeout",
    approval_url: approvalUrl,
    merchant: checkout.merchant,
    amount_cents: checkout.amount_cents,
    currency: checkout.currency,
  };
  return jit && hasBoundCard(boundCardRef) ? { ...base, card_persisted: true } : base;
}

function isPaymentApprovalDeniedError(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === "payment_approval_denied";
}

const PAYMENT_APPROVAL_RESPONSE_RESERVE_MS = 500;

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

function defaultDependencies(): CardReleaseDependencies {
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
    onApprovalPending: () => undefined,
    onApprovalTerminal: () => undefined,
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

export async function executeCardReleaseApproval(
  args: InjectCardApprovalArgs,
  api: ApiClient,
  browser: CardReleaseBrowser,
  overrides: Partial<CardReleaseDependencies> = {},
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
      try {
        const live = await api.getPaymentApproval(resume.approval_id);
        const liveDeadline = Date.parse(live.expires_at);
        const terminalStatus =
          live.status === "denied"
            ? "denied"
            : live.status === "expired" ||
                (Number.isFinite(liveDeadline) ? liveDeadline : resume.deadline) <= deps.now()
              ? "expired"
              : null;
        if (terminalStatus !== null) {
          deps.onApprovalTerminal(resume, terminalStatus);
          resumableState = undefined;
          keypairHandedOff = false;
          return terminalStatus === "denied"
            ? approvalDeniedResult(resume.approval_id, resume.approval_url, resume.checkout)
            : approvalExpiredResult(
                resume.approval_url,
                resume.checkout,
                resume.jit,
                resume.boundCardRef,
              );
        }
        reusable = isLiveResumableApproval(live, resume, deps.now());
      } catch (error) {
        if (!(error instanceof ApiCallError && error.code === "payment_approval_not_found")) {
          throw error;
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

    let checkout: CheckoutSummary;
    let item: string;
    let reason: string;
    let jit: boolean;
    let approvalId: string;
    let nonce: string;
    let agent: string;
    let accountBinding: string;
    let approvalUrl: string;
    let deadline: number;
    let boundCardRef: string | null;
    const cardRefArg = resume !== undefined ? resume.cardRef : args.card_ref;

    if (resume !== undefined) {
      checkout = resume.checkout;
      item = resume.item;
      reason = resume.reason;
      jit = resume.jit;
      approvalId = resume.approval_id;
      nonce = resume.nonce;
      agent = resume.agent;
      accountBinding = resume.account_binding;
      approvalUrl = resume.approval_url;
      deadline = resume.deadline;
      boundCardRef = resume.boundCardRef;
    } else {
      checkout = {
        merchant: args.merchant,
        checkout_origin: new URL(browser.currentUrl()).origin,
        amount_cents: args.amount_cents,
        currency: args.currency.toUpperCase(),
      };

      item = args.item;
      reason = args.reason;
      jit = false;

      const created = await api.createPaymentApproval({
        ...checkout,
        card_ref: args.card_ref,
        operator_pubkey: keypair.publicKey,
        item,
        reason,
      });
      if (typeof created.account_binding !== "string") {
        throw new Error("payment_approval_account_binding_missing");
      }
      approvalId = created.id;
      nonce = created.nonce;
      agent = created.agent;
      accountBinding = created.account_binding;
      approvalUrl = `${deps.webBase.replace(/\/+$/, "")}/vault/pay/${encodeURIComponent(created.id)}`;
      const waitBudgetMs = jit ? deps.jitApprovalTimeoutMs : deps.approvalTimeoutMs;
      const serverDeadline = Date.parse(created.expires_at);
      deadline = Number.isFinite(serverDeadline) ? serverDeadline : deps.now() + waitBudgetMs;
      boundCardRef = args.card_ref;
    }

    resumableState = () => ({
      approval_id: approvalId,
      approval_url: approvalUrl,
      nonce,
      agent,
      account_binding: accountBinding,
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
    });
    await deps.surfaceApprovalUrl(approvalUrl);

    // This call's wait is bounded by both its client budget and server expiry.
    const callDeadline =
      deps.pollBudgetMs === undefined
        ? deadline
        : Math.min(deadline, deps.now() + deps.pollBudgetMs);
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

    // A JIT approval that expires before binding still needs a card; a bound
    // card remains stored even though the approval itself is terminal.
    const timeoutResult = (): Record<string, unknown> => {
      if (jit && !hasBoundCard(boundCardRef)) {
        return cardRequiredResult(
          approvalUrl,
          checkout,
          "the add-card link expired before a card was added",
        );
      }
      return approvalExpiredResult(approvalUrl, checkout, jit, boundCardRef);
    };
    const approvalExpired = (): boolean => deps.now() >= deadline;
    let terminalApprovalState: PendingApprovalWait | undefined;
    const terminalApprovalResult = (
      terminalStatus: "denied" | "expired",
    ): Record<string, unknown> => {
      const state = resumableState?.() ?? terminalApprovalState;
      if (state !== undefined) deps.onApprovalTerminal(state, terminalStatus);
      resumableState = undefined;
      keypairHandedOff = false;
      return terminalStatus === "denied"
        ? approvalDeniedResult(approvalId, approvalUrl, checkout)
        : timeoutResult();
    };
    const expiredApprovalResult = (): Record<string, unknown> => terminalApprovalResult("expired");

    let approved: { jws: string; sealed_card: string; card_ref: string | null } | undefined;
    let claims: JWTPayload | undefined;
    // Always make one live read; later iterations recheck the budget after sleep.
    let iteration = 0;
    let immediateReviewFollowup = false;
    while (true) {
      if (iteration > 0 && !immediateReviewFollowup && !shouldKeepPolling()) break;
      immediateReviewFollowup = false;
      iteration++;
      const remainingPollMs = Math.max(Math.min(callDeadline, deadline) - deps.now(), 0);
      const candidateRead = remainingPollMs > 0 ? true : "immediate";
      let approval: PaymentApproval;
      try {
        approval =
          candidateRead === true
            ? await api.getPaymentApproval(
                approvalId,
                true,
                Math.min(
                  Math.max(remainingPollMs - PAYMENT_APPROVAL_RESPONSE_RESERVE_MS, 0),
                  15_000,
                ),
                remainingPollMs,
              )
            : await api.getPaymentApproval(approvalId, "immediate");
      } catch (error) {
        if (!isPaymentApprovalTransportTimeout(error)) throw error;
        budgetExhausted = true;
        break;
      }
      const liveDeadline = Date.parse(approval.expires_at);
      if (Number.isFinite(liveDeadline)) deadline = Math.min(deadline, liveDeadline);
      boundCardRef = approval.card_ref;
      if (approval.status === "denied") {
        return terminalApprovalResult("denied");
      }
      if (approval.status === "expired" || approvalExpired()) {
        return expiredApprovalResult();
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
              accountBinding,
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
            if (approvalExpired()) return expiredApprovalResult();

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
                if (isPaymentApprovalDeniedError(error)) {
                  return terminalApprovalResult("denied");
                }
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
                candidateCardBytes.fill(0);
                if (isPaymentApprovalDeniedError(error)) {
                  return terminalApprovalResult("denied");
                }
                const failureReason =
                  error instanceof Error && /404|409/.test(error.message)
                    ? "confirm_status"
                    : "confirm_failed";
                const state = resumableState();
                deps.onApprovalTerminal(state, "payment_confirmation_failed");
                resumableState = undefined;
                keypairHandedOff = false;
                logPaymentCandidateLifecycle(
                  approvalId,
                  "approval",
                  "confirmation_failed",
                  failureReason,
                );
                return {
                  status: "payment_confirmation_failed",
                  reason: failureReason,
                  candidate_kind: "approval",
                  approval_url: approvalUrl,
                };
              }
            }
            if (approvalExpired()) {
              candidateCardBytes.fill(0);
              return expiredApprovalResult();
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
          approved_amount_cents: checkout.amount_cents,
          currency: checkout.currency,
          merchant: checkout.merchant,
          candidate_kind: "review",
          ready_to_charge: false,
          next: {
            tool: "inject_card",
            message:
              "The review signature was verified, but final payment approval is still required. " +
              "Refresh the approval page if it does not advance to the final approval prompt, " +
              "then call inject_card again with the same arguments; it resumes this approval and waits.",
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
          approved_amount_cents: checkout.amount_cents,
          currency: checkout.currency,
          merchant: checkout.merchant,
          candidate_kind: "none",
          ready_to_charge: false,
          next: {
            tool: "inject_card",
            message:
              "The bounded server wait ended before the human responded. Call inject_card again " +
              "with the same arguments; it resumes this approval and continues waiting without " +
              "creating another approval.",
          },
        };
      }
      if (jit) {
        try {
          const final = await api.getPaymentApproval(approvalId);
          boundCardRef = final.card_ref;
        } catch {}
      }
      return expiredApprovalResult();
    }

    if (claims === undefined || card === undefined) {
      resumableState = undefined;
      keypairHandedOff = false;
      return timeoutResult();
    }
    terminalApprovalState = resumableState?.();
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
    const last4 = card.pan.slice(-4);
    const mandateId =
      typeof claims.mandate_id === "string"
        ? claims.mandate_id
        : typeof claims.session_id === "string"
          ? claims.session_id
          : typeof claims.jti === "string"
            ? claims.jti
            : undefined;
    if (approvalExpired()) return expiredApprovalResult();
    deps.onCardResolved(cardRef);
    try {
      await browser.fillCheckoutCardFields(card, { deadline });
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
      deadline,
      ...(mandateId !== undefined ? { mandate_id: mandateId } : {}),
    });
    return {
      status: "card_released",
      approval_id: approvalId,
      approval_url: approvalUrl,
      approved_terms: checkout,
      last4,
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
