// Postgres-backed AccessGrantStore for @trusty-squire/vault.
//
// Same wiring discipline as PrismaCredentialStore / PrismaVaultAuditStore
// — the vault package owns the contract + state machine, this module
// owns persistence against the API auth DB. Every transition is an
// `updateMany` with a status guard so concurrent callers (double-click
// approve, approve/revoke race) resolve to a single winner via the
// returned `count`.

import type {
  AccessGrantRecord,
  AccessGrantStore,
  GrantIntent,
  GrantMode,
  GrantStatus,
} from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";

interface AccessGrantRow {
  id: string;
  account_id: string;
  reference: string;
  agent_session_id: string;
  intent: string;
  mode: string;
  ttl_seconds: number;
  purpose: string;
  reason_proxy_not_possible: string | null;
  requested_target_host: string | null;
  requested_at: Date;
  decided_at: Date | null;
  expires_at: Date | null;
  status: string;
  auto_approved: boolean;
}

export class PrismaAccessGrantStore implements AccessGrantStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async insert(record: AccessGrantRecord): Promise<void> {
    await this.prisma.accessGrant.create({
      data: {
        id: record.id,
        account_id: record.account_id,
        reference: record.reference,
        agent_session_id: record.agent_session_id,
        intent: record.intent,
        mode: record.mode,
        ttl_seconds: record.ttl_seconds,
        purpose: record.purpose,
        reason_proxy_not_possible: record.reason_proxy_not_possible,
        requested_target_host: record.requested_target_host,
        requested_at: record.requested_at,
        decided_at: record.decided_at,
        expires_at: record.expires_at,
        status: record.status,
        auto_approved: record.auto_approved,
      },
    });
  }

  async findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<AccessGrantRecord | null> {
    const row = await this.prisma.accessGrant.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null ? null : this.toRecord(row);
  }

  async findByIdForAgentSession(
    id: string,
    agentSessionId: string,
  ): Promise<AccessGrantRecord | null> {
    const row = await this.prisma.accessGrant.findFirst({
      where: { id, agent_session_id: agentSessionId },
    });
    return row === null ? null : this.toRecord(row);
  }

  async listPendingByAccount(accountId: string): Promise<AccessGrantRecord[]> {
    const rows = await this.prisma.accessGrant.findMany({
      where: { account_id: accountId, status: "pending" },
      orderBy: { requested_at: "desc" },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async countPendingByAccount(accountId: string): Promise<number> {
    return this.prisma.accessGrant.count({
      where: { account_id: accountId, status: "pending" },
    });
  }

  async approve(input: {
    id: string;
    accountId: string;
    mode: GrantMode;
    ttlSeconds: number;
    expiresAt: Date;
    decidedAt: Date;
  }): Promise<number> {
    const { count } = await this.prisma.accessGrant.updateMany({
      where: { id: input.id, account_id: input.accountId, status: "pending" },
      data: {
        status: "approved",
        mode: input.mode,
        ttl_seconds: input.ttlSeconds,
        expires_at: input.expiresAt,
        decided_at: input.decidedAt,
      },
    });
    return count;
  }

  async deny(input: {
    id: string;
    accountId: string;
    decidedAt: Date;
  }): Promise<number> {
    const { count } = await this.prisma.accessGrant.updateMany({
      where: { id: input.id, account_id: input.accountId, status: "pending" },
      data: { status: "denied", decided_at: input.decidedAt },
    });
    return count;
  }

  async revoke(input: { id: string; accountId: string }): Promise<number> {
    const { count } = await this.prisma.accessGrant.updateMany({
      where: {
        id: input.id,
        account_id: input.accountId,
        status: { in: ["pending", "approved"] },
      },
      data: { status: "revoked" },
    });
    return count;
  }

  async consume(input: { id: string; accountId: string }): Promise<number> {
    const { count } = await this.prisma.accessGrant.updateMany({
      where: { id: input.id, account_id: input.accountId, status: "approved" },
      data: { status: "consumed" },
    });
    return count;
  }

  async revokePersistentByReference(
    reference: string,
    accountId: string,
  ): Promise<number> {
    const { count } = await this.prisma.accessGrant.updateMany({
      where: {
        reference,
        account_id: accountId,
        mode: "persistent",
        status: "approved",
      },
      data: { status: "revoked" },
    });
    return count;
  }

  private toRecord(row: AccessGrantRow): AccessGrantRecord {
    return {
      id: row.id,
      account_id: row.account_id,
      reference: row.reference,
      agent_session_id: row.agent_session_id,
      intent: row.intent as GrantIntent,
      mode: row.mode as GrantMode,
      ttl_seconds: row.ttl_seconds,
      purpose: row.purpose,
      reason_proxy_not_possible: row.reason_proxy_not_possible,
      requested_target_host: row.requested_target_host,
      requested_at: row.requested_at,
      decided_at: row.decided_at,
      expires_at: row.expires_at,
      status: row.status as GrantStatus,
      auto_approved: row.auto_approved,
    };
  }
}
