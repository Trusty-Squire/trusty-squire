import { createHash, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import type { CheckoutCard, CheckoutSubmitResult, CheckoutSummary } from "./browser.js";
import { UnrecognizedPaymentFrameError } from "./browser.js";
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
  item: string;
  reason: string;
  three_ds_wait_seconds?: number;
  // "fill_card" = split-checkout card entry: run the full approval ceremony,
  // then fill the card into the payment fields WITHOUT submitting anything —
  // the charge happens later via executeOperatePayConfirm once the order-
  // confirmation step shows the total. Absent = the single-page fill+charge.
  phase?: "fill_card";
}

export interface PaymentBrowser {
  isPayPalHostedCheckout(): Promise<boolean>;
  readCheckoutSummary(fallbackCurrency?: string): Promise<CheckoutSummary>;
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
  onCardResolved: (cardRef: string) => void;
  // fill_card only: hands the session layer what the later confirm step needs.
  onCardFilled: (pending: PendingCardFill) => void;
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
    onCardResolved: () => undefined,
    onCardFilled: () => undefined,
  };
}

function logPaymentReviewLifecycle(event: Record<string, string>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
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

    const item = args.item;
    const reason = args.reason;
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
    let claims: JWTPayload | undefined;
    const rejectedCandidates = new Set<string>();
    while (deps.now() < deadline) {
      const approval = await api.getPaymentApproval(created.id, true);
      boundCardRef = approval.card_ref;
      if (approval.status === "expired") {
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
          const cardRef = args.card_ref ?? candidate.card_ref;
          if (!hasBoundCard(cardRef)) {
            if (approval.status === "approved") {
              return {
                status: "payment_mandate_rejected",
                reason: "card_ref_unbound",
                approval_url: approvalUrl,
              };
            }
          } else {
            const publicKeyBytes = fromBase64Url(keypair.publicKey);
            const recipientHash = createHash("sha256").update(publicKeyBytes).digest();
            const canonical = canonicalize({
              approval_id: created.id,
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
              if (approval.status === "approved") {
                return {
                  status: "payment_mandate_rejected",
                  reason: "canonicalization_failed",
                  approval_url: approvalUrl,
                };
              }
            } else {
              const approvalAad = new Uint8Array(
                createHash("sha256").update(canonical, "utf8").digest(),
              );
              const reviewCanonical = canonicalize({
                approval_id: created.id,
                approval_payload_sha256: toBase64Url(approvalAad),
                card_ref: cardRef,
                recipient_pubkey_hash: toBase64Url(recipientHash),
              });
              if (reviewCanonical === undefined) {
                return {
                  status: "payment_mandate_rejected",
                  reason: "canonicalization_failed",
                  approval_url: approvalUrl,
                };
              }
              const reviewAad = new Uint8Array(
                createHash("sha256").update(reviewCanonical, "utf8").digest(),
              );
              let verifiedClaims: JWTPayload | undefined;
              let reviewCandidate = false;
              let candidateAad: Uint8Array | undefined;
              try {
                const claimedHash = decodePayloadHash(decodeJwt(candidate.jws).payload_sha256);
                if (timingSafeEqual(Buffer.from(claimedHash), Buffer.from(approvalAad))) {
                  candidateAad = approvalAad;
                } else if (timingSafeEqual(Buffer.from(claimedHash), Buffer.from(reviewAad))) {
                  candidateAad = reviewAad;
                  reviewCandidate = true;
                } else {
                  throw new Error("payload_hash_mismatch");
                }
                verifiedClaims = await verifyMandate(
                  candidate.jws,
                  candidateAad,
                  deps.vouchflowApiBase,
                  expectedAudience,
                  deps.fetch,
                );
              } catch (error) {
                const failureReason = safeFailureReason(error);
                if (reviewCandidate) {
                  logPaymentReviewLifecycle({
                    event: "review_candidate_rejected",
                    approval_id: created.id,
                    candidate_fingerprint: candidateKey,
                    failure_code: failureReason,
                  });
                  if (
                    failureReason !== "jwks_fetch_failed" &&
                    failureReason !== "jwks_fetch_timeout"
                  ) {
                    return {
                      status: "payment_review_verification_failed",
                      reason: failureReason,
                      approval_url: approvalUrl,
                    };
                  }
                }
                if (approval.status === "approved") {
                  return {
                    status: "payment_mandate_rejected",
                    reason: failureReason,
                    approval_url: approvalUrl,
                  };
                }
                if (
                  failureReason === "jwks_fetch_failed" ||
                  failureReason === "jwks_fetch_timeout"
                ) {
                  rejectedCandidates.delete(candidateKey);
                }
              }
              if (verifiedClaims !== undefined) {
                let candidateCardBytes: Uint8Array | undefined;
                let candidateCard: CheckoutCard | undefined;
                try {
                  candidateCardBytes = await openSealed(
                    keypair.privateKey,
                    candidate.sealed_card,
                    candidateAad!,
                  );
                  candidateCard = normalizeCard(
                    JSON.parse(new TextDecoder().decode(candidateCardBytes)) as unknown,
                  );
                } catch {
                  candidateCardBytes?.fill(0);
                  if (reviewCandidate) {
                    logPaymentReviewLifecycle({
                      event: "review_candidate_rejected",
                      approval_id: created.id,
                      candidate_fingerprint: candidateKey,
                      failure_code: "card_open_failed",
                    });
                    return {
                      status: "payment_review_verification_failed",
                      reason: "card_open_failed",
                      approval_url: approvalUrl,
                    };
                  }
                  if (approval.status === "approved") {
                    return { status: "payment_card_open_failed", approval_url: approvalUrl };
                  }
                }
                if (candidateCardBytes !== undefined && candidateCard !== undefined) {
                  if (reviewCandidate) {
                    try {
                      const confirmation = await api.confirmPaymentApproval(created.id, candidate);
                      if (confirmation.status !== "verified") {
                        throw new Error("review_confirmation_failed");
                      }
                    } catch (error) {
                      candidateCardBytes.fill(0);
                      const reason =
                        error instanceof Error && /404|409/.test(error.message)
                          ? "confirm_status"
                          : "confirm_failed";
                      logPaymentReviewLifecycle({
                        event: "review_candidate_rejected",
                        approval_id: created.id,
                        candidate_fingerprint: candidateKey,
                        failure_code: reason,
                      });
                      return {
                        status: "payment_review_verification_failed",
                        reason,
                        approval_url: approvalUrl,
                      };
                    }
                    logPaymentReviewLifecycle({
                      event: "review_candidate_verified",
                      approval_id: created.id,
                      candidate_fingerprint: candidateKey,
                      failure_code: "ok",
                    });
                    candidateCardBytes.fill(0);
                    await deps.sleep(deps.pollIntervalMs);
                    continue;
                  }
                  if (approval.status === "pending") {
                    try {
                      await api.confirmPaymentApproval(created.id, candidate);
                    } catch (error) {
                      try {
                        const reconciliation = await api.confirmPaymentApproval(
                          created.id,
                          candidate,
                        );
                        if (reconciliation.status !== "approved") throw error;
                      } catch {
                        candidateCardBytes.fill(0);
                        throw error;
                      }
                    }
                  }
                  cardBytes = candidateCardBytes;
                  card = candidateCard;
                  claims = verifiedClaims;
                  approved = candidate;
                  break;
                }
              }
            }
          }
        }
      }
      await deps.sleep(deps.pollIntervalMs);
    }
    if (approved === undefined) {
      if (jit) {
        try {
          const final = await api.getPaymentApproval(created.id);
          boundCardRef = final.card_ref;
        } catch {}
      }
      return timeoutResult();
    }

    if (claims === undefined || card === undefined) return timeoutResult();

    const cardRef = args.card_ref ?? approved.card_ref;
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
    // Split-checkout card entry (phase="fill_card"): fill the card, charge
    // nothing. The human approval already happened (the mandate above binds
    // merchant/origin/amount/currency); what CANNOT happen here is the
    // total-verification — the card-entry step shows no total — so it moves
    // to executeOperatePayConfirm, the step where the money actually moves.
    // The one live check that is still possible (and needed: the ceremony can
    // take minutes, and the fill targets the CURRENT page) is that the
    // browser still sits on the origin the mandate was signed for.
    if (args.phase === "fill_card") {
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
        if (error instanceof UnrecognizedPaymentFrameError) {
          return {
            status: "payment_frame_not_recognized",
            frame_origin: error.frameOrigin,
            approval_url: approvalUrl,
            reason:
              "The card fields live in a cross-origin frame that is not a recognized " +
              "payment-provider surface; the vaulted card is never filled into an " +
              "unrecognized frame.",
          };
        }
        return {
          status: "payment_card_fill_failed",
          approval_url: approvalUrl,
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
        approval_id: created.id,
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
          "Drive the checkout to the order-confirmation step (the page showing the final " +
          'total), then call operate_pay {phase:"confirm"} — it verifies the live total ' +
          "against the approved amount and places the order. Never click the " +
          "pay/place-order control yourself.",
      };
    }

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

// The charge half of a split checkout: the card was filled by phase="fill_card"
// and the host has driven the checkout to its order-confirmation step. THIS is
// where the money moves, so the total-verification gate lives here: the live
// page must show a readable total that exactly matches the amount the user
// approved (the mandate-bound checkout in `pending`) before the pay/place-order
// control is clicked. No new approval is minted — the mandate from the fill
// step already binds these values; a drifted page refuses instead of charging.
export async function executeOperatePayConfirm(
  pending: PendingCardFill,
  args: { currency?: string; three_ds_wait_seconds?: number },
  api: ApiClient,
  browser: PaymentBrowser,
): Promise<Record<string, unknown>> {
  const threeDsWaitMs = Math.min(Math.max(args.three_ds_wait_seconds ?? 180, 0), 600) * 1000;
  const checkout = pending.checkout;
  const approvalUrl = pending.approval_url;

  let live: CheckoutSummary;
  try {
    live = await browser.readCheckoutSummary(args.currency ?? checkout.currency);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "payment_checkout_total_not_found") {
      // Unlike the fill step, a missing total here is a hard refusal — there
      // is no declared-amount fallback at the moment of charging.
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
    throw error;
  }
  // Merchant is deliberately NOT compared: it derives from the page title,
  // which legitimately changes between checkout steps ("Payment" → "Review
  // order"). checkout_origin is the trust anchor; amount+currency the money
  // gate — all three mandate-bound and all three must match exactly.
  if (
    live.amount_cents !== checkout.amount_cents ||
    live.currency !== checkout.currency ||
    live.checkout_origin !== checkout.checkout_origin
  ) {
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

  let paymentStatus = "payment_submitted";
  let submitResult: CheckoutSubmitResult = { three_ds_required: false };
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
    submitResult = await browser.submitFilledCheckout();
    if (submitResult.three_ds_required) paymentStatus = "payment_3ds_required";
  } catch (error) {
    const submitNotFound = error instanceof Error && error.message === "payment_submit_not_found";
    paymentStatus = submitNotFound ? "payment_checkout_failed" : "payment_outcome_unknown";
    const paymentFieldsCleared = submitNotFound ? false : await clearPaymentFields();
    let audit_recorded = true;
    try {
      await api.auditPayment({
        ...checkout,
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
      ...checkout,
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
    amount_cents: checkout.amount_cents,
    currency: checkout.currency,
    payment_fields_cleared: paymentFieldsCleared,
  };
}
