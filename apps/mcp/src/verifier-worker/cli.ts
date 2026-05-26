// CLI entry for `mcp verifier-worker`. Glues the loop to the real
// replaySkill engine + a Playwright browser.
//
// Production usage:
//
//   REGISTRY_ADMIN_BEARER=… \
//   UNIVERSAL_BOT_LLM_TIER=free \
//   npx @trusty-squire/mcp verifier-worker --once
//
// Loops continuously when --once is omitted, sleeping 12h between
// batches by default (twice-daily cadence).

import { BrowserController } from "../bot/browser.js";
import { replaySkill, type ReplayOutcome } from "../bot/replay-skill.js";
import { pickLLMClient } from "../bot/llm-client.js";
import { VerifierRegistryClient } from "./registry-client.js";
import { runOneBatch, runVerifierLoop } from "./loop.js";

const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

interface ParsedArgs {
  once: boolean;
  limit: number | undefined;
  intervalSeconds: number | undefined;
  // Replay mode for the verifier path. Discovery mode ignores this.
  replayMode: "dry" | "full";
  // 'verifier' = closed-loop Phase 3 (validate pending-review skills).
  // 'discovery' = closed-loop Phase 6 (iterate against services with
  // many user-failures and no skill yet).
  workerMode: "verifier" | "discovery";
  registryUrl: string;
  adminBearer: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    once: false,
    limit: undefined,
    intervalSeconds: undefined,
    replayMode: "full",
    workerMode: "verifier",
    registryUrl:
      process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL,
    adminBearer: process.env.REGISTRY_ADMIN_BEARER,
  };
  for (const arg of argv) {
    if (arg === "--once") args.once = true;
    else if (arg === "--dry") args.replayMode = "dry";
    else if (arg === "--full") args.replayMode = "full";
    else if (arg === "--mode=discovery") args.workerMode = "discovery";
    else if (arg === "--mode=verifier") args.workerMode = "verifier";
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    } else if (arg.startsWith("--interval-seconds=")) {
      const n = Number(arg.slice("--interval-seconds=".length));
      if (Number.isFinite(n) && n > 0) args.intervalSeconds = Math.floor(n);
    } else if (arg.startsWith("--registry-url=")) {
      args.registryUrl = arg.slice("--registry-url=".length);
    } else if (arg.startsWith("--admin-bearer=")) {
      args.adminBearer = arg.slice("--admin-bearer=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`verifier-worker: unknown arg "${arg}"`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: mcp verifier-worker [options]

Pulls the registry's verifier queue (pending-review skills awaiting
promotion + active skills whose freshness window has elapsed), runs
each replay, posts the outcome back.

Options:
  --once                    Run a single batch and exit. Default loops.
  --limit=N                 Skills per batch (1..100, default 20).
  --interval-seconds=N      Sleep between batches (default 43200 = 12h).
  --dry / --full            Replay mode (default --full).
  --mode=verifier           Pending-review + freshness sweep (default).
  --mode=discovery          Iterate against universal-bot-failure
                            candidates that have no skill yet. The
                            actual bot invocation is gated until
                            operator-credential wiring lands; for now
                            this mode logs what would be attempted.
  --registry-url=<url>      Override TRUSTY_SQUIRE_REGISTRY_URL.
  --admin-bearer=<token>    Override REGISTRY_ADMIN_BEARER.

Required env (or matching CLI flags):
  REGISTRY_ADMIN_BEARER     Bearer for /admin/* on the registry.

Recommended env:
  UNIVERSAL_BOT_LLM_TIER=free   Use the free-tier LLM chain (verifier
                                is async; quality drops are tolerable).
  TRUSTY_SQUIRE_MACHINE_TOKEN   Bot machine token for the LLM proxy.
`);
}

export async function runVerifierWorkerCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.adminBearer === undefined || args.adminBearer.length === 0) {
    console.error(
      "verifier-worker: REGISTRY_ADMIN_BEARER (or --admin-bearer=) is required",
    );
    return 2;
  }
  const client = new VerifierRegistryClient({
    baseUrl: args.registryUrl,
    adminBearer: args.adminBearer,
  });
  // Eager-construct the LLM client so a misconfiguration (no machine
  // token + no BYOK key) errors at startup, not deep in a replay.
  const llm = pickLLMClient();
  void llm;
  const replay = async (input: {
    skill: import("@trusty-squire/adapter-sdk").Skill;
    mode: "dry" | "full";
  }): Promise<ReplayOutcome> => {
    // Each replay spins up a fresh browser. T14 in the original spec
    // calls this out — sharing a profile across services leaks
    // sessions; the verifier wants a clean slate per skill.
    const browser = new BrowserController({});
    try {
      await browser.start();
      return await replaySkill({ skill: input.skill, browser, mode: input.mode });
    } finally {
      try {
        await browser.close();
      } catch {
        // Swallow shutdown noise — the parent loop already has the
        // outcome, browser leaks are diagnosed via the bot's own logs.
      }
    }
  };
  if (args.workerMode === "discovery") {
    const { runDiscoveryBatch, runDiscoveryLoop } = await import("./discovery-loop.js");
    // The universal-bot invocation is deferred to a future
    // wiring pass. For now the loop is observability-only —
    // logs each candidate and what would be attempted. Wire to
    // provisionAnyTool.handler when ready.
    const runUniversalBot = async (input: { service: string }) => {
      console.error(
        `[discovery] TODO: invoke universal-bot for service=${input.service}. ` +
          `Wire to provisionAnyTool.handler when discovery is ready to drive real signups.`,
      );
      return { kind: "failed" as const, reason: "discovery_bot_invocation_not_wired" };
    };
    const discOpts = {
      client,
      runUniversalBot,
      once: args.once,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.intervalSeconds !== undefined
        ? { intervalMs: args.intervalSeconds * 1000 }
        : {}),
    };
    try {
      if (args.once) await runDiscoveryBatch(discOpts);
      else await runDiscoveryLoop(discOpts);
      return 0;
    } catch (err) {
      console.error(
        `discovery-worker: fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  const opts = {
    client,
    replay,
    once: args.once,
    mode: args.replayMode,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.intervalSeconds !== undefined
      ? { intervalMs: args.intervalSeconds * 1000 }
      : {}),
  };
  try {
    if (args.once) {
      await runOneBatch(opts);
    } else {
      await runVerifierLoop(opts);
    }
    return 0;
  } catch (err) {
    console.error(
      `verifier-worker: fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
