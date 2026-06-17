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
  runHealLoop,
  type HousekeeperOpts,
  type ReplayMode,
} from "./orchestrator.js";
import { createReplayRunner, createProbeRunner, type FreshVerifyRunner } from "./modes/verify.js";
import { verifyPoolConfigured } from "./identity-pool.js";
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
// 'heal' (T7) chains verify→discover in one scheduled pass and emits a
// single digest — the self-healing loop.
// 'fix' (C2) is the output-side step: read the failure batch from the capture
// dir, drive the holistic fix-agent against the eval gate, commit RCs to the
// `next` channel. See docs/DESIGN-autonomous-output-loop.md.
type Mode = "verify" | "discover" | "heal" | "fix" | "fresh-verify";

interface ParsedArgs {
  once: boolean;
  limit: number | undefined;
  intervalSeconds: number | undefined;
  replayMode: ReplayMode;
  mode: Mode;
  service: string | undefined;
  oauthProvider: "google" | "github" | undefined;
  signupUrl: string | undefined; // fresh-verify: override the bot's URL guess
  skillId: string | undefined; // fresh-verify: report the converged verdict to this skill
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
    signupUrl: undefined,
    skillId: undefined,
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
    else if (arg === "--mode=heal") args.mode = "heal";
    else if (arg === "--mode=fix") args.mode = "fix";
    else if (arg === "--mode=fresh-verify") args.mode = "fresh-verify";
    else if (arg === "--telegram") args.enableTelegram = true;
    else if (arg === "--github-issues") args.enableGithubIssues = true;
    else if (arg.startsWith("--service=")) {
      args.service = arg.slice("--service=".length);
    } else if (arg.startsWith("--signup-url=")) {
      args.signupUrl = arg.slice("--signup-url=".length);
    } else if (arg.startsWith("--skill-id=")) {
      args.skillId = arg.slice("--skill-id=".length);
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
  --mode=fix                Output-side loop (C2). Reads the failure
                            batch from the capture dir, drives the
                            holistic fix-agent against the planner
                            eval gate, and commits surviving fixes to
                            staging (the next/RC channel). Needs git
                            + a local coding CLI (TRUSTY_SQUIRE_FIX_
                            AGENT_CLI, default 'claude -p'); set
                            TRUSTY_SQUIRE_FIX_AGENT_PUSH=1 to push.
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

  Inter-run (protects the residential exit from reputation burn — env):
  UNIVERSAL_BOT_RUN_COOLDOWN_SEC  Base cooldown between live signups (default 60; 0 disables).
  UNIVERSAL_BOT_DAILY_SIGNUP_CAP  Max live signups/day before the batch stops (default 88; 0 = ∞).
  UNIVERSAL_BOT_PACE_MAX_BACKOFF  Cap on the adaptive multiplier when runs hit IP-risk (default 5).
  (Cooldown grows base×(1+streak) per consecutive OAuth-reject / dropped-conn /
   timeout / no-signup run, and resets on a clean success.)

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

// Auto-load ~/.config/trusty-squire/harvester.env for manual `node dist/bin.js
// housekeeper` runs (the systemd timer pulls it in via EnvironmentFile=, a
// hand-run shell does not). Now shared with the install/login CLI — see
// ../operator-env.ts for the rationale (re-exported for existing importers).
import { loadHarvesterEnvFile } from "../operator-env.js";
export { loadHarvesterEnvFile };

// Fill TRUSTY_SQUIRE_MACHINE_TOKEN / _ACCOUNT_ID / _API_BASE from the
// session file (keytar or ~/.config/trusty-squire/session.json, whichever
// the install used) when the env doesn't already carry them. Best-effort
// + non-overwriting: an existing env value always wins, and a
// missing/unreadable session is a no-op (the downstream guards then fire
// as before). Lets the systemd heal timer run without duplicating the
// machine token into harvester.env.
async function backfillOperatorCredsFromSession(): Promise<void> {
  if (
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN !== undefined &&
    process.env.TRUSTY_SQUIRE_ACCOUNT_ID !== undefined
  ) {
    return;
  }
  try {
    const { openSessionStorage } = await import("../session.js");
    const session = await (await openSessionStorage()).read();
    if (session === null) return;
    if (
      process.env.TRUSTY_SQUIRE_MACHINE_TOKEN === undefined &&
      session.machine_token !== undefined
    ) {
      process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = session.machine_token;
    }
    if (
      process.env.TRUSTY_SQUIRE_ACCOUNT_ID === undefined &&
      session.account_id !== undefined
    ) {
      process.env.TRUSTY_SQUIRE_ACCOUNT_ID = session.account_id;
    }
    if (
      process.env.TRUSTY_SQUIRE_API_BASE === undefined &&
      session.api_base_url !== undefined
    ) {
      process.env.TRUSTY_SQUIRE_API_BASE = session.api_base_url;
    }
  } catch {
    // best-effort — the downstream "not set" guards surface the problem.
  }
}

export async function runHousekeeperCli(argv: readonly string[]): Promise<number> {
  // Auto-load ~/.config/trusty-squire/harvester.env for manual runs (the
  // systemd timer gets it via EnvironmentFile=; a hand-run shell otherwise
  // wouldn't, so REGISTRY_ADMIN_BEARER / proxy / notifier tokens were silently
  // absent). Non-overwriting, so explicit env exports still win. MUST run
  // before parseArgs — parseArgs snapshots process.env.REGISTRY_ADMIN_BEARER
  // into args.adminBearer, so loading after it would leave the bearer unseen.
  loadHarvesterEnvFile();

  // Memory-overhaul Phase 4 — the drainable-ledger + STATE.md subcommands are
  // a different shape from the --mode runs (subcommand + id + flags), so they
  // dispatch early, before parseArgs. Operator-only (REGISTRY_ADMIN_BEARER).
  if (argv[0] === "issue" || argv[0] === "state-doc") {
    const { runLedgerCli } = await import("./modes/ledger-cli.js");
    return await runLedgerCli(argv);
  }

  const args = parseArgs(argv);

  // Reap stale sibling housekeeper runs before we touch the shared Chrome
  // profile / proxy. The signup-lock watchdog is in-process + self-policing, so
  // it can't kill a zombie on an older dist or one hung in teardown (outside the
  // lock window) — MEASURED 2026-06-12: 6h+ --service= discover zombies on the CF
  // cluster pinned Chrome+Xvfb+proxy and skewed every concurrent verify replay.
  // A fresh run on the current dist is the only actor that can reliably clean
  // them up. Best-effort, never throws.
  try {
    const { reapStaleHousekeepers } = await import("./reaper.js");
    reapStaleHousekeepers();
  } catch {
    // reaper unavailable / non-linux — proceed
  }

  // Process-level self-deadline (defense-in-depth above the in-run signup-lock
  // watchdog). The watchdog only covers the lock window; a hang in browser
  // teardown / auto-promote / telemetry — AFTER the lock released — has no
  // guard, and bin.ts only process.exit()s once the run RETURNS. This absolute
  // wall guarantees the process dies even if it wedges outside the lock. unref()
  // so it never itself keeps the loop alive. Single-service/discover runs get a
  // tight ceiling; a full heal pass gets a loose backstop.
  const selfDeadlineS = args.mode === "heal" ? 4 * 60 * 60 : 25 * 60;
  const selfDeadline = setTimeout(() => {
    console.error(
      `[housekeeper] SELF-DEADLINE: process exceeded ${Math.round(
        selfDeadlineS / 60,
      )}min — hard-exiting to avoid a lock-starving zombie (mode=${args.mode ?? "?"})`,
    );
    process.exit(2);
  }, selfDeadlineS * 1000);
  selfDeadline.unref();

  // Backfill the operator credentials from the session file when they
  // aren't already in the env. The machine token + account id live in
  // session.json (the same file the MCP server + install flow read), NOT
  // in harvester.env — so the systemd heal timer (EnvironmentFile=
  // harvester.env) used to fail every discover phase with
  // "TRUSTY_SQUIRE_MACHINE_TOKEN is not set". Populate process.env once
  // here so every downstream reader works unchanged: the discover guard,
  // the LLM proxy client (llm-client.ts reads the env directly), and the
  // inbox client. Hand-rolled wrappers that already export the vars are
  // unaffected (we only fill blanks).
  await backfillOperatorCredsFromSession();

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

  // C2 — fix mode: the output-side step. Reads the failure batch from the
  // capture dir and drives the fix-agent against the eval gate; commits RCs to
  // staging (the `next` channel). Needs no registry bearer — it's git + the
  // local coding CLI + the local eval corpus. Handle it before the
  // bearer-required guard below.
  if (args.mode === "fix") {
    const { runFixMode } = await import("./modes/fix.js");
    try {
      const res = await runFixMode({});
      if (res !== null) {
        console.log(
          `[fix] committed=${res.committed.length} walls=${res.walls.length} parked=${res.parked.length}`,
        );
      }
      return 0;
    } catch (err) {
      console.error(
        `housekeeper: fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // fresh-verify mode: verify a service by fresh-signing-up as N robot
  // identities, driving the verdict off the bounded sequential-confidence
  // sampler (D2) instead of replaying as a returning user. Needs a configured
  // identity pool + operator machine token + account id.
  if (args.mode === "fresh-verify") {
    if (args.service === undefined) {
      console.error("housekeeper --mode=fresh-verify needs --service=<slug>");
      return 2;
    }
    const { runFreshVerify } = await import("./modes/fresh-verify.js");
    try {
      const res = await runFreshVerify({
        service: args.service,
        ...(args.signupUrl !== undefined ? { signupUrl: args.signupUrl } : {}),
        ...(args.skillId !== undefined ? { skillId: args.skillId } : {}),
      });
      if (res.kind === "not_configured") {
        console.error("[fresh-verify] no identity pool — see ~/.trusty-squire/verify-identities.json");
        return 1;
      }
      if (res.kind === "insufficient_identities") {
        console.log(`[fresh-verify] ${args.service}: pool exhausted (${res.available} unspent) — mint more robots`);
        return 1;
      }
      console.log(
        `[fresh-verify] ${args.service}: ${res.verdict.toUpperCase()} ` +
          `(${res.successes}✓/${res.failures}✗, LCB ${res.passRateLcb.toFixed(2)}/` +
          `UCB ${res.passRateUcb.toFixed(2)}, ${res.samples} sample(s))`,
      );
      // promote → 0 (success). reject/hold → 1 (no promotion this pass); hold is
      // "not enough signal", reject is "the recipe failed", both non-zero.
      return res.verdict === "promote" ? 0 : 1;
    } catch (err) {
      console.error(`housekeeper: fatal: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Registry client always constructed; queues that don't need it
  // (YAML seed, ad-hoc) just don't call it. Verifier replay POST
  // does require it — fail fast if missing for verify mode and for
  // telemetry-sourced discover (the discovery candidates endpoint is
  // admin-gated). --from-sourced discover + --service don't hit the
  // admin API.
  if (
    (args.mode === "verify" ||
      args.mode === "heal" ||
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

  // T7 — heal mode: chain verify→discover in one pass + one digest. Needs
  // BOTH a replay runner (verifier queue) and a discover runner (telemetry
  // candidates, which now include freshly-demoted services via T5).
  if (args.mode === "heal") {
    const { runDiscover } = await import("./modes/discover.js");
    const healDiscover: HousekeeperOpts["discover"] = (input: {
      service: string;
      oauthProvider?: "google" | "github";
      signupUrl?: string;
      allowExtraOAuthScopes?: readonly string[];
    }) => runDiscover(input);
    // D2.D — wire the fresh-identity confidence sampler into the scheduled verify
    // batch when an identity pool is configured on this box. The verify batch
    // then routes OAuth-based skills through N independent fresh signups (the
    // sequential-confidence verdict) instead of single-account replay — the
    // diverging path the identity-pool redesign was meant to replace. Email-only
    // skills, and boxes with no pool, stay on single-account replay (the runner
    // falls back). Lazy-imported so the bot/inbox deps load only when used.
    let healFreshVerify: FreshVerifyRunner | undefined;
    if (verifyPoolConfigured()) {
      const { runFreshVerify } = await import("./modes/fresh-verify.js");
      healFreshVerify = (input) =>
        runFreshVerify({
          service: input.service,
          skillId: input.skillId,
          ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
          ...(input.oauthProvider !== undefined ? { oauthProvider: input.oauthProvider } : {}),
        });
      console.error(
        "[housekeeper] heal: identity pool configured — verify batch uses fresh-identity confidence sampler for OAuth skills",
      );
    } else {
      console.error(
        "[housekeeper] heal: no identity pool — verify batch stays on single-account replay",
      );
    }
    const base = {
      client,
      notifiers,
      replay: createReplayRunner(),
      // Auto-probe-before-retire: a brittle replay failure on a still-servable
      // page must not retire a working skill (the fly.io bug).
      probe: createProbeRunner(),
      discover: healDiscover,
      ...(healFreshVerify !== undefined ? { freshVerify: healFreshVerify } : {}),
      replayMode: args.replayMode,
      once: args.once,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    };
    // --from=<yaml> → the daily curated sweep (the autonomous engine over
    // ~100 services). Skip services that already have an ACTIVE skill — they're
    // served by replay, so re-discovering them burns signup budget and piles up
    // duplicate pending-review skills; the freed slots go to net-new coverage
    // (OF#1). Without --from, heal discovers from telemetry candidates +
    // freshly-demoted services (the candidates endpoint already excludes active).
    const healDiscoverQueue =
      args.seedPath !== undefined && args.seedPath.length > 0
        ? new YamlSeedQueue({
            path: args.seedPath,
            excludeActiveFn: () => client.fetchActiveServices(),
          })
        : new RegistryDiscoverQueue(client);
    try {
      await runHealLoop({
        verify: { ...base, queue: new RegistryVerifierQueue(client) },
        discover: { ...base, queue: healDiscoverQueue },
        notifiers,
        once: args.once,
        ...(args.intervalSeconds !== undefined
          ? { intervalMs: args.intervalSeconds * 1000 }
          : {}),
      });
      return 0;
    } catch (err) {
      console.error(
        `housekeeper: fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

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
    let allowExtraOAuthScopes: readonly string[] | undefined;
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
        if (
          Array.isArray(yamlEntry.allow_extra_oauth_scopes) &&
          yamlEntry.allow_extra_oauth_scopes.length > 0
        ) {
          allowExtraOAuthScopes = yamlEntry.allow_extra_oauth_scopes;
        }
      }
    }
    queue = new AdHocServiceQueue(args.service, oauthProvider, signupUrl, allowExtraOAuthScopes);
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

  // Auto-probe-before-retire runner — invoked by handleReplay when a replay
  // failure would otherwise count toward demotion, to tell brittleness from rot.
  const probe = createProbeRunner();

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
      allowExtraOAuthScopes?: readonly string[];
    }) => runDiscover(input);
  }

  const opts: HousekeeperOpts = {
    queue,
    client,
    replay,
    probe,
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
