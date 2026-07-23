import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  PaymentAuditInput,
  PaymentAuditRecord,
  PaymentAuditStore,
} from "./in-memory-payment-audit-store.js";

export class PrismaPaymentAuditStore implements PaymentAuditStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, input: PaymentAuditInput): Promise<string> {
    const row = await this.prisma.paymentAuditEvent.create({
      data: {
        id: ulid(),
        account_id: accountId,
        merchant: input.merchant,
        amount_cents: input.amountCents,
        currency: input.currency,
        last4: input.last4,
        status: input.status,
        mandate_id: input.mandateId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async listByAccount(accountId: string): Promise<PaymentAuditRecord[]> {
    const rows = await this.prisma.paymentAuditEvent.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      merchant: row.merchant,
      amountCents: row.amount_cents,
      currency: row.currency,
      last4: row.last4,
      status: row.status,
      mandateId: row.mandate_id,
      createdAt: row.created_at,
    }));
  }
}
