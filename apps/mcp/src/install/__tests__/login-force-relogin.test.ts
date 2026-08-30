// Regression: `mcp login --provider=<p> --force-relogin` must drop the
// provider's logged-in marker UP FRONT. Otherwise a stale marker from a
// prior successful login survives a re-login the user abandons or that
// times out (GitHub's 2FA "verify it's you" never finished), leaving
// logged-in-providers.json claiming a session whose auth cookie
// (user_session) no longer exists — the bot then auto-prefers that
// provider's OAuth path and every signup fails. Observed 2026-06-02.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as GoogleLogin from "../../bot/google-login.js";
import type * as SessionState from "../../bot/session-state.js";
import { acquireProfileOperationGuard } from "../../bot/profile.js";

// vi.hoisted so these are initialized before the hoisted vi.mock factories
// reference them (and so tsc sees plain Mocks, not spread wrappers).
const m = vi.hoisted(() => ({
  ensureOAuthSession: vi.fn(),
  clearProviderLoggedIn: vi.fn(),
  markProviderLoggedIn: vi.fn(),
  loggedInProviders: vi.fn(() => [] as string[]),
  clearAllProviderMarkers: vi.fn(),
  clearProviderCookies: vi.fn(async () => true),
  invalidateCanonicalGoogleIdentity: vi.fn(async () => true),
}));

// Spread the real module (oauth-providers.ts + agent.ts pull other
// exports from it transitively) and override only the one call login()
// makes, so the import graph stays intact.
vi.mock("../../bot/google-login.js", async (importActual) => {
  const actual = await importActual<typeof GoogleLogin>();
  return { ...actual, ensureOAuthSession: m.ensureOAuthSession };
});

vi.mock("../../bot/login-state.js", () => ({
  clearProviderLoggedIn: m.clearProviderLoggedIn,
  markProviderLoggedIn: m.markProviderLoggedIn,
  loggedInProviders: m.loggedInProviders,
  clearAllProviderMarkers: m.clearAllProviderMarkers,
  clearProviderCookies: m.clearProviderCookies,
}));

vi.mock("../../bot/session-state.js", async (importActual) => {
  const actual = await importActual<typeof SessionState>();
  return {
    ...actual,
    invalidateCanonicalGoogleIdentity: m.invalidateCanonicalGoogleIdentity,
  };
});

const { runCli } = await import("../cli.js");

describe("login --force-relogin marker honesty", () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let profileDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    profileDir = mkdtempSync(join(tmpdir(), "ts-login-profile-"));
    // login() calls process.exit(1) on timeout — throw instead so the
    // test can assert without killing the runner. We assert the exit
    // code via the spy, not the thrown message.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit");
    });
  });
  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("clears the provider marker up front on force-relogin (timed-out login can't leave it lying)", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github", "--force-relogin", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.clearProviderLoggedIn).toHaveBeenCalledWith("github", profileDir);
    // a timed-out login never confirms a cookie, so it must NOT re-mark
    expect(m.markProviderLoggedIn).not.toHaveBeenCalled();
  });

  it("treats every explicit login as a fresh provider login without requiring --force-relogin", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=google", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.clearProviderLoggedIn).not.toHaveBeenCalled();
    expect(m.invalidateCanonicalGoogleIdentity).toHaveBeenCalledWith(profileDir);
    expect(m.ensureOAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", profileDir, forceOpen: true }),
    );
  });

  it("prints the package version for an explicit login", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.ensureOAuthSession.mockResolvedValue({ status: "already_valid" });

    await runCli(["login", "--provider=google", `--profile-dir=${profileDir}`]);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/@trusty-squire\/mcp \d+\.\d+\.\d+/));
  });

  it("invalidates portable Google identity before a forced login can time out", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=google", "--force-relogin", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");

    expect(m.invalidateCanonicalGoogleIdentity).toHaveBeenCalledWith(profileDir);
    expect(m.ensureOAuthSession).toHaveBeenCalled();
  });

  it("exits non-zero when another Trusty Squire session owns the browser", async () => {
    m.ensureOAuthSession.mockResolvedValue({
      status: "error",
      detail: "another Trusty Squire session is already using the browser — close it first",
    });

    await expect(runCli(["login", `--profile-dir=${profileDir}`])).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not mutate markers while another canonical operation owns the profile", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-guard-"));
    const lease = acquireProfileOperationGuard(profileDir);
    try {
      await expect(
        runCli(["login", `--profile-dir=${profileDir}`, "--force-relogin"]),
      ).rejects.toThrow("process.exit");
      expect(m.clearProviderLoggedIn).not.toHaveBeenCalled();
      expect(m.ensureOAuthSession).not.toHaveBeenCalled();
    } finally {
      lease.release();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
