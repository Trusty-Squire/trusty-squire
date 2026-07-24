import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  PaymentAuditInput,
  PaymentAuditListOptions,
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

  async listByAccount(
    accountId: string,
    opts: PaymentAuditListOptions = {},
  ): Promise<PaymentAuditRecord[]> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.paymentAuditEvent.findMany({
      where: {
        account_id: accountId,
        ...(opts.before !== undefined
          ? {
              OR: [
                { created_at: { lt: opts.before.createdAt } },
                { created_at: opts.before.createdAt, id: { lt: opts.before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take,
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

  async exportAll(accountId: string): Promise<PaymentAuditRecord[]> {
    const rows = await this.prisma.paymentAuditEvent.findMany({
      where: { account_id: accountId },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
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
