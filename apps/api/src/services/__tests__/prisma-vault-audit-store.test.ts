// PrismaVaultAuditStore — unit tests against a faked ApiPrismaClient.
//
// We don't spin up a real Postgres here; the goal is to lock in the
// shape of the writes (one row per event with the right type +
// payload) and the rate-limiter query the vault calls 100x/hour.
// Behaviour at the DB layer is exercised in apps/api integration tests.

import { describe, expect, it, vi } from "vitest";
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
  findRows: Array<CreatedRow & { emitted_at: Date }>;
}

function fakePrisma(): Fake {
  const created: CreatedRow[] = [];
  const countCalls: CountCall[] = [];
  const state = { countResult: 0, findRows: [] as Array<CreatedRow & { emitted_at: Date }> };
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
      return state.findRows;
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
    get findRows() {
      return state.findRows;
    },
    set findRows(rows: Array<CreatedRow & { emitted_at: Date }>) {
      state.findRows = rows;
    },
  } as Fake;
}

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";

describe("PrismaVaultAuditStore", () => {
  it("applies payment categories in the database before pagination", async () => {
    const fake = fakePrisma();
    const find = vi.spyOn(fake.prisma.vaultAuditEvent, "findMany");
    const types = [VAULT_AUDIT_TYPES.paymentApprovalCreated, VAULT_AUDIT_TYPES.paymentExecuted];
    const before = new Date("2026-09-12T00:00:00.000Z");
    await new PrismaVaultAuditStore(fake.prisma).list(ACCOUNT, {
      type: types,
      limit: 1,
      before,
      reference: "pay://approval",
    });
    expect(find).toHaveBeenCalledWith({
      where: {
        account_id: ACCOUNT,
        type: { in: types },
        emitted_at: { lt: before },
        payload: { path: ["reference"], equals: "pay://approval" },
      },
      orderBy: { emitted_at: "desc" },
      take: 1,
    });
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
        attribution: {
          task_id: "task-audit-store",
          agent_identity: "web-session:abc",
          invocation_id: "invoke-audit-store",
          purpose: "user:read",
        },
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
      purpose: "user:read",
      attribution: {
        task_id: "task-audit-store",
        agent_identity: "web-session:abc",
        invocation_id: "invoke-audit-store",
      },
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
    for (const row of fake.created) {
      expect(row.payload).toMatchObject({
        purpose: row.type.replace(/^vault\./, ""),
        attribution: {
          task_id: null,
          agent_identity: null,
          invocation_id: null,
          caller_missing: true,
        },
      });
    }
  });

  it("surfaces an explicit missing caller for rows written before provenance existed", async () => {
    const fake = fakePrisma();
    fake.findRows = [
      {
        id: "01HLEGACYAAAAAAAAAAAAAAAAAA",
        account_id: ACCOUNT,
        type: VAULT_AUDIT_TYPES.deleted,
        payload: { reference: "vault://acct/legacy", requester: "user" },
        emitted_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const [row] = await new PrismaVaultAuditStore(fake.prisma).list(ACCOUNT);
    expect(row?.payload).toMatchObject({
      purpose: "credential_deleted",
      attribution: {
        task_id: null,
        agent_identity: null,
        invocation_id: null,
        purpose: "credential_deleted",
        caller_missing: true,
      },
    });
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
