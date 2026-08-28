import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEphemeralProfile,
  destroyEphemeralProfile,
  readSessionState,
  sessionStatePath,
  writeSessionState,
} from "../session-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator session storage state", () => {
  it("atomically preserves cookies, local storage, and IndexedDB in a 0600 snapshot", () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-"));
    roots.push(canonical);
    const state = {
      cookies: [{ name: "user_session", value: "opaque", domain: "github.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }],
      origins: [{ origin: "https://merchant.example", localStorage: [{ name: "token", value: "opaque" }], indexedDB: [{ name: "auth", version: 1, stores: [] }] }],
    };

    writeSessionState(canonical, state);

    expect(readSessionState(canonical)).toEqual(state);
    expect(JSON.parse(readFileSync(sessionStatePath(canonical), "utf8"))).toEqual(state);
    expect(statSync(sessionStatePath(canonical)).mode & 0o777).toBe(0o600);
  });

  it("creates distinct 0700 profiles and removes only the finished instance", () => {
    const first = createEphemeralProfile();
    const second = createEphemeralProfile();
    try {
      expect(first).not.toBe(second);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      destroyEphemeralProfile(first);
      expect(() => statSync(first)).toThrow();
      expect(statSync(second).isDirectory()).toBe(true);
    } finally {
      destroyEphemeralProfile(second);
    }
  });
});
