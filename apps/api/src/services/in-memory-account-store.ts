// Minimal in-memory Account + Device storage for the API.
//
// Covers Account-scoped data the API gateway owns (account row,
// device list). The mandate-store machinery was retired in 0.8 with
// the native-provision sunset. Tests + dev use this store; the
// Prisma-backed equivalent lives in prisma-account-store.ts.

import { ulid } from "ulid";

export interface AccountRecord {
  id: string;
  email: string;
  display_name: string;
  default_vault: string | null;
  created_at: Date;
  // Stripe billing. `subscription_status` ("free" by default) is the
  // field the free-signup quota gate consults — "active" bypasses it.
  // Written only by the Stripe webhook path.
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_id: string | null;
  current_period_end: Date | null;
}

// The subset of billing fields the Stripe webhook updates. `subscription_status`
// is always set; the ids/period are present on create/renew, absent (left as-is)
// on a bare status flip.
export interface SubscriptionPatch {
  stripe_customer_id?: string;
  subscription_status: string;
  subscription_id?: string | null;
  current_period_end?: Date | null;
}

export interface DeviceRecord {
  id: string; // signing_device_id from Vouchflow
  account_id: string;
  // We track devices observed via signPayload bundles for the
  // ledger UI. Vouchflow remains the source of truth for enrollment.
  first_seen_at: Date;
  last_seen_at: Date;
  platform: "ios" | "android" | "web";
  revoked_at: Date | null;
}

export interface AccountStore {
  createAccount(email: string, displayName: string): Promise<AccountRecord>;
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  findAccountById(id: string): Promise<AccountRecord | null>;
  // Stripe billing. The webhook maps a Stripe customer back to the account
  // on subscription.updated/deleted (which only carry the customer id), then
  // writes the new billing state.
  findAccountByStripeCustomerId(customerId: string): Promise<AccountRecord | null>;
  setSubscription(accountId: string, patch: SubscriptionPatch): Promise<void>;
  // Irreversibly delete the account identity. In Postgres this cascades to
  // OAuth identities, devices, mandate, and web/agent sessions (FK
  // onDelete: Cascade). Idempotent — deleting a missing account is a no-op.
  deleteAccount(accountId: string): Promise<void>;

  touchDevice(input: {
    account_id: string;
    signing_device_id: string;
    platform: "ios" | "android" | "web";
    now: Date;
  }): Promise<void>;
  listDevices(accountId: string): Promise<DeviceRecord[]>;
  markDeviceRevoked(signingDeviceId: string, now: Date): Promise<void>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly accountsByEmail = new Map<string, string>();
  private readonly devices = new Map<string, DeviceRecord>();

  async createAccount(email: string, displayName: string): Promise<AccountRecord> {
    const existing = this.accountsByEmail.get(email.toLowerCase());
    if (existing !== undefined) {
      const acc = this.accounts.get(existing);
      if (acc !== undefined) return { ...acc };
    }
    const acc: AccountRecord = {
      id: ulid(),
      email,
      display_name: displayName,
      default_vault: null,
      created_at: new Date(),
      stripe_customer_id: null,
      subscription_status: "free",
      subscription_id: null,
      current_period_end: null,
    };
    this.accounts.set(acc.id, acc);
    this.accountsByEmail.set(email.toLowerCase(), acc.id);
    return { ...acc };
  }

  async findAccountByEmail(email: string): Promise<AccountRecord | null> {
    const id = this.accountsByEmail.get(email.toLowerCase());
    if (id === undefined) return null;
    const acc = this.accounts.get(id);
    return acc === undefined ? null : { ...acc };
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    const acc = this.accounts.get(id);
    return acc === undefined ? null : { ...acc };
  }

  async findAccountByStripeCustomerId(customerId: string): Promise<AccountRecord | null> {
    for (const acc of this.accounts.values()) {
      if (acc.stripe_customer_id === customerId) return { ...acc };
    }
    return null;
  }

  async setSubscription(accountId: string, patch: SubscriptionPatch): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc === undefined) return;
    acc.subscription_status = patch.subscription_status;
    if (patch.stripe_customer_id !== undefined) acc.stripe_customer_id = patch.stripe_customer_id;
    if (patch.subscription_id !== undefined) acc.subscription_id = patch.subscription_id;
    if (patch.current_period_end !== undefined) acc.current_period_end = patch.current_period_end;
  }

  async touchDevice(input: {
    account_id: string;
    signing_device_id: string;
    platform: "ios" | "android" | "web";
    now: Date;
  }): Promise<void> {
    const existing = this.devices.get(input.signing_device_id);
    if (existing !== undefined) {
      existing.last_seen_at = input.now;
      return;
    }
    this.devices.set(input.signing_device_id, {
      id: input.signing_device_id,
      account_id: input.account_id,
      first_seen_at: input.now,
      last_seen_at: input.now,
      platform: input.platform,
      revoked_at: null,
    });
  }

  async listDevices(accountId: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((d) => d.account_id === accountId)
      .map((d) => ({ ...d }));
  }

  async markDeviceRevoked(signingDeviceId: string, now: Date): Promise<void> {
    const d = this.devices.get(signingDeviceId);
    if (d === undefined) return;
    d.revoked_at = now;
  }

  async deleteAccount(accountId: string): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc !== undefined) {
      this.accountsByEmail.delete(acc.email.toLowerCase());
      this.accounts.delete(accountId);
    }
    for (const [id, d] of this.devices) {
      if (d.account_id === accountId) this.devices.delete(id);
    }
  }
}
