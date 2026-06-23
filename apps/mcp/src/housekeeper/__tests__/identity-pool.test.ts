import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickUnspentIdentities,
  isSpent,
  remainingFreshVerifications,
  summarizeIdentityAvailability,
  loadIdentities,
  loadUsage,
  recordSpent,
  releaseIdentityLease,
  reserveIdentityForService,
  verifyPoolConfigured,
  type VerifyIdentity,
  type UsageRecord,
} from "../identity-pool.js";

const ID = (id: string, providers: ("google" | "github")[]): VerifyIdentity => ({
  id,
  email: `${id}@trustysquire.ai`,
  profileDir: `/p/${id}`,
  providers,
});

const POOL = [
  ID("verify-01", ["google"]),
  ID("verify-02", ["google"]),
  ID("verify-03", ["google", "github"]),
  ID("verify-04", ["github"]),
];

describe("pickUnspentIdentities", () => {
  it("returns google identities that haven't signed up at the service", () => {
    const picked = pickUnspentIdentities(POOL, [], "sentry", "google", 2);
    expect(picked.map((p) => p.id)).toEqual(["verify-01", "verify-02"]);
  });

  it("skips identities already spent at that service, in config order", () => {
    const usage: UsageRecord[] = [{ identityId: "verify-01", service: "sentry", at: "t" }];
    const picked = pickUnspentIdentities(POOL, usage, "sentry", "google", 2);
    expect(picked.map((p) => p.id)).toEqual(["verify-02", "verify-03"]);
  });

  it("filters by provider", () => {
    expect(pickUnspentIdentities(POOL, [], "x", "github", 9).map((p) => p.id)).toEqual([
      "verify-03",
      "verify-04",
    ]);
  });

  it("a spend at one service does not affect another", () => {
    const usage: UsageRecord[] = [{ identityId: "verify-01", service: "sentry", at: "t" }];
    expect(pickUnspentIdentities(POOL, usage, "neon", "google", 1).map((p) => p.id)).toEqual([
      "verify-01",
    ]);
  });

  it("caps at n and never returns negative", () => {
    expect(pickUnspentIdentities(POOL, [], "x", "google", 1)).toHaveLength(1);
    expect(pickUnspentIdentities(POOL, [], "x", "google", 0)).toHaveLength(0);
  });
});

describe("isSpent / remainingFreshVerifications", () => {
  it("isSpent matches the (identity, service) pair only", () => {
    const usage: UsageRecord[] = [{ identityId: "verify-01", service: "sentry", at: "t" }];
    expect(isSpent(usage, "verify-01", "sentry")).toBe(true);
    expect(isSpent(usage, "verify-01", "neon")).toBe(false);
    expect(isSpent(usage, "verify-02", "sentry")).toBe(false);
  });

  it("counts how many 2-of-N rounds remain for a service", () => {
    // 3 google identities, agreement 2 → 1 full round
    expect(remainingFreshVerifications(POOL, [], "sentry", "google", 2)).toBe(1);
    const usage: UsageRecord[] = [{ identityId: "verify-01", service: "sentry", at: "t" }];
    // 2 google left, agreement 2 → still 1
    expect(remainingFreshVerifications(POOL, usage, "sentry", "google", 2)).toBe(1);
  });
});

describe("notebook I/O (temp dir)", () => {
  let dir: string;
  const SAVED = process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "idpool-"));
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = dir;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR;
    else process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = SAVED;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadIdentities is empty + verifyPoolConfigured false when no file", () => {
    expect(loadIdentities()).toEqual([]);
    expect(verifyPoolConfigured()).toBe(false);
  });

  it("loads a configured pool and expands ~ in profileDir", () => {
    writeFileSync(
      join(dir, "verify-identities.json"),
      JSON.stringify({
        identities: [{ id: "verify-01", email: "verify-01@trustysquire.ai", profileDir: "~/p/v01", providers: ["google"] }],
      }),
    );
    const ids = loadIdentities();
    expect(ids).toHaveLength(1);
    expect(verifyPoolConfigured()).toBe(true);
    expect(ids[0]!.profileDir.startsWith("~/")).toBe(false); // expanded
  });

  it("recordSpent persists and is idempotent", () => {
    recordSpent("verify-01", "sentry", "2026-06-13T00:00:00Z");
    recordSpent("verify-01", "sentry", "2026-06-13T01:00:00Z"); // dup ignored
    const usage = loadUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ identityId: "verify-01", service: "sentry" });
    const onDisk = JSON.parse(readFileSync(join(dir, "identity-usage.json"), "utf8"));
    expect(onDisk.spent).toHaveLength(1);
  });

  it("loadUsage preserves spent pairs from backup ledgers", () => {
    writeFileSync(
      join(dir, "identity-usage.json"),
      JSON.stringify({
        spent: [{ identityId: "verify-02", service: "sentry", at: "new" }],
      }),
    );
    writeFileSync(
      join(dir, "identity-usage.json.bak-1"),
      JSON.stringify({
        spent: [
          { identityId: "verify-01", service: "sentry", at: "old" },
          { identityId: "verify-02", service: "sentry", at: "older-duplicate" },
        ],
      }),
    );

    const usage = loadUsage();
    expect(usage.map((u) => `${u.identityId}:${u.service}`).sort()).toEqual([
      "verify-01:sentry",
      "verify-02:sentry",
    ]);
    expect(pickUnspentIdentities(POOL, usage, "sentry", "google", 3).map((p) => p.id)).toEqual([
      "verify-03",
    ]);
  });

  it("reserves identities in a file-backed lease table and excludes active leases", () => {
    writeFileSync(
      join(dir, "verify-identities.json"),
      JSON.stringify({
        identities: [
          { id: "verify-01", email: "verify-01@trustysquire.ai", profileDir: "/p/1", providers: ["google"] },
          { id: "verify-02", email: "verify-02@trustysquire.ai", profileDir: "/p/2", providers: ["google"] },
        ],
      }),
    );

    const first = reserveIdentityForService({
      service: "ipinfo",
      provider: "google",
      runId: "run-1",
    });
    const second = reserveIdentityForService({
      service: "instant-db",
      provider: "google",
      runId: "run-2",
    });
    const third = reserveIdentityForService({
      service: "langfuse",
      provider: "google",
      runId: "run-3",
    });

    expect(first?.id).toBe("verify-01");
    expect(second?.id).toBe("verify-02");
    expect(third).toBeNull();

    releaseIdentityLease("run-1");
    const fourth = reserveIdentityForService({
      service: "langfuse",
      provider: "google",
      runId: "run-4",
    });
    expect(fourth?.id).toBe("verify-01");
  });

  it("does not reserve an identity already spent at that service", () => {
    writeFileSync(
      join(dir, "verify-identities.json"),
      JSON.stringify({
        identities: [
          { id: "verify-01", email: "verify-01@trustysquire.ai", profileDir: "/p/1", providers: ["google"] },
          { id: "verify-02", email: "verify-02@trustysquire.ai", profileDir: "/p/2", providers: ["google"] },
        ],
      }),
    );
    recordSpent("verify-01", "ipinfo", "2026-06-19T00:00:00Z");

    const picked = reserveIdentityForService({
      service: "ipinfo",
      provider: "google",
      runId: "run-spent",
    });

    expect(picked?.id).toBe("verify-02");
  });

  it("summarizes service-specific availability from spent records", () => {
    writeFileSync(
      join(dir, "verify-identities.json"),
      JSON.stringify({
        identities: [
          { id: "verify-01", email: "verify-01@trustysquire.ai", profileDir: "/p/1", providers: ["google"] },
          { id: "verify-02", email: "verify-02@trustysquire.ai", profileDir: "/p/2", providers: ["google"] },
        ],
      }),
    );
    recordSpent("verify-01", "instant-db", "2026-06-19T00:00:00Z");
    recordSpent("verify-02", "instant-db", "2026-06-19T01:00:00Z");
    recordSpent("verify-01", "arize", "2026-06-19T02:00:00Z");

    expect(summarizeIdentityAvailability(["instant-db", "arize"], "google")).toMatchObject([
      { service: "instant-db", total: 2, unspent: 0, available: 0 },
      { service: "arize", total: 2, unspent: 1, available: 1 },
    ]);
  });
});
