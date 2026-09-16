import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import type { CheckoutCard, InjectCardField, InjectCardFieldResult } from "../bot/browser.js";
import {
  injectCardIntoSessionTargets,
  withPaymentSessionCall,
  type Session,
} from "../bot/provision-session.js";
import {
  executeCardReleaseApproval,
  type CardReleaseBrowser,
  type PendingApprovalWait,
  type ReleasedCardApproval,
} from "../bot/card-release-approval.js";
import { assertApi, type Tool } from "./index.js";
import { cardTokenVocabulary } from "../bot/card-secret-tokens.js";

const APPROVAL_WAIT_MS = 60_000;

const targetSchema = z.object({
  ref: z.string().min(1).max(512),
  format: z.string().min(1).max(32).optional(),
});

const inputSchema = z.object({
  session_id: z.string().uuid(),
  merchant: z.string().trim().min(1).max(256),
  amount_cents: z.number().int().min(0).max(2_147_483_647),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  item: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  card_ref: z.string().trim().min(1).max(64),
  approval_id: z.string().trim().min(1).max(128).optional(),
  fields: z
    .object({
      pan: targetSchema.optional(),
      cvv: targetSchema.optional(),
    })
    // Expiry and cardholder name are NOT inject targets: reject them loudly
    // instead of silently stripping, so the agent reroutes to operate_type.
    .strict(),
});

type InjectCardInput = z.infer<typeof inputSchema>;

function cloneCard(card: CheckoutCard): CheckoutCard {
  return {
    ...card,
    billing: { ...card.billing },
  };
}

function fieldSummary(
  results: Record<InjectCardField, InjectCardFieldResult>,
  targets: InjectCardInput["fields"],
): {
  complete: boolean;
  fields: Record<InjectCardField, InjectCardFieldResult>;
} {
  return {
    complete: (Object.keys(targets) as InjectCardField[]).every(
      (field) => results[field].status === "filled",
    ),
    fields: results,
  };
}

async function injectReleasedCard(session: Session, args: InjectCardInput) {
  const released = session.releasedPaymentCard;
  if (released === null) throw new Error("approved card release is unavailable");
  if (args.approval_id === undefined) {
    throw new Error("approval_id is required to retry this session's released purchase");
  }
  if (args.approval_id !== released.approvalId) {
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
    card_tokens: cardTokenVocabulary(released.card),
    ...fieldSummary(results, args.fields),
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
    "Release one saved card under the existing single human purchase approval and fill only the supplied observation refs. Supply session_id and refs for pan/cvv from operate_observe; each may target the main document or any reachable frame. Expiry, cardholder name, and billing are NOT part of this tool and are not secret: fill them yourself with operate_type/operate_select. After approval the session also exposes the card as opaque per-digit masked tokens you can place into ANY field ref yourself with operate_type: {{pan}} and {{cvv}} type the whole value, {{pan:N}} and {{cvv:N}} type one digit (1-based, N up to the returned pan_length/cvv_length); the broker substitutes the real digit at the keystroke boundary and the digits are never shown to you or masked out of every observation, screenshot, and error. Use the refs for the ordinary path and the tokens for arbitrary layouts, single-digit boxes, remounts, re-validation, or post-error re-arm. Avoid provider helper/autofill/focus inputs and choose the actual card control. This tool never searches for payment providers, chooses a card UI, reads or validates the total, clicks submit, clears fields, or diagnoses the checkout. Partial results are ordinary browser outcomes; retry changed refs with the same approval_id. Before placing the order, re-observe and confirm no competing saved-card control is selected. The operator detects a rendered 3-D Secure challenge on observation or action results and notifies the cardholder once; do not solve or wait on the challenge yourself — keep observing until the checkout resolves. The released PAN/CVV are masked from all normal operator output before the first write.",
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: [
      "session_id",
      "merchant",
      "amount_cents",
      "currency",
      "item",
      "reason",
      "card_ref",
      "fields",
    ],
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
          ["pan", "cvv"].map((field) => [
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
      const resumeFrom: PendingApprovalWait | undefined =
        session.activePayment?.status === "awaiting_approval"
          ? session.activePayment.state
          : undefined;
      const controller = session.browser;
      let releasedCard: CheckoutCard | null = null;
      let fieldResults: Record<InjectCardField, InjectCardFieldResult> | null = null;
      let filled: ReleasedCardApproval | null = null;
      const releaseBrowser: CardReleaseBrowser = {
        injectCardFields: async (card) => {
          releasedCard = cloneCard(card);
          fieldResults = await injectCardIntoSessionTargets(session.id, card, args.fields);
        },
        currentUrl: () => controller.currentUrl(),
      };
      const result = await executeCardReleaseApproval(
        {
          merchant: args.merchant,
          amount_cents: args.amount_cents,
          currency: args.currency,
          item: args.item,
          reason: args.reason,
          card_ref: args.card_ref,
        },
        api as ApiClient,
        releaseBrowser,
        {
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
          pollBudgetMs: APPROVAL_WAIT_MS,
          surfaceApprovalUrl: async (url) => {
            await context?.notifyUser?.(`Approve this purchase on your phone: ${url}`, {
              approval_url: url,
            });
          },
          onApprovalPending: (state) => {
            session.activePayment = { status: "awaiting_approval", state };
          },
          onApprovalTerminal: () => {
            session.activePayment = null;
          },
          onCardFilled: (pending) => {
            filled = pending;
          },
        },
      );
      if (releasedCard === null || fieldResults === null || filled === null) {
        return pendingResult(session, result);
      }
      const approved = filled as ReleasedCardApproval;
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
        card_tokens: cardTokenVocabulary(releasedCard),
        ...fieldSummary(fieldResults, args.fields),
      };
    });
  },
};
