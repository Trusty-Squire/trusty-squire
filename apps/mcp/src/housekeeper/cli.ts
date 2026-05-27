// CLI entry for `mcp housekeeper`. The merged verifier + discoverer
// + harvester.
//
// Common usage:
//
//   # closed-loop validation + freshness (the old verifier worker)
//   REGISTRY_ADMIN_BEARER=… mcp housekeeper --once
//
//   # autonomous discovery against telemetry (the old discoverer)
//   REGISTRY_ADMIN_BEARER=… TRUSTY_SQUIRE_MACHINE_TOKEN=… \
//   TRUSTY_SQUIRE_ACCOUNT_ID=… UNIVERSAL_BOT_LLM_TIER=free \
//   mcp housekeeper --queue=discovery --once
//
//   # curated harvester run (the old harvester)
//   REGISTRY_ADMIN_BEARER=… TRUSTY_SQUIRE_MACHINE_TOKEN=… \
//   TRUSTY_SQUIRE_ACCOUNT_ID=… mcp housekeeper \
//   --queue=seed --from=tools/archived-harvester/services.yaml --once
//
//   # ad-hoc single service
//   mcp housekeeper --service=openrouter
//
// Notifier flags (combine freely): --telegram, --github-issues.
// The default log notifier (stderr lines) is always on.
//
// Operator-only tool; not shipped in the npm tarball.

import { BrowserController } from "../bot/browser.js";
import { replaySkill, type ReplayOutcome } from "../bot/replay-skill.js";
import { pickLLMClient } from "../bot/llm-client.js";
import { VerifierRegistryClient } from "./registry-client.js";
import {
  runOneBatch,
  runHousekeeperLoop,
  type HousekeeperOpts,
  type ReplayMode,
} from "./housekeeper-loop.js";
import {
  RegistryVerifierQueue,
  RegistryDiscoveryQueue,
  YamlSeedQueue,
  AdHocServiceQueue,
  type QueueProvider,
} from "./queue.js";
import { LogNotifier, type Notifier } from "./notifier.js";

const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

type QueueMode = "verifier" | "discovery" | "seed";

interface ParsedArgs {
  once: boolean;
  limit: number | undefined;
  intervalSeconds: number | undefined;
  replayMode: ReplayMode;
  queueMode: QueueMode;
  service: string | undefined;
  seedPath: string | undefined;
  registryUrl: string;
  adminBearer: string | undefined;
  enableTelegram: boolean;
  enableGithubIssues: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    once: false,
    limit: undefined,
    intervalSeconds: undefined,
    replayMode: "full",
    queueMode: "verifier",
    service: undefined,
    seedPath: undefined,
    registryUrl:
      process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL,
    adminBearer: process.env.REGISTRY_ADMIN_BEARER,
    enableTelegram: false,
    enableGithubIssues: false,
  };
  for (const arg of argv) {
    if (arg === "--once") args.once = true;
    else if (arg === "--dry") args.replayMode = "dry";
    else if (arg === "--full") args.replayMode = "full";
    else if (arg === "--queue=verifier") args.queueMode = "verifier";
    else if (arg === "--queue=discovery") args.queueMode = "discovery";
    else if (arg === "--queue=seed") args.queueMode = "seed";
    else if (arg === "--telegram") args.enableTelegram = true;
    else if (arg === "--github-issues") args.enableGithubIssues = true;
    else if (arg.startsWith("--service=")) {
      args.service = arg.slice("--service=".length);
    } else if (arg.startsWith("--from=")) {
      args.seedPath = arg.slice("--from=".length);
    } else if (arg.startsWith("--limit=")) {
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
      console.error(`housekeeper: unknown arg "${arg}"`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: mcp housekeeper [options]

The merged verifier + discoverer + harvester. Pulls a queue of
tasks, drives them through the universal bot (or skill replay for
the verifier queue), posts outcomes to the registry + any wired
notifiers.

Queue modes (pick one — default: verifier):
  --queue=verifier          Registry's pending-review + freshness
                            queue. Skills replayed; outcomes drive
                            promote/retire/demote transitions.
  --queue=discovery         Telemetry-driven candidates (services
                            with ≥3 distinct user failures, no
                            skill yet).
  --queue=seed --from=PATH  Curated YAML list (former harvester
                            services.yaml). Status:skip excluded.
  --service=SLUG            Ad-hoc single-service mode. Overrides
                            --queue. Bot runs once against SLUG.

Notifier flags (combine freely; log notifier always on):
  --telegram                Send each outcome via TELEGRAM_BOT_TOKEN.
  --github-issues           Open/edit/close a GitHub Issue per
                            service. Uses 'gh' CLI; expects
                            GH_REPO env (default Trusty-Squire/
                            trusty-squire).

Pacing:
  --once                    Single batch then exit. Default loops.
  --limit=N                 Tasks per batch (1..100, default 20).
  --interval-seconds=N      Sleep between batches (default 43200 = 12h).
  --dry / --full            Replay mode for verifier queue (default --full).

Auth:
  --registry-url=URL        Override TRUSTY_SQUIRE_REGISTRY_URL.
  --admin-bearer=TOKEN      Override REGISTRY_ADMIN_BEARER.

Required env per mode:
  verifier:    REGISTRY_ADMIN_BEARER
  discovery:   REGISTRY_ADMIN_BEARER + TRUSTY_SQUIRE_MACHINE_TOKEN
               + TRUSTY_SQUIRE_ACCOUNT_ID
  seed:        TRUSTY_SQUIRE_MACHINE_TOKEN + TRUSTY_SQUIRE_ACCOUNT_ID
  --service:   same as discovery
`);
}

export async function runHousekeeperCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  // Always-on log notifier; optional ones layer on top.
  const notifiers: Notifier[] = [new LogNotifier()];
  if (args.enableTelegram) {
    const { TelegramNotifier } = await import("./telegram-notifier.js");
    notifiers.push(new TelegramNotifier());
  }
  if (args.enableGithubIssues) {
    const { GithubIssueNotifier } = await import("./github-issue-notifier.js");
    notifiers.push(new GithubIssueNotifier());
  }

  // Registry client always constructed; queues that don't need it
  // (YAML seed, ad-hoc) just don't call it. Verifier replay POST
  // does require it — fail fast if missing for verifier mode.
  if (
    (args.queueMode === "verifier" || args.queueMode === "discovery") &&
    args.service === undefined &&
    (args.adminBearer === undefined || args.adminBearer.length === 0)
  ) {
    console.error(
      `housekeeper: REGISTRY_ADMIN_BEARER (or --admin-bearer=) is required for --queue=${args.queueMode}`,
    );
    return 2;
  }
  const client = new VerifierRegistryClient({
    baseUrl: args.registryUrl,
    adminBearer: args.adminBearer ?? "missing-admin-bearer-unused-by-this-queue",
  });

  // Pick queue provider. --service overrides --queue.
  let queue: QueueProvider;
  if (args.service !== undefined && args.service.length > 0) {
    queue = new AdHocServiceQueue(args.service);
  } else if (args.queueMode === "verifier") {
    queue = new RegistryVerifierQueue(client);
  } else if (args.queueMode === "discovery") {
    queue = new RegistryDiscoveryQueue(client);
  } else {
    if (args.seedPath === undefined || args.seedPath.length === 0) {
      console.error(
        "housekeeper: --queue=seed requires --from=<path-to-services.yaml>",
      );
      return 2;
    }
    queue = new YamlSeedQueue({ path: args.seedPath });
  }

  // Replay runner — always constructed so a misconfigured LLM env
  // surfaces at startup rather than mid-batch. Only invoked for
  // 'replay' tasks (verifier queue).
  const llm = pickLLMClient();
  void llm;
  const replay = async (input: {
    skill: import("@trusty-squire/adapter-sdk").Skill;
    mode: "dry" | "full";
  }): Promise<ReplayOutcome> => {
    const browser = new BrowserController({});
    try {
      await browser.start();
      return await replaySkill({ skill: input.skill, browser, mode: input.mode });
    } finally {
      try {
        await browser.close();
      } catch {
        // shutdown noise — replay outcome is already captured
      }
    }
  };

  // Discovery runner: only required when the queue can produce
  // 'discover' tasks. Lazy-imported so the verifier-only path
  // doesn't pull in the bot session machinery.
  let discover: HousekeeperOpts["discover"];
  if (queue.name !== "verifier") {
    const { runDiscoveryBot } = await import("./discovery-bot.js");
    discover = async (input: { service: string }) => runDiscoveryBot(input);
  }

  const opts: HousekeeperOpts = {
    queue,
    client,
    replay,
    replayMode: args.replayMode,
    once: args.once,
    notifiers,
    ...(discover !== undefined ? { discover } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.intervalSeconds !== undefined
      ? { intervalMs: args.intervalSeconds * 1000 }
      : {}),
  };

  try {
    if (args.once) await runOneBatch(opts);
    else await runHousekeeperLoop(opts);
    return 0;
  } catch (err) {
    console.error(
      `housekeeper: fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
