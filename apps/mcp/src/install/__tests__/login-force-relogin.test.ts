// Explicit login must open a fresh provider ceremony in the real profile.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as GoogleLogin from "../../bot/google-login.js";
import { acquireProfileOperationGuard } from "../../bot/profile.js";

// vi.hoisted so these are initialized before the hoisted vi.mock factories
// reference them (and so tsc sees plain Mocks, not spread wrappers).
const m = vi.hoisted(() => ({
  ensureOAuthSession: vi.fn(),
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
  clearProviderCookies: m.clearProviderCookies,
}));

const { runCli } = await import("../cli.js");

describe("login --force-relogin", () => {
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

  it("opens a fresh provider ceremony on force-relogin", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github", "--force-relogin", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.ensureOAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", profileDir, forceOpen: true }),
    );
  });

  it("treats every explicit login as fresh", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=google", `--profile-dir=${profileDir}`]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
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

  it("does not start while another operation owns the profile", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-login-guard-"));
    const lease = acquireProfileOperationGuard(profileDir);
    try {
      await expect(
        runCli(["login", `--profile-dir=${profileDir}`, "--force-relogin"]),
      ).rejects.toThrow("process.exit");
      expect(m.ensureOAuthSession).not.toHaveBeenCalled();
    } finally {
      lease.release();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
