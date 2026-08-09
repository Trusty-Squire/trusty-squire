import { z } from "zod";
import {
  activeProvisionBrowserForPayment,
  clearActivePendingCardFill,
  getActivePendingCardFill,
  recordActivePaymentProvenance,
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
    // Split checkouts (card entry BEFORE the total is shown): "fill_card"
    // fills the vaulted card without charging; "confirm" verifies the live
    // total against the approved amount and places the order. Omit for a
    // single-page checkout (fill + charge in one call).
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
    "merchant and total when present, creates a phone approval link, waits for approval, " +
    "verifies the passkey-signed purchase mandate, opens the card only in this process, " +
    "fills common checkout fields, submits, and audits only the last four digits. Never " +
    "solves 3-D Secure; waits for user completion, then returns a needs_user handoff if unresolved. " +
    "With no card_ref/card_label and no card on file, the approval link becomes a first-time " +
    "add-card ceremony and the card is bound server-side before the mandate is signed. " +
    "For a SPLIT checkout (card entry before the total is shown): call with " +
    'phase="fill_card" on the card-entry step, passing merchant + amount_cents + currency ' +
    "(the user approves those values); the card is filled into recognized payment-provider " +
    "fields only and NOTHING is charged. Then drive the checkout to the order-confirmation " +
    'step and call phase="confirm" — it verifies the visible total against the approved ' +
    "amount and places the order. Never click the pay/place-order control via operate_act.",
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
          'Split checkouts only: "fill_card" fills the vaulted card on the card-entry step ' +
          '(no total visible yet — pass merchant+amount_cents+currency) without charging; ' +
          '"confirm" verifies the live total on the order-confirmation step against the ' +
          "approved amount and places the order. Omit for single-page checkouts.",
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
    const browser = await activeProvisionBrowserForPayment();
    // Confirm step of a split checkout: the card is already filled (and the
    // mandate already signed), so no card resolution and no PayPal gate — the
    // job is verify-the-total-then-charge. Routed before the PayPal check so
    // an incidental PayPal button iframe on the review page can't block it.
    if (args.phase === "confirm") {
      const pending = getActivePendingCardFill();
      if (pending === null) {
        throw new Error(
          'operate_pay phase="confirm" requires a completed phase="fill_card" in this ' +
            "session — no vaulted card is currently filled into the checkout.",
        );
      }
      const result = await executeOperatePayConfirm(
        pending,
        {
          ...(args.currency !== undefined ? { currency: args.currency } : {}),
          ...(args.three_ds_wait_seconds !== undefined
            ? { three_ds_wait_seconds: args.three_ds_wait_seconds }
            : {}),
        },
        api,
        browser,
      );
      const status = result.status;
      if (status === "payment_submitted" || status === "payment_3ds_required") {
        recordActivePaymentProvenance(pending.card_ref);
      }
      // Terminal for the filled card (charged, in 3DS, or declined) → drop the
      // pending state. A refusal (total missing/mismatch, submit not found)
      // keeps it so the host can fix the page and retry confirm.
      if (
        status === "payment_submitted" ||
        status === "payment_3ds_required" ||
        status === "payment_declined" ||
        status === "payment_outcome_unknown"
      ) {
        clearActivePendingCardFill();
      }
      return result;
    }
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
      await activeProvisionBrowserForPayment(),
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
      },
    );
    if (result.status === "payment_card_filled") {
      if (filledPending === null) {
        throw new Error("operate_pay fill_card succeeded without pending-fill state");
      }
      setActivePendingCardFill(filledPending);
    }
    if (result.status === "payment_submitted" || result.status === "payment_3ds_required") {
      if (resolvedCardRef === null) {
        throw new Error("operate_pay succeeded without an action-time card source attestation");
      }
      recordActivePaymentProvenance(resolvedCardRef);
    }
    return result;
  },
};
