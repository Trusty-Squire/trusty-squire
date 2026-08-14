import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireOperatorProfile,
  canPublishOperatorProfileSeed,
  operatorProfilePoolTest,
  OPERATOR_SEED_GOOGLE_COOKIE_NAMES,
  publishOperatorProfileSeed as publishOperatorProfileSeedRaw,
} from "../operator-profile-pool.js";
import { profilePathIdentity } from "../profile.js";

const roots: string[] = [];
const verifiedLoginProof = {
  loginStatus: "completed",
  closeState: "closed",
  provider: "google",
} as const;

function publishOperatorProfileSeed(
  sourceProfileDir: string,
  opts: Omit<Parameters<typeof publishOperatorProfileSeedRaw>[1], "validateGoogleIdentity"> & {
    validateGoogleIdentity?: (profileDir: string) => Promise<boolean>;
  },
): ReturnType<typeof publishOperatorProfileSeedRaw> {
  return publishOperatorProfileSeedRaw(sourceProfileDir, {
    ...opts,
    validateGoogleIdentity: opts.validateGoogleIdentity ?? (() => Promise.resolve(true)),
  });
}

function writeCookies(
  source: string,
  rows: Array<{ host: string; name: string; value: string }>,
): void {
  const path = join(source, "Default", "Cookies");
  mkdirSync(join(source, "Default"), { recursive: true });
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec(
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("version", "24");
  const insert = db.prepare("INSERT INTO cookies (host_key, name, value) VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.host, row.name, row.value);
  db.close();
}

function cookieValues(profileDir: string): string[] {
  const db = new Database(join(profileDir, "Default", "Cookies"), { readonly: true });
  const values = db
    .prepare("SELECT value FROM cookies ORDER BY value")
    .all()
    .map((row) => (row as { value: string }).value);
  db.close();
  return values;
}

function fixture(): { root: string; source: string } {
  const base = mkdtempSync(join(tmpdir(), "operator-profile-pool-test-"));
  roots.push(base);
  const source = join(base, "source");
  const root = join(base, "pool");
  mkdirSync(join(source, "Default", "Cache"), { recursive: true });
  writeCookies(source, [
    { host: ".google.com", name: "SID", value: "identity-cookie" },
    ...OPERATOR_SEED_GOOGLE_COOKIE_NAMES.filter((name) => name !== "SID").map((name) => ({
      host: ".google.com",
      name,
      value: `identity-${name}`,
    })),
    { host: ".google.com", name: "payment_approval", value: "google-payment-cookie" },
    { host: "checkout.example.com", name: "approval", value: "payment-approval-cookie" },
  ]);
  writeFileSync(join(source, "Local State"), "identity-key-state");
  writeFileSync(
    join(source, "provider-emails.json"),
    JSON.stringify({ google: "worker@example.com" }),
  );
  writeFileSync(join(source, "Default", "Web Data"), "saved-card-number");
  mkdirSync(join(source, "Default", "Local Storage"), { recursive: true });
  writeFileSync(join(source, "Default", "Local Storage", "payment"), "approval-token");
  writeFileSync(join(source, "Default", "Cache", "discard"), "cache");
  writeFileSync(join(source, "SingletonLock"), "stale");
  return { root, source };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  operatorProfilePoolTest.resetDefaultPool();
});

describe("operator profile pool migration stage", () => {
  it("shares publication and active capacity across source-profile aliases", async () => {
    const { source } = fixture();
    const alias = `${source}-alias`;
    symlinkSync(source, alias, "dir");
    const generation = await publishOperatorProfileSeed(alias, { proof: verifiedLoginProof });
    const first = await acquireOperatorProfile("real-source", { sourceProfileDir: source });
    try {
      expect(first.seedGeneration).toBe(generation);
      await expect(
        acquireOperatorProfile("alias-source", { sourceProfileDir: alias }),
      ).rejects.toThrow("capacity reached");
    } finally {
      await first.destroy();
    }
  });

  it("publishes seed-lock ownership atomically as persisted state", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, {
      rootDir: root,
      proof: verifiedLoginProof,
    });
    const p = operatorProfilePoolTest.paths(root);

    await operatorProfilePoolTest.withSeedLock(p, () => {
      expect(lstatSync(p.seedLock).isFile()).toBe(true);
      const owner = JSON.parse(readFileSync(p.seedLock, "utf8")) as {
        pid: number;
        token: string;
      };
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/);
    });

    expect(existsSync(p.seedLock)).toBe(false);
  });

  it("publishes an identity-only immutable seed and deterministically GCs the old generation", async () => {
    const { root, source } = fixture();
    const first = await publishOperatorProfileSeed(source, {
      rootDir: root,
      proof: verifiedLoginProof,
    });
    const p = operatorProfilePoolTest.paths(root);
    const firstSeed = join(p.generations, first, "user-data");
    expect(cookieValues(firstSeed)).toEqual(
      OPERATOR_SEED_GOOGLE_COOKIE_NAMES.map((name) =>
        name === "SID" ? "identity-cookie" : `identity-${name}`,
      ).sort(),
    );
    const cookieBytes = readFileSync(join(firstSeed, "Default", "Cookies"));
    expect(cookieBytes.includes(Buffer.from("google-payment-cookie"))).toBe(false);
    expect(cookieBytes.includes(Buffer.from("payment-approval-cookie"))).toBe(false);
    expect(readFileSync(join(firstSeed, "Local State"), "utf8")).toBe("identity-key-state");
    expect(readFileSync(join(firstSeed, "provider-emails.json"), "utf8")).toContain(
      "worker@example.com",
    );
    expect(existsSync(join(firstSeed, "Default", "Web Data"))).toBe(false);
    expect(existsSync(join(firstSeed, "Default", "Local Storage"))).toBe(false);
    expect(() => readFileSync(join(p.generations, first, "user-data", "SingletonLock"))).toThrow();
    expect(() =>
      readFileSync(join(p.generations, first, "user-data", "Default", "Cache", "discard")),
    ).toThrow();

    writeCookies(source, [{ host: ".google.com", name: "SID", value: "new-identity-cookie" }]);
    const second = await publishOperatorProfileSeed(source, {
      rootDir: root,
      proof: verifiedLoginProof,
    });
    expect(second).not.toBe(first);
    expect(readdirSync(p.generations)).toEqual([second]);
    expect(operatorProfilePoolTest.currentGeneration(p)).toBe(second);
  });

  it("keeps the current seed when observable Google validation fails", async () => {
    const { root, source } = fixture();
    const first = await publishOperatorProfileSeed(source, {
      rootDir: root,
      proof: verifiedLoginProof,
    });
    const p = operatorProfilePoolTest.paths(root);
    writeCookies(source, [{ host: ".google.com", name: "SID", value: "replacement" }]);

    await expect(
      publishOperatorProfileSeed(source, {
        rootDir: root,
        proof: verifiedLoginProof,
        validateGoogleIdentity: async (profileDir) => {
          expect(profileDir).not.toBe(source);
          expect(cookieValues(profileDir)).toEqual(["replacement"]);
          return false;
        },
      }),
    ).rejects.toThrow("failed Google identity validation");

    expect(operatorProfilePoolTest.currentGeneration(p)).toBe(first);
    expect(readdirSync(p.generations)).toEqual([first]);
    expect(readdirSync(p.tombstones)).toEqual([]);
  });

  it("admits one active lease and never launches from the login-authoring profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(first.profileDir).not.toBe(source);
    expect(cookieValues(first.profileDir)).toEqual(
      OPERATOR_SEED_GOOGLE_COOKIE_NAMES.map((name) =>
        name === "SID" ? "identity-cookie" : `identity-${name}`,
      ).sort(),
    );
    expect(existsSync(join(first.profileDir, "Default", "Web Data"))).toBe(false);
    await expect(
      acquireOperatorProfile("session-b", { rootDir: root, sourceProfileDir: source }),
    ).rejects.toThrow("capacity reached");
    await first.destroy();
  });

  it("publishes a complete active owner without an ownerless public window", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const p = operatorProfilePoolTest.paths(root);
    let winner: ReturnType<typeof operatorProfilePoolTest.reserveActiveSlot> = null;

    const loser = operatorProfilePoolTest.reserveActiveSlot(p, 0, "loser", () => {
      winner = operatorProfilePoolTest.reserveActiveSlot(p, 0, "winner");
    });

    expect(loser).toBeNull();
    expect(winner).not.toBeNull();
    const owner = JSON.parse(readFileSync(join(p.active, "slot-0", "owner.json"), "utf8")) as {
      session_id: string;
      token: string;
    };
    expect(owner.session_id).toBe("winner");
    expect(owner.token).toBe(winner!.ownerToken);
    expect(readdirSync(p.activeClaims)).toHaveLength(1);
  });

  it("revisits quarantined active profiles until exact worker closure", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const lease = await acquireOperatorProfile("crashed-session", {
      rootDir: root,
      sourceProfileDir: source,
    });
    lease.bindWorker({
      host: hostname(),
      pid: process.pid,
      start_time: "worker-birth",
      user_data_dir: profilePathIdentity(lease.profileDir),
    });
    const p = operatorProfilePoolTest.paths(root);
    const slot = join(p.active, "slot-0");
    const owner = JSON.parse(readFileSync(join(slot, "owner.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(slot, "owner.json"),
      `${JSON.stringify({ ...owner, start_time: "stale-owner" })}\n`,
    );
    const tombstone = join(p.tombstones, "active-0-test");
    renameSync(slot, tombstone);
    const signalWorker = vi.fn(() => true);

    operatorProfilePoolTest.scavengeQuarantinedActive(p, () => "matching", signalWorker);
    expect(signalWorker).toHaveBeenCalledOnce();
    expect(existsSync(lease.profileDir)).toBe(true);
    expect(existsSync(tombstone)).toBe(true);

    operatorProfilePoolTest.scavengeQuarantinedActive(p, () => "stale", signalWorker);
    expect(existsSync(lease.profileDir)).toBe(false);
    expect(existsSync(tombstone)).toBe(false);
    expect(readdirSync(p.activeClaims)).toEqual([]);
  });

  it("binds a canonical worker identity through a symlinked pool root", async () => {
    const { root, source } = fixture();
    mkdirSync(root);
    const alias = `${root}-alias`;
    symlinkSync(root, alias, "dir");
    await publishOperatorProfileSeed(source, { rootDir: alias, proof: verifiedLoginProof });
    const lease = await acquireOperatorProfile("symlinked-pool", {
      rootDir: alias,
      sourceProfileDir: source,
    });
    expect(() =>
      lease.bindWorker({
        host: hostname(),
        pid: process.pid,
        start_time: "test-birth",
        user_data_dir: profilePathIdentity(lease.profileDir),
      }),
    ).not.toThrow();
    await lease.destroy();
  });

  it("retains destroy-required disposition until worker closure is proven", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const lease = await acquireOperatorProfile("payment-profile", {
      rootDir: root,
      sourceProfileDir: source,
    });
    lease.bindWorker({
      host: hostname(),
      pid: process.pid,
      start_time: "test-birth",
      user_data_dir: profilePathIdentity(lease.profileDir),
    });
    const p = operatorProfilePoolTest.paths(root);
    await lease.retain(true);
    const tombstone = readdirSync(p.tombstones).find((entry) =>
      entry.startsWith("destroy-required-"),
    );
    expect(tombstone).toBeDefined();
    const descriptor = JSON.parse(
      readFileSync(join(p.tombstones, tombstone!, "claim", "lease.json"), "utf8"),
    ) as { disposition?: string };
    expect(descriptor.disposition).toBe("destroy_required");

    const signalWorker = vi.fn(() => true);
    operatorProfilePoolTest.scavengeDestroyRequired(p, () => "matching", signalWorker);
    expect(signalWorker).toHaveBeenCalledOnce();
    expect(existsSync(lease.profileDir)).toBe(true);
    expect(existsSync(join(p.tombstones, tombstone!))).toBe(true);

    operatorProfilePoolTest.scavengeDestroyRequired(p, () => "stale", signalWorker);
    expect(existsSync(lease.profileDir)).toBe(false);
    expect(existsSync(join(p.tombstones, tombstone!))).toBe(false);
  });

  it("leaves failed payment-profile deletion on the destroy-required scavenger path", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const lease = await acquireOperatorProfile("payment-delete-failure", {
      rootDir: root,
      sourceProfileDir: source,
    });
    lease.bindWorker({
      host: hostname(),
      pid: process.pid,
      start_time: "test-birth",
      user_data_dir: profilePathIdentity(lease.profileDir),
    });
    const p = operatorProfilePoolTest.paths(root);
    const profileRoot = dirname(lease.profileDir);

    chmodSync(profileRoot, 0o000);
    try {
      await expect(lease.destroy()).rejects.toThrow();
    } finally {
      chmodSync(profileRoot, 0o700);
    }

    const tombstone = readdirSync(p.tombstones).find((entry) =>
      entry.startsWith("destroy-required-"),
    );
    expect(tombstone).toBeDefined();
    const descriptor = JSON.parse(
      readFileSync(join(p.tombstones, tombstone!, "claim", "lease.json"), "utf8"),
    ) as { disposition?: string };
    expect(descriptor.disposition).toBe("destroy_required");
    expect(existsSync(lease.profileDir)).toBe(true);

    operatorProfilePoolTest.scavengeDestroyRequired(p, () => "stale", vi.fn());
    expect(existsSync(lease.profileDir)).toBe(false);
    expect(existsSync(join(p.tombstones, tombstone!))).toBe(false);
  });

  it("atomically returns one closed profile warm and reclaims that exact profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const profileId = first.profileId;
    await first.returnWarm("closed");

    const second = await acquireOperatorProfile("session-b", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(second.profileId).toBe(profileId);
    expect(second.profileDir).toBe(first.profileDir);
    await second.destroy();
  });

  it("invalidates a warm profile when login publishes a new seed generation", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const staleProfile = first.profileDir;
    await first.returnWarm("closed");
    writeCookies(source, [{ host: ".google.com", name: "SID", value: "replacement" }]);
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });

    const second = await acquireOperatorProfile("session-b", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(second.profileDir).not.toBe(staleProfile);
    expect(cookieValues(second.profileDir)).toEqual(["replacement"]);
    await second.destroy();
  });

  it("isolates default namespaces for distinct source profiles", async () => {
    const firstFixture = fixture();
    const secondFixture = fixture();
    writeFileSync(
      join(secondFixture.source, "provider-emails.json"),
      JSON.stringify({ google: "second@example.com" }),
    );
    await publishOperatorProfileSeed(firstFixture.source, { proof: verifiedLoginProof });
    await publishOperatorProfileSeed(secondFixture.source, { proof: verifiedLoginProof });

    const first = await acquireOperatorProfile("source-a", {
      sourceProfileDir: firstFixture.source,
    });
    expect(readFileSync(join(first.profileDir, "provider-emails.json"), "utf8")).toContain(
      "worker@example.com",
    );
    await first.destroy();

    const second = await acquireOperatorProfile("source-b", {
      sourceProfileDir: secondFixture.source,
    });
    expect(second.profileDir).not.toBe(first.profileDir);
    expect(readFileSync(join(second.profileDir, "provider-emails.json"), "utf8")).toContain(
      "second@example.com",
    );
    await second.destroy();
  });

  it("retains an unbound dead lease while atomically freeing its active slot", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const abandoned = await acquireOperatorProfile("session-dead", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const p = operatorProfilePoolTest.paths(root);
    writeFileSync(
      join(p.active, "slot-0", "owner.json"),
      `${JSON.stringify({
        host: (await import("node:os")).hostname(),
        pid: process.pid,
        start_time: "gone",
        token: "dead-token",
        session_id: "session-dead",
      })}\n`,
      { mode: 0o600 },
    );

    let pendingReplacement: ReturnType<typeof acquireOperatorProfile> | undefined;
    await operatorProfilePoolTest.withSeedLock(p, async () => {
      pendingReplacement = acquireOperatorProfile("session-new", {
        rootDir: root,
        sourceProfileDir: source,
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      const owner = JSON.parse(readFileSync(join(p.active, "slot-0", "owner.json"), "utf8")) as {
        session_id: string;
      };
      expect(owner.session_id).toBe("session-dead");
      expect(readdirSync(p.tombstones)).toEqual([]);
    });
    const replacement = await pendingReplacement!;
    expect(replacement.profileId).not.toBe(abandoned.profileId);
    expect(readdirSync(p.tombstones)).toHaveLength(1);
    expect(existsSync(abandoned.profileDir)).toBe(true);
    await replacement.destroy();
  });

  it("retains an active owner when its birth identity is unknown", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof });
    const active = await acquireOperatorProfile("session-unknown", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const p = operatorProfilePoolTest.paths(root);
    writeFileSync(
      join(p.active, "slot-0", "owner.json"),
      `${JSON.stringify({
        host: (await import("node:os")).hostname(),
        pid: process.pid,
        start_time: "unknown",
        token: "unknown-token",
        session_id: "session-unknown",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      acquireOperatorProfile("session-new", { rootDir: root, sourceProfileDir: source }),
    ).rejects.toThrow("capacity reached");
    expect(readdirSync(p.tombstones)).toEqual([]);
    expect(existsSync(active.profileDir)).toBe(true);
  });

  it("acquires an empty isolated profile without publishing canonical state", async () => {
    const { root, source } = fixture();
    const lease = await acquireOperatorProfile("session-cold", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const p = operatorProfilePoolTest.paths(root);

    expect(operatorProfilePoolTest.currentGeneration(p)).toBeNull();
    expect(lease.seedGeneration).toBe("unpublished");
    expect(readdirSync(lease.profileDir)).toEqual([]);
    expect(existsSync(join(lease.profileDir, "provider-emails.json"))).toBe(false);
    await lease.returnWarm("closed");
    expect(existsSync(lease.profileDir)).toBe(false);
  });

  it("refuses seed publication where process closure cannot be proven", async () => {
    const { root, source } = fixture();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    expect(canPublishOperatorProfileSeed(verifiedLoginProof, "darwin")).toBe(false);
    await expect(
      publishOperatorProfileSeed(source, { rootDir: root, proof: verifiedLoginProof }),
    ).rejects.toThrow("requires explicit completed Google login provenance");
    expect(existsSync(join(root, "seed"))).toBe(false);
  });

  it.each([
    { loginStatus: "completed", closeState: "force_closed_unproven", provider: "google" },
    { loginStatus: "completed", closeState: "unknown", provider: "google" },
    { loginStatus: "preflight_satisfied", closeState: "closed", provider: "google" },
    { loginStatus: "timeout", closeState: "closed", provider: "google" },
    { loginStatus: "completed", closeState: "closed", provider: "github" },
    { loginStatus: "completed", closeState: "closed", provider: null },
  ] as const)("refuses seed publication without completed-login closure proof", async (proof) => {
    const { root, source } = fixture();
    expect(canPublishOperatorProfileSeed(proof, "linux")).toBe(false);
    await expect(publishOperatorProfileSeed(source, { rootDir: root, proof })).rejects.toThrow(
      "requires explicit completed Google login provenance",
    );
    expect(existsSync(join(root, "seed"))).toBe(false);
  });
});
