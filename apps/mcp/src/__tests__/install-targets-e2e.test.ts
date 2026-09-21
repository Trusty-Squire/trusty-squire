// E2E #3 — the install CLI works against the five host agents users
// commonly run: claude-code, codex, goose, cursor, opencode. For each target,
// this test:
//   1. Runs the same connect() entrypoint runCli dispatches to.
//   2. Mocks the external dependencies (API handshake + ASN detection
//      + OAuth login) so the test is hermetic.
//   3. Sandboxes HOME to a tmpdir so the writeConfig step lands in
//      a throwaway directory and never touches the user's real config.
//   4. Asserts the agent's config file is created at the agent's
//      `config_path()` and contains a `squire` MCP server entry.
//
// Per-target write semantics (JSON for claude-code/cursor/cline, JSONC
// for opencode, YAML for goose, TOML for codex) are covered by agents.test.ts.
// This file proves the install pipeline drives the right writer for
// each --target value.

import { promises as fs, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type * as BotModule from "../bot/index.js";
import type * as GoogleLoginModule from "../bot/google-login.js";
import type * as LoginStateModule from "../bot/login-state.js";
import type * as ProfileModule from "../bot/profile.js";

// Module-level mocks for the install pipeline's external collaborators.
// Hoisted by vitest before the install/cli.js import below, so the
// connect() function sees the mocked versions.

vi.mock("../api-client.js", () => ({
  // Canned install handshake — pretend the API issued a machine token
  // immediately and the user confirmed in the browser within ms.
  issueMachineToken: vi.fn(async () => ({
    machine_token: "tsm_test_machine_token",
  })),
  installInitiate: vi.fn(async () => ({
    setup_code: "test_setup_code",
    confirm_url: "https://test.invalid/install?token=test_setup_code",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  })),
  installPoll: vi.fn(async () => ({
    status: "claimed" as const,
    agent_session_token: "ts_agent_test_token",
    account_id: "acct_test",
  })),
}));

// `--skip-browser` hands the URL to the machine's default browser. Stubbed so
// the suite neither spawns one nor depends on whether this host can.
vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));

vi.mock("../bot/index.js", async () => {
  // Preserve the real exports the install CLI uses for typing while
  // stubbing the network-hitting detectAsn.
  const actual = await vi.importActual<typeof BotModule>("../bot/index.js");
  return {
    ...actual,
    detectAsn: vi.fn(async () => null),
  };
});

// Stub the network-hitting `ensureOAuthSession` but preserve every
// other export (the wider bot module re-imports things like
// `scopesAreBasic` from this file).
vi.mock("../bot/google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    ensureOAuthSession: vi.fn(async () => ({ status: "logged_in" as const })),
    // connect's success gate probes live provider cookies through
    // probeProviderSessionsAfterCeremony, whose own default reaches
    // detectActiveProviderSessions and launches a REAL persistent-context
    // Chrome on the bot profile. In a test that contends with any running
    // browser (e.g. a concurrent housekeeper harvest holding the profile
    // lock) it blocks ~15s + retries and times the suite out. An e2e must not
    // launch a real browser — stub the function the gate actually calls, not
    // only the one underneath it: a `...actual` spread hands back the REAL
    // probe, which resolves its default against the real module binding and
    // never sees a mocked export.
    detectActiveProviderSessions: vi.fn(async () => ["google"] as const),
    probeProviderSessionsAfterCeremony: vi.fn(async () => ["google"] as const),
    openInstallConfirmInBotChrome: vi.fn(async (options) => {
      await options.pollUntilClaimed(true);
      return { status: "claimed" as const };
    }),
  };
});

vi.mock("../bot/login-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LoginStateModule>();
  return {
    ...actual,
    clearBrowserProfile: vi.fn(),
    clearProviderCookies: vi.fn(async () => true),
  };
});

vi.mock("../bot/profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfileModule>();
  return {
    ...actual,
    // This suite verifies config writes, not contention against the user's live profile.
    withProfileOperationGuard: vi.fn(
      async <T>(_profileDir: string, fn: () => Promise<T>): Promise<T> => fn(),
    ),
  };
});

// Imported after the vi.mock calls so connect() sees the mocks. The
// install/cli.ts module pulls in api-client + bot at top level, so
// this ordering is load-bearing.
import {
  openInstallConfirmInBotChrome,
  probeProviderSessionsAfterCeremony,
} from "../bot/google-login.js";
import { clearBrowserProfile, clearProviderCookies } from "../bot/login-state.js";
import { ProfileBusyError } from "../bot/profile.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { installInitiate, installPoll } from "../api-client.js";
import { captureMachineChannel } from "./machine-channel.js";
import { connect, resolveServerLaunch } from "../install/cli.js";
import { AGENTS } from "../install/agents.js";
import { openSessionStorage } from "../session.js";
import { VERSION } from "../version.js";
import { nativeLaunchSpecFromInstalledConfig } from "../../scripts/native-launch-diagnostics.mjs";

const TARGETS = ["claude-code", "codex", "goose", "cursor", "hermes", "opencode"] as const;

let originalHome: string | undefined;
let originalXdg: string | undefined;
let originalOpenCodeConfig: string | undefined;
let tmpHome: string;

type ParsedSquireConfig = {
  command: unknown;
  args: unknown;
  env: unknown;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, `${label} should be an object`).toSatisfy(
    (candidate) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate),
  );
  return value as Record<string, unknown>;
}

async function readSquireConfig(target: (typeof TARGETS)[number]): Promise<ParsedSquireConfig> {
  const raw = await fs.readFile(AGENTS[target].config_path(), "utf8");
  switch (target) {
    case "claude-code":
    case "cursor": {
      const root = asRecord(JSON.parse(raw), `${target} config`);
      const squire = asRecord(asRecord(root.mcpServers, `${target} mcpServers`).squire, "squire");
      return { command: squire.command, args: squire.args, env: squire.env };
    }
    case "codex": {
      const root = asRecord(parseToml(raw), "codex config");
      const squire = asRecord(asRecord(root.mcp_servers, "codex mcp_servers").squire, "squire");
      return { command: squire.command, args: squire.args, env: squire.env };
    }
    case "goose": {
      const root = asRecord(parseYaml(raw), "goose config");
      const squire = asRecord(asRecord(root.extensions, "goose extensions").squire, "squire");
      return { command: squire.cmd, args: squire.args, env: squire.envs };
    }
    case "hermes": {
      const root = asRecord(parseYaml(raw), "hermes config");
      const squire = asRecord(asRecord(root.mcp_servers, "hermes mcp_servers").squire, "squire");
      return { command: squire.command, args: squire.args, env: squire.env };
    }
    case "opencode": {
      const root = asRecord(parseJsonc(raw), "opencode config");
      const squire = asRecord(asRecord(root.mcp, "opencode mcp").squire, "squire");
      expect(squire.command, "opencode squire command should be an array").toSatisfy(Array.isArray);
      const [command, ...args] = squire.command as unknown[];
      return { command, args, env: squire.environment };
    }
  }
}

function expectSquireConfig(
  config: ParsedSquireConfig,
  target: (typeof TARGETS)[number],
  registryEnabled: boolean,
  accountId = "acct_test",
  profileDir = process.env.TRUSTY_SQUIRE_PROFILE_DIR,
): void {
  const launch = resolveServerLaunch();
  expect(config.command).toBe(launch.command);
  expect(config.args).toEqual(launch.args);
  if (
    typeof config.command !== "string" ||
    !Array.isArray(config.args) ||
    !config.args.every((arg): arg is string => typeof arg === "string")
  ) {
    throw new Error(`${target}: installed launch is not executable`);
  }
  expect(
    nativeLaunchSpecFromInstalledConfig({ command: config.command, args: config.args }, VERSION),
  ).toEqual({ command: launch.command, args: launch.args, expectedVersion: VERSION });
  const env = asRecord(config.env, `${target} squire environment`);
  expect(env).toMatchObject({
    TRUSTY_SQUIRE_AGENT_IDENTITY: target,
    TRUSTY_SQUIRE_ACCOUNT_ID: accountId,
    TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
  });
  if (registryEnabled) {
    expect(env).toMatchObject({ TRUSTY_SQUIRE_REGISTRY_URL: "https://registry.trustysquire.ai" });
  } else {
    expect(env).not.toHaveProperty("TRUSTY_SQUIRE_REGISTRY_URL");
  }
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-install-e2e-"));
  process.env.HOME = tmpHome;
  // Some session-storage code paths read XDG_CONFIG_HOME directly —
  // re-anchor that too so nothing escapes the sandbox.
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
  delete process.env.OPENCODE_CONFIG;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
  else delete process.env.XDG_CONFIG_HOME;
  if (originalOpenCodeConfig !== undefined) {
    process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  } else {
    delete process.env.OPENCODE_CONFIG;
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("connect --target=<agent> writes a valid config", () => {
  for (const target of TARGETS) {
    it(`works for --target=${target}`, async () => {
      await connect({
        command: "connect",
        target,
        apiBase: "https://test.invalid",
        // Skip the bot's Chrome — `open()` the URL in the default
        // browser instead. Irrelevant to "does install write a config
        // for this target," and keeps the test fast (no Chrome boot).
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: false,
      });

      const configPath = AGENTS[target].config_path();
      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists, `${target}: config file should exist at ${configPath}`).toBe(true);

      expectSquireConfig(await readSquireConfig(target), target, true);
    });
  }

  it("--no-registry omits TRUSTY_SQUIRE_REGISTRY_URL from the config", async () => {
    await connect({
      command: "connect",
      target: TARGETS[0]!,
      apiBase: "https://test.invalid",
      skipBrowser: true,
      forceRelogin: false,
      noRegistry: true,
      noInteractive: false,
    });
    expectSquireConfig(await readSquireConfig(TARGETS[0]!), TARGETS[0]!, false);
  });

  it("keeps registry and skillification consent off when registry is disabled", async () => {
    await connect({
      command: "connect",
      target: TARGETS[0]!,
      apiBase: "https://test.invalid",
      skipBrowser: true,
      forceRelogin: false,
      noRegistry: true,
      noInteractive: false,
    });
    expectSquireConfig(await readSquireConfig(TARGETS[0]!), TARGETS[0]!, false);
    const sessionPath = path.join(process.env.XDG_CONFIG_HOME!, "trusty-squire", "session.json");
    const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as {
      consent_skillify_telemetry?: boolean;
      consent_operator_inbox_otp?: boolean;
    };
    expect(session.consent_skillify_telemetry).toBe(false);
    expect(session.consent_operator_inbox_otp).toBe(true);
  });

  it("writes the managed registry URL and skillification consent when registry is enabled", async () => {
    const prev = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://staging.registry.test";
    try {
      await connect({
        command: "connect",
        target: TARGETS[0]!,
        apiBase: "https://test.invalid",
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: false,
      });
      expectSquireConfig(await readSquireConfig(TARGETS[0]!), TARGETS[0]!, true);
      const sessionPath = path.join(process.env.XDG_CONFIG_HOME!, "trusty-squire", "session.json");
      const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as {
        consent_skillify_telemetry?: boolean;
        consent_operator_inbox_otp?: boolean;
      };
      expect(session.consent_skillify_telemetry).toBe(true);
      expect(session.consent_operator_inbox_otp).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
      else process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
    }
  });

  it("uses the claimed account after another connect moves the pointer", async () => {
    vi.mocked(probeProviderSessionsAfterCeremony).mockImplementationOnce(async () => {
      const storage = await openSessionStorage();
      await storage.write({
        api_base_url: "https://other-account.invalid",
        saved_at: new Date().toISOString(),
        machine_token: "other-machine-token",
        agent_session_token: "other-agent-token",
        account_id: "acct_other",
      });
      return ["google"];
    });
    const vaultFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 201 }));

    try {
      await connect({
        command: "connect",
        target: "claude-code",
        apiBase: "https://test.invalid",
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: false,
        twoCaptchaKey: "captcha-key",
      });

      expectSquireConfig(await readSquireConfig("claude-code"), "claude-code", true);
      const vaultCall = vaultFetch.mock.calls.find(([url]) =>
        String(url).endsWith("/v1/vault/credentials"),
      );
      expect(vaultCall).toBeDefined();
      expect(vaultCall![0]).toBe("https://test.invalid/v1/vault/credentials");
      expect(vaultCall![1]).toMatchObject({
        headers: { authorization: "Bearer ts_agent_test_token" },
      });
      expect((await (await openSessionStorage()).read())?.account_id).toBe("acct_other");
    } finally {
      vaultFetch.mockRestore();
    }
  });

  it("reconnects Hermes in its recorded profile from lock through browser and success probe", async () => {
    const hermesProfile = path.join(tmpHome, "profiles", "hermes");
    const codexProfile = path.join(tmpHome, "profiles", "codex");
    await AGENTS.hermes.writeConfig({
      command: "node",
      args: ["old-hermes", "server"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes",
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_test",
        TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
        HERMES_UNRELATED_ENV: "keep-me",
        SECRET_FIXTURE_ENV: "must-not-be-logged",
      },
    });
    await AGENTS.codex.writeConfig({
      command: "node",
      args: ["old-codex", "server"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "codex",
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_codex",
        TRUSTY_SQUIRE_PROFILE_DIR: codexProfile,
      },
    });
    const previous = {
      profile: process.env.TRUSTY_SQUIRE_PROFILE_DIR,
      account: process.env.TRUSTY_SQUIRE_ACCOUNT_ID,
      identity: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY,
    };
    delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    delete process.env.TRUSTY_SQUIRE_AGENT_IDENTITY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: true,
        forceReloginProvider: "google",
        noRegistry: false,
        noInteractive: true,
      });

      expect(clearProviderCookies).toHaveBeenCalledWith(hermesProfile, "google");
      expect(clearBrowserProfile).not.toHaveBeenCalled();
      expect(openInstallConfirmInBotChrome).toHaveBeenCalledWith(
        expect.objectContaining({ profileDir: hermesProfile }),
      );
      expect(probeProviderSessionsAfterCeremony).toHaveBeenLastCalledWith(hermesProfile, {
        awaitProviders: ["google"],
      });
      // The profile operation guard now belongs to the ceremony launcher
      // itself (launchCeremonyBrowserContext / the broker's own custody),
      // not to the connect flow around it — the ceremony this suite mocks
      // therefore runs without one. google-login.test.ts pins the guard
      // contract on the real launcher.
      const config = await readSquireConfig("hermes");
      expect(config.env).toMatchObject({
        TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes",
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_test",
        TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
        HERMES_UNRELATED_ENV: "keep-me",
        SECRET_FIXTURE_ENV: "must-not-be-logged",
      });
      expect(`${warn.mock.calls.flat()} ${error.mock.calls.flat()}`).not.toContain(
        "must-not-be-logged",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
      if (previous.profile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previous.profile;
      if (previous.account === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = previous.account;
      if (previous.identity === undefined) delete process.env.TRUSTY_SQUIRE_AGENT_IDENTITY;
      else process.env.TRUSTY_SQUIRE_AGENT_IDENTITY = previous.identity;
    }
  });

  it("keeps bare force-relogin as an intentional account-switch path", async () => {
    const hermesProfile = path.join(tmpHome, "profiles", "hermes-switch");
    await AGENTS.hermes.writeConfig({
      command: "node",
      args: ["old", "server"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes",
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_old",
        TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
      },
    });
    vi.mocked(installPoll).mockResolvedValueOnce({
      status: "claimed",
      agent_session_token: "ts_agent_new",
      account_id: "acct_new",
    });
    const previousProfile = process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    const previousAccount = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: true,
        noRegistry: false,
        noInteractive: true,
      });
      expect(clearBrowserProfile).toHaveBeenCalledWith(hermesProfile);
      expectSquireConfig(
        await readSquireConfig("hermes"),
        "hermes",
        true,
        "acct_new",
        hermesProfile,
      );
    } finally {
      if (previousProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previousProfile;
      if (previousAccount === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = previousAccount;
    }
  });

  // The ceremony waits the pairing token's LIFETIME, counted from when the
  // initiate response arrived. Differencing the server's `expires_at` against
  // this machine's clock made the window a function of clock skew: a host
  // running ten minutes fast collapsed a 2FA sign-in to sixty seconds.
  it("waits the token's lifetime even when this machine's clock is skewed", async () => {
    vi.mocked(installInitiate).mockResolvedValueOnce({
      setup_code: "test_setup_code",
      confirm_url: "https://test.invalid/install?token=test_setup_code",
      // As a host running ten minutes ahead of the server sees it.
      expires_at: new Date(Date.now() - 600_000).toISOString(),
    });
    const before = Date.now();

    await connect({
      command: "connect",
      target: "hermes",
      apiBase: "https://test.invalid",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });

    const call = vi.mocked(openInstallConfirmInBotChrome).mock.calls.at(-1);
    const deadline = call?.[0].deadline ?? 0;
    expect(deadline - before).toBeGreaterThan(9 * 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  // The ceremony waits exactly as long as the pairing token lives, so reaching
  // that deadline means the link is dead. Handing it back as `needs-sign-in`
  // gave Beeline a URL that 410s on the first click.
  it("reports an expired install, not a sign-in URL, when the ceremony runs out", async () => {
    vi.mocked(installPoll).mockResolvedValue({ status: "pending" });
    vi.mocked(openInstallConfirmInBotChrome).mockResolvedValueOnce({ status: "timeout" });
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{
        state: string;
        reason: string | null;
        sign_in_url: string | null;
      }>();
      expect(report.state).toBe("no-browser");
      expect(report.reason).toBe("install_expired");
      expect(report.sign_in_url).toBeNull();
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
      vi.mocked(installPoll).mockReset();
      vi.mocked(installPoll).mockResolvedValue({
        status: "claimed",
        agent_session_token: "ts_agent_test_token",
        account_id: "acct_test",
      });
    }
  });

  // The noVNC rig's owned lifetime tears the ceremony down and exits the
  // process from inside the rig's own cleanup — no frame below connect()
  // returns, so nothing there can report the run. Leaving the stream on the
  // non-terminal `needs-sign-in` line makes a caller infer the outcome from
  // an exit code, which is the thing the machine channel exists to delete.
  it("ends the machine channel when the ceremony rig outlives its own bound", async () => {
    vi.mocked(openInstallConfirmInBotChrome).mockImplementationOnce(async (options) => {
      options.onCeremonyExpired?.(null);
      return process.exit(1);
    });
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const lines = machine.reports<{
        state: string;
        reason: string | null;
        terminal: boolean;
      }>();
      expect(lines[0]).toMatchObject({ state: "needs-sign-in", terminal: false });
      expect(lines.filter((line) => line.terminal)).toHaveLength(1);
      const report = machine.terminal<{
        state: string;
        reason: string | null;
        browser_location: { kind: string };
      }>();
      expect(report.state).toBe("no-browser");
      expect(report.reason).toBe("install_expired");
      // The rig was stood up and had to be force-reaped, so this run is not
      // one that "opened no browser at all" — reporting `none` would tell a
      // caller nothing was left behind.
      expect(report.browser_location.kind).toBe("unreachable");
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
    }
  });

  // The rig can outlive its bound while the ceremony Chrome this run launched
  // is still holding the profile's SingletonLock — the tunnel wedges after the
  // browser is up, so `onBrowserPlacement` never fires and the placement slot
  // has no pid. Reporting that lock as a holder tells a helper daemon another
  // session owns the browser at a pid that is about to be torn down.
  it("does not name this run's own ceremony Chrome as a holder when the rig expires", async () => {
    const profileDir = path.join(tmpHome, "profiles", "expiry-holder");
    await fs.mkdir(profileDir, { recursive: true });
    const ceremonyChrome = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => ceremonyChrome.once("spawn", () => resolve()));
    symlinkSync(`${os.hostname()}-${ceremonyChrome.pid}`, path.join(profileDir, "SingletonLock"));
    vi.mocked(openInstallConfirmInBotChrome).mockImplementationOnce(async (options) => {
      options.onCeremonyExpired?.(ceremonyChrome.pid ?? null);
      return process.exit(1);
    });
    const previousProfile = process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    process.env.TRUSTY_SQUIRE_PROFILE_DIR = profileDir;
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{ reason: string | null; holder: { kind: string } }>();
      expect(report.reason).toBe("install_expired");
      expect(report.holder).toEqual({ kind: "none" });
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
      if (previousProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previousProfile;
      ceremonyChrome.kill("SIGKILL");
    }
  });

  // Intent item 4: "whether the profile/browser is currently held by another
  // session ... as a code". A ceremony the profile gate refuses is exactly
  // that. Flattening the refusal to a string made it `needs-sign-in` with a
  // live URL, and a caller that opened it elsewhere claimed the install with
  // no provider session in the bot's Chrome — which the run's own gate rejects.
  it("reports a ceremony the profile gate refused as busy, not as a sign-in", async () => {
    vi.mocked(openInstallConfirmInBotChrome).mockRejectedValueOnce(
      new ProfileBusyError("another Trusty Squire session is already using the browser"),
    );
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{
        state: string;
        sign_in_url: string | null;
        holder: { kind: string };
      }>();
      expect(report.state).toBe("busy");
      expect(report.sign_in_url).toBeNull();
      expect(report.holder).toBeDefined();
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
    }
  });

  // A resident broker that refuses the ceremony holds the browser just as
  // surely as the profile gate does. Flattening its refusal to a string put
  // `needs-sign-in` and a live URL on the machine channel, and a caller that
  // opened that URL elsewhere claimed the install with no provider session in
  // the bot's Chrome — which this run's own gate then rejects.
  it("reports a resident broker's refusal as busy, not as a sign-in", async () => {
    vi.mocked(openInstallConfirmInBotChrome).mockRejectedValueOnce(
      new BrokerRefusal("broker_unavailable", "a stale-credential broker is still serving clients"),
    );
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{
        state: string;
        reason: string | null;
        sign_in_url: string | null;
      }>();
      expect(report.state).toBe("busy");
      expect(report.reason).toBeNull();
      expect(report.sign_in_url).toBeNull();
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
    }
  });

  // Not every BrokerRefusal is contention: the wire mints `broker_lost` when
  // the daemon dies mid-ceremony and `launch_timeout` when its Chrome never
  // came up. Reporting those as `busy` told a caller to wait for a holder that
  // does not exist, on a run that actually broke.
  it("reports a broker that died mid-ceremony as a failed run, not as busy", async () => {
    vi.mocked(openInstallConfirmInBotChrome).mockRejectedValueOnce(
      new BrokerRefusal("broker_lost", "Broker connection is closed"),
    );
    const machine = captureMachineChannel();
    const human: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      human.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{ state: string; reason: string | null }>();
      expect(report.state).toBe("no-browser");
      expect(report.reason).toBe("run_failed");
      // The human copy is unchanged: the refusal's own message names the
      // recovery, and it has always been printed this way.
      expect(human.join("\n")).toContain("Broker connection is closed");
    } finally {
      exit.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      machine.restore();
    }
  });

  // Connect blocks for minutes waiting on a human. A channel that only speaks
  // at settle is silent for exactly the window in which the link is live, which
  // left a caller scraping the boxen frame on stderr for it.
  it("puts the sign-in URL on the machine channel before it starts waiting", async () => {
    const machine = captureMachineChannel();
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
        json: true,
      });
      const lines = machine.reports<{
        terminal: boolean;
        state: string;
        sign_in_url: string | null;
      }>();
      const first = lines[0];
      expect(first?.terminal).toBe(false);
      expect(first?.state).toBe("needs-sign-in");
      expect(first?.sign_in_url).toBe("https://test.invalid/install?token=test_setup_code");
      // Exactly one line ends the run, and it is the last one.
      expect(lines.filter((line) => line.terminal)).toHaveLength(1);
      expect(lines.at(-1)?.terminal).toBe(true);
    } finally {
      machine.restore();
    }
  });

  // Item 5 names three answers: a real display, a virtual one, or nowhere
  // reachable. A ceremony whose rig never came up showed the page nowhere —
  // handing back a live URL plus an English sentence to interpret is the
  // parsing this surface exists to delete.
  it("reports a ceremony that showed the page nowhere as unreachable", async () => {
    vi.mocked(installPoll).mockResolvedValue({ status: "pending" });
    vi.mocked(openInstallConfirmInBotChrome).mockResolvedValueOnce({
      status: "error",
      detail: "x11vnc is not installed",
    });
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const report = machine.terminal<{
        state: string;
        sign_in_url: string | null;
        browser_location: { kind: string; reason?: string };
      }>();
      expect(report.browser_location.kind).toBe("unreachable");
      expect(report.browser_location.reason).toBe("x11vnc is not installed");
      expect(report.state).toBe("no-browser");
    } finally {
      exit.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      machine.restore();
      vi.mocked(installPoll).mockReset();
      vi.mocked(installPoll).mockResolvedValue({
        status: "claimed",
        agent_session_token: "ts_agent_test_token",
        account_id: "acct_test",
      });
    }
  });

  // Item 5 is answered where the browser was placed, and the answer is not
  // rewritten later. A virtual display carries the address that reaches it, and
  // that line goes out while the tunnel is up — not at settle, when it is gone.
  it("reports the virtual display and its live address before the wait", async () => {
    vi.mocked(installPoll).mockResolvedValue({ status: "pending" });
    vi.mocked(openInstallConfirmInBotChrome).mockImplementationOnce(async (options) => {
      options.onBrowserPlacement?.(
        { kind: "virtual", url: "https://tunnel.invalid/#p=secret" },
        null,
      );
      return { status: "timeout" as const };
    });
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow("exit:1");
      const lines = machine.reports<{
        terminal: boolean;
        state: string;
        sign_in_url: string | null;
        browser_location: { kind: string; url?: string };
      }>();
      const live = lines.find((line) => line.browser_location.kind === "virtual");
      expect(live, "a virtual placement is reported while the tunnel is up").toBeDefined();
      expect(live?.terminal).toBe(false);
      expect(live?.state).toBe("needs-sign-in");
      expect(live?.sign_in_url).toBe("https://test.invalid/install?token=test_setup_code");
      expect(live?.browser_location.url).toBe("https://tunnel.invalid/#p=secret");
      // The placement is reported as observed on the settled line too, never
      // relabelled into something it was not.
      expect(lines.at(-1)?.browser_location.kind).toBe("virtual");
    } finally {
      exit.mockRestore();
      error.mockRestore();
      machine.restore();
      vi.mocked(installPoll).mockReset();
      vi.mocked(installPoll).mockResolvedValue({
        status: "claimed",
        agent_session_token: "ts_agent_test_token",
        account_id: "acct_test",
      });
    }
  });

  // `open()` puts a real browser on the user's screen. Reporting "no browser
  // was opened" there is an assumption standing in for an observation; Squire
  // did not place that window and cannot say where it went.
  it("does not claim no browser opened when --skip-browser handed off the link", async () => {
    const machine = captureMachineChannel();
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
        json: true,
      });
      const report = machine.terminal<{
        browser_location: { kind: string; reason?: string };
      }>();
      expect(report.browser_location.kind).toBe("unknown");
      expect(report.browser_location.reason).toContain("default browser");
    } finally {
      machine.restore();
    }
  });

  it("refuses a scoped provider refresh that returns a different account", async () => {
    const hermesProfile = path.join(tmpHome, "profiles", "hermes-scoped");
    await AGENTS.hermes.writeConfig({
      command: "node",
      args: ["old", "server"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes",
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_scoped_original",
        TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
      },
    });
    vi.mocked(installPoll).mockResolvedValueOnce({
      status: "claimed",
      agent_session_token: "ts_agent_unexpected",
      account_id: "acct_scoped_unexpected",
    });
    const previousProfile = process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    const previousAccount = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
    delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: true,
          forceReloginProvider: "google",
          noRegistry: false,
          noInteractive: true,
        }),
      ).rejects.toThrow("exit:1");
      const config = await readSquireConfig("hermes");
      expect(config.env).toMatchObject({
        TRUSTY_SQUIRE_ACCOUNT_ID: "acct_scoped_original",
        TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
      });
      expect(String(error.mock.calls.flat())).not.toContain("acct_scoped_unexpected");
    } finally {
      exit.mockRestore();
      error.mockRestore();
      if (previousProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previousProfile;
      if (previousAccount === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = previousAccount;
    }
  });
});
