import { ulid } from "ulid";
import type { VaultEditableMetadata } from "@trusty-squire/vault";

export type CredentialMutationOperation = "edit" | "delete";
export type CredentialMutationApprovalStatus =
  | "pending"
  | "executing"
  | "recoverable"
  | "approved"
  | "failed";

export interface CredentialMutationApprovalInput {
  operation: CredentialMutationOperation;
  credentialReference: string;
  credentialService: string | null;
  credentialLabel: string;
  before: VaultEditableMetadata;
  after: VaultEditableMetadata | null;
  nonce: string;
  agent: string;
  intentHash: string;
  expiresAt: Date;
}

export interface CredentialMutationApprovalRecord extends CredentialMutationApprovalInput {
  id: string;
  accountId: string;
  status: CredentialMutationApprovalStatus;
  failureCode: string | null;
  mandateId: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

export type CredentialMutationClaimResult =
  | "claimed"
  | "reclaimed"
  | "already_approved"
  | "expired"
  | "not_claimable";

export interface CredentialMutationApprovalStore {
  create(accountId: string, input: CredentialMutationApprovalInput): Promise<string>;
  findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CredentialMutationApprovalRecord | null>;
  getById(id: string): Promise<CredentialMutationApprovalRecord | null>;
  getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialMutationApprovalRecord | null>;
  claim(id: string, now: Date): Promise<CredentialMutationClaimResult>;
  complete(id: string, mandateId: string | null, now: Date): Promise<void>;
  makeRecoverable(id: string): Promise<void>;
  fail(id: string, failureCode: string, now: Date): Promise<void>;
}

export class InMemoryCredentialMutationApprovalStore implements CredentialMutationApprovalStore {
  private readonly records = new Map<string, CredentialMutationApprovalRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(accountId: string, input: CredentialMutationApprovalInput): Promise<string> {
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
  ): Promise<CredentialMutationApprovalRecord | null> {
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.intentHash === intentHash &&
        candidate.status === "pending" &&
        candidate.expiresAt > now,
    );
    return record === undefined ? null : cloneRecord(record);
  }

  async getById(id: string): Promise<CredentialMutationApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialMutationApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : cloneRecord(record);
  }

  async claim(id: string, now: Date): Promise<CredentialMutationClaimResult> {
    const record = this.records.get(id);
    if (record === undefined) return "not_claimable";
    if (record.status === "approved") return "already_approved";
    if (record.expiresAt <= now) return "expired";
    if (record.status === "recoverable") {
      record.status = "executing";
      record.executedAt = now;
      return "reclaimed";
    }
    if (
      record.status === "executing" &&
      record.executedAt !== null &&
      record.executedAt.getTime() <= now.getTime() - 30_000
    ) {
      record.executedAt = now;
      return "reclaimed";
    }
    if (record.status !== "pending") return "not_claimable";
    record.status = "executing";
    record.executedAt = now;
    return "claimed";
  }

  async complete(id: string, mandateId: string | null, now: Date): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.status = "approved";
    record.mandateId = mandateId;
    record.executedAt = now;
  }

  async makeRecoverable(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined || record.status !== "executing") return;
    record.status = "recoverable";
  }

  async fail(id: string, failureCode: string, now: Date): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.status = "failed";
    record.failureCode = failureCode;
    record.executedAt = now;
  }
}

function cloneMetadata(value: VaultEditableMetadata): VaultEditableMetadata {
  return {
    label: value.label,
    allowed_hosts: [...value.allowed_hosts],
    login_hosts: [...value.login_hosts],
  };
}

function cloneInput(input: CredentialMutationApprovalInput): CredentialMutationApprovalInput {
  return {
    ...input,
    before: cloneMetadata(input.before),
    after: input.after === null ? null : cloneMetadata(input.after),
    expiresAt: new Date(input.expiresAt),
  };
}

function cloneRecord(record: CredentialMutationApprovalRecord): CredentialMutationApprovalRecord {
  return {
    ...record,
    before: cloneMetadata(record.before),
    after: record.after === null ? null : cloneMetadata(record.after),
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
    executedAt: record.executedAt === null ? null : new Date(record.executedAt),
  };
}
