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
  SubscriptionPatch,
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

  async findAccountByStripeCustomerId(customerId: string): Promise<AccountRecord | null> {
    // findFirst, not findUnique: stripe_customer_id isn't a DB-unique column
    // (see schema note). Uniqueness holds by construction — the webhook is the
    // only writer and maps one Stripe customer to one account.
    const row = await this.prisma.account.findFirst({
      where: { stripe_customer_id: customerId },
    });
    return row === null ? null : this.toAccount(row);
  }

  async setSubscription(accountId: string, patch: SubscriptionPatch): Promise<void> {
    // Only `subscription_status` is mandatory; the ids/period are written
    // when present (create/renew) and left untouched on a bare status flip.
    await this.prisma.account.update({
      where: { id: accountId },
      data: {
        subscription_status: patch.subscription_status,
        ...(patch.stripe_customer_id !== undefined
          ? { stripe_customer_id: patch.stripe_customer_id }
          : {}),
        ...(patch.subscription_id !== undefined
          ? { subscription_id: patch.subscription_id }
          : {}),
        ...(patch.current_period_end !== undefined
          ? { current_period_end: patch.current_period_end }
          : {}),
        ...(patch.cancel_at !== undefined ? { cancel_at: patch.cancel_at } : {}),
      },
    });
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

  async deleteAccount(accountId: string): Promise<void> {
    // The schema declares onDelete: Cascade from Account on OAuthIdentity,
    // Device, ActiveMandate, WebSession, and AgentSession — deleting the
    // row tears those down with it. Credentials + vault audit are not FK-
    // linked and are purged separately by the caller.
    try {
      await this.prisma.account.delete({ where: { id: accountId } });
    } catch (err) {
      // P2025 = record not found. Idempotent, same as the in-memory store.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2025") {
        return;
      }
      throw err;
    }
  }

  private toAccount(row: {
    id: string;
    email: string;
    display_name: string;
    default_vault: string | null;
    created_at: Date;
    stripe_customer_id: string | null;
    subscription_status: string;
    subscription_id: string | null;
    current_period_end: Date | null;
    cancel_at: Date | null;
  }): AccountRecord {
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      default_vault: row.default_vault,
      created_at: row.created_at,
      stripe_customer_id: row.stripe_customer_id,
      subscription_status: row.subscription_status,
      subscription_id: row.subscription_id,
      current_period_end: row.current_period_end,
      cancel_at: row.cancel_at,
    };
  }

  // Platform is a free-text column; narrow it back to the union the
  // DeviceRecord type expects. Anything unexpected falls back to "web".
  private toPlatform(value: string): Platform {
    return value === "ios" || value === "android" ? value : "web";
  }
}
