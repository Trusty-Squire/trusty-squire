import { describe, expect, it } from "vitest";
import type { ApiClient, CardMutationApproval } from "../../api-client.js";
import { editPaymentCardTool } from "../card-mutations.js";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

const BASE_APPROVAL: CardMutationApproval = {
  approval_id: "card_mutation_1",
  approval_url: "https://trustysquire.ai/vault/mutate-card/card_mutation_1",
  status: "pending",
  operation: "edit_card",
  card: { id: "card_1", label: "Personal card", brand: "Visa", last4: "4242" },
  before: { label: "Personal card", brand: "Visa", last4: "4242" },
  after: null,
  expires_at: "2026-08-22T12:10:00.000Z",
};

describe("edit_payment_card", () => {
  it("starts with a card selector and resumes only by approval_id", async () => {
    let createdInput: unknown;
    const api = mockApi({
      createCardMutationApproval: async (input) => {
        createdInput = input;
        return BASE_APPROVAL;
      },
      getCardMutationApproval: async (id) => ({
        ...BASE_APPROVAL,
        approval_id: id,
        status: "approved",
        after: { label: "Travel card", brand: "Visa", last4: "4242" },
      }),
    });

    const pending = await editPaymentCardTool.handler(
      { card_id: "card_1" },
      api,
    );
    expect(createdInput).toEqual({ operation: "edit_card", card_id: "card_1" });
    expect(pending).toMatchObject({
      status: "approval_pending",
      approval_id: "card_mutation_1",
      next: { tool: "edit_payment_card", approval_id: "card_mutation_1" },
    });

    const byLabel = await editPaymentCardTool.handler({ label: "Personal card" }, api);
    expect(byLabel).toMatchObject({ status: "approval_pending" });

    const done = await editPaymentCardTool.handler({ approval_id: "card_mutation_1" }, api);
    expect(done).toMatchObject({
      status: "card_updated",
      approval_id: "card_mutation_1",
      after: { label: "Travel card" },
    });
  });

  it("keeps card values out of every result — display metadata only", async () => {
    const api = mockApi({
      createCardMutationApproval: async () => BASE_APPROVAL,
    });
    const pending = await editPaymentCardTool.handler({ card_id: "card_1" }, api);
    const serialized = JSON.stringify(pending);
    // Only ever the display metadata, never a sealed blob or PAN.
    expect(serialized).not.toContain("blob");
    expect(serialized).not.toContain("pan");
    expect(JSON.stringify(pending)).toContain('"last4":"4242"');
  });

  it("reports refusals for expired and failed approvals", async () => {
    const api = mockApi({
      getCardMutationApproval: async () => ({
        ...BASE_APPROVAL,
        status: "failed",
        error: "card_changed",
      }),
    });
    await expect(
      editPaymentCardTool.handler({ approval_id: "card_mutation_1" }, api),
    ).resolves.toMatchObject({
      status: "card_mutation_refused",
      reason: "card_changed",
    });
  });

  it("rejects a selector-less start and is destructive, idempotent, and always loaded", () => {
    expect(editPaymentCardTool.inputSchema.safeParse({}).success).toBe(false);
    expect(editPaymentCardTool.inputSchema.safeParse({ operation: "edit_card" }).success).toBe(
      false,
    );
    expect(editPaymentCardTool.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(editPaymentCardTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});
