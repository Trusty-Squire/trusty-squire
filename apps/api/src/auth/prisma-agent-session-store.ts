// Postgres-backed AgentSessionStore.
//
// Same AgentSessionStore interface as InMemoryAgentSessionStore;
// production wires this when AUTH_DATABASE_URL is set. Persisting
// agent sessions is what keeps a paired CLI paired across an API
// restart/redeploy.

import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import {
  agentSessionRejectionReason,
  type AgentSessionRecord,
  type AgentSessionStore,
} from "./agent.js";

export class PrismaAgentSessionStore implements AgentSessionStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async insert(record: AgentSessionRecord): Promise<void> {
    await this.prisma.agentSession.create({
      data: {
        id: record.id,
        account_id: record.account_id,
        token_hash: record.token_hash,
        agent_identity: record.agent_identity,
        agent_version: record.agent_version,
        issued_at: record.issued_at,
        expires_at: record.expires_at,
        last_used_at: record.last_used_at,
        use_count: record.use_count,
        revoked_at: record.revoked_at,
        revocation_reason: record.revocation_reason,
        trusted: record.trusted,
        trust_granted_at: record.trust_granted_at,
        trust_granted_via_passkey_id: record.trust_granted_via_passkey_id,
      },
    });
  }

  async findActiveByHash(
    tokenHash: string,
    now: Date,
  ): Promise<AgentSessionRecord | null> {
    const row = await this.prisma.agentSession.findUnique({
      where: { token_hash: tokenHash },
    });
    if (row === null) return null;
    const record = this.toRecord(row);
    return agentSessionRejectionReason(record, now) === null ? record : null;
  }

  async bumpUse(id: string, lastUsedAt: Date): Promise<void> {
    // updateMany so a missing row is a no-op (matches in-memory).
    await this.prisma.agentSession.updateMany({
      where: { id },
      data: { last_used_at: lastUsedAt, use_count: { increment: 1 } },
    });
  }

  async revoke(id: string, reason: string): Promise<void> {
    await this.prisma.agentSession.updateMany({
      where: { id },
      data: { revoked_at: new Date(), revocation_reason: reason },
    });
  }

  // Used by the connected-agents view (GET /v1/mcp/sessions). Not on
  // the AgentSessionStore interface — the route calls it directly off
  // the Prisma store.
  async listByAccount(accountId: string): Promise<AgentSessionRecord[]> {
    const rows = await this.prisma.agentSession.findMany({
      where: { account_id: accountId },
      orderBy: { issued_at: "desc" },
    });
    return rows.map((row) => this.toRecord(row));
  }

  async findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<AgentSessionRecord | null> {
    const rows = await this.prisma.agentSession.findMany({
      where: { id, account_id: accountId },
    });
    const row = rows[0];
    return row === undefined ? null : this.toRecord(row);
  }

  async setTrust(input: {
    id: string;
    accountId: string;
    trusted: boolean;
    grantedAt: Date | null;
    passkeyId: string | null;
  }): Promise<number> {
    const { count } = await this.prisma.agentSession.updateMany({
      where: { id: input.id, account_id: input.accountId },
      data: {
        trusted: input.trusted,
        trust_granted_at: input.grantedAt,
        trust_granted_via_passkey_id: input.passkeyId,
      },
    });
    return count;
  }

  private toRecord(row: {
    id: string;
    account_id: string;
    token_hash: string;
    agent_identity: string | null;
    agent_version: string | null;
    issued_at: Date;
    expires_at: Date;
    last_used_at: Date | null;
    use_count: number;
    revoked_at: Date | null;
    revocation_reason: string | null;
    trusted: boolean;
    trust_granted_at: Date | null;
    trust_granted_via_passkey_id: string | null;
  }): AgentSessionRecord {
    return {
      id: row.id,
      account_id: row.account_id,
      token_hash: row.token_hash,
      agent_identity: row.agent_identity,
      agent_version: row.agent_version,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      use_count: row.use_count,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
      trusted: row.trusted,
      trust_granted_at: row.trust_granted_at,
      trust_granted_via_passkey_id: row.trust_granted_via_passkey_id,
    };
  }
}
