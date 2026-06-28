// Minimal in-memory Account storage for the API.
//
// Covers Account-scoped data the API gateway owns (account row + Stripe
// billing state). The mandate-store + device-attestation (Vouchflow)
// machinery was retired. Tests + dev use this store; the Prisma-backed
// equivalent lives in prisma-account-store.ts.

import { ulid } from "ulid";

export interface AccountRecord {
  id: string;
  email: string;
  display_name: string;
  default_vault: string | null;
  created_at: Date;
  // Stripe billing. `subscription_status` ("free" by default) reflects the
  // paid tier; written only by the Stripe webhook path.
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_id: string | null;
  current_period_end: Date | null;
  // Scheduled cancellation date (cancel-at-period-end); null = not cancelling.
  cancel_at: Date | null;
}

// The subset of billing fields the Stripe webhook updates. `subscription_status`
// is always set; the ids/period are present on create/renew, absent (left as-is)
// on a bare status flip. `cancel_at` is written explicitly (Date or null) on
// subscription.updated so a resume clears it — pass it to set, omit to leave.
export interface SubscriptionPatch {
  stripe_customer_id?: string;
  subscription_status: string;
  subscription_id?: string | null;
  current_period_end?: Date | null;
  cancel_at?: Date | null;
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
  // OAuth identities and web/agent sessions (FK onDelete: Cascade).
  // Idempotent — deleting a missing account is a no-op.
  deleteAccount(accountId: string): Promise<void>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly accountsByEmail = new Map<string, string>();

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
      cancel_at: null,
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
    if (patch.cancel_at !== undefined) acc.cancel_at = patch.cancel_at;
  }

  async deleteAccount(accountId: string): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc !== undefined) {
      this.accountsByEmail.delete(acc.email.toLowerCase());
      this.accounts.delete(accountId);
    }
  }
}
