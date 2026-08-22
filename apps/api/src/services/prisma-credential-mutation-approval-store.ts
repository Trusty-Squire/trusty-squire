import type { VaultEditableMetadata } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import {
  type CredentialMutationApprovalInput,
  type CredentialMutationApprovalRecord,
  type CredentialMutationApprovalStore,
  type CredentialMutationClaimResult,
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

  async claim(id: string, now: Date): Promise<CredentialMutationClaimResult> {
    const result = await this.prisma.credentialMutationApproval.updateMany({
      where: { id, status: "pending", expires_at: { gt: now } },
      data: { status: "executing" },
    });
    if (result.count > 0) return "claimed";
    const row = await this.prisma.credentialMutationApproval.findFirst({ where: { id } });
    if (row?.status === "approved") return "already_approved";
    if (row !== null && row.expires_at <= now) return "expired";
    return "not_claimable";
  }

  async complete(id: string, mandateId: string | null, now: Date): Promise<void> {
    await this.prisma.credentialMutationApproval.updateMany({
      where: { id, status: "executing" },
      data: { status: "approved", mandate_id: mandateId, executed_at: now },
    });
  }

  async fail(id: string, failureCode: string, now: Date): Promise<void> {
    await this.prisma.credentialMutationApproval.updateMany({
      where: { id, status: "executing" },
      data: { status: "failed", failure_code: failureCode, executed_at: now },
    });
  }
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
  if (
    row.status !== "pending" &&
    row.status !== "executing" &&
    row.status !== "approved" &&
    row.status !== "failed"
  ) {
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
