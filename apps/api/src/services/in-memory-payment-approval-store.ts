import { ulid } from "ulid";

export interface PendingPaymentApprovalInput {
  merchant: string;
  checkoutOrigin: string;
  amountCents: number;
  currency: string;
  nonce: string;
  cardRef: string;
  operatorPubkey: string;
  expiresAt: Date;
}

export interface PendingPaymentApprovalRecord extends PendingPaymentApprovalInput {
  id: string;
  accountId: string;
  status: "pending" | "approved" | "expired";
  jws: string | null;
  sealedCard: string | null;
  createdAt: Date;
}

export interface PendingPaymentApprovalStore {
  create(accountId: string, input: PendingPaymentApprovalInput): Promise<string>;
  getByIdForAccount(id: string, accountId: string): Promise<PendingPaymentApprovalRecord | null>;
  approveForAccount(
    id: string,
    accountId: string,
    jws: string,
    sealedCard: string,
    now: Date,
  ): Promise<boolean>;
}

export class InMemoryPendingPaymentApprovalStore implements PendingPaymentApprovalStore {
  private readonly records = new Map<string, PendingPaymentApprovalRecord>();
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  async create(accountId: string, input: PendingPaymentApprovalInput): Promise<string> {
    const record: PendingPaymentApprovalRecord = {
      id: ulid(),
      accountId,
      ...input,
      status: "pending",
      jws: null,
      sealedCard: null,
      createdAt: this.now(),
    };
    this.records.set(record.id, record);
    return record.id;
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<PendingPaymentApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : { ...record };
  }

  async approveForAccount(
    id: string,
    accountId: string,
    jws: string,
    sealedCard: string,
    now: Date,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.expiresAt <= now
    ) {
      return false;
    }
    record.jws = jws;
    record.sealedCard = sealedCard;
    record.status = "approved";
    return true;
  }
}
