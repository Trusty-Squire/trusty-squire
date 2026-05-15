// Postgres-backed PairingTokenStore.
//
// 10-minute TTL, single-use claim. Expiry is enforced in code; a
// background sweep deletes rows older than ~1 hour as garbage
// collection.

import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import type {
  PairingStatus,
  PairingTokenRecord,
  PairingTokenStore,
} from "./pairing-token.js";

export class PrismaPairingTokenStore implements PairingTokenStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async insert(record: PairingTokenRecord): Promise<void> {
    await this.prisma.pairingToken.create({
      data: {
        token: record.token,
        created_at: record.created_at,
        expires_at: record.expires_at,
        status: record.status,
        agent_identity: record.agent_identity,
        agent_session_raw_token: record.agent_session_raw_token,
        account_id: record.account_id,
        machine_token: record.machine_token,
      },
    });
  }

  async find(token: string): Promise<PairingTokenRecord | null> {
    const row = await this.prisma.pairingToken.findUnique({ where: { token } });
    return row === null ? null : this.toRecord(row);
  }

  async claim(
    token: string,
    accountId: string,
    rawAgentToken: string,
    now: Date,
  ): Promise<boolean> {
    // Race-safe claim: update only if status is still "pending" AND
    // not yet expired. updateMany returns count: 0 if either guard fires,
    // which we report as "claim failed" without throwing.
    const result = await this.prisma.pairingToken.updateMany({
      where: { token, status: "pending", expires_at: { gt: now } } as Record<string, unknown>,
      data: {
        status: "claimed",
        account_id: accountId,
        agent_session_raw_token: rawAgentToken,
      },
    });
    return result.count > 0;
  }

  async deliverAndMarkUsed(token: string, now: Date): Promise<string | null> {
    // Atomic claim-then-deliver: only flip to "delivered" if status is
    // currently "claimed". updateMany doesn't return rows in Prisma, so
    // we read-then-conditionally-update.
    const row = await this.prisma.pairingToken.findUnique({ where: { token } });
    if (row === null) return null;
    if (now > row.expires_at && row.status !== "delivered") {
      await this.prisma.pairingToken.update({
        where: { token },
        data: { status: "expired" },
      });
      return null;
    }
    if (row.status !== "claimed") return null;
    const raw = row.agent_session_raw_token;
    await this.prisma.pairingToken.update({
      where: { token },
      data: { status: "delivered" },
    });
    return raw;
  }

  // Background cleanup. Run from the retention cron; deletes rows
  // older than 1h regardless of status. (Delivered + expired records
  // have no further use; pending past expiry is already dead.)
  async sweepStale(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const result = await this.prisma.pairingToken.deleteMany({
      where: { created_at: { lt: cutoff } } as Record<string, unknown>,
    });
    return result.count;
  }

  private toRecord(row: {
    token: string;
    created_at: Date;
    expires_at: Date;
    status: string;
    agent_identity: string | null;
    agent_session_raw_token: string | null;
    account_id: string | null;
    machine_token: string | null;
  }): PairingTokenRecord {
    return {
      token: row.token,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status as PairingStatus,
      agent_identity: row.agent_identity,
      agent_session_raw_token: row.agent_session_raw_token,
      account_id: row.account_id,
      machine_token: row.machine_token,
    };
  }
}
