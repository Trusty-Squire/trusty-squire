// Which Vouchflow signing devices belong to which account.
//
// Vouchflow enrollment runs browser → Vouchflow and never reaches our API, so
// an assertion's `device_token` claim names a signer we would otherwise have
// no way to attribute. A signed-in browser claims its enrolled device here;
// the passkey-gated approval ceremonies — which are sessionless — then refuse
// an assertion whose signer is not one of the owning account's devices.
//
// In-memory for tests/local dev; Postgres-backed when AUTH_DATABASE_URL is
// set. Same interface+both-impls-in-one-file shape as oauth-identity-store.

import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface VouchflowDeviceRecord {
  device_token: string;
  account_id: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface VouchflowDeviceStore {
  // Idempotent. A device token is unique to one browser profile, not to one
  // account, so re-registering it from a different signed-in account moves it:
  // the browser the human is using now is the one that may sign for them. The
  // previous account simply re-claims it on its next signed-in visit.
  register(accountId: string, deviceToken: string, now: Date): Promise<void>;
  listTokensByAccount(accountId: string): Promise<string[]>;
}

export class InMemoryVouchflowDeviceStore implements VouchflowDeviceStore {
  private readonly rows = new Map<string, VouchflowDeviceRecord>();

  async register(accountId: string, deviceToken: string, now: Date): Promise<void> {
    const existing = this.rows.get(deviceToken);
    if (existing !== undefined && existing.account_id === accountId) {
      existing.last_seen_at = now;
      return;
    }
    if (existing !== undefined) {
      existing.account_id = accountId;
      existing.last_seen_at = now;
      return;
    }
    this.rows.set(deviceToken, {
      device_token: deviceToken,
      account_id: accountId,
      first_seen_at: now,
      last_seen_at: now,
    });
  }

  async listTokensByAccount(accountId: string): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.account_id === accountId)
      .map((row) => row.device_token);
  }
}

export class PrismaVouchflowDeviceStore implements VouchflowDeviceStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async register(accountId: string, deviceToken: string, now: Date): Promise<void> {
    await this.prisma.vouchflowDevice.upsert({
      where: { device_token: deviceToken },
      create: {
        device_token: deviceToken,
        account_id: accountId,
        first_seen_at: now,
        last_seen_at: now,
      },
      update: { account_id: accountId, last_seen_at: now },
    });
  }

  async listTokensByAccount(accountId: string): Promise<string[]> {
    const rows = await this.prisma.vouchflowDevice.findMany({
      where: { account_id: accountId },
    });
    return rows.map((row) => row.device_token);
  }
}
