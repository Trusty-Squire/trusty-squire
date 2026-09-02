// Tests for profile clearing and live-context provider cookie cleanup.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearProviderCookies,
  clearProviderCookiesFromContext,
  clearBrowserProfile,
} from "../login-state.js";
import { acquireProfileOperationGuard, ProfileBusyError } from "../profile.js";

describe("full profile clearing", () => {
  it("removes every profile artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-login-profile-clear-"));
    const snapshot = join(dir, "trusty-squire-session-state.json");
    const temporary = join(dir, "trusty-squire-session-state.json.123.writer.tmp");
    const stale = join(dir, "Default");
    writeFileSync(snapshot, "prior");
    writeFileSync(temporary, "replacement");
    writeFileSync(stale, "chrome-state");
    try {
      clearBrowserProfile(dir);
      expect(existsSync(snapshot)).toBe(false);
      expect(existsSync(temporary)).toBe(false);
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
