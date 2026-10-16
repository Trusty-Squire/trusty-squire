// Postgres-backed VaultAuditStore for @trusty-squire/vault.
//
// Same wiring pattern as PrismaCredentialStore — the vault package
// owns the contract, this module owns persistence. Successful proxy calls
// increment a daily counter; every security event and failure keeps its row.

import { ulid } from "ulid";
import type {
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
  VaultAuditStore,
  VaultAuditType,
  VaultProxyDailyTotal,
} from "@trusty-squire/vault";
import { VAULT_AUDIT_TYPES, attributedVaultAuditPayload } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import { incrementProxyDailyTotal, successfulProxyCall } from "./proxy-daily-totals.js";

const AUDIT_LIST_MAX = 200;

interface ProxyDailyRow {
  day: Date;
  reference: string;
  target_host: string;
  requester: string;
  grant_id: string;
  calls: number;
  status_breakdown: Record<string, number>;
  total_bytes: bigint;
  first_at: Date;
  last_at: Date;
}

function asProxyDailyTotal(row: ProxyDailyRow): VaultProxyDailyTotal {
  return {
    day: row.day.toISOString().slice(0, 10),
    reference: row.reference,
    target_host: row.target_host,
    requester: row.requester,
    grant_id: row.grant_id,
    calls: row.calls,
    status_breakdown: row.status_breakdown,
    total_bytes: Number(row.total_bytes),
    first_at: row.first_at.toISOString(),
    last_at: row.last_at.toISOString(),
  };
}

export class PrismaVaultAuditStore implements VaultAuditStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async record(event: VaultAuditEventInput): Promise<void> {
    const id = event.idempotency_key ?? ulid();
    const attributed = attributedVaultAuditPayload(event.payload, event.type, id);
    const successful =
      event.type === VAULT_AUDIT_TYPES.proxyExecuted && !event.defer_proxy_rollup
        ? successfulProxyCall(
            event.account_id,
            attributed as unknown as Record<string, unknown>,
            new Date(),
          )
        : null;
    if (successful !== null) {
      await incrementProxyDailyTotal(this.prisma, successful);
      return;
    }
    const data = {
      id,
      account_id: event.account_id,
      type: event.type,
      // Cast through Record<string, unknown> so Prisma's Json column
      // accepts the structural payload without complaining about
      // the optional-field surface area.
      payload: {
        ...attributed,
        ...(event.defer_proxy_rollup ? { rollup_pending: true } : {}),
      } as unknown as Record<string, unknown>,
    };
    if (event.idempotency_key)
      await this.prisma.vaultAuditEvent.upsert({ where: { id }, create: data, update: {} });
    else await this.prisma.vaultAuditEvent.create({ data });
  }

  // The streaming proxy initially owns a provisional row. A completion folds
  // it into a counter only when the final body is successful.
  async amend(id: string, patch: Partial<VaultAuditPayload>): Promise<void> {
    // Lock the provisional stream row while finalizing. Either the counter
    // increment and row deletion commit together, or the failed row survives.
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          account_id: string;
          type: string;
          payload: Record<string, unknown>;
          emitted_at: Date;
        }>
      >(
        'SELECT account_id, type, payload, emitted_at FROM "VaultAuditEvent" WHERE id = $1 FOR UPDATE',
        id,
      );
      const row = rows[0];
      if (row === undefined) return;
      const merged: Record<string, unknown> = { ...row.payload, ...patch };
      if (row.payload.rollup_pending === true) {
        delete merged.rollup_pending;
        const call =
          row.type === VAULT_AUDIT_TYPES.proxyExecuted
            ? successfulProxyCall(row.account_id, merged, row.emitted_at)
            : null;
        if (call !== null) {
          await incrementProxyDailyTotal(tx, call);
          await tx.vaultAuditEvent.deleteMany({ where: { id } });
          return;
        }
      }
      await tx.vaultAuditEvent.updateMany({ where: { id }, data: { payload: merged } });
    });
  }

  async listProxyDailyTotals(
    accountId: string,
    opts: { before?: Date; reference?: string; limit?: number } = {},
  ): Promise<VaultProxyDailyTotal[]> {
    const rows = await this.prisma.$queryRawUnsafe<ProxyDailyRow[]>(
      `SELECT day, reference, target_host, requester, grant_id, calls, status_breakdown,
                  total_bytes, first_at, last_at FROM "VaultProxyDailyTotal"
             WHERE account_id = $1 AND ($2::timestamp IS NULL OR last_at < $2::timestamp)
               AND ($3::text IS NULL OR reference = $3)
             ORDER BY last_at DESC LIMIT $4`,
      accountId,
      opts.before ?? null,
      opts.reference ?? null,
      Math.min(Math.max(opts.limit ?? 200, 1), 2000),
    );
    return rows.map(asProxyDailyTotal);
  }

  async exportProxyDailyTotals(accountId: string): Promise<VaultProxyDailyTotal[]> {
    const rows = await this.prisma.$queryRawUnsafe<ProxyDailyRow[]>(
      `SELECT day, reference, target_host, requester, grant_id, calls,
              status_breakdown, total_bytes, first_at, last_at
         FROM "VaultProxyDailyTotal" WHERE account_id = $1 ORDER BY last_at DESC`,
      accountId,
    );
    return rows.map(asProxyDailyTotal);
  }

  async countRecentRetrievals(accountId: string, since: Date): Promise<number> {
    return this.prisma.vaultAuditEvent.count({
      where: {
        account_id: accountId,
        type: VAULT_AUDIT_TYPES.retrieved,
        emitted_at: { gte: since },
      },
    });
  }

  async list(accountId: string, opts: VaultAuditListOptions = {}): Promise<VaultAuditRecord[]> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), AUDIT_LIST_MAX);
    const rows = await this.prisma.vaultAuditEvent.findMany({
      where: {
        account_id: accountId,
        ...(opts.type !== undefined ? { type: opts.type } : {}),
        ...(opts.before !== undefined ? { emitted_at: { lt: opts.before } } : {}),
        // `reference` lives in the JSON payload; Postgres JSON path filter
        // keeps the single-credential history query in the DB.
        ...(opts.reference !== undefined
          ? { payload: { path: ["reference"], equals: opts.reference } }
          : {}),
      },
      orderBy: { emitted_at: "desc" },
      take,
    });
    return rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      type: row.type as VaultAuditType,
      payload: attributedVaultAuditPayload(
        (row.payload ?? {}) as unknown as VaultAuditPayload,
        row.type as VaultAuditType,
        row.id,
      ),
      emitted_at: row.emitted_at,
    }));
  }

  async exportAll(accountId: string): Promise<VaultAuditRecord[]> {
    const rows = await this.prisma.vaultAuditEvent.findMany({
      where: { account_id: accountId },
      orderBy: { emitted_at: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      type: row.type as VaultAuditType,
      payload: attributedVaultAuditPayload(
        (row.payload ?? {}) as unknown as VaultAuditPayload,
        row.type as VaultAuditType,
        row.id,
      ),
      emitted_at: row.emitted_at,
    }));
  }

  async purgeAccount(accountId: string): Promise<number> {
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM "VaultProxyDailyTotal" WHERE account_id = $1',
      accountId,
    );
    const r = await this.prisma.vaultAuditEvent.deleteMany({ where: { account_id: accountId } });
    return r.count;
  }
}
