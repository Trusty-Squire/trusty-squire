// PrismaAccessGrantStore — unit tests against a faked ApiPrismaClient.
//
// No real Postgres. The goal is to lock in the WHERE guards that make
// transitions race-safe + account-scoped: approve guards status=pending,
// consume guards status=approved, revoke guards status IN (pending,
// approved), and every transition is scoped to account_id. Behaviour at
// the DB layer is exercised in apps/api integration tests.

import { describe, expect, it } from "vitest";
import type { AccessGrantRecord } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaAccessGrantStore } from "../prisma-access-grant-store.js";

interface UpdateCall {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface Fake {
  prisma: ApiPrismaClient;
  creates: Record<string, unknown>[];
  updates: UpdateCall[];
  nextCount: { n: number };
}

function fakePrisma(): Fake {
  const creates: Record<string, unknown>[] = [];
  const updates: UpdateCall[] = [];
  const nextCount = { n: 1 };
  const accessGrant = {
    async create(args: { data: Record<string, unknown> }) {
      creates.push(args.data);
      return args.data as never;
    },
    async findFirst() {
      return null;
    },
    async findMany() {
      return [];
    },
    async count() {
      return 0;
    },
    async updateMany(args: UpdateCall) {
      updates.push(args);
      return { count: nextCount.n };
    },
  };
  const prisma = { accessGrant } as unknown as ApiPrismaClient;
  return { prisma, creates, updates, nextCount };
}

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const ID = "01HGRANTAAAAAAAAAAAAAAAAAA";

function record(): AccessGrantRecord {
  return {
    id: ID,
    account_id: ACCOUNT,
    reference: "vault://acct/sub/cred",
    agent_session_id: "01HSESSION",
    intent: "value",
    mode: "once",
    ttl_seconds: 3600,
    purpose: "x",
    reason_proxy_not_possible: "local file",
    requested_target_host: null,
    requested_at: new Date("2026-05-29T12:00:00Z"),
    decided_at: null,
    expires_at: new Date("2026-05-29T12:05:00Z"),
    status: "pending",
    auto_approved: false,
  };
}

describe("PrismaAccessGrantStore guards", () => {
  it("insert writes every column", async () => {
    const fake = fakePrisma();
    await new PrismaAccessGrantStore(fake.prisma).insert(record());
    expect(fake.creates[0]).toMatchObject({
      id: ID,
      account_id: ACCOUNT,
      intent: "value",
      status: "pending",
      auto_approved: false,
    });
  });

  it("approve guards status=pending and scopes to account", async () => {
    const fake = fakePrisma();
    const now = new Date("2026-05-29T12:01:00Z");
    const n = await new PrismaAccessGrantStore(fake.prisma).approve({
      id: ID,
      accountId: ACCOUNT,
      mode: "persistent",
      ttlSeconds: 100,
      expiresAt: now,
      decidedAt: now,
    });
    expect(n).toBe(1);
    expect(fake.updates[0]!.where).toEqual({
      id: ID,
      account_id: ACCOUNT,
      status: "pending",
    });
    expect(fake.updates[0]!.data).toMatchObject({ status: "approved", mode: "persistent" });
  });

  it("consume guards status=approved", async () => {
    const fake = fakePrisma();
    await new PrismaAccessGrantStore(fake.prisma).consume({ id: ID, accountId: ACCOUNT });
    expect(fake.updates[0]!.where).toEqual({ id: ID, account_id: ACCOUNT, status: "approved" });
    expect(fake.updates[0]!.data).toEqual({ status: "consumed" });
  });

  it("revoke guards status IN (pending, approved)", async () => {
    const fake = fakePrisma();
    await new PrismaAccessGrantStore(fake.prisma).revoke({ id: ID, accountId: ACCOUNT });
    expect(fake.updates[0]!.where).toEqual({
      id: ID,
      account_id: ACCOUNT,
      status: { in: ["pending", "approved"] },
    });
  });

  it("revokePersistentByReference guards mode=persistent + status=approved + reference", async () => {
    const fake = fakePrisma();
    fake.nextCount.n = 3;
    const n = await new PrismaAccessGrantStore(fake.prisma).revokePersistentByReference(
      "vault://acct/sub/cred",
      ACCOUNT,
    );
    expect(n).toBe(3);
    expect(fake.updates[0]!.where).toEqual({
      reference: "vault://acct/sub/cred",
      account_id: ACCOUNT,
      mode: "persistent",
      status: "approved",
    });
  });

  it("deny guards status=pending", async () => {
    const fake = fakePrisma();
    await new PrismaAccessGrantStore(fake.prisma).deny({
      id: ID,
      accountId: ACCOUNT,
      decidedAt: new Date(),
    });
    expect(fake.updates[0]!.where).toEqual({ id: ID, account_id: ACCOUNT, status: "pending" });
    expect(fake.updates[0]!.data).toMatchObject({ status: "denied" });
  });
});
