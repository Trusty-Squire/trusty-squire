// Regression: `mcp login --provider=<p> --force-relogin` must drop the
// provider's logged-in marker UP FRONT. Otherwise a stale marker from a
// prior successful login survives a re-login the user abandons or that
// times out (GitHub's 2FA "verify it's you" never finished), leaving
// logged-in-providers.json claiming a session whose auth cookie
// (user_session) no longer exists — the bot then auto-prefers that
// provider's OAuth path and every signup fails. Observed 2026-06-02.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// vi.hoisted so these are initialized before the hoisted vi.mock factories
// reference them (and so tsc sees plain Mocks, not spread wrappers).
const m = vi.hoisted(() => ({
  ensureOAuthSession: vi.fn(),
  clearProviderLoggedIn: vi.fn(),
  markProviderLoggedIn: vi.fn(),
  loggedInProviders: vi.fn(() => [] as string[]),
  clearAllProviderMarkers: vi.fn(),
  clearProviderCookies: vi.fn(async () => {}),
}));

// Spread the real module (oauth-providers.ts + agent.ts pull other
// exports from it transitively) and override only the one call login()
// makes, so the import graph stays intact.
vi.mock("../../bot/google-login.js", async (importActual) => {
  const actual = await importActual<typeof import("../../bot/google-login.js")>();
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
  beforeEach(() => {
    vi.clearAllMocks();
    // login() calls process.exit(1) on timeout — throw instead so the
    // test can assert without killing the runner. We assert the exit
    // code via the spy, not the thrown message.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit");
    });
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("clears the provider marker up front on force-relogin (timed-out login can't leave it lying)", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github", "--force-relogin"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.clearProviderLoggedIn).toHaveBeenCalledWith("github");
    // a timed-out login never confirms a cookie, so it must NOT re-mark
    expect(m.markProviderLoggedIn).not.toHaveBeenCalled();
  });

  it("does NOT touch the marker when --force-relogin is absent", async () => {
    m.ensureOAuthSession.mockResolvedValue({ status: "timeout" });
    await expect(
      runCli(["login", "--provider=github"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.clearProviderLoggedIn).not.toHaveBeenCalled();
  });
});
