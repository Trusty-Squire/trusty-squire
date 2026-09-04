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
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type * as BotModule from "../bot/index.js";
import type * as GoogleLoginModule from "../bot/google-login.js";
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
    // install() probes live provider cookies via detectActiveProviderSessions,
    // which launches a REAL persistent-context Chrome on the bot profile. In a
    // test that contends with any running browser (e.g. a concurrent
    // housekeeper harvest holding the profile lock) it blocks ~15s + retries
    // and times the suite out. An e2e must not launch a real browser — stub it.
    detectActiveProviderSessions: vi.fn(async () => ["google"] as const),
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
import { detectActiveProviderSessions } from "../bot/google-login.js";
import { connect, resolveServerLaunch } from "../install/cli.js";
import { AGENTS } from "../install/agents.js";
import { openSessionStorage } from "../session.js";

const TARGETS = ["claude-code", "codex", "goose", "cursor", "opencode"] as const;

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
): void {
  const launch = resolveServerLaunch();
  expect(config.command).toBe(launch.command);
  expect(config.args).toEqual(launch.args);
  const env = asRecord(config.env, `${target} squire environment`);
  expect(env).toMatchObject({
    TRUSTY_SQUIRE_AGENT_IDENTITY: target,
    TRUSTY_SQUIRE_ACCOUNT_ID: accountId,
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
    vi.mocked(detectActiveProviderSessions).mockImplementationOnce(async () => {
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
});
