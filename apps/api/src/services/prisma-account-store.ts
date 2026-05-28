// Postgres-backed AccountStore.
//
// Conforms to the same AccountStore interface as InMemoryAccountStore;
// production wires this when AUTH_DATABASE_URL is set. Until this
// existed, accounts lived only in memory and were wiped on every API
// restart/redeploy.

import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  AccountRecord,
  AccountStore,
  DeviceRecord,
} from "./in-memory-account-store.js";

type Platform = "ios" | "android" | "web";

export class PrismaAccountStore implements AccountStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async createAccount(email: string, displayName: string): Promise<AccountRecord> {
    // Idempotent on email — mirrors the in-memory store, which returns
    // the existing account rather than creating a duplicate.
    const existing = await this.prisma.account.findUnique({ where: { email } });
    if (existing !== null) return this.toAccount(existing);
    const row = await this.prisma.account.create({
      data: {
        id: ulid(),
        email,
        display_name: displayName,
        default_vault: null,
        created_at: new Date(),
      },
    });
    return this.toAccount(row);
  }

  async findAccountByEmail(email: string): Promise<AccountRecord | null> {
    const row = await this.prisma.account.findUnique({ where: { email } });
    return row === null ? null : this.toAccount(row);
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    const row = await this.prisma.account.findUnique({ where: { id } });
    return row === null ? null : this.toAccount(row);
  }

  async touchDevice(input: {
    account_id: string;
    signing_device_id: string;
    platform: Platform;
    now: Date;
  }): Promise<void> {
    await this.prisma.device.upsert({
      where: { id: input.signing_device_id },
      create: {
        id: input.signing_device_id,
        account_id: input.account_id,
        first_seen_at: input.now,
        last_seen_at: input.now,
        platform: input.platform,
        revoked_at: null,
      },
      update: { last_seen_at: input.now },
    });
  }

  async listDevices(accountId: string): Promise<DeviceRecord[]> {
    const rows = await this.prisma.device.findMany({
      where: { account_id: accountId },
    });
    return rows.map((d) => ({
      id: d.id,
      account_id: d.account_id,
      first_seen_at: d.first_seen_at,
      last_seen_at: d.last_seen_at,
      platform: this.toPlatform(d.platform),
      revoked_at: d.revoked_at,
    }));
  }

  async markDeviceRevoked(signingDeviceId: string, now: Date): Promise<void> {
    await this.prisma.device.updateMany({
      where: { id: signingDeviceId },
      data: { revoked_at: now },
    });
  }

  private toAccount(row: {
    id: string;
    email: string;
    display_name: string;
    default_vault: string | null;
    created_at: Date;
  }): AccountRecord {
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      default_vault: row.default_vault,
      created_at: row.created_at,
    };
  }

  // Platform is a free-text column; narrow it back to the union the
  // DeviceRecord type expects. Anything unexpected falls back to "web".
  private toPlatform(value: string): Platform {
    return value === "ios" || value === "android" ? value : "web";
  }
}
