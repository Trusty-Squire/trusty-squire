// Postgres-backed EgressGrantStore.
//
// Same wiring pattern as PrismaVaultAuditStore — the egress-grant module owns
// the contract + pure logic, this module owns persistence. One row per minted
// grant in the EgressGrant table on the API auth DB. Only the token HASH is
// stored; the token itself is shown to the caller exactly once at mint.
//
// The pure EgressGrant model uses ISO-string timestamps (so mint/verify stay
// deterministic in tests); Prisma stores DateTime. This store is the single
// conversion boundary between the two.

import type { ApiPrismaClient } from "./api-prisma-client.js";
import type { VaultAuditEventInput } from "@trusty-squire/vault";
import {
  EgressGrantStoreUnavailableError,
  type EgressGrant,
  type EgressGrantStore,
} from "./egress-grant.js";
import { PrismaVaultAuditStore } from "./prisma-vault-audit-store.js";

interface EgressGrantRow {
  id: string;
  account_id: string;
  credential_ref: string;
  token_hash: string;
  rate_limit_per_hour: number;
  spend_cap_usd: number | null;
  created_at: Date;
  revoked_at: Date | null;
}

function toGrant(row: EgressGrantRow): EgressGrant {
  return {
    id: row.id,
    account_id: row.account_id,
    credential_ref: row.credential_ref,
    token_hash: row.token_hash,
    rate_limit_per_hour: row.rate_limit_per_hour,
    spend_cap_usd: row.spend_cap_usd,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  };
}

export class PrismaEgressGrantStore implements EgressGrantStore {
  private readonly cache = new Map<string, { grant: EgressGrant | null; expiresAt: number }>();
  private readonly liveTtlMs: number;
  private readonly revokedTtlMs: number;

  constructor(
    private readonly prisma: ApiPrismaClient,
    opts: { liveTtlMs?: number; revokedTtlMs?: number; now?: () => number } = {},
  ) {
    this.liveTtlMs = opts.liveTtlMs ?? 30_000;
    this.revokedTtlMs = opts.revokedTtlMs ?? 1_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  async create(grant: EgressGrant): Promise<void> {
    await this.prisma.egressGrant.create({
      data: {
        id: grant.id,
        account_id: grant.account_id,
        credential_ref: grant.credential_ref,
        token_hash: grant.token_hash,
        rate_limit_per_hour: grant.rate_limit_per_hour,
        spend_cap_usd: grant.spend_cap_usd,
        created_at: new Date(grant.created_at),
        revoked_at: grant.revoked_at === null ? null : new Date(grant.revoked_at),
      },
    });
    this.cacheGrant(grant);
  }

  async createWithAudit(grant: EgressGrant, event: VaultAuditEventInput): Promise<void> {
    const transaction = () =>
      this.prisma.$transaction(async (tx) => {
        await tx.egressGrant.create({
          data: {
            id: grant.id,
            account_id: grant.account_id,
            credential_ref: grant.credential_ref,
            token_hash: grant.token_hash,
            rate_limit_per_hour: grant.rate_limit_per_hour,
            spend_cap_usd: grant.spend_cap_usd,
            created_at: new Date(grant.created_at),
            revoked_at: grant.revoked_at === null ? null : new Date(grant.revoked_at),
          },
        });
        await new PrismaVaultAuditStore(tx).record(event);
      });

    try {
      await transaction();
    } catch (err) {
      if (!isRetryablePrismaConnectionError(err) && !isPrismaUniqueConstraintError(err)) {
        throw err;
      }
      if (isRetryablePrismaConnectionError(err)) {
        await disconnectPrisma(this.prisma);
      }
      if (await this.createWasCommitted(grant)) {
        this.cacheGrant(grant);
        return;
      }
      if (isPrismaUniqueConstraintError(err)) throw err;

      try {
        await transaction();
      } catch (retryErr) {
        if (
          !isRetryablePrismaConnectionError(retryErr) &&
          !isPrismaUniqueConstraintError(retryErr)
        ) {
          throw retryErr;
        }
        if (isRetryablePrismaConnectionError(retryErr)) {
          await disconnectPrisma(this.prisma);
        }
        if (await this.createWasCommitted(grant)) {
          this.cacheGrant(grant);
          return;
        }
        if (isRetryablePrismaConnectionError(retryErr)) {
          throw new EgressGrantStoreUnavailableError(
            `create egress grant ${grant.id} with audit: ${prismaErrorMessage(retryErr)}`,
          );
        }
        throw retryErr;
      }
    }
    this.cacheGrant(grant);
  }

  private cacheGrant(grant: EgressGrant): void {
    this.cache.set(grant.id, {
      grant,
      expiresAt: this.now() + (grant.revoked_at === null ? this.liveTtlMs : this.revokedTtlMs),
    });
  }

  async getById(id: string): Promise<EgressGrant | null> {
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.grant;
    const row = await this.withConnectionRetry(
      () => this.prisma.egressGrant.findUnique({ where: { id } }),
      `get egress grant ${id}`,
    );
    const grant = row === null ? null : toGrant(row);
    this.cache.set(id, {
      grant,
      expiresAt: this.now() + (grant?.revoked_at === null ? this.liveTtlMs : this.revokedTtlMs),
    });
    return grant;
  }

  async listByAccount(accountId: string): Promise<EgressGrant[]> {
    const rows = await this.prisma.egressGrant.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: "desc" },
    });
    return rows.map(toGrant);
  }

  async revoke(id: string, accountId: string, at: string): Promise<boolean> {
    const result = await this.withConnectionRetry(
      () =>
        this.prisma.egressGrant.updateMany({
          where: { id, account_id: accountId, revoked_at: null },
          data: { revoked_at: new Date(at) },
        }),
      `revoke egress grant ${id}`,
    );
    this.cache.delete(id);
    return result.count > 0;
  }

  async revokeWithAudit(
    id: string,
    accountId: string,
    at: string,
    event: VaultAuditEventInput,
  ): Promise<boolean> {
    this.cache.delete(id);
    const before = await this.findForReconciliation(
      id,
      `reconcile egress grant ${id} before revoke`,
    );
    if (before === null || before.account_id !== accountId || before.revoked_at !== null) {
      return false;
    }

    const transaction = () =>
      this.prisma.$transaction(async (tx) => {
        const result = await tx.egressGrant.updateMany({
          where: { id, account_id: accountId, revoked_at: null },
          data: { revoked_at: new Date(at) },
        });
        if (result.count === 0) return false;
        await new PrismaVaultAuditStore(tx).record(event);
        return true;
      });

    try {
      return await transaction();
    } catch (err) {
      if (!isRetryablePrismaConnectionError(err)) throw err;
      await disconnectPrisma(this.prisma);
      const reconciled = await this.findForReconciliation(
        id,
        `reconcile egress grant ${id} after revoke`,
      );
      if (revokeWasCommitted(before, reconciled, at)) return true;
      if (reconciled?.revoked_at !== null && reconciled?.revoked_at !== undefined) return false;

      try {
        return await transaction();
      } catch (retryErr) {
        if (!isRetryablePrismaConnectionError(retryErr)) throw retryErr;
        await disconnectPrisma(this.prisma);
        const retried = await this.findForReconciliation(
          id,
          `reconcile egress grant ${id} after revoke retry`,
        );
        if (revokeWasCommitted(before, retried, at)) return true;
        if (retried?.revoked_at !== null && retried?.revoked_at !== undefined) return false;
        throw new EgressGrantStoreUnavailableError(
          `revoke egress grant ${id} with audit: ${prismaErrorMessage(retryErr)}`,
        );
      }
    }
  }

  private async createWasCommitted(grant: EgressGrant): Promise<boolean> {
    const row = await this.findForReconciliation(
      grant.id,
      `reconcile egress grant ${grant.id} after create`,
    );
    return row !== null && rowsDescribeSameGrant(row, grant);
  }

  private async findForReconciliation(id: string, label: string): Promise<EgressGrantRow | null> {
    try {
      return await this.prisma.egressGrant.findUnique({ where: { id } });
    } catch (err) {
      if (!isRetryablePrismaConnectionError(err)) throw err;
      await disconnectPrisma(this.prisma);
      try {
        return await this.prisma.egressGrant.findUnique({ where: { id } });
      } catch (retryErr) {
        if (isRetryablePrismaConnectionError(retryErr)) {
          throw new EgressGrantStoreUnavailableError(`${label}: ${prismaErrorMessage(retryErr)}`);
        }
        throw retryErr;
      }
    }
  }

  private async withConnectionRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!isRetryablePrismaConnectionError(err)) throw err;
      await disconnectPrisma(this.prisma);
      try {
        return await op();
      } catch (retryErr) {
        if (isRetryablePrismaConnectionError(retryErr)) {
          throw new EgressGrantStoreUnavailableError(`${label}: ${prismaErrorMessage(retryErr)}`);
        }
        throw retryErr;
      }
    }
  }
}

export function isRetryablePrismaConnectionError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  if (code === "P1017" || code === "P1001" || code === "P1002") return true;
  const message = prismaErrorMessage(err).toLowerCase();
  return (
    message.includes("server has closed the connection") ||
    message.includes("connection terminated") ||
    message.includes("connection pool") ||
    message.includes("can't reach database server")
  );
}

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code?: unknown }).code ?? "") === "P2002"
  );
}

function rowsDescribeSameGrant(row: EgressGrantRow, grant: EgressGrant): boolean {
  return (
    row.id === grant.id &&
    row.account_id === grant.account_id &&
    row.credential_ref === grant.credential_ref &&
    row.token_hash === grant.token_hash &&
    row.rate_limit_per_hour === grant.rate_limit_per_hour &&
    row.spend_cap_usd === grant.spend_cap_usd &&
    row.created_at.toISOString() === grant.created_at &&
    (row.revoked_at === null ? null : row.revoked_at.toISOString()) === grant.revoked_at
  );
}

function revokeWasCommitted(
  before: EgressGrantRow,
  after: EgressGrantRow | null,
  revokedAt: string,
): boolean {
  return (
    before.revoked_at === null &&
    after !== null &&
    after.account_id === before.account_id &&
    after.revoked_at?.toISOString() === revokedAt
  );
}

function prismaErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function disconnectPrisma(prisma: ApiPrismaClient): Promise<void> {
  const maybeDisconnect = (prisma as { $disconnect?: () => Promise<void> }).$disconnect;
  if (maybeDisconnect === undefined) return;
  try {
    await maybeDisconnect.call(prisma);
  } catch {
    // A failed disconnect should not prevent the retry; Prisma reconnects lazily
    // on the next query when possible.
  }
}
