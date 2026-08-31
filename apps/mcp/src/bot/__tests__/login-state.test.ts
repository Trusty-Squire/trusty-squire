// Tests for the OAuth login-state marker — the signup bot reads this
// to decide which providers it can auto-prefer for OAuth-first signup.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderCookies,
  clearProviderCookiesFromContext,
  clearBrowserProfile,
  loggedInProviders,
  markProviderLoggedIn,
  loggedInEmail,
  recordProviderEmail,
} from "../login-state.js";
import { acquireProfileOperationGuard, ProfileBusyError } from "../profile.js";
import { SESSION_STATE_FILE } from "../session-state.js";

describe("full profile clearing", () => {
  it("preserves the canonical snapshot and an in-flight snapshot temporary", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-profile-clear-"));
    const snapshot = join(dir, SESSION_STATE_FILE);
    const temporary = join(dir, `${SESSION_STATE_FILE}.123.writer.tmp`);
    const stale = join(dir, "Default");
    writeFileSync(snapshot, "prior");
    writeFileSync(temporary, "replacement");
    writeFileSync(stale, "chrome-state");
    try {
      clearBrowserProfile(dir);
      expect(readFileSync(snapshot, "utf8")).toBe("prior");
      expect(readFileSync(temporary, "utf8")).toBe("replacement");
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider cookie clearing", () => {
  it("removes and verifies only the requested provider's actual cookie rows", async () => {
    let cookies = [
      { name: "SAPISID", domain: ".google.com", path: "/" },
      { name: "user_session", domain: "github.com", path: "/" },
      { name: "app", domain: "trustysquire.ai", path: "/" },
    ];
    const context = {
      cookies: async () => cookies,
      clearCookies: async (target: { name: string; domain: string; path: string }) => {
        cookies = cookies.filter(
          (cookie) =>
            cookie.name !== target.name ||
            cookie.domain !== target.domain ||
            cookie.path !== target.path,
        );
      },
      close: async () => undefined,
    };

    await expect(clearProviderCookiesFromContext(context, "github")).resolves.toBe(true);
    expect(cookies).toEqual([
      { name: "SAPISID", domain: ".google.com", path: "/" },
      { name: "app", domain: "trustysquire.ai", path: "/" },
    ]);
  });

  it("fails closed when the requested provider cookie remains", async () => {
    const cookies = [{ name: "user_session", domain: ".github.com", path: "/" }];
    const context = {
      cookies: async () => cookies,
      clearCookies: async () => undefined,
      close: async () => undefined,
    };

    await expect(clearProviderCookiesFromContext(context, "github")).resolves.toBe(false);
  });

  it("tears down cookie-clear launch custody at the terminal boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-state-lifecycle-"));
    const marker = "v1:1:cookie-clear";
    const events: string[] = [];
    let cookies = [{ name: "user_session", domain: "github.com", path: "/" }];
    const context = {
      cookies: async () => cookies,
      clearCookies: async () => {
        cookies = [];
      },
      close: async () => {
        events.push("close");
      },
    };
    try {
      await expect(
        clearProviderCookies(dir, "github", {
          loadChromium: async () => ({
            launchPersistentContext: async () => context,
          }),
          registerLaunch: () => ({ marker, env: {} }),
          bindLaunch: () => {
            events.push("bind");
            return true;
          },
          markTerminal: () => {
            events.push("terminal");
          },
          terminate: async () => {
            events.push("terminate");
            return true;
          },
          untrack: () => {
            events.push("untrack");
          },
        }),
      ).resolves.toBe(true);
      expect(events).toEqual(["bind", "terminal", "close", "terminate", "untrack"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaps and releases launch custody when cookie-clear launch rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-state-launch-failure-"));
    const marker = "v1:1:cookie-clear-failure";
    const markTerminal = vi.fn();
    const terminate = vi.fn(async () => true);
    const untrack = vi.fn();
    try {
      await expect(
        clearProviderCookies(dir, "github", {
          loadChromium: async () => ({
            launchPersistentContext: async () => {
              throw new Error("launch rejected");
            },
          }),
          registerLaunch: () => ({ marker, env: {} }),
          bindLaunch: () => true,
          markTerminal,
          terminate,
          untrack,
        }),
      ).resolves.toBe(false);
      expect(markTerminal).toHaveBeenCalledWith(marker);
      expect(terminate).toHaveBeenCalledWith(marker, dir);
      expect(untrack).toHaveBeenCalledWith(marker);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches exact-marker teardown when cookie-clear context close hangs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-state-hung-close-"));
    const terminate = vi.fn(async () => true);
    try {
      await expect(
        clearProviderCookies(dir, "github", {
          loadChromium: async () => ({
            launchPersistentContext: async () => ({
              cookies: async () => [],
              clearCookies: async () => undefined,
              close: async () => await new Promise<never>(() => undefined),
            }),
          }),
          registerLaunch: () => ({ marker: "v1:1:hung-cookie-clear", env: {} }),
          bindLaunch: () => true,
          markTerminal: vi.fn(),
          terminate,
          untrack: vi.fn(),
          closeTimeoutMs: 1,
        }),
      ).resolves.toBe(true);
      expect(terminate).toHaveBeenCalledWith("v1:1:hung-cookie-clear", dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open the canonical profile while another operation owns it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-state-guard-"));
    const lease = acquireProfileOperationGuard(dir);
    try {
      await expect(clearProviderCookies(dir, "google")).rejects.toBeInstanceOf(ProfileBusyError);
    } finally {
      lease.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("login-state marker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-login-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no providers when the marker is absent", () => {
    expect(loggedInProviders(dir)).toEqual([]);
  });

  it("round-trips a marked provider", () => {
    markProviderLoggedIn("google", dir);
    expect(loggedInProviders(dir)).toEqual(["google"]);
  });

  it("accumulates providers and de-duplicates", () => {
    markProviderLoggedIn("google", dir);
    markProviderLoggedIn("github", dir);
    markProviderLoggedIn("google", dir);
    expect([...loggedInProviders(dir)].sort()).toEqual(["github", "google"]);
  });

  it("drops unknown provider ids and tolerates a non-array payload", () => {
    writeFileSync(join(dir, "logged-in-providers.json"), '["google","bogus"]');
    expect(loggedInProviders(dir)).toEqual(["google"]);
    writeFileSync(join(dir, "logged-in-providers.json"), '{"x":1}');
    expect(loggedInProviders(dir)).toEqual([]);
  });
});

describe("provider-email marker (PR3 capture-at-login)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-provider-email-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no email marker exists", () => {
    expect(loggedInEmail("google", dir)).toBeNull();
  });

  it("round-trips a recorded email per provider", () => {
    recordProviderEmail("google", "ada@example.com", dir);
    expect(loggedInEmail("google", dir)).toBe("ada@example.com");
    expect(loggedInEmail("github", dir)).toBeNull();
  });

  it("overwrites the email on re-record (account switch)", () => {
    recordProviderEmail("google", "old@example.com", dir);
    recordProviderEmail("google", "new@example.com", dir);
    expect(loggedInEmail("google", dir)).toBe("new@example.com");
  });

  it("ignores an empty email and tolerates a malformed marker", () => {
    recordProviderEmail("google", "", dir);
    expect(loggedInEmail("google", dir)).toBeNull();
    writeFileSync(join(dir, "provider-emails.json"), "not json");
    expect(loggedInEmail("google", dir)).toBeNull();
  });

  it("keeps the provider-array marker independent of the email marker", () => {
    markProviderLoggedIn("google", dir);
    recordProviderEmail("google", "ada@example.com", dir);
    expect(loggedInProviders(dir)).toEqual(["google"]);
    expect(loggedInEmail("google", dir)).toBe("ada@example.com");
  });
});
