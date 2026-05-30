// Postgres-backed VaultAuditStore for @trusty-squire/vault.
//
// Same wiring pattern as PrismaCredentialStore — the vault package
// owns the contract, this module owns the persistence. Writes one row
// per audit event into the VaultAuditEvent table on the API auth DB.

import { ulid } from "ulid";
import type {
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
  VaultAuditStore,
  VaultAuditType,
} from "@trusty-squire/vault";
import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";

const AUDIT_LIST_MAX = 200;

export class PrismaVaultAuditStore implements VaultAuditStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async record(event: VaultAuditEventInput): Promise<void> {
    await this.prisma.vaultAuditEvent.create({
      data: {
        id: ulid(),
        account_id: event.account_id,
        type: event.type,
        // Cast through Record<string, unknown> so Prisma's Json column
        // accepts the structural payload without complaining about
        // the optional-field surface area.
        payload: event.payload as unknown as Record<string, unknown>,
      },
    });
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
      payload: (row.payload ?? {}) as unknown as VaultAuditPayload,
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
      payload: (row.payload ?? {}) as unknown as VaultAuditPayload,
      emitted_at: row.emitted_at,
    }));
  }

  async purgeAccount(accountId: string): Promise<number> {
    const r = await this.prisma.vaultAuditEvent.deleteMany({ where: { account_id: accountId } });
    return r.count;
  }
}
