// Postgres-backed VaultAuditStore for @trusty-squire/vault.
//
// Same wiring pattern as PrismaCredentialStore — the vault package
// owns the contract, this module owns the persistence. Writes one row
// per audit event into the VaultAuditEvent table on the API auth DB.

import { ulid } from "ulid";
import type {
  VaultAuditEventInput,
  VaultAuditStore,
} from "@trusty-squire/vault";
import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";

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
}
