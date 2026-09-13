import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import type {
  CheckoutCard,
  CheckoutSubmitResult,
  InjectCardField,
  InjectCardFieldResult,
  ThreeDsResolution,
} from "../bot/browser.js";
import {
  injectCardIntoSessionTargets,
  withPaymentSessionCall,
  type Session,
} from "../bot/provision-session.js";
import {
  executeOperatePay,
  type PaymentBrowser,
  type PendingApprovalWait,
  type PendingCardFill,
} from "../bot/pay-operator.js";
import { assertApi, type Tool } from "./index.js";

const APPROVAL_WAIT_MS = 60_000;

const targetSchema = z.object({
  ref: z.string().min(1).max(512),
  format: z.string().min(1).max(32).optional(),
});

const inputSchema = z.object({
  session_id: z.string().uuid().optional(),
  merchant: z.string().trim().min(1).max(256),
  amount_cents: z.number().int().min(0).max(2_147_483_647),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  item: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  card_ref: z.string().trim().min(1).max(64),
  approval_id: z.string().trim().min(1).max(128).optional(),
  fields: z.object({
    pan: targetSchema.optional(),
    cvv: targetSchema.optional(),
    exp_month: targetSchema.optional(),
    exp_year: targetSchema.optional(),
    exp: targetSchema.optional(),
    name: targetSchema.optional(),
  }),
});

type InjectCardInput = z.infer<typeof inputSchema>;

function cloneCard(card: CheckoutCard): CheckoutCard {
  return {
    ...card,
    billing: { ...card.billing },
  };
}

function fieldSummary(results: Record<InjectCardField, InjectCardFieldResult>): {
  complete: boolean;
  fields: Record<InjectCardField, InjectCardFieldResult>;
} {
  return {
    complete: Object.values(results).every(
      (result) => result.status === "filled" || result.status === "not_found",
    ),
    fields: results,
  };
}

async function injectReleasedCard(session: Session, args: InjectCardInput) {
  const released = session.releasedPaymentCard;
  if (released === null) throw new Error("approved card release is unavailable");
  if (args.approval_id !== undefined && args.approval_id !== released.approvalId) {
    throw new Error("approval_id does not match this session's released purchase");
  }
  if (Date.now() >= released.deadline) throw new Error("payment_approval_expired");
  const results = await injectCardIntoSessionTargets(session.id, released.card, args.fields);
  return {
    status: "card_injected",
    session_id: session.id,
    approval_id: released.approvalId,
    approval_url: released.approvalUrl,
    approved_terms: released.checkout,
    last4: released.last4,
    ...fieldSummary(results),
  };
}

function pendingResult(session: Session, result: Record<string, unknown>): Record<string, unknown> {
  const next = result.next;
  return {
    ...result,
    session_id: session.id,
    ...(next !== null && typeof next === "object"
      ? { next: { ...(next as Record<string, unknown>), tool: "inject_card" } }
      : {}),
  };
}

export const injectCardTool: Tool<InjectCardInput> = {
  name: "inject_card",
  description:
    "Release one saved card under the existing single human purchase approval and fill only the supplied observation refs. Supply refs for pan/cvv/expiry/name from operate_observe; each may target the main document or any reachable frame. This tool never searches for payment providers, chooses a card UI, reads or validates the total, clicks submit, clears fields, or diagnoses the checkout. Partial results are ordinary browser outcomes; retry changed refs with the same approval_id. The released PAN/CVV are masked from all normal operator output before the first write.",
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["merchant", "amount_cents", "currency", "item", "reason", "card_ref", "fields"],
    properties: {
      session_id: { type: "string", format: "uuid" },
      merchant: { type: "string" },
      amount_cents: { type: "integer", minimum: 0 },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      item: { type: "string" },
      reason: { type: "string" },
      card_ref: { type: "string" },
      approval_id: { type: "string" },
      fields: {
        type: "object",
        properties: Object.fromEntries(
          ["pan", "cvv", "exp_month", "exp_year", "exp", "name"].map((field) => [
            field,
            {
              type: "object",
              required: ["ref"],
              properties: { ref: { type: "string" }, format: { type: "string" } },
            },
          ]),
        ),
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async handler(args, api, context) {
    assertApi(api);
    return await withPaymentSessionCall(args.session_id, async (session) => {
      if (session.releasedPaymentCard !== null) return await injectReleasedCard(session, args);
      if (args.approval_id !== undefined) {
        const pending = session.activePayment;
        if (
          pending?.status !== "awaiting_approval" ||
          pending.state.approval_id !== args.approval_id
        ) {
          throw new Error("approval_id is not resumable in this session");
        }
      }
      if (session.activePayment?.status === "terminal_approval") {
        const terminal = session.activePayment;
        session.activePayment = null;
        return {
          session_id: session.id,
          status:
            terminal.terminalStatus === "denied"
              ? "payment_approval_denied"
              : terminal.terminalStatus === "expired"
                ? "payment_approval_timeout"
                : "payment_confirmation_failed",
          approval_id: terminal.state.approval_id,
          approval_url: terminal.state.approval_url,
          approved_terms: terminal.state.checkout,
        };
      }
      if (session.activePayment !== null && session.activePayment.status !== "awaiting_approval") {
        throw new Error("another card release is already in progress");
      }
      const resumeFrom: PendingApprovalWait | undefined =
        session.activePayment?.status === "awaiting_approval"
          ? session.activePayment.state
          : undefined;
      const controller = session.browser;
      const checkoutOrigin = new URL(controller.currentUrl()).origin;
      let releasedCard: CheckoutCard | null = null;
      let fieldResults: Record<InjectCardField, InjectCardFieldResult> | null = null;
      let filled: PendingCardFill | null = null;
      const paymentBrowser: PaymentBrowser = {
        isPayPalHostedCheckout: async () => false,
        readCheckoutSummary: async () => ({
          merchant: args.merchant,
          checkout_origin: checkoutOrigin,
          amount_cents: args.amount_cents,
          currency: args.currency.toUpperCase(),
        }),
        readCheckoutConfirmSummary: async () => {
          throw new Error("inject_card never reads a confirmation total");
        },
        fillAndSubmitCheckout: async (): Promise<CheckoutSubmitResult> => {
          throw new Error("inject_card never submits checkout");
        },
        fillCheckoutCardFields: async (card) => {
          releasedCard = cloneCard(card);
          fieldResults = await injectCardIntoSessionTargets(session.id, card, args.fields);
        },
        submitFilledCheckout: async () => {
          throw new Error("inject_card never submits checkout");
        },
        clearSealedPaymentFields: async () => undefined,
        waitForThreeDsResolution: async (): Promise<ThreeDsResolution> => "timeout",
        currentUrl: () => controller.currentUrl(),
      };
      const result = await executeOperatePay(
        {
          merchant: args.merchant,
          amount_cents: args.amount_cents,
          currency: args.currency,
          item: args.item,
          reason: args.reason,
          card_ref: args.card_ref,
          phase: "fill_card",
        },
        api as ApiClient,
        paymentBrowser,
        {
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
          pollBudgetMs: context?.paymentApprovalWaitMs ?? APPROVAL_WAIT_MS,
          surfaceApprovalUrl: async (url) => {
            await context?.notifyUser(`Approve this purchase on your phone: ${url}`, {
              approval_url: url,
            });
          },
          onApprovalPending: (state) => {
            session.activePayment = { status: "awaiting_approval", state };
          },
          onApprovalTerminal: (state, terminalStatus) => {
            session.activePayment = { status: "terminal_approval", state, terminalStatus };
          },
          onCardFilled: (pending) => {
            filled = pending;
          },
        },
      );
      if (releasedCard === null || fieldResults === null || filled === null) {
        return pendingResult(session, result);
      }
      const approved = filled as PendingCardFill;
      session.releasedPaymentCard = {
        approvalId: approved.approval_id,
        approvalUrl: approved.approval_url,
        checkout: approved.checkout,
        cardRef: approved.card_ref,
        last4: approved.last4,
        deadline: approved.deadline ?? Date.now() + 5 * 60_000,
        card: releasedCard,
      };
      session.activePayment = null;
      return {
        status: "card_injected",
        session_id: session.id,
        approval_id: approved.approval_id,
        approval_url: approved.approval_url,
        approved_terms: approved.checkout,
        last4: approved.last4,
        ...fieldSummary(fieldResults),
      };
    });
  },
};
