import { ulid } from "ulid";
import {
  VAULT_AUDIT_TYPES,
  type CredentialStore,
  type VaultAuditEventInput,
  type VaultAuditStore,
} from "@trusty-squire/vault";
import type { CredentialMutationMetadata } from "./credential-metadata.js";

export type CredentialMutationOperation = "edit" | "delete";
export type CredentialMutationApprovalStatus = "pending" | "approved" | "failed";

export interface CredentialMutationApprovalInput {
  operation: CredentialMutationOperation;
  credentialReference: string;
  credentialService: string | null;
  credentialLabel: string;
  before: CredentialMutationMetadata;
  after: CredentialMutationMetadata | null;
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

export type CredentialMutationCommitResult =
  | "approved"
  | "already_approved"
  | "expired"
  | "not_pending"
  | "credential_not_found"
  | "metadata_changed"
  | "name_conflict";

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
  commit(id: string, mandateId: string | null): Promise<CredentialMutationCommitResult>;
}

export class InMemoryCredentialMutationApprovalStore implements CredentialMutationApprovalStore {
  private readonly records = new Map<string, CredentialMutationApprovalRecord>();
  private readonly committing = new Set<string>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly audit: VaultAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  async commit(id: string, mandateId: string | null): Promise<CredentialMutationCommitResult> {
    const record = this.records.get(id);
    if (record === undefined || this.committing.has(id)) return "not_pending";
    if (record.status === "approved") return "already_approved";
    if (record.status !== "pending") return "not_pending";
    this.committing.add(id);
    try {
      const now = this.now();
      if (record.expiresAt <= now) return "expired";
      const credential = await this.credentials.findByReferenceIncludingDeleted(
        record.credentialReference,
      );
      if (
        credential === null ||
        credential.account_id !== record.accountId ||
        credential.deleted_at !== null
      ) {
        markFailed(record, "credential_not_found", now);
        return "credential_not_found";
      }
      if (!sameMetadata(editableMetadata(credential), record.before)) {
        markFailed(record, "credential_metadata_changed", now);
        return "metadata_changed";
      }
      const event = mutationAuditEvent(record);
      if (record.operation === "edit") {
        if (record.after === null) throw new Error("credential edit approval missing after state");
        const nextMetadata = metadataAfterEdit(credential.metadata, record.after);
        const updated = await this.credentials.updateMetadata(
          credential.reference,
          {
            label: credential.label,
            allowed_hosts: credential.allowed_hosts,
            metadata: credential.metadata,
          },
          {
            label: record.after.label,
            allowed_hosts: record.after.allowed_hosts,
            metadata: nextMetadata,
          },
        );
        if (updated === "conflict") {
          markFailed(record, "credential_name_conflict", now);
          return "name_conflict";
        }
        if (updated === "changed") {
          markFailed(record, "credential_metadata_changed", now);
          return "metadata_changed";
        }
        try {
          await this.audit.record(event);
        } catch (error) {
          await this.credentials.updateMetadata(
            credential.reference,
            {
              label: record.after.label,
              allowed_hosts: record.after.allowed_hosts,
              metadata: nextMetadata,
            },
            {
              label: credential.label,
              allowed_hosts: credential.allowed_hosts,
              metadata: credential.metadata,
            },
          );
          throw error;
        }
      } else {
        await this.credentials.softDelete(credential.reference, now);
        try {
          await this.audit.record(event);
        } catch (error) {
          await this.credentials.restore(credential.reference);
          throw error;
        }
      }
      record.status = "approved";
      record.mandateId = mandateId;
      record.executedAt = now;
      return "approved";
    } finally {
      this.committing.delete(id);
    }
  }
}

function markFailed(
  record: CredentialMutationApprovalRecord,
  failureCode: string,
  now: Date,
): void {
  record.status = "failed";
  record.failureCode = failureCode;
  record.executedAt = now;
}

function editableMetadata(record: {
  label: string;
  allowed_hosts: string[];
  metadata: Record<string, unknown>;
}): CredentialMutationMetadata {
  return {
    label: record.label,
    allowed_hosts: [...record.allowed_hosts],
    login_hosts: metadataStringArray(record.metadata.login_hosts),
    auth_strategy:
      typeof record.metadata.auth_strategy === "string" ? record.metadata.auth_strategy : null,
  };
}

function metadataAfterEdit(
  current: Record<string, unknown>,
  after: CredentialMutationMetadata,
): Record<string, unknown> {
  const { auth_strategy: _authStrategy, login_hosts: _loginHosts, ...preserved } = current;
  return {
    ...preserved,
    login_hosts: after.login_hosts,
    ...(after.auth_strategy !== null ? { auth_strategy: after.auth_strategy } : {}),
  };
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameMetadata(
  left: CredentialMutationMetadata,
  right: CredentialMutationMetadata,
): boolean {
  return (
    left.label === right.label &&
    left.auth_strategy === right.auth_strategy &&
    sameArray(left.allowed_hosts, right.allowed_hosts) &&
    sameArray(left.login_hosts, right.login_hosts)
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function mutationAuditEvent(record: CredentialMutationApprovalRecord): VaultAuditEventInput {
  return {
    account_id: record.accountId,
    type:
      record.operation === "edit" ? VAULT_AUDIT_TYPES.metadataEdited : VAULT_AUDIT_TYPES.deleted,
    payload: {
      reference: record.credentialReference,
      requester: record.agent.startsWith("web-session:") ? "user" : "agent",
      ...(record.credentialService !== null ? { service: record.credentialService } : {}),
      label: record.operation === "edit" ? record.after!.label : record.credentialLabel,
      approval_id: record.id,
    },
  };
}

function cloneMetadata(value: CredentialMutationMetadata): CredentialMutationMetadata {
  return {
    label: value.label,
    allowed_hosts: [...value.allowed_hosts],
    login_hosts: [...value.login_hosts],
    auth_strategy: value.auth_strategy,
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
