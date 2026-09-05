// The single-use fence, at the level it is actually enforced.
//
// The route tests prove the HTTP behaviour; these prove the store primitive
// underneath it — including the Prisma implementation, whose whole guarantee
// is that the approved → consumed transition is a CONDITIONAL update, so two
// concurrent resumes cannot both be handed the value.

import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialFetchApprovalStore,
  type CredentialFetchApprovalInput,
} from "../credential-fetch-approval-store.js";
import { PrismaCredentialFetchApprovalStore } from "../prisma-credential-fetch-approval-store.js";
import type { ApiPrismaClient } from "../api-prisma-client.js";

const T0 = Date.parse("2026-09-05T12:00:00.000Z");

function input(over: Partial<CredentialFetchApprovalInput> = {}): CredentialFetchApprovalInput {
  return {
    credentialReference: "vault://acct_1/sub/cred",
    credentialService: "OpenAI",
    credentialLabel: "default",
    field: null,
    fieldNames: ["value"],
    nonce: "nonce_1",
    agent: "codex",
    requesterKind: "agent",
    intentHash: "intent_1",
    expiresAt: new Date(T0 + 10 * 60 * 1000),
    ...over,
  };
}

describe("InMemoryCredentialFetchApprovalStore", () => {
  it("claims exactly once, no matter how many callers race", async () => {
    let nowMs = T0;
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(nowMs));
    const id = await store.create("acct_1", input());
    expect(await store.approve(id, "mandate_1")).toBe("approved");

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(id, "acct_1")),
    );
    expect(outcomes.filter((outcome) => outcome.kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "already_consumed")).toHaveLength(7);
  });

  it("will not claim for a different account", async () => {
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(T0));
    const id = await store.create("acct_1", input());
    await store.approve(id, null);
    expect(await store.claim(id, "acct_2")).toEqual({ kind: "not_found" });
    // …and the owner's claim is untouched by the failed attempt.
    expect((await store.claim(id, "acct_1")).kind).toBe("claimed");
  });

  it("refuses to claim what was never approved, and to approve what expired", async () => {
    let nowMs = T0;
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(nowMs));
    const unapproved = await store.create("acct_1", input());
    expect((await store.claim(unapproved, "acct_1")).kind).toBe("not_approved");

    nowMs = T0 + 11 * 60 * 1000;
    expect(await store.approve(unapproved, null)).toBe("expired");
    expect((await store.claim(unapproved, "acct_1")).kind).toBe("not_approved");
  });

  it("closes an approved-but-unclaimed approval at expiry", async () => {
    let nowMs = T0;
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(nowMs));
    const id = await store.create("acct_1", input());
    expect(await store.approve(id, null)).toBe("approved");
    nowMs = T0 + 11 * 60 * 1000;
    expect((await store.claim(id, "acct_1")).kind).toBe("expired");
  });

  it("settles a lapsed approval exactly once, so a poller writes one audit row", async () => {
    let nowMs = T0;
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(nowMs));
    const id = await store.create("acct_1", input());
    // Not lapsed yet: nothing to settle.
    expect(await store.expire(id, new Date(nowMs))).toBe("already_terminal");
    nowMs = T0 + 11 * 60 * 1000;
    expect(await store.expire(id, new Date(nowMs))).toBe("expired");
    expect(await store.expire(id, new Date(nowMs))).toBe("already_terminal");
    expect((await store.getById(id))?.failureCode).toBe("expired");
  });

  it("denies only a pending approval — a denial cannot revoke a live approval", async () => {
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(T0));
    const pending = await store.create("acct_1", input());
    expect(await store.deny(pending)).toBe("denied");
    expect(await store.deny(pending)).toBe("already_denied");
    expect(await store.approve(pending, null)).toBe("not_pending");
    expect((await store.claim(pending, "acct_1")).kind).toBe("not_approved");

    // Once approved, "deny" is a lie — the value may already be out.
    const approved = await store.create("acct_1", input({ intentHash: "intent_2" }));
    await store.approve(approved, null);
    expect(await store.deny(approved)).toBe("not_pending");
  });

  it("reuses a pending approval for the same intent, but never a spent one", async () => {
    const store = new InMemoryCredentialFetchApprovalStore(() => new Date(T0));
    const id = await store.create("acct_1", input());
    expect((await store.findReusablePending("acct_1", "intent_1", new Date(T0)))?.id).toBe(id);
    expect(await store.findReusablePending("acct_2", "intent_1", new Date(T0))).toBeNull();

    await store.approve(id, null);
    await store.claim(id, "acct_1");
    expect(await store.findReusablePending("acct_1", "intent_1", new Date(T0))).toBeNull();
  });
});

describe("PrismaCredentialFetchApprovalStore", () => {
  // A hand-rolled double rather than a real DB: what matters is the WHERE
  // clause the store sends, because that clause is the fence.
  function fakePrisma(row: Record<string, unknown>) {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const prisma = {
      credentialFetchApproval: {
        async create() {
          return { id: String(row.id) };
        },
        async findFirst() {
          return row;
        },
        async updateMany(args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) {
          updates.push(args);
          // Understands the two Prisma operators the store actually sends:
          // `{ gt | lte }` on expires_at and `{ in }` on status.
          const matches = Object.entries(args.where).every(([key, value]) => {
            if (value !== null && typeof value === "object") {
              const clause = value as { gt?: Date; lte?: Date; in?: string[] };
              if (clause.gt !== undefined) return (row[key] as Date) > clause.gt;
              if (clause.lte !== undefined) return (row[key] as Date) <= clause.lte;
              if (clause.in !== undefined) return clause.in.includes(row[key] as string);
            }
            return row[key] === value;
          });
          if (!matches) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
    } as unknown as ApiPrismaClient;
    return { prisma, updates };
  }

  const baseRow = () => ({
    id: "fetch_1",
    account_id: "acct_1",
    credential_reference: "vault://acct_1/sub/cred",
    credential_service: "OpenAI",
    credential_label: "default",
    field: null,
    field_names: ["value"],
    nonce: "nonce_1",
    agent: "codex",
    requester_kind: "agent",
    intent_hash: "intent_1",
    status: "approved",
    failure_code: null,
    mandate_id: "mandate_1",
    created_at: new Date(T0),
    expires_at: new Date(T0 + 10 * 60 * 1000),
    approved_at: new Date(T0),
    delivered_at: null,
  });

  it("claims with a conditional update fenced on account, status, and expiry", async () => {
    const row = baseRow();
    const { prisma, updates } = fakePrisma(row);
    const store = new PrismaCredentialFetchApprovalStore(prisma, () => new Date(T0 + 1000));

    expect((await store.claim("fetch_1", "acct_1")).kind).toBe("claimed");
    expect(updates[0]!.where).toMatchObject({
      id: "fetch_1",
      account_id: "acct_1",
      status: "approved",
    });
    expect(updates[0]!.data).toMatchObject({ status: "consumed" });
    // The row is now consumed, so the same conditional update matches nothing.
    expect((await store.claim("fetch_1", "acct_1")).kind).toBe("already_consumed");
  });

  it("does not claim for another account", async () => {
    const { prisma } = fakePrisma(baseRow());
    const store = new PrismaCredentialFetchApprovalStore(prisma, () => new Date(T0 + 1000));
    // findFirst is scoped by account too, so a foreign id resolves to nothing.
    const foreign = new PrismaCredentialFetchApprovalStore(
      {
        credentialFetchApproval: {
          ...(prisma as unknown as { credentialFetchApproval: Record<string, unknown> })
            .credentialFetchApproval,
          async findFirst() {
            return null;
          },
        },
      } as unknown as ApiPrismaClient,
      () => new Date(T0 + 1000),
    );
    expect(await foreign.claim("fetch_1", "acct_2")).toEqual({ kind: "not_found" });
    expect((await store.claim("fetch_1", "acct_1")).kind).toBe("claimed");
  });

  it("reports an expired approved row as expired, not claimed", async () => {
    const { prisma } = fakePrisma(baseRow());
    const store = new PrismaCredentialFetchApprovalStore(
      prisma,
      () => new Date(T0 + 11 * 60 * 1000),
    );
    expect((await store.claim("fetch_1", "acct_1")).kind).toBe("expired");
  });

  it("settles a lapsed row with a conditional update, once", async () => {
    const row = baseRow();
    const { prisma, updates } = fakePrisma(row);
    const store = new PrismaCredentialFetchApprovalStore(prisma, () => new Date(T0));
    const lapsed = new Date(T0 + 11 * 60 * 1000);
    expect(await store.expire("fetch_1", lapsed)).toBe("expired");
    expect(updates[0]!.data).toMatchObject({ status: "failed", failure_code: "expired" });
    expect(await store.expire("fetch_1", lapsed)).toBe("already_terminal");
  });

  it("approves only a pending, unexpired row", async () => {
    const pending = { ...baseRow(), status: "pending", approved_at: null, mandate_id: null };
    const { prisma, updates } = fakePrisma(pending);
    const store = new PrismaCredentialFetchApprovalStore(prisma, () => new Date(T0 + 1000));
    expect(await store.approve("fetch_1", "mandate_9")).toBe("approved");
    expect(updates[0]!.where).toMatchObject({ id: "fetch_1", status: "pending" });
    expect(pending.mandate_id).toBe("mandate_9");
    expect(await store.approve("fetch_1", "mandate_9")).toBe("already_approved");
  });

  it("denies only a pending row", async () => {
    const pending = { ...baseRow(), status: "pending", approved_at: null, mandate_id: null };
    const { prisma } = fakePrisma(pending);
    const store = new PrismaCredentialFetchApprovalStore(prisma, () => new Date(T0 + 1000));
    expect(await store.deny("fetch_1")).toBe("denied");
    expect(pending.failure_code).toBe("denied_by_user");
    expect(await store.deny("fetch_1")).toBe("already_denied");

    const { prisma: approvedPrisma } = fakePrisma(baseRow());
    const approvedStore = new PrismaCredentialFetchApprovalStore(
      approvedPrisma,
      () => new Date(T0 + 1000),
    );
    expect(await approvedStore.deny("fetch_1")).toBe("not_pending");
  });
});
