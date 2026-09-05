// Approval records for `fetch_credential` — the one path that returns a raw
// vaulted value to an agent.
//
// Deliberately a SEPARATE store from credential mutations and payments rather
// than a third `operation` on either. Disclosure is not a mutation: it has its
// own vouch context, its own table, and its own terminal state, so a signed
// mutation or payment mandate is not merely rejected by a check that could be
// forgotten — it has nowhere to land. Nothing here can edit or delete a
// credential, and nothing in the mutation store can reveal one.
//
// Delivery is SINGLE-USE. `approve` records the human's decision; `claim`
// moves approved → consumed exactly once, and only that transition authorizes
// a decrypt. A replayed approval_id after delivery returns already_consumed
// and no value.

import { ulid } from "ulid";

export type CredentialFetchApprovalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "failed";

export type CredentialFetchRequesterKind = "web" | "agent";

export interface CredentialFetchApprovalInput {
  credentialReference: string;
  credentialService: string | null;
  credentialLabel: string;
  /** The single field the agent asked for, or null for the whole field map. */
  field: string | null;
  /** Field names on the credential at mint time — shown in the ceremony. */
  fieldNames: string[];
  nonce: string;
  agent: string;
  requesterKind: CredentialFetchRequesterKind;
  intentHash: string;
  expiresAt: Date;
}

export interface CredentialFetchApprovalRecord extends CredentialFetchApprovalInput {
  id: string;
  accountId: string;
  status: CredentialFetchApprovalStatus;
  failureCode: string | null;
  mandateId: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  deliveredAt: Date | null;
}

export type CredentialFetchApproveResult =
  | "approved"
  | "already_approved"
  | "expired"
  | "not_pending";

export type CredentialFetchDenyResult = "denied" | "already_denied" | "not_pending";

/** `expired` means THIS call performed the transition — the caller audits once. */
export type CredentialFetchExpireResult = "expired" | "already_terminal";

export type CredentialFetchClaimResult =
  | { kind: "claimed"; record: CredentialFetchApprovalRecord }
  | { kind: "not_found" }
  | { kind: "not_approved"; record: CredentialFetchApprovalRecord }
  | { kind: "already_consumed"; record: CredentialFetchApprovalRecord }
  | { kind: "expired"; record: CredentialFetchApprovalRecord };

export interface CredentialFetchApprovalStore {
  create(accountId: string, input: CredentialFetchApprovalInput): Promise<string>;
  findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CredentialFetchApprovalRecord | null>;
  getById(id: string): Promise<CredentialFetchApprovalRecord | null>;
  getByIdForAccount(id: string, accountId: string): Promise<CredentialFetchApprovalRecord | null>;
  approve(id: string, mandateId: string | null): Promise<CredentialFetchApproveResult>;
  deny(id: string): Promise<CredentialFetchDenyResult>;
  /** approved → consumed, exactly once. The ONLY transition that authorizes a decrypt. */
  claim(id: string, accountId: string): Promise<CredentialFetchClaimResult>;
  /**
   * Settle a lapsed pending/approved approval as failed. Idempotent, and it
   * reports whether IT did the work — so a polling agent produces one expiry
   * audit row, not one per poll.
   */
  expire(id: string, now: Date): Promise<CredentialFetchExpireResult>;
}

export class InMemoryCredentialFetchApprovalStore implements CredentialFetchApprovalStore {
  private readonly records = new Map<string, CredentialFetchApprovalRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(accountId: string, input: CredentialFetchApprovalInput): Promise<string> {
    const id = ulid();
    this.records.set(id, {
      id,
      accountId,
      ...cloneInput(input),
      status: "pending",
      failureCode: null,
      mandateId: null,
      createdAt: this.now(),
      approvedAt: null,
      deliveredAt: null,
    });
    return id;
  }

  async findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CredentialFetchApprovalRecord | null> {
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.intentHash === intentHash &&
        candidate.status === "pending" &&
        candidate.expiresAt > now,
    );
    return record === undefined ? null : cloneRecord(record);
  }

  async getById(id: string): Promise<CredentialFetchApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialFetchApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : cloneRecord(record);
  }

  async approve(id: string, mandateId: string | null): Promise<CredentialFetchApproveResult> {
    const record = this.records.get(id);
    if (record === undefined) return "not_pending";
    if (record.status === "approved") return "already_approved";
    if (record.status !== "pending") return "not_pending";
    const now = this.now();
    if (record.expiresAt <= now) return "expired";
    record.status = "approved";
    record.mandateId = mandateId;
    record.approvedAt = now;
    return "approved";
  }

  async deny(id: string): Promise<CredentialFetchDenyResult> {
    const record = this.records.get(id);
    if (record === undefined) return "not_pending";
    if (record.status === "denied") return "already_denied";
    // An already-approved fetch stays approved: the value may already be out.
    if (record.status !== "pending") return "not_pending";
    record.status = "denied";
    record.failureCode = "denied_by_user";
    return "denied";
  }

  async expire(id: string, now: Date): Promise<CredentialFetchExpireResult> {
    const record = this.records.get(id);
    if (record === undefined) return "already_terminal";
    if (record.status !== "pending" && record.status !== "approved") return "already_terminal";
    if (record.expiresAt > now) return "already_terminal";
    record.status = "failed";
    record.failureCode = "expired";
    return "expired";
  }

  async claim(id: string, accountId: string): Promise<CredentialFetchClaimResult> {
    const record = this.records.get(id);
    if (record === undefined || record.accountId !== accountId) return { kind: "not_found" };
    if (record.status === "consumed") {
      return { kind: "already_consumed", record: cloneRecord(record) };
    }
    if (record.status !== "approved") return { kind: "not_approved", record: cloneRecord(record) };
    const now = this.now();
    if (record.expiresAt <= now) return { kind: "expired", record: cloneRecord(record) };
    record.status = "consumed";
    record.deliveredAt = now;
    return { kind: "claimed", record: cloneRecord(record) };
  }
}

function cloneInput(input: CredentialFetchApprovalInput): CredentialFetchApprovalInput {
  return { ...input, fieldNames: [...input.fieldNames], expiresAt: new Date(input.expiresAt) };
}

function cloneRecord(record: CredentialFetchApprovalRecord): CredentialFetchApprovalRecord {
  return {
    ...record,
    fieldNames: [...record.fieldNames],
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
    approvedAt: record.approvedAt === null ? null : new Date(record.approvedAt),
    deliveredAt: record.deliveredAt === null ? null : new Date(record.deliveredAt),
  };
}
