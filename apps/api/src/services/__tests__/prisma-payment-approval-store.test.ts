import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaPendingPaymentApprovalStore } from "../prisma-payment-approval-store.js";

const ACCOUNT_ID = "01HACCOUNTAAAAAAAAAAAAAAAA";
const CARD_REF = "01HCARDCCCCCCCCCCCCCCCCCCC";

describe("PrismaPendingPaymentApprovalStore", () => {
  it("locks and parameterizes the card lookup before binding", async () => {
    let query = "";
    let values: unknown[] = [];
    let updateCalls = 0;

    const tx = {
      async $queryRaw(strings: TemplateStringsArray, ...boundValues: unknown[]) {
        query = strings.join("?");
        values = boundValues;
        return [{ id: CARD_REF }];
      },
      pendingPaymentApproval: {
        async updateMany() {
          updateCalls += 1;
          return { count: 1 };
        },
      },
    } as unknown as ApiPrismaClient;
    const prisma = {
      async $transaction<T>(fn: (transaction: ApiPrismaClient) => Promise<T>): Promise<T> {
        return fn(tx);
      },
    } as unknown as ApiPrismaClient;

    const store = new PrismaPendingPaymentApprovalStore(prisma);
    const result = await store.bindCardForAccount(
      "01HAPPROVALAAAAAAAAAAAAAAAA",
      ACCOUNT_ID,
      CARD_REF,
      new Date("2026-07-27T12:00:00.000Z"),
    );

    expect(query.replace(/\s+/g, " ").trim()).toBe(
      'SELECT id FROM "E2ECredential" WHERE id = ? AND account_id = ? FOR KEY SHARE',
    );
    expect(values).toEqual([CARD_REF, ACCOUNT_ID]);
    expect(updateCalls).toBe(1);
    expect(result).toBe("ok");
  });
});
