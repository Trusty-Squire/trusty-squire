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
import {
  EgressGrantStoreUnavailableError,
  type EgressGrant,
  type EgressGrantStore,
} from "./egress-grant.js";

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

  // Account-scoped + idempotent: revoking an already-revoked grant returns true
  // without re-stamping, and a grant owned by another account is a miss (false).
  async revoke(id: string, accountId: string, at: string): Promise<boolean> {
    const row = await this.withConnectionRetry(
      () => this.prisma.egressGrant.findUnique({ where: { id } }),
      `revoke lookup egress grant ${id}`,
    );
    if (row === null || row.account_id !== accountId) return false;
    if (row.revoked_at !== null) return true;
    await this.withConnectionRetry(
      () =>
        this.prisma.egressGrant.update({
          where: { id },
          data: { revoked_at: new Date(at) },
        }),
      `revoke egress grant ${id}`,
    );
    this.cache.delete(id);
    return true;
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
