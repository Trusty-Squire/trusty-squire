// PrismaEgressGrantStore — unit tests against a faked ApiPrismaClient.
//
// No real Postgres: a small in-memory map stands in for the egressGrant
// delegate so we can lock the DateTime<->ISO conversion boundary, the
// account-scoped + idempotent revoke, and the create/get/list roundtrip.
// DB-layer behaviour is exercised in apps/api integration tests.

import { describe, expect, it, vi } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaEgressGrantStore } from "../prisma-egress-grant-store.js";
import { mintGrant } from "../egress-grant.js";

interface Row {
  id: string;
  account_id: string;
  credential_ref: string;
  token_hash: string;
  rate_limit_per_hour: number;
  spend_cap_usd: number | null;
  created_at: Date;
  revoked_at: Date | null;
}

interface AuditRow {
  account_id: string;
  type: string;
  payload: unknown;
}

function p1017(): Error & { code: string } {
  return Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed."), { code: "P2002" });
}

type TransactionBehavior =
  | "normal"
  | "commit_then_connection_error"
  | "rollback_then_connection_error"
  | "concurrent_commit_then_unique";

function fakePrisma(): {
  prisma: ApiPrismaClient & { $disconnect: () => Promise<void> };
  rows: Map<string, Row>;
  auditRows: AuditRow[];
  calls: {
    findUnique: number;
    disconnect: number;
    failFindUnique: number;
    failAudit: number;
    auditCreates: number;
    transactionAttempts: number;
    transactionBehaviors: TransactionBehavior[];
  };
} {
  const rows = new Map<string, Row>();
  const auditRows: AuditRow[] = [];
  const calls = {
    findUnique: 0,
    disconnect: 0,
    failFindUnique: 0,
    failAudit: 0,
    auditCreates: 0,
    transactionAttempts: 0,
    transactionBehaviors: [] as TransactionBehavior[],
  };
  let pendingRows: Row[] = [];
  let pendingAuditRows: AuditRow[] = [];
  const egressGrant = {
    async create(args: { data: Record<string, unknown> }) {
      const d = args.data;
      const row: Row = {
        id: d.id as string,
        account_id: d.account_id as string,
        credential_ref: d.credential_ref as string,
        token_hash: d.token_hash as string,
        rate_limit_per_hour: d.rate_limit_per_hour as number,
        spend_cap_usd: (d.spend_cap_usd as number | null) ?? null,
        created_at: d.created_at as Date,
        revoked_at: (d.revoked_at as Date | null) ?? null,
      };
      if (rows.has(row.id)) throw p2002();
      rows.set(row.id, row);
      return row;
    },
    async findUnique(args: { where: { id: string } }) {
      calls.findUnique += 1;
      if (calls.failFindUnique > 0) {
        calls.failFindUnique -= 1;
        throw p1017();
      }
      return rows.get(args.where.id) ?? null;
    },
    async findMany(args: { where: Record<string, unknown> }) {
      const acct = args.where.account_id as string | undefined;
      return [...rows.values()].filter((r) => acct === undefined || r.account_id === acct);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const r = rows.get(args.where.id)!;
      const next = { ...r, ...(args.data as Partial<Row>) };
      rows.set(r.id, next);
      return next;
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const row = rows.get(args.where.id as string);
      if (
        row === undefined ||
        row.account_id !== args.where.account_id ||
        row.revoked_at !== args.where.revoked_at
      ) {
        return { count: 0 };
      }
      rows.set(row.id, { ...row, ...(args.data as Partial<Row>) });
      return { count: 1 };
    },
    async deleteMany() {
      return { count: 0 };
    },
  };
  const prisma = {
    egressGrant,
    vaultAuditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        if (calls.failAudit > 0) {
          calls.failAudit -= 1;
          throw new Error("synthetic audit outage");
        }
        auditRows.push({
          account_id: args.data.account_id as string,
          type: args.data.type as string,
          payload: args.data.payload,
        });
        calls.auditCreates += 1;
        return {};
      },
      async findMany(args: { where: Record<string, unknown> }) {
        const payloadFilter = args.where.payload as
          | { path?: string[]; equals?: unknown }
          | undefined;
        return auditRows.filter((row) => {
          if (args.where.account_id !== undefined && row.account_id !== args.where.account_id) {
            return false;
          }
          if (args.where.type !== undefined && row.type !== args.where.type) return false;
          if (payloadFilter?.path === undefined) return true;
          let value: unknown = row.payload;
          for (const segment of payloadFilter.path) {
            if (value === null || typeof value !== "object") return false;
            value = (value as Record<string, unknown>)[segment];
          }
          return value === payloadFilter.equals;
        });
      },
    },
    async $transaction<T>(fn: (tx: ApiPrismaClient) => Promise<T>): Promise<T> {
      calls.transactionAttempts += 1;
      const behavior = calls.transactionBehaviors.shift() ?? "normal";
      if (behavior === "concurrent_commit_then_unique") {
        for (const row of pendingRows) rows.set(row.id, { ...row });
        auditRows.push(...pendingAuditRows.map((row) => ({ ...row })));
        calls.auditCreates += pendingAuditRows.length;
        pendingRows = [];
        pendingAuditRows = [];
      }
      const snapshot = new Map([...rows].map(([id, row]) => [id, { ...row }] as const));
      const auditSnapshot = calls.auditCreates;
      const auditRowsSnapshot = auditRows.map((row) => ({ ...row }));
      let result: T;
      try {
        result = await fn(prisma as unknown as ApiPrismaClient);
      } catch (error) {
        rows.clear();
        for (const [id, row] of snapshot) rows.set(id, row);
        calls.auditCreates = auditSnapshot;
        auditRows.splice(0, auditRows.length, ...auditRowsSnapshot);
        throw error;
      }
      if (behavior === "commit_then_connection_error") throw p1017();
      if (behavior === "rollback_then_connection_error") {
        pendingRows = [...rows.entries()]
          .filter(([id]) => !snapshot.has(id))
          .map(([, row]) => ({ ...row }));
        pendingAuditRows = auditRows.slice(auditRowsSnapshot.length).map((row) => ({ ...row }));
        rows.clear();
        for (const [id, row] of snapshot) rows.set(id, row);
        calls.auditCreates = auditSnapshot;
        auditRows.splice(0, auditRows.length, ...auditRowsSnapshot);
        throw p1017();
      }
      return result;
    },
    async $disconnect() {
      calls.disconnect += 1;
    },
  } as unknown as ApiPrismaClient & { $disconnect: () => Promise<void> };
  return { prisma, rows, auditRows, calls };
}

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const OTHER = "01HOTHERBBBBBBBBBBBBBBBBBB";

function makeGrant(account = ACCOUNT, n = 1) {
  return mintGrant({
    account_id: account,
    credential_ref: `vault://${account}/cred-${n}`,
    rate_limit_per_hour: 1000,
    spend_cap_usd: null,
    now: "2026-06-13T12:00:00.000Z",
    randomId: () => `id${n}${account.slice(-2)}`,
    randomToken: () => `tok${n}`,
  }).grant;
}

describe("PrismaEgressGrantStore", () => {
  it("create() then getById() roundtrips and converts DateTime back to ISO strings", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    await store.create(grant);

    // Persisted as a real Date, not an ISO string.
    expect(fake.rows.get(grant.id)!.created_at).toBeInstanceOf(Date);

    const got = await store.getById(grant.id);
    expect(got).not.toBeNull();
    expect(got!.created_at).toBe("2026-06-13T12:00:00.000Z");
    expect(got!.revoked_at).toBeNull();
    expect(got!.credential_ref).toBe(grant.credential_ref);
  });

  it("createWithAudit() rolls back the grant when the audit insert fails", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    fake.calls.failAudit = 1;

    await expect(
      store.createWithAudit(grant, {
        account_id: ACCOUNT,
        type: "vault.grant_minted",
        payload: {
          reference: grant.credential_ref,
          requester: "agent",
          grant_id: grant.id,
        },
      }),
    ).rejects.toThrow("synthetic audit outage");
    expect(fake.rows.has(grant.id)).toBe(false);
  });

  it("createWithAudit() reconciles a committed transaction after its acknowledgement is lost", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    fake.calls.transactionBehaviors.push("commit_then_connection_error");

    await expect(
      store.createWithAudit(grant, {
        account_id: ACCOUNT,
        type: "vault.grant_minted",
        payload: {
          reference: grant.credential_ref,
          requester: "agent",
          grant_id: grant.id,
        },
      }),
    ).resolves.toBeUndefined();
    expect(fake.rows).toHaveLength(1);
    expect(fake.calls.auditCreates).toBe(1);
    expect(fake.calls.transactionAttempts).toBe(1);
  });

  it("createWithAudit() reconciles a unique violation after an ambiguous retry", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    fake.calls.transactionBehaviors.push(
      "rollback_then_connection_error",
      "concurrent_commit_then_unique",
    );

    await expect(
      store.createWithAudit(grant, {
        account_id: ACCOUNT,
        type: "vault.grant_minted",
        payload: {
          reference: grant.credential_ref,
          requester: "agent",
          grant_id: grant.id,
        },
      }),
    ).resolves.toBeUndefined();
    expect(fake.rows).toHaveLength(1);
    expect(fake.calls.auditCreates).toBe(1);
    expect(fake.calls.transactionAttempts).toBe(2);
  });

  it("getById() returns null for an unknown id", async () => {
    const store = new PrismaEgressGrantStore(fakePrisma().prisma);
    expect(await store.getById("g_nope")).toBeNull();
  });

  it("getById() caches grant lookups within the TTL", async () => {
    const fake = fakePrisma();
    let now = 1_000;
    const store = new PrismaEgressGrantStore(fake.prisma, {
      liveTtlMs: 30_000,
      now: () => now,
    });
    const grant = makeGrant();
    await store.create(grant);

    expect(await store.getById(grant.id)).toMatchObject({ id: grant.id });
    expect(await store.getById(grant.id)).toMatchObject({ id: grant.id });
    expect(fake.calls.findUnique).toBe(0); // create() populated the cache.

    now += 30_001;
    expect(await store.getById(grant.id)).toMatchObject({ id: grant.id });
    expect(fake.calls.findUnique).toBe(1);
  });

  it("getById() coalesces concurrent expired-cache reads into one database lookup", async () => {
    const fake = fakePrisma();
    let now = 1_000;
    const store = new PrismaEgressGrantStore(fake.prisma, {
      liveTtlMs: 30_000,
      now: () => now,
    });
    const grant = makeGrant();
    await store.create(grant);
    now += 30_001;

    const grants = await Promise.all(Array.from({ length: 8 }, () => store.getById(grant.id)));

    expect(grants.every((value) => value?.id === grant.id)).toBe(true);
    expect(fake.calls.findUnique).toBe(1);
  });

  it("getById() retries once on Prisma P1017 and reconnects before surfacing success", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma, { liveTtlMs: 0 });
    const grant = makeGrant();
    await store.create(grant);
    fake.calls.failFindUnique = 1;

    await expect(store.getById(grant.id)).resolves.toMatchObject({ id: grant.id });
    expect(fake.calls.findUnique).toBe(2);
    expect(fake.calls.disconnect).toBe(1);
  });

  it("getById() wraps repeated P1017 as a store-unavailable error", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma, { liveTtlMs: 0 });
    const grant = makeGrant();
    await store.create(grant);
    fake.calls.failFindUnique = 2;

    await expect(store.getById(grant.id)).rejects.toMatchObject({
      name: "EgressGrantStoreUnavailableError",
    });
    expect(fake.calls.disconnect).toBe(1);
  });

  it("listByAccount() returns only this account's grants", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    await store.create(makeGrant(ACCOUNT, 1));
    await store.create(makeGrant(ACCOUNT, 2));
    await store.create(makeGrant(OTHER, 1));

    const mine = await store.listByAccount(ACCOUNT);
    expect(mine).toHaveLength(2);
    expect(mine.every((g) => g.account_id === ACCOUNT)).toBe(true);
  });

  it("revoke() reports only the first account-scoped state transition", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    await store.create(grant);

    // Wrong account: a miss, never touches the row.
    expect(await store.revoke(grant.id, OTHER, "2026-06-13T13:00:00.000Z")).toBe(false);
    expect(fake.rows.get(grant.id)!.revoked_at).toBeNull();

    // Owner revokes.
    expect(await store.revoke(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z")).toBe(true);
    expect((await store.getById(grant.id))!.revoked_at).toBe("2026-06-13T13:00:00.000Z");

    expect(await store.revoke(grant.id, ACCOUNT, "2026-06-13T14:00:00.000Z")).toBe(false);
    expect((await store.getById(grant.id))!.revoked_at).toBe("2026-06-13T13:00:00.000Z");
  });

  it("revokeWithAudit() rolls back on audit failure and records one transition", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    const event = {
      account_id: ACCOUNT,
      type: "vault.grant_revoked",
      payload: {
        reference: grant.credential_ref,
        requester: "agent",
        grant_id: grant.id,
      },
    } as const;
    await store.create(grant);
    fake.calls.failAudit = 1;

    await expect(
      store.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z", event),
    ).rejects.toThrow("synthetic audit outage");
    expect(fake.rows.get(grant.id)?.revoked_at).toBeNull();

    expect(await store.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z", event)).toBe(
      true,
    );
    expect(await store.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T14:00:00.000Z", event)).toBe(
      false,
    );
    expect(fake.calls.auditCreates).toBe(1);
  });

  it("revokeWithAudit() reconciles a committed transition after its acknowledgement is lost", async () => {
    const fake = fakePrisma();
    const store = new PrismaEgressGrantStore(fake.prisma);
    const grant = makeGrant();
    const event = {
      account_id: ACCOUNT,
      type: "vault.grant_revoked",
      payload: {
        reference: grant.credential_ref,
        requester: "agent",
        grant_id: grant.id,
      },
    } as const;
    await store.create(grant);
    fake.calls.transactionBehaviors.push("commit_then_connection_error");

    await expect(
      store.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z", event),
    ).resolves.toBe(true);
    await expect(
      store.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T14:00:00.000Z", event),
    ).resolves.toBe(false);
    expect(fake.rows.get(grant.id)?.revoked_at?.toISOString()).toBe("2026-06-13T13:00:00.000Z");
    expect(fake.calls.auditCreates).toBe(1);
    expect(fake.calls.transactionAttempts).toBe(1);
  });

  it("attributes a concurrent ambiguous revoke only to the audit nonce owner", async () => {
    const fake = fakePrisma();
    const winner = new PrismaEgressGrantStore(fake.prisma, {
      randomUUID: () => "winner-attempt",
    });
    const loser = new PrismaEgressGrantStore(fake.prisma, {
      randomUUID: () => "loser-attempt",
    });
    const grant = makeGrant();
    const event = {
      account_id: ACCOUNT,
      type: "vault.grant_revoked",
      payload: {
        reference: grant.credential_ref,
        requester: "agent",
        grant_id: grant.id,
      },
    } as const;
    await winner.create(grant);
    fake.calls.transactionBehaviors.push("normal", "commit_then_connection_error");

    const results = await Promise.all([
      winner.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z", event),
      loser.revokeWithAudit(grant.id, ACCOUNT, "2026-06-13T13:00:00.000Z", event),
    ]);
    const notify = vi.fn();
    for (const firstTransition of results) {
      if (firstTransition) notify();
    }

    expect(results).toEqual([true, false]);
    expect(fake.auditRows).toHaveLength(1);
    expect(fake.auditRows[0]?.payload).toMatchObject({
      grant_id: grant.id,
      revoke_attempt_nonce: "winner-attempt",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("revoke() of an unknown grant is a miss", async () => {
    const store = new PrismaEgressGrantStore(fakePrisma().prisma);
    expect(await store.revoke("g_nope", ACCOUNT, "2026-06-13T13:00:00.000Z")).toBe(false);
  });
});
