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

export interface PaymentAuditStore {
  create(accountId: string, input: PaymentAuditInput): Promise<string>;
  listByAccount(accountId: string): Promise<PaymentAuditRecord[]>;
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

  async listByAccount(accountId: string): Promise<PaymentAuditRecord[]> {
    return this.records
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((record) => ({ ...record }));
  }
}
