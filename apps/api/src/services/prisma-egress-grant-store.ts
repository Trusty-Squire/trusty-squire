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
import type { EgressGrant, EgressGrantStore } from "./egress-grant.js";

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
  constructor(private readonly prisma: ApiPrismaClient) {}

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
  }

  async getById(id: string): Promise<EgressGrant | null> {
    const row = await this.prisma.egressGrant.findUnique({ where: { id } });
    return row === null ? null : toGrant(row);
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
    const row = await this.prisma.egressGrant.findUnique({ where: { id } });
    if (row === null || row.account_id !== accountId) return false;
    if (row.revoked_at !== null) return true;
    await this.prisma.egressGrant.update({
      where: { id },
      data: { revoked_at: new Date(at) },
    });
    return true;
  }
}
