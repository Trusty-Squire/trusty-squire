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
//   mcp housekeeper --mode=discover --once
//
//   # curated harvester run (the old harvester) — discover from a YAML
//   REGISTRY_ADMIN_BEARER=… TRUSTY_SQUIRE_MACHINE_TOKEN=… \
//   TRUSTY_SQUIRE_ACCOUNT_ID=… mcp housekeeper \
//   --mode=discover --from=tools/housekeeper-services.yaml --once
//
//   # ad-hoc single service
//   mcp housekeeper --service=openrouter
//
// Notifier flags (combine freely): --telegram, --github-issues.
// The default log notifier (stderr lines) is always on.
//
// Operator-only tool; not shipped in the npm tarball.

// pickLLMClient was used for an eager startup preflight that the
// verifier path didn't actually need. 0.8.3 removed the preflight;
// discover's LLM init now happens lazily inside runDiscover.
import { VerifierRegistryClient } from "./registry-client.js";
import {
  runOneBatch,
  runHousekeeperLoop,
  type HousekeeperOpts,
  type ReplayMode,
} from "./orchestrator.js";
import { createReplayRunner } from "./modes/verify.js";
import {
  RegistryVerifierQueue,
  RegistryDiscoverQueue,
  YamlSeedQueue,
  AdHocServiceQueue,
  lookupServiceInYaml,
  type QueueProvider,
} from "./queues/index.js";
import { LogNotifier, type Notifier } from "./notifier.js";

const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

// Two runners: verify (skill replay) and discover (universal bot).
// 'discover' is fed by either telemetry candidates or a curated YAML
// (--from); the YAML feed is the former "harvest" path.
type Mode = "verify" | "discover";

interface ParsedArgs {
  once: boolean;
  limit: number | undefined;
  intervalSeconds: number | undefined;
  replayMode: ReplayMode;
  mode: Mode;
  service: string | undefined;
  oauthProvider: "google" | "github" | undefined;
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
    mode: "verify",
    service: undefined,
    oauthProvider: undefined,
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
    else if (arg === "--mode=verify") args.mode = "verify";
    else if (arg === "--mode=discover") args.mode = "discover";
    else if (arg === "--telegram") args.enableTelegram = true;
    else if (arg === "--github-issues") args.enableGithubIssues = true;
    else if (arg.startsWith("--service=")) {
      args.service = arg.slice("--service=".length);
    } else if (arg.startsWith("--oauth-provider=")) {
      const v = arg.slice("--oauth-provider=".length);
      if (v !== "google" && v !== "github") {
        console.error(`housekeeper: --oauth-provider must be google|github (got ${v})`);
        process.exit(2);
      }
      args.oauthProvider = v;
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
tasks, drives them through skill replay (verify mode) or the
universal bot (discover mode), posts outcomes to the registry +
any wired notifiers.

Modes (pick one — default: verify):
  --mode=verify             Registry's pending-review + freshness
                            queue. Skills replayed; outcomes drive
                            promote/retire/demote transitions.
  --mode=discover           Drive the universal bot at a service
                            slug. Source defaults to telemetry
                            candidates (services with ≥3 distinct
                            user failures, no skill yet); pass
                            --from=PATH to source from a curated
                            YAML list instead (former harvester
                            services.yaml — status:skip excluded).
  --service=SLUG            Ad-hoc single-service mode. Implies
                            discover. Bot runs once against SLUG.
  --oauth-provider=google|github
                            Force the bot's OAuth-first scan to look
                            for THIS provider on the signup page.
                            Use alongside --service= when the YAML
                            isn't being read.

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
  --dry / --full            Replay mode for verify mode (default --full).

Auth:
  --registry-url=URL        Override TRUSTY_SQUIRE_REGISTRY_URL.
  --admin-bearer=TOKEN      Override REGISTRY_ADMIN_BEARER.

Required env per mode:
  verify:              REGISTRY_ADMIN_BEARER
  discover (telemetry): REGISTRY_ADMIN_BEARER + TRUSTY_SQUIRE_MACHINE_TOKEN
                        + TRUSTY_SQUIRE_ACCOUNT_ID
  discover --from=:    TRUSTY_SQUIRE_MACHINE_TOKEN + TRUSTY_SQUIRE_ACCOUNT_ID
  --service:           same as discover --from=
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
  // does require it — fail fast if missing for verify mode and for
  // telemetry-sourced discover (the discovery candidates endpoint is
  // admin-gated). --from-sourced discover + --service don't hit the
  // admin API.
  if (
    (args.mode === "verify" ||
      (args.mode === "discover" && args.seedPath === undefined)) &&
    args.service === undefined &&
    (args.adminBearer === undefined || args.adminBearer.length === 0)
  ) {
    console.error(
      `housekeeper: REGISTRY_ADMIN_BEARER (or --admin-bearer=) is required for --mode=${args.mode}`,
    );
    return 2;
  }
  const client = new VerifierRegistryClient({
    baseUrl: args.registryUrl,
    adminBearer: args.adminBearer ?? "missing-admin-bearer-unused-by-this-queue",
  });

  // Pick queue provider. --service overrides --mode. --mode=verify →
  // verifier queue; --mode=discover → telemetry candidates, or the
  // curated YAML when --from= is set.
  let queue: QueueProvider;
  if (args.service !== undefined && args.service.length > 0) {
    // When --from=<yaml> is also set, try to enrich the ad-hoc task
    // with that YAML's curated signup_url + oauth_provider for the
    // matching slug. Without this enrichment, ad-hoc runs against
    // services with non-.com domains (ipinfo.io, console.anthropic.com)
    // hit guessSignupUrl(slug) → https://<slug>.com/signup which is
    // wrong for most non-trivial services. Falls back silently to
    // slug-only if the YAML doesn't have the slug or can't be parsed.
    let signupUrl: string | undefined;
    let oauthProvider = args.oauthProvider;
    if (args.seedPath !== undefined && args.seedPath.length > 0) {
      const yamlEntry = await lookupServiceInYaml(args.seedPath, args.service);
      if (yamlEntry !== null) {
        if (
          signupUrl === undefined &&
          typeof yamlEntry.signup_url === "string" &&
          yamlEntry.signup_url.length > 0
        ) {
          signupUrl = yamlEntry.signup_url;
        }
        if (
          oauthProvider === undefined &&
          (yamlEntry.oauth_provider === "google" || yamlEntry.oauth_provider === "github")
        ) {
          oauthProvider = yamlEntry.oauth_provider;
        }
      }
    }
    queue = new AdHocServiceQueue(args.service, oauthProvider, signupUrl);
  } else if (args.mode === "verify") {
    queue = new RegistryVerifierQueue(client);
  } else if (args.seedPath === undefined || args.seedPath.length === 0) {
    // --mode=discover, no --from → telemetry candidates.
    queue = new RegistryDiscoverQueue(client);
  } else {
    // --mode=discover --from=PATH → curated YAML (former harvest).
    queue = new YamlSeedQueue({ path: args.seedPath });
  }

  // Replay runner — invoked for 'replay' tasks (verifier queue).
  // The verifier-only template-value synthesis + BrowserController
  // lifecycle lives in modes/verify.ts; this just wires it.
  const replay = createReplayRunner();

  // Discover runner: only required when the queue can produce
  // 'discover' tasks. Lazy-imported so the verifier-only path
  // doesn't pull in the bot session machinery.
  let discover: HousekeeperOpts["discover"];
  if (queue.name !== "verifier") {
    const { runDiscover } = await import("./modes/discover.js");
    // The lambda has to mirror DiscoveryBotRunner's full shape — the
    // previous version dropped signupUrl on the floor (rc.3 plumbed
    // the YAML field through the task queue, but the cli's discover
    // lambda was still constructing a 2-field input and stripping it).
    discover = async (input: {
      service: string;
      oauthProvider?: "google" | "github";
      signupUrl?: string;
    }) => runDiscover(input);
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
