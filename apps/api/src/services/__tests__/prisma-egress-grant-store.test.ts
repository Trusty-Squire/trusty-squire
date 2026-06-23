// PrismaEgressGrantStore — unit tests against a faked ApiPrismaClient.
//
// No real Postgres: a small in-memory map stands in for the egressGrant
// delegate so we can lock the DateTime<->ISO conversion boundary, the
// account-scoped + idempotent revoke, and the create/get/list roundtrip.
// DB-layer behaviour is exercised in apps/api integration tests.

import { describe, expect, it } from "vitest";
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

function p1017(): Error & { code: string } {
  return Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
}

function fakePrisma(): {
  prisma: ApiPrismaClient & { $disconnect: () => Promise<void> };
  rows: Map<string, Row>;
  calls: { findUnique: number; disconnect: number; failFindUnique: number };
} {
  const rows = new Map<string, Row>();
  const calls = { findUnique: 0, disconnect: 0, failFindUnique: 0 };
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
    async deleteMany() {
      return { count: 0 };
    },
  };
  const prisma = {
    egressGrant,
    async $disconnect() {
      calls.disconnect += 1;
    },
  } as unknown as ApiPrismaClient & { $disconnect: () => Promise<void> };
  return { prisma, rows, calls };
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

  it("revoke() stamps revoked_at and is idempotent + account-scoped", async () => {
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

    // Idempotent: second revoke returns true without re-stamping.
    expect(await store.revoke(grant.id, ACCOUNT, "2026-06-13T14:00:00.000Z")).toBe(true);
    expect((await store.getById(grant.id))!.revoked_at).toBe("2026-06-13T13:00:00.000Z");
  });

  it("revoke() of an unknown grant is a miss", async () => {
    const store = new PrismaEgressGrantStore(fakePrisma().prisma);
    expect(await store.revoke("g_nope", ACCOUNT, "2026-06-13T13:00:00.000Z")).toBe(false);
  });
});
