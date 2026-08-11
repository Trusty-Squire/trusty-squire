import { z } from "zod";
import {
  activeCartCheckoutForOrigin,
  activeProvisionBrowserForPayment,
  claimActivePaymentForOperatePay,
  clearActivePendingCardFill,
  completeActivePaymentLeaseWithPendingFill,
  markActivePendingCardFillSubmitStarted,
  recordActivePaymentProvenance,
  releaseActivePaymentLease,
  retainActivePaymentFieldSeal,
  restoreActivePendingCardFillAfterConfirmThrow,
  setActivePendingCardFill,
} from "../bot/provision-session.js";
import {
  executeOperatePay,
  executeOperatePayConfirm,
  type PendingCardFill,
} from "../bot/pay-operator.js";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z
  .object({
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
    "Pay the checkout in the one active operate_start browser session. Reads the live " +
    "merchant and total, creates a phone approval link, waits for approval, " +
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
  async handler(args, api, context) {
    assertApi(api);
    const paymentClaim = claimActivePaymentForOperatePay(args.phase);
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
        const browser = await activeProvisionBrowserForPayment();
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
            onSubmitStarted: markActivePendingCardFillSubmitStarted,
          },
        );
        const status = result.status;
        if (status === "payment_submitted" || status === "payment_3ds_required") {
          recordActivePaymentProvenance(pending.card_ref);
        }
        if (shouldRestorePendingCardFill(result)) {
          setActivePendingCardFill(pending);
        } else if (
          status === "payment_submitted" ||
          status === "payment_3ds_required" ||
          status === "payment_declined" ||
          status === "payment_outcome_unknown"
        ) {
          clearActivePendingCardFill(result.payment_fields_cleared === true);
        }
        return result;
      } catch (error) {
        restoreActivePendingCardFillAfterConfirmThrow(pending);
        throw error;
      }
    }
    if (paymentClaim.kind !== "lease") {
      throw new Error("operate_pay acquired an invalid payment lease");
    }
    const paymentLease = paymentClaim.lease;
    let paymentLeaseCompleted = false;
    let paymentFieldsCleared = true;
    try {
      const browser = await activeProvisionBrowserForPayment();
      if (await browser.isPayPalHostedCheckout()) {
        return {
          status: "paypal_checkout",
          reason: "paypal_hosted_fields_unfillable",
          needs_user: {
            wall: "paypal",
            message:
              "This checkout uses PayPal-hosted payment fields. Trusty Squire cannot enter a saved card into that cross-origin PayPal frame.",
            resume: "checkout",
          },
        };
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
        args.phase === "fill_card" && cartFallbackOrigin !== null
          ? (activeCartCheckoutForOrigin(cartFallbackOrigin) ?? undefined)
          : undefined;
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
            retainActivePaymentFieldSeal();
          },
          ...(cartFallbackCheckout !== undefined ? { cartFallbackCheckout } : {}),
        },
      );
      if (result.payment_fields_cleared === false) paymentFieldsCleared = false;
      if (result.status === "payment_card_filled") {
        if (filledPending === null) {
          paymentFieldsCleared = false;
          throw new Error("operate_pay fill_card succeeded without pending-fill state");
        }
        completeActivePaymentLeaseWithPendingFill(paymentLease, filledPending);
        paymentLeaseCompleted = true;
      }
      if (result.status === "payment_submitted" || result.status === "payment_3ds_required") {
        if (resolvedCardRef === null) {
          throw new Error("operate_pay succeeded without an action-time card source attestation");
        }
        recordActivePaymentProvenance(resolvedCardRef);
      }
      return result;
    } finally {
      if (!paymentLeaseCompleted) {
        releaseActivePaymentLease(paymentLease, paymentFieldsCleared);
      }
    }
  },
};
