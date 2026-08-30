// Explicit login must open a fresh provider ceremony without destroying the
// last portable identity first. The live context clears its provider cookies;
// the canonical snapshot is replaced only after a completed capture.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as GoogleLogin from "../../bot/google-login.js";
import { acquireProfileOperationGuard } from "../../bot/profile.js";
import {
  readSessionState,
  writeCanonicalIdentitySnapshot,
} from "../../bot/session-state.js";

// vi.hoisted so these are initialized before the hoisted vi.mock factories
// reference them (and so tsc sees plain Mocks, not spread wrappers).
const m = vi.hoisted(() => ({
  ensureOAuthSession: vi.fn(),
  clearProviderLoggedIn: vi.fn(),
  markProviderLoggedIn: vi.fn(),
  loggedInProviders: vi.fn(() => [] as string[]),
  clearAllProviderMarkers: vi.fn(),
  clearProviderCookies: vi.fn(async () => true),
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

  it("treats every explicit login as fresh without deleting the last Google snapshot", async () => {
    const prior = {
      cookies: [
        {
          name: "SID",
          value: "prior-portable-google-session",
          domain: ".google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    await writeCanonicalIdentitySnapshot(profileDir, prior, undefined, () => true, ["google"]);
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=google", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.clearProviderLoggedIn).not.toHaveBeenCalled();
    expect(m.ensureOAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", profileDir, forceOpen: true }),
    );
    await expect(readSessionState(profileDir)).resolves.toEqual(prior);
  });

  it("prints the package version for an explicit login", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.ensureOAuthSession.mockResolvedValue({ status: "already_valid" });

    await runCli(["login", "--provider=google", `--profile-dir=${profileDir}`]);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/@trusty-squire\/mcp \d+\.\d+\.\d+/));
  });

  it("keeps the same fresh-login path when --force-relogin is passed", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=google", "--force-relogin", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(m.ensureOAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", profileDir, forceOpen: true }),
    );
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
