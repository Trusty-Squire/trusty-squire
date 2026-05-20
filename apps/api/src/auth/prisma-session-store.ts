// Postgres-backed SessionStore.
//
// Same SessionStore interface as InMemorySessionStore; production
// wires this when AUTH_DATABASE_URL is set. Persisting web sessions
// is what keeps a login alive across an API restart/redeploy.

import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import {
  sessionRejectionReason,
  type SessionRecord,
  type SessionStore,
} from "./session.js";

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async insert(record: SessionRecord): Promise<void> {
    await this.prisma.webSession.create({
      data: {
        id: record.id,
        account_id: record.account_id,
        jwt_id: record.jwt_id,
        issued_at: record.issued_at,
        last_active_at: record.last_active_at,
        absolute_expires_at: record.absolute_expires_at,
        revoked_at: record.revoked_at,
        revocation_reason: record.revocation_reason,
        ip: record.ip,
        user_agent: record.user_agent,
      },
    });
  }

  async findActive(jwtId: string, now: Date): Promise<SessionRecord | null> {
    const row = await this.prisma.webSession.findUnique({
      where: { jwt_id: jwtId },
    });
    if (row === null) return null;
    const record = this.toRecord(row);
    // Same validity gate as the in-memory store: revoked / absolute /
    // idle expiry all mean "not active".
    return sessionRejectionReason(record, now) === null ? record : null;
  }

  async touch(jwtId: string, lastActiveAt: Date): Promise<void> {
    // updateMany (not update) so a missing row is a no-op, matching
    // the in-memory store, rather than a P2025 throw.
    await this.prisma.webSession.updateMany({
      where: { jwt_id: jwtId },
      data: { last_active_at: lastActiveAt },
    });
  }

  async revoke(jwtId: string, reason: string): Promise<void> {
    await this.prisma.webSession.updateMany({
      where: { jwt_id: jwtId },
      data: { revoked_at: new Date(), revocation_reason: reason },
    });
  }

  private toRecord(row: {
    id: string;
    account_id: string;
    jwt_id: string;
    issued_at: Date;
    last_active_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
    revocation_reason: string | null;
    ip: string | null;
    user_agent: string | null;
  }): SessionRecord {
    return {
      id: row.id,
      account_id: row.account_id,
      jwt_id: row.jwt_id,
      issued_at: row.issued_at,
      last_active_at: row.last_active_at,
      absolute_expires_at: row.absolute_expires_at,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
      ip: row.ip,
      user_agent: row.user_agent,
    };
  }
}
