import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOperatorProfile,
  operatorProfilePoolTest,
  publishOperatorProfileSeed,
} from "../operator-profile-pool.js";

const roots: string[] = [];

function fixture(): { root: string; source: string } {
  const base = mkdtempSync(join(tmpdir(), "operator-profile-pool-test-"));
  roots.push(base);
  const source = join(base, "source");
  const root = join(base, "pool");
  mkdirSync(join(source, "Default", "Cache"), { recursive: true });
  writeFileSync(join(source, "Default", "Cookies"), "session-cookie");
  writeFileSync(join(source, "Default", "Cache", "discard"), "cache");
  writeFileSync(join(source, "SingletonLock"), "stale");
  return { root, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator profile pool migration stage", () => {
  it("publishes a complete immutable seed and deterministically GCs the old generation", async () => {
    const { root, source } = fixture();
    const first = await publishOperatorProfileSeed(source, { rootDir: root });
    const p = operatorProfilePoolTest.paths(root);
    expect(
      readFileSync(join(p.generations, first, "user-data", "Default", "Cookies"), "utf8"),
    ).toBe("session-cookie");
    expect(() => readFileSync(join(p.generations, first, "user-data", "SingletonLock"))).toThrow();
    expect(() =>
      readFileSync(join(p.generations, first, "user-data", "Default", "Cache", "discard")),
    ).toThrow();

    writeFileSync(join(source, "Default", "Cookies"), "new-session-cookie");
    const second = await publishOperatorProfileSeed(source, { rootDir: root });
    expect(second).not.toBe(first);
    expect(readdirSync(p.generations)).toEqual([second]);
    expect(operatorProfilePoolTest.currentGeneration(p)).toBe(second);
  });

  it("admits one active lease and never launches from the login-authoring profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(first.profileDir).not.toBe(source);
    expect(readFileSync(join(first.profileDir, "Default", "Cookies"), "utf8")).toBe(
      "session-cookie",
    );
    await expect(
      acquireOperatorProfile("session-b", { rootDir: root, sourceProfileDir: source }),
    ).rejects.toThrow("capacity reached");
    await first.destroy();
  });

  it("atomically returns one closed profile warm and reclaims that exact profile", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const profileId = first.profileId;
    await first.returnWarm();

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
    await publishOperatorProfileSeed(source, { rootDir: root });
    const first = await acquireOperatorProfile("session-a", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const staleProfile = first.profileDir;
    await first.returnWarm();
    writeFileSync(join(source, "Default", "Cookies"), "replacement");
    await publishOperatorProfileSeed(source, { rootDir: root });

    const second = await acquireOperatorProfile("session-b", {
      rootDir: root,
      sourceProfileDir: source,
    });
    expect(second.profileDir).not.toBe(staleProfile);
    expect(readFileSync(join(second.profileDir, "Default", "Cookies"), "utf8")).toBe("replacement");
    await second.destroy();
  });

  it("quarantines a dead active owner before reclaiming its profile and slot", async () => {
    const { root, source } = fixture();
    await publishOperatorProfileSeed(source, { rootDir: root });
    const abandoned = await acquireOperatorProfile("session-dead", {
      rootDir: root,
      sourceProfileDir: source,
    });
    const p = operatorProfilePoolTest.paths(root);
    writeFileSync(
      join(p.active, "slot-0", "owner.json"),
      `${JSON.stringify({
        host: (await import("node:os")).hostname(),
        pid: 2_000_000_000,
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
    expect(readdirSync(p.tombstones)).toEqual([]);
    await replacement.destroy();
  });
});
