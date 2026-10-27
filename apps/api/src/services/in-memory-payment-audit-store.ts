import { ulid } from "ulid";
import type { VaultAuditEventInput } from "@trusty-squire/vault";

export interface PaymentAuditInput {
  merchant: string;
  amountCents: number;
  currency: string;
  last4: string;
  status: string;
  mandateId?: string | undefined;
  // The payment approval this outcome settles, when the broker knows it. The
  // approval card reads it to tell a completed checkout from one in flight.
  approvalId?: string | undefined;
}

export interface PaymentAuditRecord extends Omit<PaymentAuditInput, "mandateId" | "approvalId"> {
  id: string;
  accountId: string;
  mandateId: string | null;
  approvalId: string | null;
  createdAt: Date;
}

export interface PaymentAuditCursor {
  createdAt: Date;
  id: string;
}

export interface PaymentAuditListOptions {
  limit?: number;
  before?: PaymentAuditCursor;
}

export interface PaymentAuditStore {
  create(accountId: string, input: PaymentAuditInput): Promise<string>;
  createWithVaultAudit?(
    accountId: string,
    input: PaymentAuditInput,
    eventForId: (id: string) => VaultAuditEventInput,
  ): Promise<string>;
  listByAccount(accountId: string, opts?: PaymentAuditListOptions): Promise<PaymentAuditRecord[]>;
  exportAll(accountId: string): Promise<PaymentAuditRecord[]>;
  /** The newest outcome recorded for one payment approval, or null. */
  findLatestForApproval(accountId: string, approvalId: string): Promise<PaymentAuditRecord | null>;
}

export class InMemoryPaymentAuditStore implements PaymentAuditStore {
  private readonly records: PaymentAuditRecord[] = [];
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  async create(accountId: string, input: PaymentAuditInput): Promise<string> {
    const record: PaymentAuditRecord = {
      id: ulid(),
      accountId,
      merchant: input.merchant,
      amountCents: input.amountCents,
      currency: input.currency,
      last4: input.last4,
      status: input.status,
      mandateId: input.mandateId ?? null,
      approvalId: input.approvalId ?? null,
      createdAt: this.now(),
    };
    this.records.push(record);
    return record.id;
  }

  async listByAccount(
    accountId: string,
    opts: PaymentAuditListOptions = {},
  ): Promise<PaymentAuditRecord[]> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.records
      .filter(
        (record) =>
          record.accountId === accountId &&
          (opts.before === undefined ||
            record.createdAt < opts.before.createdAt ||
            (record.createdAt.getTime() === opts.before.createdAt.getTime() &&
              record.id < opts.before.id)),
      )
      .sort((a, b) => {
        const createdAtOrder = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtOrder !== 0) return createdAtOrder;
        return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
      })
      .slice(0, take)
      .map((record) => ({ ...record }));
  }

  async exportAll(accountId: string): Promise<PaymentAuditRecord[]> {
    return this.records
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => {
        const createdAtOrder = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtOrder !== 0) return createdAtOrder;
        return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
      })
      .map((record) => ({ ...record }));
  }

  async findLatestForApproval(
    accountId: string,
    approvalId: string,
  ): Promise<PaymentAuditRecord | null> {
    let latest: PaymentAuditRecord | null = null;
    for (const record of this.records) {
      if (record.accountId !== accountId || record.approvalId !== approvalId) continue;
      if (
        latest === null ||
        record.createdAt > latest.createdAt ||
        (record.createdAt.getTime() === latest.createdAt.getTime() && record.id > latest.id)
      ) {
        latest = record;
      }
    }
    return latest === null ? null : { ...latest };
  }
}
