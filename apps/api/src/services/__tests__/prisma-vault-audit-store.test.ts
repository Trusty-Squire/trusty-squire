// PrismaVaultAuditStore — unit tests against a faked ApiPrismaClient.
//
// We don't spin up a real Postgres here; the goal is to lock in the
// shape of the writes (one row per event with the right type +
// payload) and the rate-limiter query the vault calls 100x/hour.
// Behaviour at the DB layer is exercised in apps/api integration tests.

import { describe, expect, it } from "vitest";
import { VAULT_AUDIT_TYPES, type VaultAuditEventInput } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaVaultAuditStore } from "../prisma-vault-audit-store.js";

interface CreatedRow {
  id: string;
  account_id: string;
  type: string;
  payload: unknown;
}

interface CountCall {
  where: { account_id: string; type: string; emitted_at: { gte: Date } };
}

interface Fake {
  prisma: ApiPrismaClient;
  created: CreatedRow[];
  countCalls: CountCall[];
  countResult: number;
}

function fakePrisma(): Fake {
  const created: CreatedRow[] = [];
  const countCalls: CountCall[] = [];
  const state = { countResult: 0 };
  const vaultAuditEvent = {
    async create(args: { data: Record<string, unknown> }) {
      const d = args.data;
      const row: CreatedRow = {
        id: d.id as string,
        account_id: d.account_id as string,
        type: d.type as string,
        payload: d.payload,
      };
      created.push(row);
      return { ...row, emitted_at: new Date() };
    },
    async count(args: CountCall) {
      countCalls.push(args);
      return state.countResult;
    },
    async findMany() {
      return [];
    },
  };
  const prisma = { vaultAuditEvent } as unknown as ApiPrismaClient;
  return {
    prisma,
    created,
    countCalls,
    get countResult() {
      return state.countResult;
    },
    set countResult(n: number) {
      state.countResult = n;
    },
  } as Fake;
}

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";

describe("PrismaVaultAuditStore", () => {
  it("record() writes a row with a ULID, the event type, and the payload as JSON", async () => {
    const fake = fakePrisma();
    const store = new PrismaVaultAuditStore(fake.prisma);

    const event: VaultAuditEventInput = {
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.retrieved,
      payload: {
        reference: "vault://acct/sub/abc",
        requester: "user",
        purpose: "user:read",
        signing_device_id: "01HDEVICE",
        outcome: "success",
      },
    };
    await store.record(event);

    expect(fake.created).toHaveLength(1);
    const row = fake.created[0]!;
    expect(row.account_id).toBe(ACCOUNT);
    expect(row.type).toBe("vault.credential_retrieved");
    expect(row.payload).toMatchObject({
      reference: "vault://acct/sub/abc",
      outcome: "success",
    });
    // ULID: 26 chars, Crockford base32.
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("record() writes the mutation event types unchanged", async () => {
    const fake = fakePrisma();
    const store = new PrismaVaultAuditStore(fake.prisma);

    for (const type of [
      VAULT_AUDIT_TYPES.stored,
      VAULT_AUDIT_TYPES.rotated,
      VAULT_AUDIT_TYPES.deleted,
    ]) {
      await store.record({
        account_id: ACCOUNT,
        type,
        payload: { reference: "vault://acct/sub/x", requester: "system" },
      });
    }

    expect(fake.created.map((r) => r.type)).toEqual([
      "vault.credential_stored",
      "vault.credential_rotated",
      "vault.credential_deleted",
    ]);
  });

  it("countRecentRetrievals() filters by account + retrieved type + emitted_at window", async () => {
    const fake = fakePrisma();
    fake.countResult = 7;
    const store = new PrismaVaultAuditStore(fake.prisma);

    const since = new Date("2026-05-29T14:00:00.000Z");
    const n = await store.countRecentRetrievals(ACCOUNT, since);

    expect(n).toBe(7);
    expect(fake.countCalls).toHaveLength(1);
    expect(fake.countCalls[0]!.where).toEqual({
      account_id: ACCOUNT,
      type: "vault.credential_retrieved",
      emitted_at: { gte: since },
    });
  });
});
