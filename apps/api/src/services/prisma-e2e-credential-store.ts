import { ulid } from "ulid";
import type { VaultAuditEventInput } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  E2ECredentialCardMetadata,
  E2ECredentialRecord,
  E2ECredentialStore,
  E2ECredentialSummary,
} from "./in-memory-e2e-credential-store.js";
import { PrismaVaultAuditStore } from "./prisma-vault-audit-store.js";

export class PrismaE2ECredentialStore implements E2ECredentialStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(
    accountId: string,
    label: string,
    blob: string,
    metadata?: E2ECredentialCardMetadata,
  ): Promise<string> {
    const row = await this.prisma.e2ECredential.create({
      data: {
        id: ulid(),
        account_id: accountId,
        label,
        blob,
        brand: metadata?.brand ?? null,
        last4: metadata?.last4 ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async createWithAudit(
    accountId: string,
    label: string,
    blob: string,
    metadata: E2ECredentialCardMetadata,
    eventForId: (id: string) => VaultAuditEventInput,
  ): Promise<string> {
    const id = ulid();
    await this.prisma.$transaction(async (tx) => {
      await tx.e2ECredential.create({
        data: {
          id,
          account_id: accountId,
          label,
          blob,
          brand: metadata.brand,
          last4: metadata.last4,
        },
        select: { id: true },
      });
      await new PrismaVaultAuditStore(tx).record(eventForId(id));
    });
    return id;
  }

  async listByAccount(accountId: string): Promise<E2ECredentialSummary[]> {
    const rows = await this.prisma.e2ECredential.findMany({
      where: { account_id: accountId },
      select: { id: true, label: true, brand: true, last4: true, created_at: true },
      orderBy: [{ created_at: "desc" }, { id: "desc" }] as unknown as Record<string, unknown>,
    });
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      brand: row.brand,
      last4: row.last4,
      createdAt: row.created_at,
    }));
  }

  async exportAll(accountId: string): Promise<E2ECredentialRecord[]> {
    const rows = await this.prisma.e2ECredential.findMany({
      where: { account_id: accountId },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      label: row.label,
      blob: row.blob,
      brand: row.brand,
      last4: row.last4,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getByIdForAccount(id: string, accountId: string): Promise<E2ECredentialRecord | null> {
    const row = await this.prisma.e2ECredential.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null
      ? null
      : {
          id: row.id,
          accountId: row.account_id,
          label: row.label,
          blob: row.blob,
          brand: row.brand,
          last4: row.last4,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  async updateLabelForAccount(id: string, accountId: string, label: string): Promise<boolean> {
    const result = await this.prisma.e2ECredential.updateMany({
      where: { id, account_id: accountId },
      data: { label },
    });
    return result.count > 0;
  }

  async deleteForAccount(id: string, accountId: string): Promise<boolean> {
    const result = await this.prisma.e2ECredential.deleteMany({
      where: { id, account_id: accountId },
    });
    return result.count > 0;
  }

  async deleteForAccountWithAudit(
    id: string,
    accountId: string,
    event: Parameters<NonNullable<E2ECredentialStore["deleteForAccountWithAudit"]>>[2],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.e2ECredential.deleteMany({
        where: { id, account_id: accountId },
      });
      if (result.count === 0) return false;
      await new PrismaVaultAuditStore(tx).record(event);
      return true;
    });
  }
}
