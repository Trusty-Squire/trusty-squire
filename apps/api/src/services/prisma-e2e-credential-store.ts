import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  E2ECredentialRecord,
  E2ECredentialStore,
  E2ECredentialSummary,
} from "./in-memory-e2e-credential-store.js";

export class PrismaE2ECredentialStore implements E2ECredentialStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, label: string, blob: string): Promise<string> {
    const row = await this.prisma.e2ECredential.create({
      data: { id: ulid(), account_id: accountId, label, blob },
      select: { id: true },
    });
    return row.id;
  }

  async listByAccount(accountId: string): Promise<E2ECredentialSummary[]> {
    const rows = await this.prisma.e2ECredential.findMany({
      where: { account_id: accountId },
      select: { id: true, label: true, created_at: true },
      orderBy: [{ created_at: "desc" }, { id: "desc" }] as unknown as Record<string, unknown>,
    });
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
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
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  async deleteForAccount(id: string, accountId: string): Promise<boolean> {
    const result = await this.prisma.e2ECredential.deleteMany({
      where: { id, account_id: accountId },
    });
    return result.count > 0;
  }
}
