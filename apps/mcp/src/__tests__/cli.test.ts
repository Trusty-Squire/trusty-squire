// Covers parseArgs (the connect flags, and the removals that keep `connect`
// the one onboarding pathway).
//
// The 0.5.1 install flow does not have a separate runLoginStage —
// the bot's Chrome IS where the user signs in to confirm the install,
// so the provider session lands in the profile as a side effect of
// the install confirm itself.

import { describe, expect, it, vi } from "vitest";
import { parseArgs, applyInstallPreferences } from "../install/cli.js";
import type { SessionData } from "../session.js";

describe("applyInstallPreferences (fresh interactive consent must win)", () => {
  const base: SessionData = {
    api_base_url: "https://x",
    saved_at: "t",
    consent_operator_inbox_otp: true, // the user just answered YES in the CLI
    consent_skillify_telemetry: true,
  };
  const stalePrefs = { registry_enabled: false, consent_operator_inbox_otp: false };

  it("interactive (applyServerPrefs=false): keeps the local consent, ignores stale server prefs", () => {
    const out = applyInstallPreferences(base, stalePrefs, false);
    expect(out.consent_operator_inbox_otp).toBe(true);
    expect(out.consent_skillify_telemetry).toBe(true);
  });
  it("non-interactive (applyServerPrefs=true): inherits the server prefs", () => {
    const out = applyInstallPreferences(base, stalePrefs, true);
    expect(out.consent_operator_inbox_otp).toBe(false);
    expect(out.consent_skillify_telemetry).toBe(false);
  });
  it("undefined server prefs → baseSession unchanged either way", () => {
    expect(applyInstallPreferences(base, undefined, true).consent_operator_inbox_otp).toBe(true);
  });
});

describe("parseArgs --skip-browser", () => {
  it("defaults skipBrowser false and sets it with --skip-browser", () => {
    expect(parseArgs(["connect"]).skipBrowser).toBe(false);
    expect(parseArgs(["connect", "--skip-browser"]).skipBrowser).toBe(true);
  });

  it("parses --force-relogin for account switching", () => {
    expect(parseArgs(["connect"]).forceRelogin).toBe(false);
    expect(parseArgs(["connect", "--force-relogin"]).forceRelogin).toBe(true);
  });
});

describe("parseArgs registry", () => {
  it("defaults registry participation on", () => {
    expect(parseArgs(["connect"]).noRegistry).toBe(false);
  });

  it("keeps the legacy --no-registry flag as an explicit off switch", () => {
    const args = parseArgs(["connect", "--no-registry"]);
    expect(args.noRegistry).toBe(true);
    expect(args.registryConfigured).toBe(true);
  });

  it("rejects deprecated registry flags", () => {
    expectDeprecatedExit(() => parseArgs(["connect", "--registry"]));
    expectDeprecatedExit(() =>
      parseArgs(["connect", "--registry-url=https://staging.registry.test"]),
    );
  });
});

describe("parseArgs deprecated flags", () => {
  it("rejects the removed install alias", () => {
    expectDeprecatedExit(() => parseArgs(["install"]));
  });

  it("rejects removed compatibility flags", () => {
    expectDeprecatedExit(() => parseArgs(["connect", "--skip-login"]));
    expectDeprecatedExit(() => parseArgs(["connect", "--skip-secondary"]));
  });

  // ONE pathway: `login` and the two flags that existed only to serve it are
  // gone, and a user (or an agent reading a stale doc) that reaches for them
  // must be told to use connect instead of silently getting a working command.
  it("rejects the removed login subcommand and points at connect", () => {
    const message = expectDeprecatedExit(() => parseArgs(["login"]));
    expect(message).toContain("`login` has been removed");
    expect(message).toContain("connect");
  });

  it("rejects the login-only provider and profile-dir flags", () => {
    expect(expectDeprecatedExit(() => parseArgs(["connect", "--provider=google"]))).toContain(
      "--force-relogin",
    );
    expectDeprecatedExit(() => parseArgs(["connect", "--profile-dir=/tmp/profile"]));
  });
});

describe("parseArgs --force-relogin", () => {
  it("supports the full-profile form", () => {
    const args = parseArgs(["connect", "--force-relogin"]);
    expect(args.forceRelogin).toBe(true);
    expect(args.forceReloginProvider).toBeUndefined();
  });

  it("supports provider-scoped relogin", () => {
    const args = parseArgs(["connect", "--force-relogin=github"]);
    expect(args.forceRelogin).toBe(true);
    expect(args.forceReloginProvider).toBe("github");
  });
});

// Returns the message printed to the user, so a caller can assert WHICH
// replacement the removal points at.
function expectDeprecatedExit(fn: () => unknown): string {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  });
  try {
    expect(fn).toThrow("exit:64");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[trusty-squire]"));
    return String(error.mock.calls.at(-1)?.[0] ?? "");
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}
