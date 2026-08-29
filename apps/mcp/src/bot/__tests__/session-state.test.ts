import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEphemeralProfile,
  destroyEphemeralProfile,
  MAX_SESSION_STATE_BYTES,
  readSessionState,
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

});
