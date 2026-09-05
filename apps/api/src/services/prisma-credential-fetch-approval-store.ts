import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  CredentialFetchApprovalInput,
  CredentialFetchApprovalRecord,
  CredentialFetchApprovalStore,
  CredentialFetchApproveResult,
  CredentialFetchClaimResult,
  CredentialFetchDenyResult,
  CredentialFetchExpireResult,
  CredentialFetchRequesterKind,
  CredentialFetchApprovalStatus,
} from "./credential-fetch-approval-store.js";

export class PrismaCredentialFetchApprovalStore implements CredentialFetchApprovalStore {
  constructor(
    private readonly prisma: ApiPrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(accountId: string, input: CredentialFetchApprovalInput): Promise<string> {
    const row = await this.prisma.credentialFetchApproval.create({
      data: {
        id: ulid(),
        account_id: accountId,
        credential_reference: input.credentialReference,
        credential_service: input.credentialService,
        credential_label: input.credentialLabel,
        field: input.field,
        field_names: input.fieldNames,
        nonce: input.nonce,
        agent: input.agent,
        requester_kind: input.requesterKind,
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
  ): Promise<CredentialFetchApprovalRecord | null> {
    const row = await this.prisma.credentialFetchApproval.findFirst({
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

  async getById(id: string): Promise<CredentialFetchApprovalRecord | null> {
    const row = await this.prisma.credentialFetchApproval.findFirst({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialFetchApprovalRecord | null> {
    const row = await this.prisma.credentialFetchApproval.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null ? null : toRecord(row);
  }

  async approve(id: string, mandateId: string | null): Promise<CredentialFetchApproveResult> {
    const now = this.now();
    const claimed = await this.prisma.credentialFetchApproval.updateMany({
      where: { id, status: "pending", expires_at: { gt: now } },
      data: { status: "approved", mandate_id: mandateId, approved_at: now },
    });
    if (claimed.count === 1) return "approved";
    const current = await this.getById(id);
    if (current === null) return "not_pending";
    if (current.status === "approved") return "already_approved";
    if (current.status === "pending") return "expired";
    return "not_pending";
  }

  async deny(id: string, now: Date): Promise<CredentialFetchDenyResult> {
    // Only a live pending fetch can be denied: once approved, the value may
    // already have been delivered, and a later "deny" would be a lie — as
    // would recording an approval that simply ran out the clock as a refusal
    // the human made.
    const denied = await this.prisma.credentialFetchApproval.updateMany({
      where: { id, status: "pending", expires_at: { gt: now } },
      data: { status: "denied", failure_code: "denied_by_user" },
    });
    if (denied.count === 1) return "denied";
    const current = await this.getById(id);
    if (current === null) return "not_pending";
    if (current.status === "denied") return "already_denied";
    return current.status === "pending" ? "expired" : "not_pending";
  }

  async expire(id: string, now: Date): Promise<CredentialFetchExpireResult> {
    const settled = await this.prisma.credentialFetchApproval.updateMany({
      where: { id, status: { in: ["pending", "approved"] }, expires_at: { lte: now } },
      data: { status: "failed", failure_code: "expired" },
    });
    return settled.count === 1 ? "expired" : "already_terminal";
  }

  async claim(id: string, accountId: string): Promise<CredentialFetchClaimResult> {
    const now = this.now();
    // The single-use fence. A conditional update is the whole guarantee:
    // exactly one caller can move approved → consumed, so two concurrent
    // resumes cannot both be handed the value.
    const claimed = await this.prisma.credentialFetchApproval.updateMany({
      where: { id, account_id: accountId, status: "approved", expires_at: { gt: now } },
      data: { status: "consumed", delivered_at: now },
    });
    const current = await this.getByIdForAccount(id, accountId);
    if (current === null) return { kind: "not_found" };
    if (claimed.count === 1) return { kind: "claimed", record: current };
    if (current.status === "consumed") return { kind: "already_consumed", record: current };
    if (current.status === "approved") return { kind: "expired", record: current };
    return { kind: "not_approved", record: current };
  }
}

export interface CredentialFetchApprovalRow {
  id: string;
  account_id: string;
  credential_reference: string;
  credential_service: string | null;
  credential_label: string;
  field: string | null;
  field_names: string[];
  nonce: string;
  agent: string;
  requester_kind: string;
  intent_hash: string;
  status: string;
  failure_code: string | null;
  mandate_id: string | null;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  delivered_at: Date | null;
}

function toRecord(row: CredentialFetchApprovalRow): CredentialFetchApprovalRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    credentialReference: row.credential_reference,
    credentialService: row.credential_service,
    credentialLabel: row.credential_label,
    field: row.field,
    fieldNames: [...row.field_names],
    nonce: row.nonce,
    agent: row.agent,
    requesterKind: row.requester_kind === "web" ? "web" : ("agent" as CredentialFetchRequesterKind),
    intentHash: row.intent_hash,
    status: row.status as CredentialFetchApprovalStatus,
    failureCode: row.failure_code,
    mandateId: row.mandate_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    deliveredAt: row.delivered_at,
  };
}
