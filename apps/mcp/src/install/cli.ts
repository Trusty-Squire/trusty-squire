#!/usr/bin/env node
// Install / uninstall CLI.
//
// Flows:
//   install              → detect agents, pair, write config
//   install --target=X   → skip detection, pair, write config for X
//   logout               → clear keychain/file session
//
// Usage:
//   npx @trusty-squire/mcp install
//   npx @trusty-squire/mcp install --target=claude-code
//   npx @trusty-squire/mcp logout

import process from "node:process";
import { pairInitiate, pairPoll } from "../api-client.js";
import { openSessionStorage } from "../session.js";
import { AGENTS, detectInstalledAgents, type AgentTarget } from "./agents.js";

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://api.trustysquire.ai";

type Argv = { command: string; target?: AgentTarget; apiBase: string };

function parseArgs(argv: string[]): Argv {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = positional[0] ?? "install";
  let target: AgentTarget | undefined;
  let apiBase = DEFAULT_API_BASE;
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      const t = arg.slice("--target=".length);
      if (isAgentTarget(t)) target = t;
    }
    if (arg.startsWith("--api-base=")) {
      apiBase = arg.slice("--api-base=".length);
    }
  }
  return target !== undefined ? { command, target, apiBase } : { command, apiBase };
}

function isAgentTarget(s: string): s is AgentTarget {
  return s === "claude-code" || s === "cursor" || s === "goose" || s === "cline" || s === "continue";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "logout") return logout();
  if (args.command !== "install" && args.command !== "help") {
    console.error(`unknown command: ${args.command}`);
    console.error("usage: squire-mcp install [--target=<agent>] [--api-base=<url>]");
    process.exit(64);
  }
  if (args.command === "help") {
    printHelp();
    return;
  }
  await install(args);
}

async function install(args: Argv): Promise<void> {
  // ── Resolve target ──────────────────────────────────────────
  let target = args.target;
  if (target === undefined) {
    const detected = await detectInstalledAgents();
    if (detected.length === 1) {
      target = detected[0]!.target;
      console.warn(`Detected ${detected[0]!.display_name}. Configuring squire for it.`);
    } else if (detected.length > 1) {
      console.error("Multiple agents detected. Please pass --target=<agent>:");
      for (const a of detected) console.error(`  --target=${a.target}  (${a.display_name})`);
      process.exit(2);
    } else {
      console.error("No coding agents auto-detected. Pass --target= explicitly:");
      for (const a of Object.values(AGENTS)) {
        console.error(`  --target=${a.target}  (${a.display_name})`);
      }
      process.exit(2);
    }
  }
  const agent = AGENTS[target];

  // ── Pair ──────────────────────────────────────────────────
  console.warn(`Pairing this machine with Trusty Squire…`);
  const initiate = await pairInitiate(args.apiBase, target);
  console.warn(`Open this URL in your browser to confirm:`);
  console.warn(`  ${initiate.pair_url}`);

  // Best-effort browser open; failure is non-fatal (the user can
  // copy/paste the URL).
  try {
    const openMod = await import("open");
    await openMod.default(initiate.pair_url);
  } catch {
    // ignore
  }

  // ── Poll ──────────────────────────────────────────────────
  const sessionToken = await pollForClaim(args.apiBase, initiate.pair_token);
  if (sessionToken === null) {
    console.error("Pairing timed out or expired. Re-run `squire-mcp install` to try again.");
    process.exit(1);
  }

  // ── Save session ──────────────────────────────────────────
  const storage = await openSessionStorage();
  await storage.write({
    agent_session_token: sessionToken.token,
    account_id: sessionToken.account_id,
    api_base_url: args.apiBase,
    saved_at: new Date().toISOString(),
  });
  console.warn(`✓ Session saved (${storage.backendName()}).`);

  // ── Write agent config ────────────────────────────────────
  await agent.writeConfig({
    command: "npx",
    args: ["-y", "@trusty-squire/mcp"],
    env: { TRUSTY_SQUIRE_AGENT_IDENTITY: target },
  });
  console.warn(`✓ Wrote ${agent.display_name} MCP config at ${agent.config_path()}.`);
  console.warn(`Restart ${agent.display_name} to pick up the new tools.`);
}

async function logout(): Promise<void> {
  const storage = await openSessionStorage();
  await storage.clear();
  console.warn(`✓ Cleared local session (${storage.backendName()}).`);
}

function printHelp(): void {
  console.warn(`squire-mcp — install Trusty Squire MCP into a coding agent`);
  console.warn(``);
  console.warn(`Commands:`);
  console.warn(`  install [--target=<agent>] [--api-base=<url>]`);
  console.warn(`  logout`);
  console.warn(``);
  console.warn(`Agents: ${Object.keys(AGENTS).join(", ")}`);
}

interface ClaimResult {
  token: string;
  account_id: string;
}

async function pollForClaim(
  apiBase: string,
  pairToken: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<ClaimResult | null> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await pairPoll(apiBase, pairToken);
    if (status.status === "claimed" && status.agent_session_token !== undefined) {
      return {
        token: status.agent_session_token,
        account_id: status.account_id ?? "",
      };
    }
    if (status.status === "expired") return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { install, logout, parseArgs, pollForClaim };
