import { z } from "zod";
import type { CardMutationApproval } from "../api-client.js";
import { ALWAYS_LOAD_META } from "./always-load.js";
import { assertApi, type Tool } from "./index.js";

// edit_payment_card — the saved-card analogue of edit_credential. The agent
// proposes nothing but the target card; every field lives inside the sealed
// blob, so the human edits them in the browser ceremony, where the card is
// decrypted and re-encrypted locally and the server stores only the new
// opaque blob. Card values never enter the model transcript.

const cardStart = z
  .object({
    card_id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => value.card_id !== undefined || value.label !== undefined, {
    message: "one of card_id or label is required",
  });
const cardResume = z.object({ approval_id: z.string().min(1).max(64) }).strict();
const cardInput = z.union([cardStart, cardResume]);

function toolResult(expectedOperation: "edit_card", approval: CardMutationApproval) {
  if (approval.operation !== expectedOperation) {
    return {
      status: "approval_intent_mismatch",
      error: "approval_operation_mismatch",
      expected_operation: expectedOperation,
      actual_operation: approval.operation,
    };
  }
  if (approval.status === "approved") {
    return {
      status: "card_updated",
      operation: expectedOperation,
      card: approval.card,
      before: approval.before,
      after: approval.after,
      approval_id: approval.approval_id,
    };
  }
  if (approval.status === "expired" || approval.status === "failed") {
    return {
      status: "card_mutation_refused",
      operation: expectedOperation,
      reason: approval.error ?? `approval_${approval.status}`,
      approval_id: approval.approval_id,
      card: approval.card,
    };
  }
  return {
    status: "approval_pending",
    operation: expectedOperation,
    approval_id: approval.approval_id,
    approval_url: approval.approval_url,
    expires_at: approval.expires_at,
    card: approval.card,
    before: approval.before,
    after: approval.after,
    next: { tool: "edit_payment_card", approval_id: approval.approval_id },
  };
}

const DESCRIPTION = `Request an edit of a saved PAYMENT CARD (label, number, expiry, name, billing)
behind the user's passkey approval. Identify the card by its exact id from
list_payment_cards, or by its exact label. The first call returns
approval_pending and an approval_id; the user opens the approval link and
edits the card fields directly in the browser, where the card is decrypted
and re-encrypted locally — the server stores only the new sealed blob and
the agent never sees or chooses any card value. After the user finishes,
call edit_payment_card again with ONLY that approval_id to confirm the
result (idempotent). This tool can never read card data.`;

export const editPaymentCardTool: Tool<z.infer<typeof cardInput>> = {
  name: "edit_payment_card",
  description: DESCRIPTION,
  inputSchema: cardInput,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          card_id: { type: "string" },
          label: { type: "string" },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["approval_id"],
        properties: { approval_id: { type: "string" } },
        additionalProperties: false,
      },
    ],
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const approval =
      "approval_id" in args
        ? await api.getCardMutationApproval(args.approval_id)
        : await api.createCardMutationApproval({
            operation: "edit_card",
            ...(args.card_id !== undefined ? { card_id: args.card_id } : {}),
            ...(args.label !== undefined ? { label: args.label } : {}),
          });
    return toolResult("edit_card", approval);
  },
};
