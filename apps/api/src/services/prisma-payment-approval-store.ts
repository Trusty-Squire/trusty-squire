import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  PendingPaymentApprovalInput,
  PendingPaymentApprovalRecord,
  PendingPaymentApprovalStore,
} from "./in-memory-payment-approval-store.js";

export class PrismaPendingPaymentApprovalStore implements PendingPaymentApprovalStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, input: PendingPaymentApprovalInput): Promise<string> {
    const row = await this.prisma.pendingPaymentApproval.create({
      data: {
        id: ulid(),
        account_id: accountId,
        merchant: input.merchant,
        checkout_origin: input.checkoutOrigin,
        amount_cents: input.amountCents,
        currency: input.currency,
        nonce: input.nonce,
        card_ref: input.cardRef,
        operator_pubkey: input.operatorPubkey,
        status: "pending",
        expires_at: input.expiresAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<PendingPaymentApprovalRecord | null> {
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null
      ? null
      : {
          id: row.id,
          accountId: row.account_id,
          merchant: row.merchant,
          checkoutOrigin: row.checkout_origin,
          amountCents: row.amount_cents,
          currency: row.currency,
          nonce: row.nonce,
          cardRef: row.card_ref,
          operatorPubkey: row.operator_pubkey,
          status: row.status as PendingPaymentApprovalRecord["status"],
          jws: row.jws,
          sealedCard: row.sealed_card,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        };
  }

  async approveForAccount(
    id: string,
    accountId: string,
    jws: string,
    sealedCard: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.prisma.pendingPaymentApproval.updateMany({
      where: {
        id,
        account_id: accountId,
        status: "pending",
        expires_at: { gt: now },
      },
      data: { jws, sealed_card: sealedCard, status: "approved" },
    });
    return result.count > 0;
  }
}
