// Covers parseArgs (the connect flags, and the removals that keep `connect`
// the one onboarding pathway).
//
// The 0.5.1 install flow does not have a separate runLoginStage —
// the bot's Chrome IS where the user signs in to confirm the install,
// so the provider session lands in the profile as a side effect of
// the install confirm itself.

import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  applyInstallPreferences,
  resolveConnectTargetContext,
  runCli,
} from "../install/cli.js";
import type { SessionData } from "../session.js";
import type { AgentDefinition } from "../install/agents.js";
import { CHROME_PROFILE_DIR } from "../bot/profile.js";

function configuredAgent(env: Record<string, string> | null): AgentDefinition {
  return {
    target: "hermes",
    display_name: "Hermes",
    config_path: () => "/synthetic/hermes.yaml",
    detect: async () => true,
    readConfigEnv: async () => env,
    writeConfig: async () => undefined,
  };
}

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

  it("parses --json without changing the default human path", () => {
    expect(parseArgs(["connect"]).json).toBeUndefined();
    expect(parseArgs(["connect", "--json"]).json).toBe(true);
  });

  // The clack picker draws on stdout, which --json owns.
  it("makes --json non-interactive so nothing else writes to the machine channel", () => {
    expect(parseArgs(["connect"]).noInteractive).toBe(false);
    expect(parseArgs(["connect", "--json"]).noInteractive).toBe(true);
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

  it("rejects deprecated registry flags", async () => {
    await expectDeprecatedExit(["connect", "--registry"]);
    await expectDeprecatedExit(["connect", "--registry-url=https://staging.registry.test"]);
  });
});

describe("parseArgs deprecated flags", () => {
  it("rejects the removed install alias", async () => {
    await expectDeprecatedExit(["install"]);
  });

  it("rejects removed compatibility flags", async () => {
    await expectDeprecatedExit(["connect", "--skip-login"]);
    await expectDeprecatedExit(["connect", "--skip-secondary"]);
  });

  // ONE pathway: `login` and the two flags that existed only to serve it are
  // gone, and a user (or an agent reading a stale doc) that reaches for them
  // must be told to use connect instead of silently getting a working command.
  it("rejects the removed login subcommand and points at connect", async () => {
    const message = await expectDeprecatedExit(["login"]);
    expect(message).toContain("`login` has been removed");
    expect(message).toContain("connect");
  });

  it("rejects the login-only provider and profile-dir flags", async () => {
    expect(await expectDeprecatedExit(["connect", "--provider=google"])).toContain(
      "--force-relogin",
    );
    await expectDeprecatedExit(["connect", "--profile-dir=/tmp/profile"]);
  });
});

// `npx @trusty-squire/mcp --json --skip-login` runs the connect command —
// parseArgs defaults the command when no positional is given — so it owes a
// report like every other connect exit. Matching argv[0] literally missed it.
describe("the machine channel on a usage failure", () => {
  it("reports for the bare invocation, not only the explicit `connect` word", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-cli-machine-"));
    const file = join(dir, "machine.json");
    const fd = openSync(file, "w+");
    const original = process.stdout.fd;
    Object.defineProperty(process.stdout, "fd", { value: fd, configurable: true, writable: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(runCli(["--json", "--skip-login"])).rejects.toThrow("exit:64");
      const report = JSON.parse(readFileSync(file, "utf8")) as {
        state: string;
        reason: string | null;
      };
      expect(report.state).toBe("no-browser");
      expect(report.reason).toBe("run_failed");
    } finally {
      exit.mockRestore();
      error.mockRestore();
      Object.defineProperty(process.stdout, "fd", {
        value: original,
        configurable: true,
        writable: true,
      });
      closeSync(fd);
    }
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

describe("resolveConnectTargetContext", () => {
  it("reuses the selected target's recorded profile, account, and agent identity", async () => {
    await expect(
      resolveConnectTargetContext(
        "hermes",
        configuredAgent({
          TRUSTY_SQUIRE_PROFILE_DIR: "/synthetic/profiles/hermes",
          TRUSTY_SQUIRE_ACCOUNT_ID: "acct_hermes",
          TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes-runtime",
        }),
        {},
      ),
    ).resolves.toEqual({
      profileDir: "/synthetic/profiles/hermes",
      accountId: "acct_hermes",
      agentIdentity: "hermes-runtime",
    });
  });

  it("gives documented caller env precedence over recorded target context", async () => {
    await expect(
      resolveConnectTargetContext(
        "hermes",
        configuredAgent({
          TRUSTY_SQUIRE_PROFILE_DIR: "/synthetic/profiles/hermes",
          TRUSTY_SQUIRE_ACCOUNT_ID: "acct_hermes",
          TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes-runtime",
        }),
        {
          TRUSTY_SQUIRE_PROFILE_DIR: "/synthetic/override-profile",
          TRUSTY_SQUIRE_ACCOUNT_ID: "acct_override",
          TRUSTY_SQUIRE_AGENT_IDENTITY: "override-runtime",
        },
      ),
    ).resolves.toEqual({
      profileDir: "/synthetic/override-profile",
      accountId: "acct_override",
      agentIdentity: "override-runtime",
    });
  });

  it("preserves legacy first-connect defaults when the target has no config", async () => {
    await expect(resolveConnectTargetContext("hermes", configuredAgent(null), {})).resolves.toEqual(
      {
        profileDir: CHROME_PROFILE_DIR,
        agentIdentity: "hermes",
      },
    );
  });

  it("fails closed on an invalid configured context without logging its value", async () => {
    const secret = "secret-fixture-profile";
    const error = await resolveConnectTargetContext(
      "hermes",
      configuredAgent({ TRUSTY_SQUIRE_PROFILE_DIR: `  `, SECRET_FIXTURE: secret }),
      {},
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("TRUSTY_SQUIRE_PROFILE_DIR");
    expect(String(error)).not.toContain(secret);
  });
});

// Drives the real CLI boundary, because that is where the removal's exit code
// is observable. Returns the message printed to the user, so a caller can
// assert WHICH replacement the removal points at.
async function expectDeprecatedExit(argv: string[]): Promise<string> {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  });
  try {
    await expect(runCli(argv)).rejects.toThrow("exit:64");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[trusty-squire]"));
    return String(error.mock.calls.at(-1)?.[0] ?? "");
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}
