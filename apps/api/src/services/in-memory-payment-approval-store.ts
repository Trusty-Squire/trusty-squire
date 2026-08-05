import { ulid } from "ulid";
import type { InMemoryE2ECredentialStore } from "./in-memory-e2e-credential-store.js";

export interface PendingPaymentApprovalInput {
  merchant: string;
  checkoutOrigin: string;
  amountCents: number;
  currency: string;
  nonce: string;
  cardRef: string | null;
  operatorPubkey: string;
  item: string;
  reason: string;
  agent: string;
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

export type BindCardForAccountResult = "card_not_found" | "not_bindable" | "ok";

export interface PendingPaymentApprovalStore {
  create(accountId: string, input: PendingPaymentApprovalInput): Promise<string>;
  getById(id: string): Promise<PendingPaymentApprovalRecord | null>;
  getByIdForAccount(id: string, accountId: string): Promise<PendingPaymentApprovalRecord | null>;
  bindCardForAccount(
    id: string,
    accountId: string,
    cardRef: string,
    now: Date,
  ): Promise<BindCardForAccountResult>;
  stageForAccount(
    id: string,
    accountId: string,
    jws: string,
    sealedCard: string,
    now: Date,
  ): Promise<boolean>;
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

  constructor(
    private readonly e2eCredentialStore: InMemoryE2ECredentialStore,
    now?: () => Date,
  ) {
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

  async getById(id: string): Promise<PendingPaymentApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async bindCardForAccount(
    id: string,
    accountId: string,
    cardRef: string,
    now: Date,
  ): Promise<BindCardForAccountResult> {
    // The synchronous check and bind are atomic within one event-loop turn.
    if (!this.e2eCredentialStore.hasForAccount(cardRef, accountId)) {
      return "card_not_found";
    }
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.cardRef !== null ||
      record.expiresAt <= now
    ) {
      return "not_bindable";
    }
    record.cardRef = cardRef;
    return "ok";
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
      record.jws !== jws ||
      record.sealedCard !== sealedCard
    ) {
      return false;
    }
    if (record.status === "approved") return true;
    if (record.status !== "pending" || record.expiresAt <= now) return false;
    record.status = "approved";
    return true;
  }

  async stageForAccount(
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
    return true;
  }
}
