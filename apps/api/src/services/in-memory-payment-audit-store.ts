import { ulid } from "ulid";

export interface PaymentAuditInput {
  merchant: string;
  amountCents: number;
  currency: string;
  last4: string;
  status: string;
  mandateId?: string | undefined;
}

export interface PaymentAuditRecord extends Omit<PaymentAuditInput, "mandateId"> {
  id: string;
  accountId: string;
  mandateId: string | null;
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
  listByAccount(
    accountId: string,
    opts?: PaymentAuditListOptions,
  ): Promise<PaymentAuditRecord[]>;
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
      ...input,
      mandateId: input.mandateId ?? null,
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
          record.accountId === accountId
          && (opts.before === undefined
            || record.createdAt < opts.before.createdAt
            || (record.createdAt.getTime() === opts.before.createdAt.getTime()
              && record.id < opts.before.id)),
      )
      .sort((a, b) => {
        const createdAtOrder = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtOrder !== 0) return createdAtOrder;
        return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
      })
      .slice(0, take)
      .map((record) => ({ ...record }));
  }
}
