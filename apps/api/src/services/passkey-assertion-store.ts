// Passkey step-up assertions.
//
// The trusted-session toggle (PATCH /v1/mcp/sessions/:id) requires the
// account to have completed a WebAuthn assertion within the last 24h.
// The web UI runs `navigator.credentials.get()` and POSTs the result to
// the step-up endpoint, which records a row here. `findRecent` answers
// the gating question: "did this account passkey-assert since <when>?"
//
// v1 records the assertion's recency — the signal the plan locks the
// toggle on. Cryptographic verification against a registered credential
// is deferred: there is no public-key store yet (no registration
// ceremony exists), so there is nothing to verify the signature against.

import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface PasskeyAssertionRecord {
  id: string;
  account_id: string;
  credential_id: string | null;
  web_session_id: string | null;
  asserted_at: Date;
}

export interface PasskeyAssertionStore {
  record(record: PasskeyAssertionRecord): Promise<void>;
  // The most recent assertion for the account at/after `since`, or null.
  findRecent(accountId: string, since: Date): Promise<PasskeyAssertionRecord | null>;
}

export class InMemoryPasskeyAssertionStore implements PasskeyAssertionStore {
  private readonly rows: PasskeyAssertionRecord[] = [];

  async record(record: PasskeyAssertionRecord): Promise<void> {
    this.rows.push({ ...record });
  }

  async findRecent(
    accountId: string,
    since: Date,
  ): Promise<PasskeyAssertionRecord | null> {
    const matches = this.rows
      .filter(
        (r) =>
          r.account_id === accountId &&
          r.asserted_at.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.asserted_at.getTime() - a.asserted_at.getTime());
    return matches[0] ?? null;
  }
}

export class PrismaPasskeyAssertionStore implements PasskeyAssertionStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async record(record: PasskeyAssertionRecord): Promise<void> {
    await this.prisma.passkeyAssertion.create({
      data: {
        id: record.id,
        account_id: record.account_id,
        credential_id: record.credential_id,
        web_session_id: record.web_session_id,
        asserted_at: record.asserted_at,
      },
    });
  }

  async findRecent(
    accountId: string,
    since: Date,
  ): Promise<PasskeyAssertionRecord | null> {
    const row = await this.prisma.passkeyAssertion.findFirst({
      where: { account_id: accountId, asserted_at: { gte: since } },
      orderBy: { asserted_at: "desc" },
    });
    return row === null
      ? null
      : {
          id: row.id,
          account_id: row.account_id,
          credential_id: row.credential_id,
          web_session_id: row.web_session_id,
          asserted_at: row.asserted_at,
        };
  }
}
