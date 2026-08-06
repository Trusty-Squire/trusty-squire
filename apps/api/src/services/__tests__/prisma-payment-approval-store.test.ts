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

  it("retains a delivered candidate until fingerprint-bound confirmation clears it", async () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const expiresAt = new Date("2026-07-27T12:00:15.000Z");
    const fingerprint = "candidate-fingerprint";
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const row = {
      id: "01HAPPROVALAAAAAAAAAAAAAAAA",
      account_id: ACCOUNT_ID,
      status: "pending",
      expires_at: new Date("2026-07-27T12:10:00.000Z"),
      submission_jws: "candidate-jws",
      submission_sealed_card: "candidate-seal",
      submission_candidate_fingerprint: fingerprint,
      submission_phase: "submitted",
      submission_expires_at: expiresAt,
      review_jws: null,
      review_sealed_card: null,
      review_candidate_fingerprint: null,
      review_phase: null,
      review_expires_at: null,
    };
    const prisma = {
      pendingPaymentApproval: {
        async findFirst() {
          return row;
        },
        async updateMany(args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) {
          updates.push(args);
          return { count: 1 };
        },
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaPendingPaymentApprovalStore(prisma);

    await expect(
      store.getRelayCandidateForAccount(row.id, ACCOUNT_ID, now),
    ).resolves.toEqual({
      binding: "approval",
      jws: "candidate-jws",
      sealedCard: "candidate-seal",
      fingerprint,
    });
    expect(updates[0]?.data).toEqual({ submission_phase: "delivered" });

    row.submission_phase = "delivered";
    await expect(
      store.confirmCandidateForAccount(row.id, ACCOUNT_ID, fingerprint, now),
    ).resolves.toBe("confirmed");
    expect(updates[1]).toMatchObject({
      where: {
        id: row.id,
        account_id: ACCOUNT_ID,
        submission_candidate_fingerprint: fingerprint,
        submission_expires_at: { gt: now },
        submission_phase: "delivered",
      },
      data: {
        status: "approved",
        jws: null,
        sealed_card: null,
        review_jws: null,
        review_sealed_card: null,
        submission_jws: null,
        submission_sealed_card: null,
        submission_phase: "confirmed",
      },
    });
  });
});
