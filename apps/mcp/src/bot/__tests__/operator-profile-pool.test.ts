import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireOperatorProfile,
  operatorProfilePoolTest,
  publishOperatorProfileSeed,
} from "../operator-profile-pool.js";

const roots: string[] = [];

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
  it("publishes an identity-only immutable seed and deterministically GCs the old generation", async () => {
    const { root, source } = fixture();
    const first = await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
    const p = operatorProfilePoolTest.paths(root);
    const firstSeed = join(p.generations, first, "user-data");
    expect(cookieValues(firstSeed)).toEqual(["identity-cookie"]);
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

    writeCookies(source, [
      { host: ".google.com", name: "SID", value: "new-identity-cookie" },
    ]);
    const second = await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
    expect(second).not.toBe(first);
    expect(readdirSync(p.generations)).toEqual([second]);
    expect(operatorProfilePoolTest.currentGeneration(p)).toBe(second);
  });

  it("admits one active lease and never launches from the login-authoring profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(first.profileDir).not.toBe(source);
    expect(cookieValues(first.profileDir)).toEqual(["identity-cookie"]);
    expect(existsSync(join(first.profileDir, "Default", "Web Data"))).toBe(false);
    await expect(
      acquireOperatorProfile("session-b", { rootDir: root, sourceProfileDir: source }),
    ).rejects.toThrow("capacity reached");
    await first.destroy();
  });

  it("atomically returns one closed profile warm and reclaims that exact profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
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
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const staleProfile = first.profileDir;
    await first.returnWarm("closed");
    writeCookies(source, [{ host: ".google.com", name: "SID", value: "replacement" }]);
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });

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
    await publishOperatorProfileSeed(firstFixture.source, { closeState: "closed" });
    await publishOperatorProfileSeed(secondFixture.source, { closeState: "closed" });

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
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
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

    const replacement = await acquireOperatorProfile("session-new", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(replacement.profileId).not.toBe(abandoned.profileId);
    expect(readdirSync(p.tombstones)).toHaveLength(1);
    expect(existsSync(abandoned.profileDir)).toBe(true);
    await replacement.destroy();
  });

  it("retains an active owner when its birth identity is unknown", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" });
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

  it("refuses seed publication where process closure cannot be proven", async () => {
    const { root, source } = fixture();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await expect(
      publishOperatorProfileSeed(source, { rootDir: root, closeState: "closed" }),
    ).rejects.toThrow(
      "operator profile seed publication requires Linux process identity",
    );
    expect(existsSync(join(root, "seed"))).toBe(false);
  });

  it.each(["force_closed_unproven", "unknown"] as const)(
    "refuses seed publication after %s teardown",
    async (closeState) => {
      const { root, source } = fixture();
      await expect(
        publishOperatorProfileSeed(source, { rootDir: root, closeState }),
      ).rejects.toThrow("operator profile seed publication requires verified Chrome closure");
      expect(existsSync(join(root, "seed"))).toBe(false);
    },
  );
});
