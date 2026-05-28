// OAuthIdentity store — maps a provider identity (google|github + the
// provider's stable user id) to a Trusty Squire account.
//
// In-memory for tests/local dev; Postgres-backed when AUTH_DATABASE_URL
// is set. Same interface+both-impls-in-one-file shape as captcha-events.

import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface OAuthIdentityRecord {
  id: string;
  account_id: string;
  provider: string;
  provider_user_id: string;
  email: string;
  created_at: Date;
}

export interface OAuthIdentityStore {
  findByProvider(
    provider: string,
    providerUserId: string,
  ): Promise<OAuthIdentityRecord | null>;
  // Identities bound to one account. Used by /v1/auth/whoami so the
  // install wizard can know which providers the user has connected
  // without having to read the bot Chrome profile.
  listByAccount(accountId: string): Promise<OAuthIdentityRecord[]>;
  create(input: {
    account_id: string;
    provider: string;
    provider_user_id: string;
    email: string;
  }): Promise<OAuthIdentityRecord>;
}

export class InMemoryOAuthIdentityStore implements OAuthIdentityStore {
  private readonly rows: OAuthIdentityRecord[] = [];

  async findByProvider(
    provider: string,
    providerUserId: string,
  ): Promise<OAuthIdentityRecord | null> {
    const row = this.rows.find(
      (r) => r.provider === provider && r.provider_user_id === providerUserId,
    );
    return row === undefined ? null : { ...row };
  }

  async listByAccount(accountId: string): Promise<OAuthIdentityRecord[]> {
    return this.rows
      .filter((r) => r.account_id === accountId)
      .map((r) => ({ ...r }));
  }

  async create(input: {
    account_id: string;
    provider: string;
    provider_user_id: string;
    email: string;
  }): Promise<OAuthIdentityRecord> {
    const record: OAuthIdentityRecord = {
      id: ulid(),
      account_id: input.account_id,
      provider: input.provider,
      provider_user_id: input.provider_user_id,
      email: input.email,
      created_at: new Date(),
    };
    this.rows.push(record);
    return { ...record };
  }
}

export class PrismaOAuthIdentityStore implements OAuthIdentityStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async findByProvider(
    provider: string,
    providerUserId: string,
  ): Promise<OAuthIdentityRecord | null> {
    // Compound-unique lookup — Prisma names the key after the fields
    // in the @@unique([provider, provider_user_id]) declaration.
    const row = await this.prisma.oAuthIdentity.findUnique({
      where: {
        provider_provider_user_id: {
          provider,
          provider_user_id: providerUserId,
        },
      },
    });
    return row === null ? null : this.toRecord(row);
  }

  async listByAccount(accountId: string): Promise<OAuthIdentityRecord[]> {
    const rows = await this.prisma.oAuthIdentity.findMany({
      where: { account_id: accountId },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async create(input: {
    account_id: string;
    provider: string;
    provider_user_id: string;
    email: string;
  }): Promise<OAuthIdentityRecord> {
    const row = await this.prisma.oAuthIdentity.create({
      data: {
        id: ulid(),
        account_id: input.account_id,
        provider: input.provider,
        provider_user_id: input.provider_user_id,
        email: input.email,
        created_at: new Date(),
      },
    });
    return this.toRecord(row);
  }

  private toRecord(row: {
    id: string;
    account_id: string;
    provider: string;
    provider_user_id: string;
    email: string;
    created_at: Date;
  }): OAuthIdentityRecord {
    return {
      id: row.id,
      account_id: row.account_id,
      provider: row.provider,
      provider_user_id: row.provider_user_id,
      email: row.email,
      created_at: row.created_at,
    };
  }
}
