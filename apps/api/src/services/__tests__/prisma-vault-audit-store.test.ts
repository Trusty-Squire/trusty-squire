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
  dailyWrites: unknown[][];
}

function fakePrisma(): Fake {
  const created: CreatedRow[] = [];
  const countCalls: CountCall[] = [];
  const dailyWrites: unknown[][] = [];
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
    async upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
    }): Promise<unknown> {
      return (
        created.find((row) => row.id === args.where.id) ??
        (await this.create({ data: args.create }))
      );
    },
    async count(args: CountCall) {
      countCalls.push(args);
      return state.countResult;
    },
    async findMany() {
      return [];
    },
    async deleteMany(args: { where: { id: string } }) {
      const index = created.findIndex((row) => row.id === args.where.id);
      if (index >= 0) created.splice(index, 1);
      return { count: index >= 0 ? 1 : 0 };
    },
    async updateMany(args: { where: { id: string }; data: { payload: unknown } }) {
      const row = created.find((r) => r.id === args.where.id);
      if (row) row.payload = args.data.payload;
      return { count: row ? 1 : 0 };
    },
  };
  const prisma = {
    vaultAuditEvent,
    $transaction: async (fn: (tx: ApiPrismaClient) => Promise<unknown>) =>
      fn(prisma as ApiPrismaClient),
    $queryRawUnsafe: async (_sql: string, id: string) => {
      const row = created.find((r) => r.id === id);
      return row ? [{ ...row, emitted_at: new Date("2026-10-16T12:00:00Z") }] : [];
    },
    $executeRawUnsafe: async (_sql: string, ...values: unknown[]) => {
      dailyWrites.push(values);
      return 1;
    },
  } as unknown as ApiPrismaClient;
  return {
    prisma,
    created,
    countCalls,
    dailyWrites,
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
  it("increments the daily counter for a successful proxy call and keeps a failed call", async () => {
    const fake = fakePrisma();
    const store = new PrismaVaultAuditStore(fake.prisma);
    const base: VaultAuditEventInput = {
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.proxyExecuted,
      payload: {
        reference: "vault://ref",
        target_host: "api.example.com",
        requester: "agent",
        grant_id: "grant-1",
        response_status: 200,
        response_size: 42,
      },
    };
    await store.record(base);
    await store.record({ ...base, payload: { ...base.payload, response_status: 429 } });
    await store.record({ ...base, payload: { ...base.payload, proxy_error: "stream failed" } });
    expect(fake.dailyWrites).toHaveLength(1);
    expect(fake.dailyWrites[0]?.slice(0, 8)).toEqual([
      ACCOUNT,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      "vault://ref",
      "api.example.com",
      "agent",
      "grant-1",
      "200",
      42,
    ]);
    expect(fake.created).toHaveLength(2);
    expect(
      fake.created.map((r) => (r.payload as { response_status: number }).response_status),
    ).toEqual([429, 200]);
  });

  it("finalizes a streamed success into the counter but retains a streamed error", async () => {
    const fake = fakePrisma();
    const store = new PrismaVaultAuditStore(fake.prisma);
    const payload = {
      reference: "vault://ref",
      target_host: "api.example.com",
      requester: "agent" as const,
      response_status: 200,
      response_size: 0,
    };
    await store.record({
      idempotency_key: "stream-ok",
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.proxyExecuted,
      payload,
      defer_proxy_rollup: true,
    });
    await store.record({
      idempotency_key: "stream-bad",
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.proxyExecuted,
      payload,
      defer_proxy_rollup: true,
    });
    expect(fake.created).toHaveLength(2);
    await store.amend("stream-ok", { response_size: 300 });
    await store.amend("stream-bad", { response_size: 10, proxy_error: "upstream reset" });
    expect(fake.dailyWrites).toHaveLength(1);
    expect(fake.dailyWrites[0]?.[7]).toBe(300);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.payload).toMatchObject({ proxy_error: "upstream reset" });
  });

  it("repairs retries through one durable audit identity", async () => {
    const fake = fakePrisma();
    const store = new PrismaVaultAuditStore(fake.prisma);
    const event: VaultAuditEventInput = {
      idempotency_key: "capture-audit-identity",
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.stored,
      payload: { reference: "vault://capture", requester: "system" },
    };
    await Promise.all([store.record(event), store.record(event)]);
    await new PrismaVaultAuditStore(fake.prisma).record(event);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      id: event.idempotency_key,
      account_id: ACCOUNT,
      type: VAULT_AUDIT_TYPES.stored,
    });
  });
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
