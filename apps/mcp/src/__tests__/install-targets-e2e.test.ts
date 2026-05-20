// E2E #3 — the install CLI works against the four host agents users
// commonly run: claude-code, codex, goose, cursor. For each target,
// this test:
//   1. Runs the same install() entrypoint runCli dispatches to.
//   2. Mocks the external dependencies (API handshake + ASN detection
//      + OAuth login + keytar) so the test is hermetic.
//   3. Sandboxes HOME to a tmpdir so the writeConfig step lands in
//      a throwaway directory and never touches the user's real config.
//   4. Asserts the agent's config file is created at the agent's
//      `config_path()` and contains a `squire` MCP server entry.
//
// Per-target write semantics (JSON for claude-code/cursor/cline, YAML
// for goose, TOML for codex) are already covered by agents.test.ts.
// This file proves the install pipeline drives the right writer for
// each --target value.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks for the install pipeline's external collaborators.
// Hoisted by vitest before the install/cli.js import below, so the
// install() function sees the mocked versions.

vi.mock("../api-client.js", () => ({
  // Canned install handshake — pretend the API issued a machine token
  // immediately and the user confirmed in the browser within ms.
  issueMachineToken: vi.fn(async () => ({
    machine_token: "tsm_test_machine_token",
    quota_limit: 10,
    quota_used: 0,
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
  const actual = await vi.importActual<typeof import("../bot/index.js")>("../bot/index.js");
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
  const actual = await importOriginal<typeof import("../bot/google-login.js")>();
  return {
    ...actual,
    ensureOAuthSession: vi.fn(async () => ({ status: "logged_in" as const })),
  };
});

// Imported after the vi.mock calls so install() sees the mocks. The
// install/cli.ts module pulls in api-client + bot at top level, so
// this ordering is load-bearing.
import { install } from "../install/cli.js";
import { AGENTS } from "../install/agents.js";

const TARGETS = ["claude-code", "codex", "goose", "cursor"] as const;

let originalHome: string | undefined;
let originalXdg: string | undefined;
let tmpHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-install-e2e-"));
  process.env.HOME = tmpHome;
  // Some session-storage code paths read XDG_CONFIG_HOME directly —
  // re-anchor that too so nothing escapes the sandbox.
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
  else delete process.env.XDG_CONFIG_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("install --target=<agent> writes a valid config", () => {
  for (const target of TARGETS) {
    it(`works for --target=${target}`, async () => {
      await install({
        command: "install",
        target,
        apiBase: "https://test.invalid",
        // Skip the bot's Chrome — `open()` the URL in the default
        // browser instead. Irrelevant to "does install write a config
        // for this target," and keeps the test fast (no Chrome boot).
        skipBrowser: true,
        forceRelogin: false,
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
    });
  }
});
