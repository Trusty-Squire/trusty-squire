import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEphemeralProfile,
  destroyEphemeralProfile,
  MAX_SESSION_STATE_BYTES,
  readSessionState,
  seedEphemeralIdentityFromCanonical,
  sessionStateHasGoogleIdentity,
  sessionStatePath,
  writeSessionState,
} from "../session-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator session storage state", () => {
  it("atomically preserves cookies, local storage, and IndexedDB in a 0600 snapshot", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "user_session",
          value: "opaque",
          domain: "github.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [
        {
          origin: "https://merchant.example",
          localStorage: [{ name: "token", value: "opaque" }],
          indexedDB: [{ name: "auth", version: 1, stores: [] }],
        },
      ],
    };

    await writeSessionState(canonical, state);

    await expect(readSessionState(canonical)).resolves.toEqual(state);
    expect(JSON.parse(readFileSync(sessionStatePath(canonical), "utf8"))).toEqual(state);
    expect(statSync(sessionStatePath(canonical)).mode & 0o777).toBe(0o600);
  });

  it("keeps the prior snapshot when terminal ownership is revoked before publish", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-revoked-"));
    roots.push(canonical);
    const cookie = {
      domain: ".google.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    };
    const prior = { cookies: [{ ...cookie, name: "SID", value: "prior" }], origins: [] };
    const replacement = {
      cookies: [{ ...cookie, name: "SID", value: "replacement" }],
      origins: [],
    };

    await writeSessionState(canonical, prior);
    await expect(writeSessionState(canonical, replacement, () => false)).resolves.toBe(false);

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
  });

  it("leaves one complete snapshot after concurrent last-writer-wins publishes", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-concurrent-"));
    roots.push(canonical);
    const first = { cookies: [], origins: [{ origin: "https://first.example", localStorage: [] }] };
    const second = {
      cookies: [],
      origins: [{ origin: "https://second.example", localStorage: [] }],
    };

    await Promise.all([writeSessionState(canonical, first), writeSessionState(canonical, second)]);

    expect([first, second]).toContainEqual(await readSessionState(canonical));
  });

  it("skips oversized snapshots and preserves the prior state", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-cap-"));
    roots.push(canonical);
    const prior = {
      cookies: [],
      origins: [{ origin: "https://prior.example", localStorage: [] }],
    };
    const oversized = {
      cookies: [],
      origins: [
        {
          origin: "https://oversized.example",
          localStorage: [{ name: "state", value: "x".repeat(MAX_SESSION_STATE_BYTES) }],
        },
      ],
    };
    await writeSessionState(canonical, prior);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(writeSessionState(canonical, oversized)).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("retaining prior snapshot"));
    } finally {
      error.mockRestore();
    }

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
  });

  it("creates distinct 0700 profiles and removes only the finished instance", async () => {
    const first = createEphemeralProfile();
    const second = createEphemeralProfile();
    try {
      expect(first).not.toBe(second);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      await destroyEphemeralProfile(first);
      expect(() => statSync(first)).toThrow();
      expect(statSync(second).isDirectory()).toBe(true);
    } finally {
      await destroyEphemeralProfile(second);
    }
  });

  it("seeds a legacy Google login into each private profile without copying site cookies", () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-legacy-"));
    const first = createEphemeralProfile();
    const second = createEphemeralProfile();
    roots.push(canonical, first, second);
    mkdirSync(join(canonical, "Default"), { recursive: true });
    writeFileSync(join(canonical, "Local State"), '{"os_crypt":{"encrypted_key":"opaque"}}');
    const source = new Database(join(canonical, "Default", "Cookies"));
    source.exec(
      "CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR); " +
        "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, encrypted_value BLOB); " +
        "CREATE UNIQUE INDEX cookies_unique ON cookies(host_key, name);",
    );
    source.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("version", "24");
    source
      .prepare("INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)")
      .run(".google.com", "SID", Buffer.from("google-session"));
    source
      .prepare("INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)")
      .run("merchant.example", "session", Buffer.from("merchant-session"));
    source.close();

    expect(seedEphemeralIdentityFromCanonical(canonical, first)).toBe(true);
    expect(seedEphemeralIdentityFromCanonical(canonical, second)).toBe(true);

    for (const destination of [first, second]) {
      expect(readFileSync(join(destination, "Local State"), "utf8")).toContain("encrypted_key");
      const cookies = new Database(join(destination, "Default", "Cookies"), {
        readonly: true,
      });
      expect(cookies.prepare("SELECT host_key, name FROM cookies").all()).toEqual([
        { host_key: ".google.com", name: "SID" },
      ]);
      cookies.close();
    }

    const untouchedSource = new Database(join(canonical, "Default", "Cookies"), {
      readonly: true,
    });
    expect(untouchedSource.prepare("SELECT count(*) AS count FROM cookies").get()).toEqual({
      count: 2,
    });
    untouchedSource.close();
  });

  it("distinguishes a usable Google snapshot from a blank partial snapshot", () => {
    expect(sessionStateHasGoogleIdentity({ cookies: [], origins: [] })).toBe(false);
    expect(
      sessionStateHasGoogleIdentity({
        cookies: [
          {
            name: "SID",
            value: "long-enough-google-session",
            domain: ".google.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    ).toBe(true);
  });
});
