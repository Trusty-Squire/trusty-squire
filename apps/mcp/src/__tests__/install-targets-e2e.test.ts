vi.mock("../install/broker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BrokerServiceModule>()),
  installBrokerService: vi.fn(async () => undefined),
}));
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

import { promises as fs } from "node:fs";
import { createServer } from "node:net";
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
import type * as BrokerServiceModule from "../install/broker-service.js";

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
    // --skip-browser probes provider cookies through
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
    detectProviderSessionsFromProfile: vi.fn(actual.detectProviderSessionsFromProfile),
    probeProviderSessionsAfterCeremony: vi.fn(async () => ["google"] as const),
    confirmLiveGoogleProviderSnapshot: vi.fn(async (_profile, providers) => providers),
    // The broker daemon's ceremony. beforeEach installs an emulation of the
    // daemon: it lands the claim through the real finalize step.
    requestBrokerCeremony: vi.fn(),
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
  detectProviderSessionsFromProfile,
  probeProviderSessionsAfterCeremony,
  requestBrokerCeremony,
} from "../bot/google-login.js";
import type { CeremonyRequest, CeremonyView } from "../bot/broker/ceremony.js";
import { finalizeCeremonyClaim, resolveServerLaunch } from "../install/ceremony-finalize.js";
import { clearBrowserProfile, clearProviderCookies } from "../bot/login-state.js";
import { ProfileBusyError } from "../bot/profile.js";
import { profileDeviceAnchor } from "../bot/profile.js";
import {
  brokerAccountBindingPath,
  readBrokerAccountBinding,
} from "../bot/broker/account-binding.js";
import { readBrokerUnitMarkerSync, writeBrokerUnitMarker } from "../bot/broker/managed-marker.js";
import { brokerConnectionTarget } from "../bot/broker/discovery.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { installInitiate, installPoll, issueMachineToken } from "../api-client.js";
import { captureMachineChannel } from "./machine-channel.js";
import { installBrokerService } from "../install/broker-service.js";
import { connect } from "../install/cli.js";
import { AGENTS } from "../install/agents.js";
import { openSessionStorage } from "../session.js";
import { VERSION } from "../version.js";
import { nativeLaunchSpecFromInstalledConfig } from "../../scripts/native-launch-diagnostics.mjs";

const TARGETS = [
  "claude-code",
  "codex",
  "goose",
  "cursor",
  "hermes",
  "opencode",
  "cline",
  "continue",
] as const;

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
    case "cursor":
    case "cline": {
      const root = asRecord(JSON.parse(raw), `${target} config`);
      const squire = asRecord(asRecord(root.mcpServers, `${target} mcpServers`).squire, "squire");
      return { command: squire.command, args: squire.args, env: squire.env };
    }
    case "continue": {
      const root = asRecord(parseYaml(raw), "continue config");
      const servers = root.mcpServers;
      if (!Array.isArray(servers)) throw new Error("continue mcpServers must be an array");
      const squire = asRecord(
        servers.find((entry) => asRecord(entry, "continue entry").name === "squire"),
        "squire",
      );
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
  expect(launch).toEqual({ command: "npx", args: ["-y", "@trusty-squire/mcp@latest", "server"] });
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

const TUNNEL_URL = "https://tunnel.invalid/#p=secret";

// What the broker daemon does with a start: open the window, and — the moment
// /status delivers the claim — write the session and the host agent config
// with the plan connect sent. Here the claim is delivered at once.
async function emulateBrokerCeremony(
  profileDir: string,
  request: CeremonyRequest,
): Promise<CeremonyView> {
  if (request.action !== "start") return { state: "none" };
  const status = await installPoll(request.apiBase, request.setupCode);
  if (status.status === "claimed" && status.agent_session_token !== undefined) {
    await finalizeCeremonyClaim(
      request.finalize,
      {
        token: status.agent_session_token,
        account_id: status.account_id ?? "",
        ...(status.install_preferences !== undefined
          ? { preferences: status.install_preferences }
          : {}),
      },
      profileDir,
    );
  }
  return {
    state: "live",
    confirm_url: request.confirmUrl,
    browser_location: { kind: "virtual", url: TUNNEL_URL },
    reused: false,
  };
}

function lastCeremonyStart(): Extract<CeremonyRequest, { action: "start" }> {
  const call = vi
    .mocked(requestBrokerCeremony)
    .mock.calls.map(([, request]) => request)
    .filter((request) => request.action === "start")
    .at(-1);
  if (call === undefined || call.action !== "start") throw new Error("no ceremony start");
  return call;
}

// A start the broker refuses; the live-ceremony read before it still answers.
function refuseCeremonyStart(error: Error): void {
  vi.mocked(requestBrokerCeremony).mockImplementation(async (profileDir, request) => {
    if (request.action === "start") throw error;
    return await emulateBrokerCeremony(profileDir, request);
  });
}

beforeEach(async () => {
  vi.mocked(requestBrokerCeremony).mockReset();
  vi.mocked(requestBrokerCeremony).mockImplementation(emulateBrokerCeremony);
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

it("reports service startup failure before enrollment or config publication", async () => {
  vi.mocked(installBrokerService).mockRejectedValueOnce(
    new Error("Broker not running after user service startup"),
  );
  vi.mocked(installInitiate).mockClear();
  const channel = captureMachineChannel();
  try {
    await expect(
      connect({
        command: "connect",
        target: "codex",
        apiBase: "https://test.invalid",
        skipBrowser: true,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
        json: true,
      }),
    ).rejects.toThrow("Broker not running");
    expect(channel.terminal()).toMatchObject({
      state: "no-browser",
      reason: "run_failed",
      terminal: true,
    });
    expect(installInitiate).not.toHaveBeenCalled();
    await expect(fs.access(AGENTS.codex.config_path())).rejects.toThrow();
  } finally {
    channel.restore();
  }
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

      expect(installBrokerService).toHaveBeenCalledWith(process.env.TRUSTY_SQUIRE_PROFILE_DIR);
      expect(vi.mocked(installBrokerService).mock.invocationCallOrder.at(-1)).toBeLessThan(
        vi.mocked(installInitiate).mock.invocationCallOrder.at(-1)!,
      );
      const configPath = AGENTS[target].config_path();
      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists, `${target}: config file should exist at ${configPath}`).toBe(true);

      expectSquireConfig(await readSquireConfig(target), target, true);
    });
  }

  // The stranding bug: the account was claimed, but the foreground connect
  // that owned the ceremony had stopped polling, so nothing ever collected the
  // token. The broker daemon now holds the ceremony; connect only hands it off
  // and returns, and the claim lands without connect.
  it("hands the sign-in to the broker, whose claim writes the session and config", async () => {
    await connect({
      command: "connect",
      target: "hermes",
      apiBase: "https://test.invalid",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });

    const start = lastCeremonyStart();
    expect(start).toMatchObject({
      confirmUrl: "https://test.invalid/install?token=test_setup_code",
      setupCode: "test_setup_code",
      apiBase: "https://test.invalid",
      finalize: {
        applyServerPrefs: true,
        baseSession: { machine_token: "tsm_test_machine_token" },
        agentConfigs: [
          {
            target: "hermes",
            configPath: AGENTS.hermes.config_path(),
            agentIdentity: "hermes",
            profileDir: process.env.TRUSTY_SQUIRE_PROFILE_DIR,
          },
        ],
      },
    });
    expectSquireConfig(await readSquireConfig("hermes"), "hermes", true);
    const session = await (await openSessionStorage()).read();
    expect(session?.account_id).toBe("acct_test");
    expect(session?.agent_session_token).toBe("ts_agent_test_token");
  });

  // An agent's tool call can end the moment connect prints the window. The
  // machine channel says so: the sign-in is outstanding and this run is over.
  it("ends with a terminal needs-sign-in that carries the live window", async () => {
    vi.mocked(probeProviderSessionsAfterCeremony).mockClear();
    const channel = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
        json: true,
      });
      expect(probeProviderSessionsAfterCeremony).not.toHaveBeenCalled();
      const lines = channel.reports<{ terminal: boolean; state: string }>();
      expect(lines.filter((line) => line.terminal)).toHaveLength(1);
      expect(channel.terminal()).toMatchObject({
        state: "needs-sign-in",
        terminal: true,
        sign_in_url: "https://test.invalid/install?token=test_setup_code",
        browser_location: { kind: "virtual", url: TUNNEL_URL },
      });
      // The person gets the window from connect's own output.
      expect(error.mock.calls.flat().join("\n")).toContain(TUNNEL_URL);
    } finally {
      error.mockRestore();
      channel.restore();
    }
  });

  // The incident had two connects 47s apart, each with its own token and tab on
  // the same display. A connect while a ceremony is live joins it instead.
  it.each([false, true])("joins a live ceremony before preflight (forceRelogin=%s)", async (forceRelogin) => {
    const storage = await openSessionStorage();
    await storage.write({ api_base_url: "https://test.invalid", saved_at: "t",
      account_id: "acct_test", agent_session_token: "agent-token" });
    vi.mocked(detectProviderSessionsFromProfile).mockClear();
    vi.mocked(requestBrokerCeremony).mockImplementation(async (_profileDir, request) => {
      if (request.action === "join") {
        return {
          state: "live",
          confirm_url: "https://test.invalid/install?token=first_code",
          browser_location: { kind: "virtual", url: TUNNEL_URL },
          reused: false,
        };
      }
      throw new Error("a second connect must not start a ceremony");
    });
    vi.mocked(installInitiate).mockClear();
    vi.mocked(issueMachineToken).mockClear();
    // connect only asks a broker that is listening.
    const socket = path.join(tmpHome, "broker.sock");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(socket, resolve));
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", socket);
    const channel = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin,
        noRegistry: false,
        noInteractive: true,
        json: true,
      });
      expect(requestBrokerCeremony).toHaveBeenCalledWith(expect.any(String), {
        action: "join", agentConfigs: [expect.objectContaining({ target: "hermes", configPath: AGENTS.hermes.config_path() })],
      });
      expect(detectProviderSessionsFromProfile).not.toHaveBeenCalled();
      expect(installInitiate).not.toHaveBeenCalled();
      expect(issueMachineToken).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join("\n")).toContain(TUNNEL_URL);
      // Nothing about the live sign-in is disturbed, not even by a re-login.
      expect(clearProviderCookies).not.toHaveBeenCalled();
      expect(channel.terminal()).toMatchObject({
        state: "needs-sign-in",
        terminal: true,
        sign_in_url: "https://test.invalid/install?token=first_code",
        browser_location: { kind: "virtual", url: TUNNEL_URL },
      });
    } finally {
      error.mockRestore();
      channel.restore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  // The noVNC helpers now run in the broker daemon, whose environment is not
  // the person's. Their own tunnel travels with the request.
  it("sends the caller's named login tunnel with the ceremony start", async () => {
    vi.stubEnv("TS_LOGIN_PUBLIC_HOSTNAME", "login.example.test");
    vi.stubEnv("TS_LOGIN_LOCAL_PORT", "6080");
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
      });
      expect(lastCeremonyStart().namedTunnel).toEqual({
        hostname: "login.example.test",
        port: 6080,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A broker from before this change cannot be running a daemon-owned
  // ceremony; its refusal of the read must not fail an ordinary connect.
  it("treats an outdated broker's ceremony read as no live ceremony", async () => {
    vi.mocked(requestBrokerCeremony).mockImplementation(async (profileDir, request) => {
      if (request.action === "join") throw new BrokerRefusal("broker_outdated", "old broker");
      return await emulateBrokerCeremony(profileDir, request);
    });
    await connect({
      command: "connect",
      target: "hermes",
      apiBase: "https://test.invalid",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });
    expect(lastCeremonyStart().setupCode).toBe("test_setup_code");
  });

  it("still checks the bot profile after a --skip-browser claim", async () => {
    vi.mocked(probeProviderSessionsAfterCeremony).mockClear();
    vi.mocked(probeProviderSessionsAfterCeremony).mockResolvedValueOnce([]);
    const channel = captureMachineChannel();
    try {
      await expect(
        connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: true,
          forceRelogin: false,
          noRegistry: false,
          noInteractive: true,
          json: true,
        }),
      ).rejects.toThrow('process.exit unexpectedly called with "1"');
      expect(probeProviderSessionsAfterCeremony).toHaveBeenCalledOnce();
      expect(channel.terminal()).toMatchObject({
        state: "no-browser",
        reason: "provider_session_missing",
        account: { providers: [] },
      });
    } finally {
      channel.restore();
    }
  });

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

  it("reconnects Hermes in its recorded profile from lock through browser", async () => {
    vi.mocked(probeProviderSessionsAfterCeremony).mockClear();
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
      expect(requestBrokerCeremony).toHaveBeenCalledWith(
        hermesProfile,
        expect.objectContaining({
          action: "start",
          finalize: expect.objectContaining({
            agentConfigs: [
              {
                target: "hermes",
                configPath: AGENTS.hermes.config_path(),
                agentIdentity: "hermes",
                profileDir: hermesProfile,
              },
            ],
          }),
        }),
      );
      expect(probeProviderSessionsAfterCeremony).not.toHaveBeenCalled();
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
    await fs.mkdir(hermesProfile, { recursive: true });
    const anchor = profileDeviceAnchor(hermesProfile);
    if (anchor === null) throw new Error("profile has no device anchor");
    await writeBrokerUnitMarker(hermesProfile, {
      version: 1,
      socket: path.join(tmpHome, "broker.sock"),
      profile: anchor,
      accountBinding: "acct_old",
    });
    await fs.writeFile(
      brokerAccountBindingPath(hermesProfile),
      JSON.stringify({ version: 1, accountId: "acct_old" }),
    );
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
      // A live broker holds the profile, so the old binding survives the
      // deferred logout and must be replaced after the claimed sign-in.
      vi.mocked(clearProviderCookies).mockRejectedValueOnce(new ProfileBusyError("profile busy"));
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: true,
        noRegistry: false,
        noInteractive: true,
      });
      // The busy profile's cookie clear rides the ceremony tab instead.
      expect(lastCeremonyStart().forceReloginProviders).toEqual(["google", "github"]);
      expect(clearBrowserProfile).not.toHaveBeenCalledWith(hermesProfile);
      expect(await readBrokerAccountBinding(hermesProfile)).toBe("acct_new");
      const marker = readBrokerUnitMarkerSync(hermesProfile);
      expect(marker.kind).toBe("valid");
      if (marker.kind === "valid") expect(marker.marker.accountBinding).toBe("acct_new");
      await expect(
        brokerConnectionTarget(hermesProfile, path.join(tmpHome, "broker.sock"), {
          accountId: "acct_new",
        }),
      ).resolves.toEqual({ socket: path.join(tmpHome, "broker.sock") });
      await expect(
        brokerConnectionTarget(hermesProfile, path.join(tmpHome, "broker.sock"), {
          accountId: "acct_old",
        }),
      ).rejects.toThrow(/bound to account/);
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

    const { ttlMs } = lastCeremonyStart();
    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000 - (Date.now() - before) + 1_000);
  });

  // Intent item 4: "whether the profile/browser is currently held by another
  // session ... as a code". A ceremony the profile gate refuses is exactly
  // that. Flattening the refusal to a string made it `needs-sign-in` with a
  // live URL, and a caller that opened it elsewhere claimed the install with
  // no provider session in the bot's Chrome — which the run's own gate rejects.
  it("reports a ceremony the profile gate refused as busy, not as a sign-in", async () => {
    refuseCeremonyStart(
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
    refuseCeremonyStart(
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
    refuseCeremonyStart(new BrokerRefusal("broker_lost", "Broker connection is closed"));
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
      expect(lines[0]).toMatchObject({ state: "connecting", terminal: false });
      const signIn = lines.find((line) => line.state === "needs-sign-in");
      expect(signIn?.terminal).toBe(false);
      expect(signIn?.sign_in_url).toBe("https://test.invalid/install?token=test_setup_code");
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
    vi.mocked(requestBrokerCeremony).mockImplementation(async (profileDir, request) =>
      request.action === "start"
        ? {
            state: "unshowable",
            confirm_url: request.confirmUrl,
            reason: "x11vnc is not installed",
          }
        : await emulateBrokerCeremony(profileDir, request),
    );
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
      expect(report.sign_in_url).toBe("https://test.invalid/install?token=test_setup_code");
    } finally {
      exit.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      machine.restore();
    }
  });

  // Item 5 is answered where the browser was placed. A virtual display carries
  // the address that reaches it, on the line that ends the run, while the
  // daemon keeps the tunnel up.
  it("reports the virtual display and its live address when it hands off", async () => {
    vi.mocked(installPoll).mockResolvedValue({ status: "pending" });
    const machine = captureMachineChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await connect({
        command: "connect",
        target: "hermes",
        apiBase: "https://test.invalid",
        skipBrowser: false,
        forceRelogin: false,
        noRegistry: false,
        noInteractive: true,
        json: true,
      });
      const lines = machine.reports<{
        terminal: boolean;
        state: string;
        sign_in_url: string | null;
        browser_location: { kind: string; url?: string };
      }>();
      expect(lines[0]).toMatchObject({ state: "connecting", terminal: false });
      const settled = lines.at(-1);
      expect(settled?.terminal).toBe(true);
      expect(settled?.state).toBe("needs-sign-in");
      expect(settled?.sign_in_url).toBe("https://test.invalid/install?token=test_setup_code");
      expect(settled?.browser_location).toEqual({ kind: "virtual", url: TUNNEL_URL });
      // Nothing was claimed, so nothing was written yet.
      expect(await (await openSessionStorage()).read()).toBeNull();
    } finally {
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

  it.each(["google", "github"] as const)(
    "rebinds after a scoped %s refresh claims a different account",
    async (provider) => {
      const hermesProfile = path.join(tmpHome, "profiles", `hermes-scoped-${provider}`);
      await fs.mkdir(hermesProfile, { recursive: true });
      const anchor = profileDeviceAnchor(hermesProfile);
      if (anchor === null) throw new Error("profile has no device anchor");
      await writeBrokerUnitMarker(hermesProfile, {
        version: 1,
        socket: path.join(tmpHome, "broker.sock"),
        profile: anchor,
        accountBinding: "acct_scoped_original",
      });
      await fs.writeFile(
        brokerAccountBindingPath(hermesProfile),
        JSON.stringify({ version: 1, accountId: "acct_scoped_original" }),
      );
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
        agent_session_token: "ts_agent_new",
        account_id: "acct_scoped_new",
      });
      const previousProfile = process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      const previousAccount = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      try {
        vi.mocked(clearProviderCookies).mockRejectedValueOnce(new ProfileBusyError("profile busy"));
        if (provider === "github") {
          vi.mocked(detectProviderSessionsFromProfile).mockResolvedValueOnce(["google", "github"]);
        }
        await connect({
          command: "connect",
          target: "hermes",
          apiBase: "https://test.invalid",
          skipBrowser: false,
          forceRelogin: true,
          forceReloginProvider: provider,
          noRegistry: false,
          noInteractive: true,
        });
        const config = await readSquireConfig("hermes");
        expect(config.env).toMatchObject({
          TRUSTY_SQUIRE_ACCOUNT_ID: "acct_scoped_new",
          TRUSTY_SQUIRE_PROFILE_DIR: hermesProfile,
        });
        expect(await readBrokerAccountBinding(hermesProfile)).toBe("acct_scoped_new");
        const marker = readBrokerUnitMarkerSync(hermesProfile);
        expect(marker.kind).toBe("valid");
        if (marker.kind === "valid") expect(marker.marker.accountBinding).toBe("acct_scoped_new");
      } finally {
        if (previousProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
        else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previousProfile;
        if (previousAccount === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
        else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = previousAccount;
      }
    },
  );
});
