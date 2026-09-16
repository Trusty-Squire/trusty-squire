import { ulid } from "ulid";
import { VAULT_AUDIT_TYPES, type VaultAuditEventInput, type VaultAuditStore } from "@trusty-squire/vault";
import type { E2ECredentialCardUpdate, E2ECredentialStore } from "./in-memory-e2e-credential-store.js";

// edit_payment_card's approval records — the passkey-gated saved-card edit.
//
// The ceremony primitives (payload hashing, mandate verification, ownership,
// link building) are the SHARED ones every other approval kind uses; only the
// apply step is card-specific. The agent proposes nothing but the target
// card: the human edits the fields in the browser, which decrypts locally,
// re-encrypts with the same sealed key, and submits the new blob at approve
// time — so `after` is null until the approved mutation carries it.
//
// The store stays separate from the credential-mutation approval store for
// the same reason fetch_credential's is: a signed credential-mutation (or
// payment) mandate has nowhere to land here, and vice versa.

export type CardMutationOperation = "edit_card";
export type CardMutationApprovalStatus = "pending" | "approved" | "failed";
export type CardMutationRequesterKind = "web" | "agent";

// Display metadata only — never a card value. brand/last4 are the nullable
// display columns (legacy cards can carry nulls).
export interface CardMutationMetadata {
  label: string;
  brand: string | null;
  last4: string | null;
}

export interface CardMutationApprovalInput {
  operation: CardMutationOperation;
  cardId: string;
  cardLabel: string;
  before: CardMutationMetadata;
  after: CardMutationMetadata | null;
  nonce: string;
  agent: string;
  requesterKind: CardMutationRequesterKind;
  intentHash: string;
  expiresAt: Date;
}

export interface CardMutationApprovalRecord extends CardMutationApprovalInput {
  id: string;
  accountId: string;
  status: CardMutationApprovalStatus;
  failureCode: string | null;
  mandateId: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

// The browser-submitted whole-card replacement the signed approval settles.
export type CardMutationApplied = E2ECredentialCardUpdate;

export type CardMutationCommitResult =
  | "approved"
  | "already_approved"
  | "expired"
  | "not_pending"
  | "card_not_found"
  | "card_changed";

export interface CardMutationApprovalStore {
  create(accountId: string, input: CardMutationApprovalInput): Promise<string>;
  findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CardMutationApprovalRecord | null>;
  getById(id: string): Promise<CardMutationApprovalRecord | null>;
  getByIdForAccount(id: string, accountId: string): Promise<CardMutationApprovalRecord | null>;
  commit(
    id: string,
    mandateId: string | null,
    applied: CardMutationApplied,
  ): Promise<CardMutationCommitResult>;
}

export class InMemoryCardMutationApprovalStore implements CardMutationApprovalStore {
  private readonly records = new Map<string, CardMutationApprovalRecord>();
  private readonly committing = new Set<string>();

  constructor(
    private readonly cards: E2ECredentialStore,
    private readonly audit: VaultAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(accountId: string, input: CardMutationApprovalInput): Promise<string> {
    const id = ulid();
    this.records.set(id, {
      id,
      accountId,
      ...cloneInput(input),
      status: "pending",
      failureCode: null,
      mandateId: null,
      createdAt: this.now(),
      executedAt: null,
    });
    return id;
  }

  async findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CardMutationApprovalRecord | null> {
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.intentHash === intentHash &&
        candidate.status === "pending" &&
        candidate.expiresAt > now,
    );
    return record === undefined ? null : cloneRecord(record);
  }

  async getById(id: string): Promise<CardMutationApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CardMutationApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : cloneRecord(record);
  }

  async commit(
    id: string,
    mandateId: string | null,
    applied: CardMutationApplied,
  ): Promise<CardMutationCommitResult> {
    const record = this.records.get(id);
    if (record === undefined || this.committing.has(id)) return "not_pending";
    if (record.status === "approved") return "already_approved";
    if (record.status !== "pending") return "not_pending";
    this.committing.add(id);
    try {
      const now = this.now();
      if (record.expiresAt <= now) return "expired";
      const card = await this.cards.getByIdForAccount(record.cardId, record.accountId);
      if (card === null) {
        markFailed(record, "card_not_found", now);
        return "card_not_found";
      }
      if (!sameMetadata(cardMetadataOf(card), record.before)) {
        markFailed(record, "card_changed", now);
        return "card_changed";
      }
      const event = cardMutationAuditEvent(record, applied);
      const updated = await this.cards.updateCardForAccount(record.cardId, record.accountId, applied);
      if (!updated) {
        markFailed(record, "card_not_found", now);
        return "card_not_found";
      }
      try {
        await this.audit.record(event);
      } catch (error) {
        // Mirror the credential store: roll the card back if the audit write
        // fails, so the ledger never misses an applied mutation.
        await this.cards.updateCardForAccount(record.cardId, record.accountId, {
          label: card.label,
          blob: card.blob,
          brand: card.brand,
          last4: card.last4,
        });
        throw error;
      }
      record.status = "approved";
      record.after = { label: applied.label, brand: applied.brand, last4: applied.last4 };
      record.mandateId = mandateId;
      record.executedAt = now;
      return "approved";
    } finally {
      this.committing.delete(id);
    }
  }
}

export function cardMetadataOf(card: {
  label: string;
  brand: string | null;
  last4: string | null;
}): CardMutationMetadata {
  return { label: card.label, brand: card.brand, last4: card.last4 };
}

function sameMetadata(left: CardMutationMetadata, right: CardMutationMetadata): boolean {
  return left.label === right.label && left.brand === right.brand && left.last4 === right.last4;
}

export function cardMutationAuditEvent(
  record: CardMutationApprovalRecord,
  applied: CardMutationApplied,
): VaultAuditEventInput {
  return {
    account_id: record.accountId,
    type: VAULT_AUDIT_TYPES.cardUpdated,
    payload: {
      reference: `card://${record.cardId}`,
      requester: record.requesterKind === "web" ? "user" : "agent",
      label: applied.label,
      approval_id: record.id,
      ...(applied.brand !== null ? { brand: applied.brand } : {}),
      ...(applied.last4 !== null ? { last4: applied.last4 } : {}),
    },
  };
}

function markFailed(
  record: CardMutationApprovalRecord,
  failureCode: string,
  now: Date,
): void {
  record.status = "failed";
  record.failureCode = failureCode;
  record.executedAt = now;
}

function cloneMetadata(value: CardMutationMetadata): CardMutationMetadata {
  return { label: value.label, brand: value.brand, last4: value.last4 };
}

function cloneInput(input: CardMutationApprovalInput): CardMutationApprovalInput {
  return {
    ...input,
    before: cloneMetadata(input.before),
    after: input.after === null ? null : cloneMetadata(input.after),
    expiresAt: new Date(input.expiresAt),
  };
}

function cloneRecord(record: CardMutationApprovalRecord): CardMutationApprovalRecord {
  return {
    ...record,
    before: cloneMetadata(record.before),
    after: record.after === null ? null : cloneMetadata(record.after),
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
    executedAt: record.executedAt === null ? null : new Date(record.executedAt),
  };
}
