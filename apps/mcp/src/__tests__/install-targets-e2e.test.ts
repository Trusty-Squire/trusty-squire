// E2E #3 — the install CLI works against the five host agents users
// commonly run: claude-code, codex, goose, cursor, opencode. For each target,
// this test:
//   1. Runs the same connect() entrypoint runCli dispatches to.
//   2. Mocks the external dependencies (API handshake + ASN detection
//      + OAuth login + keytar) so the test is hermetic.
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
import type * as BotModule from "../bot/index.js";
import type * as GoogleLoginModule from "../bot/google-login.js";

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

// keytar's native binding does real keychain writes on macOS / a real
// libsecret call on Linux. Force the test through the file storage
// fallback by making the dynamic import reject.
vi.mock("keytar", () => {
  throw new Error("keytar disabled in tests");
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

// Imported after the vi.mock calls so connect() sees the mocks. The
// install/cli.ts module pulls in api-client + bot at top level, so
// this ordering is load-bearing.
import { connect } from "../install/cli.js";
import { AGENTS } from "../install/agents.js";

const TARGETS = ["claude-code", "codex", "goose", "cursor", "opencode"] as const;

let originalHome: string | undefined;
let originalXdg: string | undefined;
let originalOpenCodeConfig: string | undefined;
let tmpHome: string;

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

      // Sanity: the file mentions "squire" — any of JSON / YAML / TOML
      // outputs include the entry key by that name.
      const raw = await fs.readFile(configPath, "utf8");
      expect(raw, `${target}: config should reference the squire entry`).toMatch(
        /squire|trusty-squire/,
      );
      // Skill-registry URL is written when registry participation is enabled.
      // That same choice is also the user's skillification consent.
      expect(raw, `${target}: config should set TRUSTY_SQUIRE_REGISTRY_URL when enabled`).toMatch(
        /TRUSTY_SQUIRE_REGISTRY_URL/,
      );
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
    const raw = await fs.readFile(AGENTS[TARGETS[0]!].config_path(), "utf8");
    expect(raw).not.toMatch(/TRUSTY_SQUIRE_REGISTRY_URL/);
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
    const raw = await fs.readFile(AGENTS[TARGETS[0]!].config_path(), "utf8");
    expect(raw).not.toMatch(/TRUSTY_SQUIRE_REGISTRY_URL/);
    const sessionPath = path.join(process.env.XDG_CONFIG_HOME!, "trusty-squire", "session.json");
    const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as {
      consent_skillify_telemetry?: boolean;
      consent_operator_inbox_otp?: boolean;
    };
    expect(session.consent_skillify_telemetry).toBe(false);
    expect(session.consent_operator_inbox_otp).toBe(false);
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
      const raw = await fs.readFile(AGENTS[TARGETS[0]!].config_path(), "utf8");
      expect(raw).toMatch(/registry\.trustysquire\.ai/);
      expect(raw).not.toMatch(/staging\.registry\.test/);
      const sessionPath = path.join(process.env.XDG_CONFIG_HOME!, "trusty-squire", "session.json");
      const session = JSON.parse(await fs.readFile(sessionPath, "utf8")) as {
        consent_skillify_telemetry?: boolean;
        consent_operator_inbox_otp?: boolean;
      };
      expect(session.consent_skillify_telemetry).toBe(true);
      expect(session.consent_operator_inbox_otp).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
      else process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
    }
  });
});
