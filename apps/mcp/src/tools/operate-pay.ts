import { z } from "zod";
import {
  activeCartCheckoutForOrigin,
  activeProvisionBrowserForPayment,
  claimActivePaymentForOperatePay,
  clearActivePendingCardFill,
  completeActivePaymentLeaseWithPendingApproval,
  completeActivePaymentLeaseWithPendingFill,
  getActivePendingApproval,
  markActivePendingCardFillSubmitStarted,
  recordActivePaymentProvenance,
  releaseActivePaymentLease,
  retainActivePaymentFieldSeal,
  restoreActivePendingCardFillAfterConfirmThrow,
  setActivePendingCardFill,
  withPaymentSessionCall,
  type Session,
} from "../bot/provision-session.js";
import {
  classifyApprovalCandidate,
  executeOperatePay,
  executeOperatePayConfirm,
  type PendingApprovalWait,
  type PendingCardFill,
} from "../bot/pay-operator.js";
import type { ApiClient } from "../api-client.js";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z
  .object({
    session_id: z.string().uuid().optional(),
    merchant: z.string().min(1).max(256).optional(),
    amount_cents: z.number().int().min(0).max(2_147_483_647).optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional(),
    card_ref: z.string().min(1).max(64).optional(),
    card_label: z.string().min(1).max(256).optional(),
    phase: z.enum(["fill_card", "confirm"]).optional(),
    item: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(500),
    three_ds_wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe(
        "How long to wait for the user to complete a 3-D Secure challenge before handing back (default 180s, 0 = don't wait).",
      ),
  })
  // At most one card selector. Neither is allowed: the handler then resolves
  // against the cards on file (0 → JIT add-card ceremony, 1 → use it, >1 →
  // error listing labels). Providing both is still rejected.
  .refine((value) => value.card_ref === undefined || value.card_label === undefined, {
    message: "Provide at most one of card_ref or card_label",
  });

function paymentResult<T extends object>(
  session: Session,
  result: T,
): T & {
  session_id: string;
} {
  return { ...result, session_id: session.id };
}

function shouldRestorePendingCardFill(result: Record<string, unknown>): boolean {
  switch (result.status) {
    case "payment_configuration_error":
    case "payment_checkout_currency_unresolved":
    case "payment_checkout_total_not_found":
    case "payment_approval_timeout":
    case "payment_mandate_rejected":
    case "payment_review_verification_failed":
    case "payment_card_open_failed":
    case "payment_checkout_origin_mismatch":
    case "payment_amount_mismatch":
    case "payment_amount_exceeds_approval":
      return true;
    case "payment_checkout_failed":
      return result.reason === "payment_submit_not_found";
    default:
      return false;
  }
}

function paymentSchemaRepair(
  _args: unknown,
  issues: readonly { path: (string | number)[]; message: string }[],
) {
  const missing = [
    ...new Set(
      issues
        .map((issue) => issue.path[0])
        .filter((field): field is string => typeof field === "string"),
    ),
  ];
  const cardSelectorConflict = issues.some((issue) =>
    /at most one of card_ref or card_label/i.test(issue.message),
  );
  return {
    error: "invalid_payment_arguments",
    allowed_kinds: ["operate_pay"],
    missing,
    example: {
      item: "Item being purchased",
      reason: "Why this purchase is needed",
      card_label: "Personal",
    },
    safe_alternative: cardSelectorConflict
      ? "Provide only one of card_ref or card_label, or omit both to use the saved-card resolution flow. Card data stays inside operate_pay."
      : "Provide item and reason. Use at most one saved-card selector; card data stays inside operate_pay.",
  };
}

export const listPaymentCardsTool: Tool = {
  name: "list_payment_cards",
  description:
    "List saved payment cards by opaque ID and user-visible label only. Never returns encrypted blobs or card data.",
  inputSchema: z.object({}),
  jsonInputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async handler(_args, api) {
    assertApi(api);
    return { cards: await api.listPaymentCards() };
  },
};

export const operatePayTool: Tool<z.infer<typeof inputSchema>> = {
  name: "operate_pay",
  description:
    "Pay the checkout in the addressed operate_start browser session. session_id is required " +
    "when multiple operator sessions are active (and optional only for a sole local session). Reads the live " +
    "merchant and authoritative checkout total independently of informational checkout_state, " +
    "creates a phone approval link, waits for approval, " +
    "verifies the passkey-signed purchase mandate, opens the card only in this process, " +
    "fills common checkout fields, submits, and audits only the last four digits. Never " +
    "solves 3-D Secure; waits for user completion, then returns a needs_user handoff if unresolved. " +
    "With no card_ref/card_label and no card on file, the approval link becomes a first-time " +
    "add-card ceremony and the card is bound server-side before the mandate is signed. " +
    "For a SPLIT checkout (a card-entry step with no visible total, e.g. Rakuten): call with " +
    'phase="fill_card" on that step — the approval amount is sourced from the most recent real ' +
    "total this session observed (e.g. the cart page) when the card-entry page itself shows " +
    "none, and releases the card into recognized payment-provider fields without charging. Then " +
    'drive the checkout to the order-confirmation step and call phase="confirm" — it reads the ' +
    "strict final total and places the order if it does not exceed the amount already approved " +
    "at fill_card, with NO second approval. A final total above that amount is refused, never " +
    "re-approved. Exactly one human approval per purchase. Never click the pay/place-order " +
    "control via operate_act.",
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["item", "reason"],
    // At most one selector — never both. Omitting both is valid (resolves
    // against the cards on file, or starts a JIT add-card ceremony if none).
    not: { required: ["card_ref", "card_label"] },
    properties: {
      session_id: {
        type: "string",
        format: "uuid",
        description:
          "The operate_start session to charge. Omit only when exactly one local operator session is active.",
      },
      merchant: { type: "string" },
      amount_cents: { type: "integer", minimum: 0 },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      card_ref: { type: "string" },
      card_label: { type: "string" },
      phase: {
        type: "string",
        enum: ["fill_card", "confirm"],
        description:
          'Split checkouts only: "fill_card" approves an amount (falling back to the most ' +
          "recent real total this session observed when the card-entry page itself has none) " +
          'and releases the vaulted card without charging; "confirm" reads the final total and ' +
          "charges within that SAME approval — no second tap — refusing instead if the final " +
          "total exceeds it. Omit for single-page checkouts.",
      },
      item: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
      three_ds_wait_seconds: {
        type: "integer",
        minimum: 0,
        maximum: 600,
        description:
          "How long to wait for the user to complete a 3-D Secure challenge before handing back (default 180s, 0 = don't wait).",
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  schemaRepair: paymentSchemaRepair,
  async handler(args, api, context) {
    assertApi(api);
    return await withPaymentSessionCall(args.session_id, async (session) => {
      const paymentClaim = claimActivePaymentForOperatePay(args.phase, session);
      // Confirm step of a split checkout: the card is already filled (and the
      // mandate already signed), so no card resolution and no PayPal gate — the
      // job is verify-the-total-then-charge. Routed before the PayPal check so
      // an incidental PayPal button iframe on the review page can't block it.
      if (args.phase === "confirm") {
        if (paymentClaim.kind === "missing_confirm") {
          throw new Error(
            'operate_pay phase="confirm" requires a completed phase="fill_card" in this ' +
              "session — no vaulted card is currently filled into the checkout.",
          );
        }
        if (paymentClaim.kind !== "confirm") {
          throw new Error("operate_pay confirm acquired an invalid payment lease");
        }
        const pending = paymentClaim.pending;
        try {
          const browser = await activeProvisionBrowserForPayment(session);
          const result = await executeOperatePayConfirm(
            pending,
            {
              ...(args.three_ds_wait_seconds !== undefined
                ? { three_ds_wait_seconds: args.three_ds_wait_seconds }
                : {}),
            },
            api,
            browser,
            {
              onSubmitStarted: () => markActivePendingCardFillSubmitStarted(session),
            },
          );
          const status = result.status;
          if (status === "payment_submitted" || status === "payment_3ds_required") {
            recordActivePaymentProvenance(pending.card_ref, session);
          }
          if (shouldRestorePendingCardFill(result)) {
            setActivePendingCardFill(pending, session);
          } else if (
            status === "payment_submitted" ||
            status === "payment_3ds_required" ||
            status === "payment_declined" ||
            status === "payment_outcome_unknown"
          ) {
            clearActivePendingCardFill(result.payment_fields_cleared === true, session);
          }
          return paymentResult(session, result);
        } catch (error) {
          restoreActivePendingCardFillAfterConfirmThrow(pending, session);
          throw error;
        }
      }
      if (paymentClaim.kind !== "lease") {
        throw new Error("operate_pay acquired an invalid payment lease");
      }
      const paymentLease = paymentClaim.lease;
      let paymentLeaseCompleted = false;
      let paymentFieldsCleared = true;
      let approvalPending: PendingApprovalWait | null = null;
      let operatorStarted = false;
      try {
        const browser = await activeProvisionBrowserForPayment(session);
        if (await browser.isPayPalHostedCheckout()) {
          if (paymentClaim.resumeApproval !== undefined) {
            completeActivePaymentLeaseWithPendingApproval(
              paymentLease,
              paymentClaim.resumeApproval,
              session,
            );
            paymentLeaseCompleted = true;
          }
          return paymentResult(session, {
            status: "paypal_checkout",
            reason: "paypal_hosted_fields_unfillable",
            needs_user: {
              wall: "paypal",
              message:
                "This checkout uses PayPal-hosted payment fields. Trusty Squire cannot enter a saved card into that cross-origin PayPal frame.",
              resume: "checkout",
            },
          });
        }
        // Resolve which card to charge. An explicit card_ref wins. Otherwise:
        //  - card_label given  → resolve it (0 → error, >1 same-label → error)
        //  - neither given      → resolve against the cards on file:
        //      0 cards  → cardRef stays undefined → JIT add-card ceremony
        //      1 card   → use it
        //      >1 cards → error listing the labels (never silently guess)
        let cardRef = args.card_ref;
        if (cardRef === undefined) {
          const cards = await api.listPaymentCards();
          if (args.card_label !== undefined) {
            const matches = cards.filter((card) => card.label === args.card_label);
            if (matches.length === 0) {
              throw new Error(`No saved payment card has label "${args.card_label}".`);
            }
            if (matches.length > 1) {
              throw new Error(
                `Multiple saved payment cards have label "${args.card_label}"; use card_ref instead.`,
              );
            }
            cardRef = matches[0]!.id;
          } else if (cards.length === 1) {
            cardRef = cards[0]!.id;
          } else if (cards.length > 1) {
            const labels = cards.map((card) => `"${card.label}"`).join(", ");
            throw new Error(
              `Multiple saved payment cards on file (${labels}); specify card_ref or card_label.`,
            );
          }
          // cards.length === 0 → leave cardRef undefined; executeOperatePay runs
          // the JIT add-card ceremony.
        }
        let resolvedCardRef: string | null = null;
        let filledPending: PendingCardFill | null = null;
        // Split checkouts (Rakuten-style) show no total on the card-entry page
        // itself. executeOperatePay's own live read is tried first regardless;
        // this is only its fallback when that read specifically finds no total.
        let cartFallbackOrigin: string | null = null;
        try {
          cartFallbackOrigin = new URL(browser.currentUrl()).origin;
        } catch {
          cartFallbackOrigin = null;
        }
        const cartFallbackCheckout =
          cartFallbackOrigin !== null
            ? (activeCartCheckoutForOrigin(cartFallbackOrigin, session) ?? undefined)
            : undefined;
        operatorStarted = true;
        const result = await executeOperatePay(
          {
            ...(cardRef !== undefined ? { card_ref: cardRef } : {}),
            ...(args.merchant !== undefined ? { merchant: args.merchant } : {}),
            ...(args.amount_cents !== undefined ? { amount_cents: args.amount_cents } : {}),
            ...(args.currency !== undefined ? { currency: args.currency } : {}),
            item: args.item,
            reason: args.reason,
            ...(args.three_ds_wait_seconds !== undefined
              ? { three_ds_wait_seconds: args.three_ds_wait_seconds }
              : {}),
            ...(args.phase === "fill_card" ? { phase: "fill_card" as const } : {}),
          },
          api,
          browser,
          {
            ...(context !== undefined
              ? {
                  surfaceApprovalUrl: async (url: string) => {
                    await context.notifyUser(`Approve this payment on your phone: ${url}`, {
                      approval_url: url,
                    });
                  },
                }
              : {}),
            onCardResolved: (value) => {
              resolvedCardRef = value;
            },
            onCardFilled: (pending) => {
              filledPending = pending;
            },
            onCardFillCleanupFailed: () => {
              paymentFieldsCleared = false;
              retainActivePaymentFieldSeal(session);
            },
            onApprovalPending: (state) => {
              approvalPending = state;
            },
            ...(cartFallbackCheckout !== undefined ? { cartFallbackCheckout } : {}),
            ...(paymentClaim.resumeApproval !== undefined
              ? { resumeFrom: paymentClaim.resumeApproval }
              : {}),
            // [P0] Never block the RPC waiting on the human — one live check,
            // then hand back approval_pending. operate_payment_await/status (or
            // simply calling operate_pay again, which resumes this SAME
            // approval) is how the host finds out when the phone responds.
            pollBudgetMs: 0,
          },
        );
        if (result.payment_fields_cleared === false) paymentFieldsCleared = false;
        if (result.status === "payment_card_filled") {
          if (filledPending === null) {
            paymentFieldsCleared = false;
            throw new Error("operate_pay fill_card succeeded without pending-fill state");
          }
          completeActivePaymentLeaseWithPendingFill(paymentLease, filledPending, session);
          paymentLeaseCompleted = true;
        }
        if (
          result.status === "approval_pending" ||
          result.status === "approval_pending_final_signature"
        ) {
          if (approvalPending === null) {
            throw new Error("operate_pay pending approval returned without resumable state");
          }
          completeActivePaymentLeaseWithPendingApproval(paymentLease, approvalPending, session);
          paymentLeaseCompleted = true;
        }
        if (result.status === "payment_submitted" || result.status === "payment_3ds_required") {
          if (resolvedCardRef === null) {
            throw new Error("operate_pay succeeded without an action-time card source attestation");
          }
          recordActivePaymentProvenance(resolvedCardRef, session);
        }
        if (
          paymentClaim.resumeApproval !== undefined &&
          !paymentLeaseCompleted &&
          resolvedCardRef === null
        ) {
          if (result.status === "payment_configuration_error") {
            completeActivePaymentLeaseWithPendingApproval(
              paymentLease,
              paymentClaim.resumeApproval,
              session,
            );
            paymentLeaseCompleted = true;
          } else {
            paymentClaim.resumeApproval.keypair.privateKey = "";
          }
        }
        return paymentResult(session, result);
      } catch (error) {
        const approvalToRestore =
          approvalPending ?? (!operatorStarted ? (paymentClaim.resumeApproval ?? null) : null);
        if (approvalToRestore !== null) {
          completeActivePaymentLeaseWithPendingApproval(paymentLease, approvalToRestore, session);
          paymentLeaseCompleted = true;
        }
        throw error;
      } finally {
        if (!paymentLeaseCompleted) {
          releaseActivePaymentLease(paymentLease, paymentFieldsCleared, session);
        }
      }
    });
  },
};

// [P0] Shared by operate_payment_status/await: maps the LIVE server record
// (never the locally-cached approval terms) to a status the host can act on.
// Never opens the sealed card or calls confirm — read-only, no side effects.
// `boundMs`, when given, races the server call so this can never outlast the
// caller's own bound even though the server's wait_for_submission window is
// a fixed ~15s.
async function readApprovalStatus(
  api: ApiClient,
  state: PendingApprovalWait,
  sessionId: string,
  waitForSubmission: boolean,
  boundMs?: number,
): Promise<Record<string, unknown>> {
  const fetchApproval = api.getPaymentApproval(
    state.approval_id,
    waitForSubmission ? "wait-peek" : "peek",
  );
  const approval =
    boundMs === undefined
      ? await fetchApproval
      : await Promise.race([
          fetchApproval,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), boundMs)),
        ]);
  if (approval === null) {
    return {
      status: "pending",
      approval_id: state.approval_id,
      approval_url: state.approval_url,
      phase: state.phase ?? null,
      merchant: state.checkout.merchant,
      amount_cents: state.checkout.amount_cents,
      currency: state.checkout.currency,
      candidate_submitted: false,
      candidate_kind: state.reviewVerified === true ? "review" : "none",
      ready_to_charge: false,
      next: { tool: "operate_payment_await", session_id: sessionId, max_wait_seconds: 15 },
    };
  }
  const candidateSubmitted =
    typeof approval.jws === "string" && typeof approval.sealed_card === "string";
  const observedCandidateKind = classifyApprovalCandidate(approval, state);
  const candidateKind =
    observedCandidateKind === "none" && state.reviewVerified === true
      ? "review"
      : observedCandidateKind;
  const readyToCharge = observedCandidateKind === "approval";
  const expired = approval.status === "expired";
  return {
    status: expired ? "expired" : approval.status,
    approval_id: state.approval_id,
    approval_url: state.approval_url,
    expires_at: approval.expires_at,
    phase: state.phase ?? null,
    merchant: approval.merchant,
    amount_cents: approval.amount_cents,
    currency: approval.currency,
    candidate_submitted: candidateSubmitted,
    candidate_kind: candidateKind,
    ready_to_charge: readyToCharge,
    ...(expired
      ? {}
      : readyToCharge
        ? {
            next: {
              tool: "operate_pay",
              session_id: sessionId,
              hint:
                "The phone has responded. Call operate_pay again with the same arguments " +
                '(including phase="fill_card" if that is how this payment was started) to ' +
                "complete verification and release/charge — it resumes this SAME approval, " +
                "never mints a new one.",
            },
          }
        : candidateKind === "review" && observedCandidateKind === "review"
          ? {
              next: {
                tool: "operate_pay",
                session_id: sessionId,
                hint:
                  "A legacy review signature was submitted. Call operate_pay to verify it, but " +
                  "final payment approval is still required before any card can be released or charged. " +
                  "Refresh the approval page if it does not advance.",
              },
            }
          : candidateKind === "review"
            ? {
                next: {
                  tool: "operate_payment_await",
                  session_id: sessionId,
                  max_wait_seconds: 15,
                  hint:
                    "The review signature was verified. Final payment approval is still required; " +
                    "refresh the approval page if the final prompt is not visible.",
                },
              }
            : candidateKind === "invalid"
              ? {
                  next: {
                    action: "refresh_approval_page",
                    hint:
                      "The submitted payment candidate is not bound to this approval and cannot " +
                      "authorize a charge. Refresh the approval page and submit again.",
                  },
                }
              : {
                  next: {
                    tool: "operate_payment_await",
                    session_id: sessionId,
                    max_wait_seconds: 15,
                  },
                }),
  };
}

function noPendingPaymentResult(session: Session): Record<string, unknown> {
  return {
    session_id: session.id,
    status: "no_pending_payment",
    reason: "No operate_pay call in this session is currently awaiting approval.",
  };
}

const paymentStatusInputSchema = z.object({ session_id: z.string().uuid().optional() });

export const operatePaymentStatusTool: Tool<z.infer<typeof paymentStatusInputSchema>> = {
  name: "operate_payment_status",
  description:
    "Read-only: report the status of the payment approval currently awaiting the human's phone " +
    "tap, if any — started by the most recent operate_pay call that returned approval_pending. " +
    "Never blocks, never verifies a mandate or opens a card. Only candidate_kind=approval with " +
    "ready_to_charge=true is a final authorization; a review candidate still requires final approval.",
  inputSchema: paymentStatusInputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        format: "uuid",
        description: "The payment session; omit only when exactly one local session is active.",
      },
    },
  },
  annotations: { readOnlyHint: true },
  async handler(args, api) {
    assertApi(api);
    return await withPaymentSessionCall(args.session_id, async (session) => {
      const state = getActivePendingApproval(session);
      if (state === null) return noPendingPaymentResult(session);
      return paymentResult(session, await readApprovalStatus(api, state, session.id, false));
    });
  },
};

const paymentAwaitInputSchema = z.object({
  session_id: z.string().uuid().optional(),
  max_wait_seconds: z.number().int().min(1).max(15).optional(),
});

export const operatePaymentAwaitTool: Tool<z.infer<typeof paymentAwaitInputSchema>> = {
  name: "operate_payment_await",
  description:
    "Bounded wait (never more than ~15s) for the payment approval currently awaiting the human's " +
    "phone tap — started by the most recent operate_pay call that returned approval_pending. " +
    "Returns explicit candidate_kind and ready_to_charge fields: only an approval-bound candidate " +
    "is ready to complete; a review-bound candidate still requires final approval. Never hangs " +
    "for minutes; call it again (or operate_payment_status) if it comes back pending.",
  inputSchema: paymentAwaitInputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        format: "uuid",
        description: "The payment session; omit only when exactly one local session is active.",
      },
      max_wait_seconds: {
        type: "integer",
        minimum: 1,
        maximum: 15,
        description: "Upper bound on this call's wait. Defaults to 15s; clamped to [1, 15].",
      },
    },
  },
  annotations: { readOnlyHint: true },
  async handler(args, api) {
    assertApi(api);
    return await withPaymentSessionCall(args.session_id, async (session) => {
      const state = getActivePendingApproval(session);
      if (state === null) return noPendingPaymentResult(session);
      const boundMs = Math.min(Math.max((args.max_wait_seconds ?? 15) * 1000, 1_000), 15_000);
      return paymentResult(
        session,
        await readApprovalStatus(api, state, session.id, true, boundMs),
      );
    });
  },
};
