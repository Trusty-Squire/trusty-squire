import type { VaultEditableMetadata } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import {
  type CredentialMutationCommitResult,
  type CredentialMutationApprovalInput,
  type CredentialMutationApprovalRecord,
  type CredentialMutationApprovalStore,
  mutationAuditEvent,
} from "./credential-mutation-approval-store.js";
import { ulid } from "ulid";

export class PrismaCredentialMutationApprovalStore implements CredentialMutationApprovalStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, input: CredentialMutationApprovalInput): Promise<string> {
    const row = await this.prisma.credentialMutationApproval.create({
      data: {
        id: ulid(),
        account_id: accountId,
        operation: input.operation,
        credential_reference: input.credentialReference,
        credential_service: input.credentialService,
        credential_label: input.credentialLabel,
        before_metadata: input.before,
        after_metadata: input.after,
        nonce: input.nonce,
        agent: input.agent,
        intent_hash: input.intentHash,
        status: "pending",
        expires_at: input.expiresAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CredentialMutationApprovalRecord | null> {
    const row = await this.prisma.credentialMutationApproval.findFirst({
      where: {
        account_id: accountId,
        intent_hash: intentHash,
        status: "pending",
        expires_at: { gt: now },
      },
      orderBy: { created_at: "desc" },
    });
    return row === null ? null : toRecord(row);
  }

  async getById(id: string): Promise<CredentialMutationApprovalRecord | null> {
    const row = await this.prisma.credentialMutationApproval.findFirst({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialMutationApprovalRecord | null> {
    const row = await this.prisma.credentialMutationApproval.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null ? null : toRecord(row);
  }

  async commit(
    id: string,
    mandateId: string | null,
    now: Date,
  ): Promise<CredentialMutationCommitResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<CredentialMutationApprovalRow[]>`
          SELECT id, account_id, operation, credential_reference, credential_service,
                 credential_label, before_metadata, after_metadata, nonce, agent,
                 intent_hash, status, failure_code, mandate_id, created_at,
                 expires_at, executed_at
          FROM credential_mutation_approvals
          WHERE id = ${id}
          FOR UPDATE
        `;
        const row = locked[0];
        if (row === undefined) return "not_pending";
        const record = toRecord(row);
        if (record.status === "approved") return "already_approved";
        if (record.expiresAt <= now) return "expired";
        if (record.status !== "pending") return "not_pending";

        const credentials = await tx.$queryRaw<SafeCredentialRow[]>`
          SELECT reference, account_id, label, allowed_hosts, metadata, deleted_at
          FROM "Credential"
          WHERE reference = ${record.credentialReference}
            AND account_id = ${record.accountId}
          LIMIT 1
        `;
        const credential = credentials[0];
        if (credential === undefined || credential.deleted_at !== null) {
          await markFailed(tx, record.id, "credential_not_found", now);
          return "credential_not_found";
        }

        if (record.operation === "edit") {
          if (record.after === null)
            throw new Error("credential edit approval missing after state");
          if (!sameMetadata(editableMetadata(credential), record.before)) {
            await markFailed(tx, record.id, "credential_metadata_changed", now);
            return "metadata_changed";
          }
          const currentMetadata = objectMetadata(credential.metadata);
          const updated = await tx.credential.updateMany({
            where: {
              reference: record.credentialReference,
              account_id: record.accountId,
              deleted_at: null,
              label: credential.label,
              allowed_hosts: { equals: credential.allowed_hosts },
              metadata: { equals: currentMetadata },
            },
            data: {
              label: record.after.label,
              allowed_hosts: record.after.allowed_hosts,
              metadata: {
                ...currentMetadata,
                login_hosts: record.after.login_hosts,
                ...(record.after.login_hosts.length > 0
                  ? { auth_strategy: "username_password" }
                  : {}),
              },
            },
          });
          if (updated.count === 0) {
            await markFailed(tx, record.id, "credential_metadata_changed", now);
            return "metadata_changed";
          }
        } else {
          const deleted = await tx.credential.updateMany({
            where: {
              reference: record.credentialReference,
              account_id: record.accountId,
              deleted_at: null,
            },
            data: { deleted_at: now },
          });
          if (deleted.count === 0) {
            await markFailed(tx, record.id, "credential_not_found", now);
            return "credential_not_found";
          }
        }

        const event = mutationAuditEvent(record);
        await tx.vaultAuditEvent.create({
          data: {
            id: ulid(),
            account_id: event.account_id,
            type: event.type,
            payload: event.payload as unknown as Record<string, unknown>,
            emitted_at: now,
          },
        });
        const completed = await tx.credentialMutationApproval.updateMany({
          where: { id: record.id, status: "pending" },
          data: { status: "approved", mandate_id: mandateId, executed_at: now },
        });
        if (completed.count !== 1) throw new Error("credential mutation approval lost DB claim");
        return "approved";
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) return "name_conflict";
      throw error;
    }
  }
}

interface CredentialMutationApprovalRow {
  id: string;
  account_id: string;
  operation: string;
  credential_reference: string;
  credential_service: string | null;
  credential_label: string;
  before_metadata: unknown;
  after_metadata: unknown;
  nonce: string;
  agent: string;
  intent_hash: string;
  status: string;
  failure_code: string | null;
  mandate_id: string | null;
  created_at: Date;
  expires_at: Date;
  executed_at: Date | null;
}

interface SafeCredentialRow {
  reference: string;
  account_id: string;
  label: string;
  allowed_hosts: string[];
  metadata: unknown;
  deleted_at: Date | null;
}

async function markFailed(
  tx: ApiPrismaClient,
  id: string,
  failureCode: string,
  now: Date,
): Promise<void> {
  await tx.credentialMutationApproval.updateMany({
    where: { id, status: "pending" },
    data: { status: "failed", failure_code: failureCode, executed_at: now },
  });
}

function editableMetadata(row: SafeCredentialRow): VaultEditableMetadata {
  const candidate = objectMetadata(row.metadata);
  return {
    label: row.label,
    allowed_hosts: row.allowed_hosts,
    login_hosts: metadataStringArray(candidate.login_hosts),
  };
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameMetadata(left: VaultEditableMetadata, right: VaultEditableMetadata): boolean {
  return (
    left.label === right.label &&
    sameArray(left.allowed_hosts, right.allowed_hosts) &&
    sameArray(left.login_hosts, right.login_hosts)
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code ?? "") === "P2002"
  );
}

function metadata(value: unknown): VaultEditableMetadata {
  if (value === null || typeof value !== "object") {
    throw new Error("invalid credential mutation metadata");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.label !== "string" ||
    !Array.isArray(candidate.allowed_hosts) ||
    !Array.isArray(candidate.login_hosts) ||
    !candidate.allowed_hosts.every((host) => typeof host === "string") ||
    !candidate.login_hosts.every((host) => typeof host === "string")
  ) {
    throw new Error("invalid credential mutation metadata");
  }
  return {
    label: candidate.label,
    allowed_hosts: candidate.allowed_hosts,
    login_hosts: candidate.login_hosts,
  };
}

function toRecord(row: {
  id: string;
  account_id: string;
  operation: string;
  credential_reference: string;
  credential_service: string | null;
  credential_label: string;
  before_metadata: unknown;
  after_metadata: unknown;
  nonce: string;
  agent: string;
  intent_hash: string;
  status: string;
  failure_code: string | null;
  mandate_id: string | null;
  created_at: Date;
  expires_at: Date;
  executed_at: Date | null;
}): CredentialMutationApprovalRecord {
  if (row.operation !== "edit" && row.operation !== "delete") {
    throw new Error("invalid credential mutation operation");
  }
  if (row.status !== "pending" && row.status !== "approved" && row.status !== "failed") {
    throw new Error("invalid credential mutation approval status");
  }
  return {
    id: row.id,
    accountId: row.account_id,
    operation: row.operation,
    credentialReference: row.credential_reference,
    credentialService: row.credential_service,
    credentialLabel: row.credential_label,
    before: metadata(row.before_metadata),
    after: row.after_metadata === null ? null : metadata(row.after_metadata),
    nonce: row.nonce,
    agent: row.agent,
    intentHash: row.intent_hash,
    status: row.status,
    failureCode: row.failure_code,
    mandateId: row.mandate_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
  };
}
