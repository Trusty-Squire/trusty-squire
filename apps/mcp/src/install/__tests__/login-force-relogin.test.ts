// Regression: `mcp login --provider=<p> --force-relogin` must drop the
// provider's logged-in marker UP FRONT. Otherwise a stale marker from a
// prior successful login survives a re-login the user abandons or that
// times out (GitHub's 2FA "verify it's you" never finished), leaving
// logged-in-providers.json claiming a session whose auth cookie
// (user_session) no longer exists — the bot then auto-prefers that
// provider's OAuth path and every signup fails. Observed 2026-06-02.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureOAuthSession = vi.fn();
const clearProviderLoggedIn = vi.fn();
const markProviderLoggedIn = vi.fn();
const loggedInProviders = vi.fn(() => [] as string[]);
const clearAllProviderMarkers = vi.fn();
const clearProviderCookies = vi.fn(async () => {});

// Spread the real module (oauth-providers.ts + agent.ts pull other
// exports from it transitively) and override only the one call login()
// makes, so the import graph stays intact.
vi.mock("../../bot/google-login.js", async (importActual) => {
  const actual = await importActual<typeof import("../../bot/google-login.js")>();
  return { ...actual, ensureOAuthSession: (...a: unknown[]) => ensureOAuthSession(...a) };
});

vi.mock("../../bot/login-state.js", () => ({
  clearProviderLoggedIn: (...a: unknown[]) => clearProviderLoggedIn(...a),
  markProviderLoggedIn: (...a: unknown[]) => markProviderLoggedIn(...a),
  loggedInProviders: (...a: unknown[]) => loggedInProviders(...a),
  clearAllProviderMarkers: (...a: unknown[]) => clearAllProviderMarkers(...a),
  clearProviderCookies: (...a: unknown[]) => clearProviderCookies(...a),
}));

const { runCli } = await import("../cli.js");

describe("login --force-relogin marker honesty", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    // login() calls process.exit(1) on timeout — throw instead so the
    // test can assert without killing the runner.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("clears the provider marker up front on force-relogin (timed-out login can't leave it lying)", async () => {
    ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github", "--force-relogin"]),
    ).rejects.toThrow("process.exit:1");
    expect(clearProviderLoggedIn).toHaveBeenCalledWith("github");
    // a timed-out login never confirms a cookie, so it must NOT re-mark
    expect(markProviderLoggedIn).not.toHaveBeenCalled();
  });

  it("does NOT touch the marker when --force-relogin is absent", async () => {
    ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github"]),
    ).rejects.toThrow("process.exit:1");
    expect(clearProviderLoggedIn).not.toHaveBeenCalled();
  });
});
