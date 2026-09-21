// Setup CLI — connect / settings / logout subcommands.
//
// `connect` is the ONE onboarding AND re-auth pathway. There is no separate
// `login` command: a second command that could seed a provider session
// independently of the account claim is exactly how an install ended up
// "connected" with no live Google session.
//
//   npx @trusty-squire/mcp connect --target=claude-code
//     Issues a machine token, then opens the trustysquire install-
//     confirm page in the bot's own Chrome. The user signs in there
//     once with Google — that single sign-in does TWO things:
//       (a) trustysquire claims the install and binds the machine to
//           the user's account, and
//       (b) the bot's Chrome profile gains a provider session it can
//           ride on future signups (Resend, Postmark, etc.).
//     One Google login, both jobs done — and connect only reports success
//     once it has re-probed the profile and seen that session LIVE.
//
//   npx @trusty-squire/mcp connect --force-relogin[=google|github]
//     Re-auth. Clears the selected provider (or the whole profile) and
//     re-runs the same ceremony. This replaces `login --provider=…`.
//
//   npx @trusty-squire/mcp logout
//
// Flags:
//   --target=<agent>     skip auto-detection
//   --api-base=<url>     override the API base URL
//   --skip-browser       don't launch the bot's Chrome; just print the
//                        confirm URL and expect the user to open it in
//                        their own browser (CI / scripted installs)
//   --no-registry        disable managed registry participation
//
// Pure module — `runCli()` is invoked by bin.ts. No shebang, no
// entrypoint guard, no top-level execution.

import process from "node:process";
import { cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadHarvesterEnvFile } from "../operator-env.js";
import { fileURLToPath } from "node:url";
import { installInitiate, installPoll, issueMachineToken } from "../api-client.js";
import { openSessionStorage, type SessionData } from "../session.js";
import {
  AGENTS,
  detectInstalledAgents,
  writeClaudeCodePermissions,
  type AgentDefinition,
  type AgentTarget,
} from "./agents.js";
import { detectAsn, type AsnInfo } from "../bot/index.js";
import {
  detectProviderSessionsFromProfile,
  openInstallConfirmInBotChrome,
  probeProviderSessionsAfterCeremony,
  type InstallClaimPollResult,
} from "../bot/google-login.js";
import { type OAuthProviderId } from "../bot/oauth-providers.js";
import { clearBrowserProfile, clearProviderCookies } from "../bot/login-state.js";
import {
  CHROME_PROFILE_DIR,
  PROFILE_BUSY_MESSAGE,
  ProfileBusyError,
  profilePathIdentity,
  withProfileOperationGuard,
} from "../bot/profile.js";
import { VERSION } from "../version.js";
import { isBrowserContentionRefusal } from "../bot/broker/discovery.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { ensureLatestVersion, VersionUpdateRequiredError } from "./version-check.js";
import * as ui from "./ui.js";
import {
  runInteractiveSetup,
  runSettingsSetup,
  shouldRunInteractive,
  showOutro,
} from "./interactive.js";
import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";
import {
  alreadyConnectedMessage,
  beginConnectRun,
  buildConnectReport,
  connectIncompleteMessage,
  decideConnectComplete,
  decideConnectPreflight,
  emitConnectReport,
  emitConnectUsageError,
  preflightUnverifiedMessage,
  providersConnectMustAwait,
  snapshotConnectHolder,
  type ConnectBrowserLocation,
  type ConnectOutcome,
} from "./connect-report.js";

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
// Mirrors PAIR_TTL_MS in apps/api/src/auth/pairing-token.ts. Held as a
// duration, never as a comparison against the server's clock. Drift is caught
// from the server side by apps/api/src/__tests__/pairing-token-ttl.test.ts and
// from this side by the ceremony-deadline test in install-targets-e2e.
const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
// Managed skill-registry URL. Advanced setup decides whether this is written
// into the MCP config; the URL itself is product-owned and not user-editable.
const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

type ProviderArg = "google" | "github";

type Argv = {
  command: string;
  target?: AgentTarget;
  apiBase: string;
  // --account=<id>: sessions are stored one per account, so `logout` needs to
  // say WHICH account it is clearing. Defaults to the most recently connected.
  account?: string;
  // Optional 2Captcha API key from advanced setup. Stored ENCRYPTED in the
  // vault (never written to the MCP config) by maybeStoreTwoCaptchaKey once the
  // session is paired; the bot spends it through the injecting proxy.
  twoCaptchaKey?: string;
  // Skill registry is product-owned infrastructure. Advanced setup controls
  // whether this install participates; registry ON is also the user's consent
  // to contribute successful non-personal signup recipes back to the registry.
  noRegistry: boolean;
  registryConfigured?: boolean;
  // --skip-browser:
  // don't launch the bot's Chrome at the confirm URL. Print the URL
  // for the user to open in their own browser, then poll for claim.
  // If that ceremony leaves no live provider session in the bot's Chrome,
  // connect reports the install as incomplete (see decideConnectComplete)
  // rather than pretending an OAuth-capable install exists.
  skipBrowser: boolean;
  // --force-relogin: skip the install preflight that short-circuits
  // when an existing session + bot Google login are already valid.
  // Use this to switch the bound Google account or recover a
  // suspect-stale session.
  forceRelogin: boolean;
  // Optional scoped form: --force-relogin=google|github. Bare
  // --force-relogin remains the full-profile account-switch escape hatch.
  forceReloginProvider?: ProviderArg;
  // --no-interactive: skip the clack picker even in a TTY. Useful for
  // scripted runs that still want a normal Chrome confirm (i.e. don't
  // imply --skip-browser).
  noInteractive: boolean;
  // --json: print the typed connect report on stdout. Human copy stays
  // on stderr. Additive — an interactive run without this flag is unchanged.
  json?: boolean;
  advancedConfigured?: boolean;
  consentOperatorInboxOtp?: boolean;
};

interface InstallConsent {
  skillifyTelemetry: boolean;
  operatorInboxOtp: boolean;
}

// The ONE rule for which subcommand an argv runs. The machine-channel report
// gate asks the same question the parser does, so it must not answer it twice.
// Default (no positional) → `connect` because the most common invocation is
// `npx @trusty-squire/mcp` with no args, and that should kick off setup.
function commandFromArgv(argv: readonly string[]): string {
  return argv.filter((a) => !a.startsWith("--"))[0] ?? "connect";
}

function parseArgs(argv: string[]): Argv {
  const command = commandFromArgv(argv);
  if (command === "install") {
    rejectDeprecatedCli("`install` has been removed. Use `npx @trusty-squire/mcp connect`.");
  }
  if (command === "login") {
    // ONE pathway. `login` seeded a provider session independently of the
    // account claim (so an install could look connected with no live Google
    // session) and drove Google's OAuth through CDP, which Google rejects.
    rejectDeprecatedCli(
      "`login` has been removed. Use `npx @trusty-squire/mcp connect` — " +
        "add `--force-relogin=google` or `--force-relogin=github` to refresh one provider session.",
    );
  }
  let target: AgentTarget | undefined;
  let apiBase = DEFAULT_API_BASE;
  let noRegistry = false;
  let registryConfigured = false;
  let skipBrowser = false;
  let forceRelogin = false;
  let forceReloginProvider: ProviderArg | undefined;
  let noInteractive = false;
  let json = false;
  let account: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      const t = arg.slice("--target=".length);
      if (!isAgentTarget(t)) {
        // Silent-drop is the footgun behind the pre-0.4.2 Goose mishap
        // (--target=goose-typo → auto-detect → wrong agent configured).
        // Fail loud with the valid list so the user sees the mismatch.
        rejectUsage(`unknown --target '${t}'. Valid targets: ${Object.keys(AGENTS).join(", ")}`);
      }
      target = t;
    } else if (arg.startsWith("--api-base=")) {
      apiBase = arg.slice("--api-base=".length);
    } else if (arg.startsWith("--registry-url=")) {
      rejectDeprecatedCli(
        "`--registry-url` has been removed. Trusty Squire uses the managed skill registry.",
      );
    } else if (arg === "--no-registry") {
      noRegistry = true;
      registryConfigured = true;
    } else if (arg === "--registry") {
      rejectDeprecatedCli(
        "`--registry` has been removed because the managed registry is enabled by default.",
      );
    } else if (arg.startsWith("--provider=")) {
      rejectDeprecatedCli(
        "`--provider` has been removed with `login`. Use `connect --force-relogin=google|github`.",
      );
    } else if (arg.startsWith("--account=")) {
      // An empty value must not fall through to "the most recent account":
      // silently clearing a different account than the one named is the
      // silent-destruction class this whole change removes.
      const value = arg.slice("--account=".length).trim();
      if (value.length === 0) {
        rejectUsage("--account requires an account id (e.g. --account=01ABC...)");
      }
      account = value;
    } else if (arg.startsWith("--profile-dir=")) {
      rejectDeprecatedCli(
        "`--profile-dir` has been removed with `login`. `connect` always uses the bot's Chrome profile.",
      );
    } else if (arg === "--skip-browser") {
      skipBrowser = true;
    } else if (arg === "--skip-login") {
      rejectDeprecatedCli("`--skip-login` has been removed. Use `--skip-browser`.");
    } else if (arg === "--force-relogin") {
      forceRelogin = true;
    } else if (arg.startsWith("--force-relogin=")) {
      forceRelogin = true;
      const p = arg.slice("--force-relogin=".length);
      if (p === "google" || p === "github") forceReloginProvider = p;
    } else if (arg === "--skip-secondary") {
      rejectDeprecatedCli("`--skip-secondary` has been removed; connect is single-stage.");
    } else if (arg === "--no-interactive") {
      noInteractive = true;
    } else if (arg === "--json") {
      json = true;
    }
  }
  const args: Argv = {
    command,
    apiBase,
    skipBrowser,
    forceRelogin,
    ...(forceReloginProvider !== undefined ? { forceReloginProvider } : {}),
    noRegistry,
    ...(registryConfigured ? { registryConfigured } : {}),
    // The picker draws on stdout, which is the machine channel under --json.
    noInteractive: noInteractive || json,
    ...(json ? { json } : {}),
  };
  if (target !== undefined) args.target = target;
  if (account !== undefined) {
    if (account.length === 0) {
      rejectDeprecatedCli("`--account` requires a non-empty account ID.");
    }
    args.account = account;
  }
  return args;
}

// Usage failures throw so the caller can still report on the machine channel
// before the process ends; `runCli` keeps the exit code they have always used.
export class CliUsageError extends Error {}

function rejectUsage(message: string): never {
  console.error(message);
  throw new CliUsageError(message);
}

function rejectDeprecatedCli(message: string): never {
  rejectUsage(`[trusty-squire] ${message}`);
}

function isAgentTarget(s: string): s is AgentTarget {
  // Source of truth is AGENTS — adding/removing a target there auto-
  // propagates here, so a new agent (or a removed one) can't drift the
  // accept-list out of sync.
  return s in AGENTS;
}

// The MCP-config command that launches the server. Three cases:
//
// 1. Non-ephemeral — running from a checkout or a `node` invocation
//    that points at a permanent path. Use the absolute bin.js path
//    directly. Deterministic, offline, fast.
//
// 2. Ephemeral — the CLI was invoked via npx, which copies the package into
//    npx's throwaway cache. The cache CAN get swept, so never pin the cache
//    path into a host agent config. Instead write
//    `npx -y @trusty-squire/mcp@<version> server`, which re-resolves the exact
//    published version on each agent launch. This matters for RCs: prerelease
//    versions are published to npm on the `next` tag, so treating every
//    prerelease as a non-registry tarball leaves Goose pointing at dead npx
//    cache paths and stale tool schemas.
/**
 * Copy an npx-style node_modules tree to a stable location.
 *
 * Exported for testing. npx caches frequently contain dangling .bin/*
 * symlinks (e.g. `node_modules/.bin/yaml` → `../yaml/bin/yaml.js` where
 * the target is created lazily by a postinstall script that didn't run
 * in the cache). Default cpSync follows symlinks, stats the target,
 * sees ENOENT, throws.
 *
 * `verbatimSymlinks: true` copies symlinks as symlinks (no target stat)
 * — node's runtime resolver dereferences .bin lazily anyway, so the
 * resulting tree still works for MCP-server launches.
 *
 * On re-install, the destination's `.bin/` already contains symlinks
 * pointing at the PREVIOUS npx cache hash (a different dir for every
 * new install). Node's cpSync with `force: true` doesn't unlink an
 * existing symlink before writing a new one at the same name — it
 * throws EEXIST instead. Wipe the destination first so the copy
 * always lands cleanly. This costs ~1s on disk but the alternative is
 * the install silently leaves users on the ephemeral cache path,
 * which breaks days later when npx GCs the cache.
 */
export function copyNpxNodeModules(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
}

function resolveServerLaunch(): { command: string; args: string[] } {
  const binPath = fileURLToPath(new URL("../bin.js", import.meta.url));
  const ephemeral = /[/\\]_npx[/\\]/.test(binPath);
  if (!ephemeral) {
    return { command: process.execPath, args: [binPath, "server"] };
  }
  return { command: "npx", args: ["-y", `@trusty-squire/mcp@${VERSION}`, "server"] };
}

// Historical fallback for GitHub-release tarball installs. The normal install
// path no longer calls this because RCs are published to npm and host configs
// must not pin npx cache paths. Kept exported for the regression tests around
// copying broken npx symlink trees.
function resolveCopiedNpxServerLaunch(binPath: string): { command: string; args: string[] } {
  // Copy the package PLUS the
  // ephemeral cache's entire `node_modules` to a stable location.
  //
  // We need both because the package imports @modelcontextprotocol/sdk,
  // playwright, etc. at runtime. Node's resolver walks up the directory
  // tree looking for `node_modules/<dep>`; if we copy only the package
  // dir, the resolver finds nothing and fails ERR_MODULE_NOT_FOUND on
  // the first import. Mirroring the cache's `node_modules` structure
  // means the same walk-up resolution works from the stable location.
  //
  // npx cache layout we depend on:
  //   <cache>/
  //     node_modules/
  //       @trusty-squire/mcp/dist/bin.js   ← binPath
  //       @modelcontextprotocol/sdk/...    ← peer at the same level
  //       ...                              ← every other transitive dep
  //
  // We copy the whole `<cache>/node_modules` tree to
  // `~/.trusty-squire/lib/node_modules`, then launch
  // `node .../node_modules/@trusty-squire/mcp/dist/bin.js server`.
  const stableLib = join(homedir(), ".trusty-squire", "lib");
  const stableNodeModules = join(stableLib, "node_modules");
  const pkgRoot = dirname(dirname(binPath)); // dist/bin.js → @trusty-squire/mcp/
  const cacheNodeModules = dirname(dirname(pkgRoot)); // → node_modules/
  const stableBin = join(stableNodeModules, "@trusty-squire", "mcp", "dist", "bin.js");
  try {
    copyNpxNodeModules(cacheNodeModules, stableNodeModules);
  } catch (err) {
    // Defence in depth: if the copy still fails (e.g. EACCES on $HOME),
    // fall back to the in-cache absolute path. Works until npx clears
    // the cache (days-to-weeks later), at which point the MCP server
    // breaks silently mid-session. Surface the warning so users know.
    console.warn(
      `[trusty-squire] couldn't copy node_modules to ~/.trusty-squire/lib ` +
        `(${err instanceof Error ? err.message : String(err)}); using cache path. ` +
        `Re-run install if the MCP server stops working.`,
    );
    return { command: process.execPath, args: [binPath, "server"] };
  }
  return { command: process.execPath, args: [stableBin, "server"] };
}

export async function runCli(argv: string[]): Promise<void> {
  let args: Argv;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      reportUnparsedConnect(argv, err.message);
      process.exit(64);
    }
    throw err;
  }
  loadHarvesterEnvFile();
  try {
    switch (args.command) {
      case "connect":
        await connect(args, argv);
        return;
      case "logout":
        await logout(args);
        return;
      case "settings":
        await settings(args);
        return;
      case "help":
        printHelp();
        return;
      default:
        console.error(`unknown command: ${args.command}`);
        printHelp();
        process.exit(64);
    }
  } catch (err) {
    if (err instanceof TargetUnresolvedError) process.exit(2);
    if (err instanceof VersionUpdateRequiredError) process.exit(70);
    throw err;
  }
}

// A connect that dies inside argv validation never built an `Argv`, so the
// flag is read off the raw argv — the machine channel still owes an answer.
// It is NOT a connection report: nothing about a rejected flag says where a
// browser is or who holds the profile.
function reportUnparsedConnect(argv: readonly string[], message: string): void {
  if (commandFromArgv(argv) !== "connect" || !argv.includes("--json")) return;
  beginConnectRun();
  emitConnectUsageError(message, true);
}

// Store the user-supplied 2Captcha key in the vault (encrypted, never written
// to the MCP config). Idempotent + best-effort: a failure here must never fail
// the install — the bot just won't have the Tier-3 solver. Runs after pairing,
// so the session carries a usable agent_session_token. Clears args.twoCaptchaKey
// on success so the secret doesn't linger in memory longer than needed.
async function maybeStoreTwoCaptchaKey(args: Argv, session: SessionData): Promise<void> {
  const key = args.twoCaptchaKey?.trim();
  if (key === undefined || key.length === 0) return;
  if (session.agent_session_token === undefined) {
    ui.warn("Couldn't vault the 2Captcha key — no active session yet. Re-run connect to retry.");
    return;
  }
  try {
    const res = await fetch(`${session.api_base_url}/v1/vault/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.agent_session_token}`,
      },
      body: JSON.stringify({
        service: "2captcha",
        label: "default",
        value: key,
        type: "api_key",
        // 2Captcha authenticates with the key as the `key` query param
        // (in.php/res.php). The bot's runtime use_credential calls place the
        // ${SECRET} explicitly; this records the canonical shape for the vault.
        auth_shape: "query:key",
        observed_hosts: ["2captcha.com", "api.2captcha.com"],
        env_var_suggestion: "TWOCAPTCHA_API_KEY",
      }),
    });
    if (res.ok) {
      delete args.twoCaptchaKey;
      ui.success("2Captcha key vaulted — the bot spends it through the injecting proxy.");
    } else {
      ui.warn(`Couldn't vault the 2Captcha key (HTTP ${res.status}). Re-run connect to retry.`);
    }
  } catch (err) {
    ui.warn(`Couldn't vault the 2Captcha key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function settings(args: Argv): Promise<void> {
  const storage = await openSessionStorage();
  const session = await storage.read();
  if (session === null) {
    ui.fail(
      `No local Trusty Squire session found. Run ${ui.code("npx @trusty-squire/mcp connect")} first.`,
    );
    process.exit(1);
  }

  if (!args.noInteractive && process.stdin.isTTY === true) {
    const picker = await runSettingsSetup({
      ...(args.target !== undefined ? { initialTarget: args.target } : {}),
      initialRegistryEnabled: session.consent_skillify_telemetry === true,
      initialConsentOperatorInboxOtp: session.consent_operator_inbox_otp !== false,
    });
    args.target = picker.target;
    args.noRegistry = !picker.registryEnabled;
    args.advancedConfigured = true;
    args.consentOperatorInboxOtp = picker.consentOperatorInboxOtp === true;
    if (picker.twoCaptchaKey !== undefined) args.twoCaptchaKey = picker.twoCaptchaKey;
  } else {
    if (args.target === undefined) {
      ui.fail(
        `Pass ${ui.code("--target=<agent>")} when running settings outside an interactive terminal.`,
      );
      process.exit(64);
    }
    if (args.registryConfigured !== true) {
      args.noRegistry = session.consent_skillify_telemetry !== true;
    }
    if (args.consentOperatorInboxOtp === undefined) {
      args.consentOperatorInboxOtp = session.consent_operator_inbox_otp !== false;
    }
  }

  const target = await resolveTarget(args.target);
  const agent = AGENTS[target];
  const updated: SessionData = {
    ...session,
    saved_at: new Date().toISOString(),
    consent_skillify_telemetry: !args.noRegistry,
    consent_operator_inbox_otp: args.consentOperatorInboxOtp !== false,
  };
  await storage.write(updated);
  await writeAgentConfig(target, agent, args, updated);
  await maybeStoreTwoCaptchaKey(args, updated);
  ui.success(`${agent.display_name} settings saved.`);
}

async function connect(args: Argv, argv: readonly string[] = []): Promise<void> {
  beginConnectRun();
  // Every exit path reports, including one that fails before a target or a
  // profile is resolved. `emitConnectReport` drops anything after a terminal
  // line, so this is a floor under the stream rather than an extra report.
  let reportProfileDir = CHROME_PROFILE_DIR;
  // Null until the ceremony is attempted: only then is "no browser opened"
  // something this handler could stop asserting for free.
  const placed: BrowserPlacementSlot = { value: null, ownBrowserPid: null };
  try {
    // `npx …/mcp connect` reuses a stale local copy instead of fetching the
    // latest, and connect then pins the host config to that stale version.
    // Re-exec on the current release first so the one-liner alone lands it.
    await ensureLatestVersion(argv);
    const { target, agent, wantInteractive } = await prepareConnect(args);
    const context = await resolveConnectTargetContext(target, agent);
    const canonicalProfileDir = profilePathIdentity(context.profileDir);
    reportProfileDir = canonicalProfileDir;
    await withConnectTargetEnvironment(
      {
        profileDir: canonicalProfileDir,
        ...(context.accountId !== undefined ? { accountId: context.accountId } : {}),
        agentIdentity: context.agentIdentity,
      },
      async () => {
        // An install that is already connected needs no browser at all. Decide
        // that BEFORE any browser work, or a machine whose browser is busy with
        // other work fails an install it never had to perform.
        if (
          await settleAlreadyConnected(
            args,
            target,
            agent,
            canonicalProfileDir,
            context.accountId,
            context.agentIdentity,
          )
        )
          return;
        // No drain, no exclusive profile guard: the ceremony opens the confirm
        // page as a TAB in the shared browser (the resident broker's Chrome),
        // or — on a machine where no broker can serve yet — launches the
        // operator's own persistent-context browser on the bot profile. It
        // never starts a second instance beside a broker that owns the
        // profile, and it never waits for one to free it.
        await runConnectInstall(
          args,
          target,
          agent,
          canonicalProfileDir,
          context.accountId,
          context.agentIdentity,
          wantInteractive,
          placed,
        );
      },
    );
  } catch (err) {
    // The broker's own message names the resident and the recovery, so it
    // stays the human copy it has always been. Only the refusals that mean
    // another session HAS the browser report `busy`: a broker that died
    // mid-ceremony is this run failing, and telling a caller to wait for a
    // holder that does not exist is worse than naming the failure.
    if (err instanceof ProfileBusyError || err instanceof BrokerRefusal) {
      const contended = err instanceof ProfileBusyError || isBrowserContentionRefusal(err);
      emitConnectStatus(args, {
        outcome: contended ? { kind: "profile_busy" } : { kind: "run_failed" },
        profileDir: reportProfileDir,
        browser_location: placed.value ?? { kind: "none" },
        ownBrowserPid: placed.ownBrowserPid,
      });
      ui.fail(
        err instanceof ProfileBusyError
          ? PROFILE_BUSY_MESSAGE
          : `Couldn't open the confirm page: ${err.message}`,
      );
      process.exit(1);
    }
    emitConnectStatus(args, {
      outcome: { kind: "run_failed" },
      profileDir: reportProfileDir,
      browser_location: placed.value ?? { kind: "none" },
      ownBrowserPid: placed.ownBrowserPid,
    });
    throw err;
  }
}

async function prepareConnect(
  args: Argv,
): Promise<{ target: AgentTarget; agent: AgentDefinition; wantInteractive: boolean }> {
  const wantInteractive =
    !args.noInteractive &&
    shouldRunInteractive({
      hasTty: process.stdin.isTTY === true,
      skipBrowser: args.skipBrowser,
      forceRelogin: args.forceRelogin,
    });
  if (wantInteractive) {
    const picker = await runInteractiveSetup({
      ...(args.target !== undefined ? { initialTarget: args.target } : {}),
      initialRegistryEnabled: !args.noRegistry,
    });
    args.target = picker.target;
    args.noRegistry = !picker.registryEnabled;
    args.advancedConfigured = picker.advancedConfigured;
    if (picker.consentOperatorInboxOtp !== undefined) {
      args.consentOperatorInboxOtp = picker.consentOperatorInboxOtp;
    }
    if (picker.twoCaptchaKey !== undefined) args.twoCaptchaKey = picker.twoCaptchaKey;
  } else {
    ui.heading("Trusty Squire");
    ui.hint("Setting up this machine.");
  }
  const target = await resolveTarget(args.target);
  return { target, agent: AGENTS[target], wantInteractive };
}

export interface ConnectTargetContext {
  profileDir: string;
  accountId?: string;
  agentIdentity: string;
}

function contextValue(
  source: Record<string, string | undefined>,
  key: string,
  label: string,
): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) throw new Error(`${label} has an empty ${key}`);
  return value;
}

/**
 * Resolve reconnect custody before any browser work. Explicit process env wins
 * over the target's recorded launch env; the recorded env wins over
 * first-connect defaults.
 */
export async function resolveConnectTargetContext(
  target: AgentTarget,
  agent: AgentDefinition = AGENTS[target],
  callerEnv: NodeJS.ProcessEnv = process.env,
): Promise<ConnectTargetContext> {
  const configured = (await agent.readConfigEnv()) ?? {};
  const profileDir =
    contextValue(callerEnv, "TRUSTY_SQUIRE_PROFILE_DIR", "caller environment") ??
    contextValue(configured, "TRUSTY_SQUIRE_PROFILE_DIR", `${agent.display_name} config`) ??
    CHROME_PROFILE_DIR;
  const accountId =
    contextValue(callerEnv, "TRUSTY_SQUIRE_ACCOUNT_ID", "caller environment") ??
    contextValue(configured, "TRUSTY_SQUIRE_ACCOUNT_ID", `${agent.display_name} config`);
  const agentIdentity =
    contextValue(callerEnv, "TRUSTY_SQUIRE_AGENT_IDENTITY", "caller environment") ??
    contextValue(configured, "TRUSTY_SQUIRE_AGENT_IDENTITY", `${agent.display_name} config`) ??
    target;
  return {
    profileDir,
    ...(accountId !== undefined ? { accountId } : {}),
    agentIdentity,
  };
}

function emitConnectStatus(
  args: Argv,
  input: {
    outcome: ConnectOutcome;
    profileDir: string;
    browser_location: ConnectBrowserLocation;
    ownBrowserPid?: number | null;
  },
): void {
  emitConnectReport(
    buildConnectReport({
      outcome: input.outcome,
      holder: snapshotConnectHolder(input.profileDir, input.ownBrowserPid ?? null),
      browser_location: input.browser_location,
    }),
    args.json,
  );
}

async function withConnectTargetEnvironment<T>(
  context: ConnectTargetContext,
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [
    "TRUSTY_SQUIRE_PROFILE_DIR",
    "TRUSTY_SQUIRE_ACCOUNT_ID",
    "TRUSTY_SQUIRE_AGENT_IDENTITY",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TRUSTY_SQUIRE_PROFILE_DIR = context.profileDir;
  process.env.TRUSTY_SQUIRE_AGENT_IDENTITY = context.agentIdentity;
  if (context.accountId === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
  else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = context.accountId;
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Settle a connect that needs no login ceremony, using only reads: the stored
 * session, the account-bound plumbing, and a cookie probe of the profile on
 * disk. Returns true when the connect is finished.
 *
 * An existing install is "connected" only when BOTH the account-bound plumbing
 * still works and the bot profile has Google session cookies. A bare
 * machine/agent token can talk to Trusty Squire, but it cannot act as the user
 * at third-party sites, so it must not skip the browser confirm. Pass
 * --force-relogin to bypass (e.g. to switch Google).
 *
 * This runs before any browser work and takes no profile lease: a machine
 * whose browser is busy is exactly the machine this path exists to settle
 * without touching the browser at all.
 */
async function settleAlreadyConnected(
  args: Argv,
  target: AgentTarget,
  agent: AgentDefinition,
  profileDir: string,
  accountId: string | undefined,
  agentIdentity: string,
): Promise<boolean> {
  if (args.forceRelogin) return false;
  const preflight = await checkAlreadyProvisioned(profileDir, accountId);
  if (preflight.kind === "ceremony") return false;
  ui.divider();
  await hydrateArgsFromStoredPreferences(args, accountId);
  await ensureConsentRecorded(consentFromArgs(args), args.advancedConfigured === true, accountId);
  if (preflight.kind === "unverified") {
    await writeAgentConfig(target, agent, args, preflight.session, {
      profileDir,
      agentIdentity,
    });
    await maybeStoreTwoCaptchaKey(args, preflight.session);
    emitConnectStatus(args, {
      outcome: { kind: "unverified", account_id: preflight.session.account_id ?? null },
      profileDir,
      browser_location: { kind: "none" },
    });
    ui.warn(preflightUnverifiedMessage(preflight.detail));
    ui.hint(
      `Close any other Trusty Squire session and re-run ` +
        `${ui.code("npx @trusty-squire/mcp connect --force-relogin")} to verify it.`,
    );
    return true;
  }
  // Connect session validation: we short-circuited because Google is
  // cookie-present + bound, but if GitHub cookies are absent, proactively
  // offer to reconnect it — a missing GitHub session is why people re-run
  // connect (GitHub-OAuth signups fail). Skippable; non-interactive notices.
  // Saying yes falls THROUGH into the same ceremony rather than branching into
  // a second sign-in command.
  const reconnectGithub =
    !preflight.providers.includes("github") && (await offerGithubReloginIfDead(args));
  if (!reconnectGithub) {
    await writeAgentConfig(target, agent, args, preflight.session, {
      profileDir,
      agentIdentity,
    });
    await maybeStoreTwoCaptchaKey(args, preflight.session);
    emitConnectStatus(args, {
      outcome: {
        kind: "provisioned",
        account_id: preflight.session.account_id ?? "",
        providers: preflight.providers,
      },
      profileDir,
      browser_location: { kind: "none" },
    });
    ui.success(alreadyConnectedMessage(preflight.providers, agent.display_name));
    printProviderState(preflight.providers);
    ui.hint(
      `Pass ${ui.code("--force-relogin")} to switch accounts or to refresh a ` +
        `stale/expired session (this "connected" check reads cached cookies, ` +
        `which can outlive the real session).`,
    );
    return true;
  }
  args.forceRelogin = true;
  args.forceReloginProvider = "github";
  return false;
}

async function runConnectInstall(
  args: Argv,
  target: AgentTarget,
  agent: AgentDefinition,
  profileDir: string,
  accountId: string | undefined,
  agentIdentity: string,
  wantInteractive: boolean,
  placed: BrowserPlacementSlot,
): Promise<void> {
  console.warn("");
  console.warn(
    "Opening the Trusty Squire install page in a browser. " +
      "The page walks you through signing in with Google and (optionally) GitHub.",
  );
  // --force-relogin means "redo the OAuth dance from scratch". The scoped
  // form clears only one provider; bare --force-relogin is the full-profile
  // account-switch escape hatch.
  //
  // clearProviderCookies launches its own short-lived headless Chrome and
  // fail-fasts while any other browser holds the profile — including the
  // resident broker's Chrome. Run it BEFORE clearBrowserProfile so an
  // account-switch on a busy machine is refused at the gate instead of
  // deleting the profile directory out from under a live Chrome. Both steps
  // hold ONE profile operation lease (the guard is re-entrant, so the
  // clear's own inner acquisition nests): releasing between them would let
  // a browser claim the now-uncontended profile in the window before the
  // wipe deletes its live user-data-dir. When the clear DOES busy-fail, the
  // clear now rides the upcoming ceremony instead of hard-refusing the
  // re-login: the confirm tab signs the providers out through the shared
  // browser (or the self-launched context, when it wins the profile) — no
  // second Chrome, no drain.
  let deferredReloginProviders: OAuthProviderId[] = [];
  if (args.forceRelogin) {
    const wanted: OAuthProviderId[] =
      args.forceReloginProvider !== undefined ? [args.forceReloginProvider] : ["google", "github"];
    let cleared = false;
    let busy = false;
    try {
      await withProfileOperationGuard(profileDir, async () => {
        if (args.forceReloginProvider !== undefined) {
          cleared = await clearProviderCookies(profileDir, args.forceReloginProvider);
        } else {
          cleared = await clearProviderCookies(profileDir);
          if (cleared) clearBrowserProfile(profileDir);
        }
      });
    } catch (err) {
      if (!(err instanceof ProfileBusyError)) throw err;
      busy = true;
    }
    if (busy) {
      deferredReloginProviders = wanted;
      console.error(
        "[connect] the bot profile is busy, so the old provider sessions will be " +
          "signed out through the sign-in browser instead.",
      );
    } else if (!cleared) {
      emitConnectStatus(args, {
        outcome: { kind: "cookie_clear_failed" },
        profileDir,
        browser_location: { kind: "none" },
      });
      ui.fail(
        "I couldn't verify that the previous provider cookies were cleared. " +
          "Close every Chrome process using the bot profile and retry with --force-relogin.",
      );
      process.exit(1);
    }
  }

  const consent = consentFromArgs(args);

  // Detect egress class so the asn rides along in the install payload
  // (API uses it to correlate captcha failures with network class).
  // Best-effort: a failure returns null and the install continues.
  const asn = await ui.withSpinner({
    start: "Detecting network",
    done: "Network detected",
    fail: () => "Network detection failed (continuing)",
    task: () => detectAsn(),
  });

  // The machine token is the bot-internal credential the operator driver
  // uses for the LLM proxy and the operator inbox-OTP service. It
  // is NOT the user's auth — the agent_session_token (issued via the
  // browser confirm flow below) is. The MCP server reads both from the
  // session file.
  const machine = await ui.withSpinner({
    start: "Issuing machine token",
    done: "Machine token issued",
    task: () => issueMachineToken(args.apiBase, fetch, asn ?? undefined),
  });

  // Warn datacenter users explicitly. The whole captcha-bypass story
  // depends on a residential egress IP — Hetzner / AWS / Codespaces
  // get rejected by reCAPTCHA v2 regardless of fingerprint quality.
  if (asn !== null) {
    printAsnWarning(asn);
  }

  // Browser confirm: bind this machine in the bot's real Chrome profile.
  // The user signs into trustysquire from inside the bot's persistent
  // Chrome profile on a visible display. That
  // single sign-in does TWO things at once: trustysquire claims the
  // install (sets agent_session_token), AND the provider session
  // lands in the bot's Chrome profile so future OAuth-based signups
  // can ride it.
  const baseSession: SessionData = {
    api_base_url: args.apiBase,
    saved_at: new Date().toISOString(),
    machine_token: machine.machine_token,
    consent_skillify_telemetry: consent.skillifyTelemetry,
    consent_operator_inbox_otp: consent.operatorInboxOtp,
  };
  const claim = await runInstallClaim(args.apiBase, target, baseSession, args.skipBrowser, {
    applyServerPrefs: !wantInteractive,
    profileDir,
    placed,
    reportSignInOpen: (confirm_url, browser_location) =>
      emitConnectStatus(args, {
        outcome: { kind: "sign_in_open", confirm_url },
        profileDir,
        browser_location,
        ownBrowserPid: placed.ownBrowserPid,
      }),
    ...(deferredReloginProviders.length ? { forceReloginProviders: deferredReloginProviders } : {}),
  });
  if (claim.kind === "confirm_failed") {
    emitConnectStatus(args, {
      outcome: { kind: "install_unclaimed", confirm_url: claim.confirm_url },
      profileDir,
      browser_location: claim.browser_location,
      ownBrowserPid: placed.ownBrowserPid,
    });
    ui.fail(`Couldn't open the confirm page: ${claim.detail}`);
    process.exit(1);
  }
  if (claim.kind === "expired") {
    emitConnectStatus(args, {
      outcome: { kind: "install_expired" },
      profileDir,
      browser_location: claim.browser_location,
      ownBrowserPid: placed.ownBrowserPid,
    });
    ui.fail(
      `The sign-in window expired before the browser confirm finished. ` +
        `Start again: ${ui.code("npx @trusty-squire/mcp connect")}`,
    );
    process.exit(1);
  }
  if (claim.kind === "unclaimed") {
    emitConnectStatus(args, {
      outcome: { kind: "install_unclaimed", confirm_url: claim.confirm_url },
      profileDir,
      browser_location: claim.browser_location,
      ownBrowserPid: placed.ownBrowserPid,
    });
    ui.fail(
      `Install didn't complete — browser confirm never finished. ` +
        `Try again: ${ui.code("npx @trusty-squire/mcp connect")}`,
    );
    process.exit(1);
  }
  const session = claim.session;
  if (
    args.forceReloginProvider !== undefined &&
    accountId !== undefined &&
    session.account_id !== accountId
  ) {
    emitConnectStatus(args, {
      outcome: { kind: "account_switch_refused" },
      profileDir,
      browser_location: claim.browser_location,
      ownBrowserPid: placed.ownBrowserPid,
    });
    ui.fail(
      `The scoped ${args.forceReloginProvider} refresh returned a different Trusty Squire account. ` +
        `Refusing to replace ${agent.display_name}'s account binding; use bare --force-relogin ` +
        `only when you intend to switch accounts.`,
    );
    process.exit(1);
  }

  const storage = await openSessionStorage();
  await storage.write(session);
  ui.success(`Session saved (${storage.path})`);
  args.noRegistry = session.consent_skillify_telemetry !== true;
  args.consentOperatorInboxOtp = session.consent_operator_inbox_otp !== false;

  // Probe the real profile. Cookie/session state is the source of truth; no
  // persisted provider marker is allowed to outlive the session it describes.
  // This probe is also the SUCCESS GATE: the machine claim alone proves the
  // account plumbing, not that the bot can wear the user's identity at a third-
  // party site. After a broker-hosted ceremony the broker's Chrome still holds
  // the profile, so the live probe busy-fails: probeProviderSessionsAfterCeremony
  // falls back to the committed-cookie snapshot (polling past Chrome's ~30s
  // commit lag) instead of failing the gate for winning the broker path.
  // `null` means the probe itself failed, which is not a pass.
  let providers: OAuthProviderId[] | null = null;
  try {
    providers = await ui.withSpinner({
      start: "Checking provider sessions",
      done: "Provider sessions checked",
      fail: () => "Provider session check failed",
      task: () =>
        probeProviderSessionsAfterCeremony(profileDir, {
          awaitProviders: providersConnectMustAwait(args.forceReloginProvider),
        }),
    });
  } catch (err) {
    console.error(
      `[connect] provider-session probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  printProviderState(providers ?? []);

  // Config + key land either way: the session is real and re-running connect
  // must be able to pick up from here. Only the SUCCESS claim is gated.
  await writeAgentConfig(target, agent, args, session, { profileDir, agentIdentity });
  await maybeStoreTwoCaptchaKey(args, session);

  const complete = decideConnectComplete(providers, args.forceReloginProvider);
  emitConnectStatus(args, {
    outcome: {
      kind: "ceremony_complete",
      account_id: session.account_id ?? "",
      providers,
      ...(args.forceReloginProvider !== undefined
        ? { requested_provider: args.forceReloginProvider }
        : {}),
    },
    profileDir,
    browser_location: claim.browser_location,
    ownBrowserPid: placed.ownBrowserPid,
  });
  if (!complete.ok) {
    ui.fail(connectIncompleteMessage(complete.reason, args.skipBrowser));
    process.exit(1);
  }

  // Visual consistency: when the picker was running, close with
  // clack's `outro` so the bookends match. The flag-driven path keeps
  // the boxen panel (its callers are typically CI / logs where
  // clack's box would look noisier).
  const closingLine =
    `Squire on duty. Restart ${agent.display_name} to pick up the new tools. ` +
    `Try it — ask your agent: ${ui.code(`"sign me up for Resend"`)}`;
  if (wantInteractive) {
    showOutro(closingLine);
  } else {
    ui.divider();
    ui.panel(closingLine, { color: "wine" });
  }
}

async function hydrateArgsFromStoredPreferences(args: Argv, accountId?: string): Promise<void> {
  if (args.advancedConfigured === true) return;
  try {
    const session = await (await openSessionStorage()).read(accountId);
    if (session === null) return;
    args.noRegistry = session.consent_skillify_telemetry !== true;
    args.consentOperatorInboxOtp = session.consent_operator_inbox_otp !== false;
  } catch {
    // Best-effort. Missing inbox preference uses the default-on setting.
  }
}

function printProviderState(providers: OAuthProviderId[]): void {
  const have = new Set(providers);
  ui.hint(
    `  Provider sessions: Google ${have.has("google") ? "connected" : "not connected"}; ` +
      `GitHub ${have.has("github") ? "connected" : "not connected"}`,
  );
}

// Runs the browser-based install confirm flow.
//
// Default path (`skipBrowser=false`): opens the trustysquire confirm
// URL in the bot's OWN persistent Chrome profile. The user signs in
// once — that single sign-in claims the install and establishes the bot's
// profile with a provider session for future OAuth signups. The
// pollUntilClaimed callback closes the Chrome window as soon as the
// API flips the install to claimed.
//
// Fallback (`skipBrowser=true`): prints the URL, attempts a best-
// effort `open()` to the user's default browser, polls the API for
// claim. If that ceremony leaves no live provider session in the bot's Chrome,
// connect's success gate reports the install as incomplete rather than claiming
// an OAuth-capable install. This path is for CI / scripted installs that only
// need the config written.
// True when the local session + bot profile already carry everything
// connect would establish. Returns the list of confirmed provider sessions, or
// null when anything's missing. Best-effort: any read/probe error returns null
// and the caller proceeds with the normal browser flow.
// Probe whether the stored agent token still authenticates. Agent
// sessions have a 24h absolute cap, so a token can be PRESENT in the
// session file but already dead on the server. Treating present as
// provisioned makes `connect` rewrite the config, print "Already
// provisioned", and return — after which every MCP call 401s with no
// hint that a re-pair is needed (the bug that had connect short-circuit
// on an expired token). Only an explicit auth rejection counts as
// invalid; a transient network error is treated as "probably fine" so a
// blip doesn't force the full browser re-claim.
export async function agentTokenStillValid(
  apiBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/v1/vault/credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true;
  }
}

type CheckedConnectPreflight =
  | { kind: "ceremony" }
  | { kind: "provisioned"; providers: OAuthProviderId[]; session: SessionData }
  | { kind: "unverified"; detail: string; session: SessionData };

async function checkAlreadyProvisioned(
  profileDir: string,
  accountId?: string,
): Promise<CheckedConnectPreflight> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read(accountId);
    // Need the token present before we can validate it; an incomplete
    // session is decided (→ null) without an API round-trip.
    if (
      session === null ||
      session.machine_token === undefined ||
      session.agent_session_token === undefined ||
      session.account_id === undefined
    ) {
      return { kind: "ceremony" };
    }
    // Don't short-circuit on a present-but-expired token — re-pair.
    const stillValid = await agentTokenStillValid(
      session.api_base_url,
      session.agent_session_token,
    );
    // Read the profile's cookie store instead of trusting the marker: the
    // marker is a cache that can lie after logout/expiry. This is a byte-copy
    // read — it takes no profile lease, waits for nothing, and opens no
    // browser — because the machines that are already connected are exactly the
    // machines whose browser is busy, and asking the profile a question must
    // never contend with the browser the question is about.
    //
    // A busy profile or any other probe failure must not force a re-pair: that
    // is the connect-loops-forever bug. It also must not become a connected
    // claim based on cached markers, because only reading the profile proves the
    // provider session. Refresh config with an explicit unverified warning.
    let providers: OAuthProviderId[] | null;
    try {
      providers = await detectProviderSessionsFromProfile(profileDir);
    } catch (err) {
      const preflight = decideConnectPreflight(session, stillValid, null);
      if (preflight.kind === "unverified") {
        return {
          kind: "unverified",
          detail: err instanceof Error ? err.message : String(err),
          session,
        };
      }
      return preflight;
    }
    const preflight = decideConnectPreflight(session, stillValid, providers);
    // The profile IS the record: what its cookie store proves decides the
    // claim, every run. Nothing persists a provider list to compare against,
    // so a stale one can never demote a machine that is really signed in.
    return preflight.kind === "provisioned" ? { ...preflight, session } : preflight;
  } catch {
    return { kind: "ceremony" };
  }
}

// Connect short-circuited (Google valid + bound) but the bot's GitHub session
// validated DEAD. GitHub is optional, but a dead session is exactly why a user
// re-runs connect (GitHub-OAuth signups were failing), so PROACTIVELY offer to
// fix it rather than just noticing. Returns true when the caller should fall
// through into the normal ceremony with a GitHub-scoped relogin — there is one
// sign-in pathway, so "yes" continues this run rather than starting a second
// command. Skippable; non-interactive notices so scripted installs never block.
async function offerGithubReloginIfDead(args: Argv): Promise<boolean> {
  const reconnectHint = `run ${ui.code("npx @trusty-squire/mcp connect --force-relogin=github")} when a service needs GitHub`;
  if (process.stdout.isTTY !== true || args.noInteractive) {
    ui.hint(`GitHub session is not active — ${reconnectHint}.`);
    return false;
  }
  const answer = await confirm({
    message:
      "Your GitHub session looks dead (GitHub-only signups will fail). Reconnect GitHub now?",
    initialValue: true,
  });
  if (isCancel(answer) || answer !== true) {
    ui.hint(`Skipped GitHub — ${reconnectHint}.`);
    return false;
  }
  return true;
}

function consentFromArgs(args: Argv): InstallConsent {
  return {
    skillifyTelemetry: !args.noRegistry,
    operatorInboxOtp: args.consentOperatorInboxOtp !== false,
  };
}

async function ensureConsentRecorded(
  consent: InstallConsent,
  overwrite: boolean,
  accountId?: string,
): Promise<void> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read(accountId);
    if (session === null) return;
    if (
      !overwrite &&
      session.consent_skillify_telemetry !== undefined &&
      session.consent_operator_inbox_otp !== undefined
    ) {
      return;
    }
    await storage.write({
      ...session,
      saved_at: new Date().toISOString(),
      consent_skillify_telemetry: consent.skillifyTelemetry,
      consent_operator_inbox_otp: consent.operatorInboxOtp,
    });
  } catch {
    // Best-effort. Missing preferences use the runtime default (inbox reads on).
  }
}

// Writes the host agent's MCP config — extracted so both the normal
// install path and the preflight-already-provisioned shortcut share
// one implementation.
async function writeAgentConfig(
  target: AgentTarget,
  agent: (typeof AGENTS)[AgentTarget],
  args: Argv,
  session: SessionData,
  context?: Pick<ConnectTargetContext, "profileDir" | "agentIdentity">,
): Promise<void> {
  // Tokens themselves are NOT in the env — the MCP server reads them
  // from the account's 0600 JSON session file, which keeps them out of
  // any child-process listing or shell history.
  const launch = resolveServerLaunch();
  const env: Record<string, string> = {
    TRUSTY_SQUIRE_AGENT_IDENTITY: context?.agentIdentity ?? target,
  };
  if (context !== undefined) {
    env.TRUSTY_SQUIRE_PROFILE_DIR = context.profileDir;
  }
  // Which account this host agent's server serves. Sessions are stored one per
  // account, so pinning it here is what keeps an ALREADY-RUNNING server on the
  // account it was launched for after someone connects a different one: the old
  // process keeps its launch env, the new config names the new account.
  const boundAccount = session.account_id;
  if (boundAccount !== undefined && boundAccount.length > 0) {
    env.TRUSTY_SQUIRE_ACCOUNT_ID = boundAccount;
  }
  // Skill registry URL. The endpoint is not user-configurable; Advanced setup
  // controls whether it is written at all. Registry participation is also the
  // user's consent to contribute successful non-personal signup recipes.
  if (!args.noRegistry) {
    env.TRUSTY_SQUIRE_REGISTRY_URL = DEFAULT_REGISTRY_URL;
  }
  await agent.writeConfig({
    command: launch.command,
    args: launch.args,
    env,
  });
  ui.success(`Wrote ${agent.display_name} MCP config at ${ui.code(agent.config_path())}`);
  // Claude Code: also pre-allow the safe credential tools so the agent
  // isn't prompted on every use_credential / list / poll / store call.
  if (target === "claude-code") {
    try {
      const settingsPath = await writeClaudeCodePermissions();
      ui.hint(`  Pre-allowed credential tools in ${ui.code(settingsPath)}`);
    } catch {
      ui.hint("  Couldn't write .claude/settings.json permissions (non-fatal)");
    }
  }
  if (args.noRegistry) {
    ui.hint(
      "  Skill registry disabled — signups are driven fresh by your agent each time " +
        "(no shared skill replay).",
    );
  }
}

// The browser remains open until both the account claim and its explicit Finish
// callback arrive. The callback is emitted after the visible browser flow
// completes, so it works for onboarding and forced re-login without inspecting
// Chrome's on-disk cookie database.
export function shouldCompleteInstallClaim(claimed: boolean, wizardCompleted = false): boolean {
  return claimed && wizardCompleted;
}

// During normal onboarding, claim happens before the browser's Finish step.
// Keep the terminal message aligned with that two-phase flow.
export function claimHeartbeatMessage(claimed: boolean): string {
  return claimed
    ? "Sign-in complete — click Finish in the browser to close it and continue."
    : "Still waiting for you to finish signing in — the URL/window above stays live until you do.";
}

// What the ceremony settled on, with the two facts a machine caller needs
// when it did not claim: the sign-in URL that is still live, and where the
// browser actually went.
// One run's observed ceremony placement, shared with the handlers that report
// it. `value === null` means no ceremony was attempted, which is the only
// state in which "no browser was opened" is a fact rather than an assumption.
// `ownBrowserPid` is the Chrome this run launched, so the holder snapshot can
// tell its own ceremony window apart from another session's.
interface BrowserPlacementSlot {
  value: ConnectBrowserLocation | null;
  ownBrowserPid: number | null;
}

type InstallClaimResult =
  | { kind: "claimed"; session: SessionData; browser_location: ConnectBrowserLocation }
  | { kind: "unclaimed"; confirm_url: string; browser_location: ConnectBrowserLocation }
  | { kind: "expired"; browser_location: ConnectBrowserLocation }
  | {
      kind: "confirm_failed";
      detail: string;
      confirm_url: string;
      browser_location: ConnectBrowserLocation;
    };

async function runInstallClaim(
  apiBase: string,
  target: AgentTarget,
  baseSession: SessionData,
  skipBrowser: boolean,
  options: {
    // Whether to let the SERVER's stored install_preferences override the local
    // session's consent choices. Only for the non-interactive path (CI / re-install
    // inheritance). In the interactive flow the user JUST answered these questions,
    // so baseSession is authoritative — applying stale server prefs there silently
    // discarded a fresh inbox-read preference.
    applyServerPrefs: boolean;
    profileDir: string;
    // Where the ceremony browser went, recorded for whoever reports the run —
    // including a handler above this frame that never sees the claim.
    placed: BrowserPlacementSlot;
    // Writes a non-terminal line naming the live pairing link and where the
    // browser is, before this run blocks on a human.
    reportSignInOpen: (confirm_url: string, browser_location: ConnectBrowserLocation) => void;
    // Providers whose cookie clear busy-failed and now rides the ceremony
    // (see the --force-relogin block in the caller).
    forceReloginProviders?: readonly OAuthProviderId[];
  },
): Promise<InstallClaimResult> {
  console.warn(`Connecting this machine to your account…`);
  const initiate = await installInitiate(apiBase, target, baseSession.machine_token ?? null);
  // Waiting past the pairing token's life would hand back a URL that is
  // already dead. Counted as a DURATION from the moment the response arrived:
  // subtracting a local clock reading from the server's `expires_at` makes the
  // window depend on clock skew, which collapses or overshoots it silently.
  const ceremonyDeadline = Date.now() + PAIRING_TOKEN_TTL_MS;
  const expired = { value: false };
  // The link is valid from here on, and everything after this waits. Say so
  // now rather than at settle, when it is already spent.
  options.reportSignInOpen(initiate.confirm_url, options.placed.value ?? { kind: "none" });

  // Track the claimed token outside the poll closure so the in-Chrome
  // flow's pollUntilClaimed can read it once the API reports claimed.
  // Wrapper object so TS can narrow `state.value` after a `=== null`
  // check at the call site — bare closure-captured `let` doesn't.
  const state: { value: ClaimResult | null } = { value: null };
  // The normal wizard's Finish button invokes the nonce-scoped loopback
  // callback. Every install path waits for it. Plain login deliberately has no
  // CDP attach, so this callback is the sole browser-completion authority.
  const pollOnce = async (wizardCompleted: boolean): Promise<InstallClaimPollResult> => {
    let claimedThisPoll = false;
    // Keep state.value warm — the install moves to "claimed" the instant the
    // user finishes signing in.
    if (state.value === null) {
      const status = await installPoll(apiBase, initiate.setup_code);
      if (status.status === "claimed" && status.agent_session_token !== undefined) {
        state.value = {
          token: status.agent_session_token,
          account_id: status.account_id ?? "",
          ...(status.install_preferences !== undefined
            ? { preferences: status.install_preferences }
            : {}),
        };
        claimedThisPoll = true;
      } else if (status.status === "expired") {
        expired.value = true;
        return "expired";
      }
    }
    const claimed = state.value !== null;
    const tearDown = shouldCompleteInstallClaim(claimed, wizardCompleted);
    if (tearDown) {
      return { status: "claimed", provider: null };
    }
    if (claimedThisPoll) {
      console.error(chalk.dim(`   ✓ ${claimHeartbeatMessage(true)}`));
    }
    return "pending";
  };

  if (skipBrowser) {
    // CI / scripted: best-effort open() into the user's default browser,
    // poll the API directly. Bot Chrome stays unbothered. This is the
    // ONLY branch that prints the trustysquire URL — in the default
    // branch the bot's Chrome opens it for the user, and printing it
    // here too would suggest "sign in here OR there" and the user
    // would sign in twice (or sign in via their laptop, leaving the
    // bot's Chrome profile empty — no Google session for future OAuth
    // signups).
    ui.panel(`Open this URL to sign in and confirm:\n\n  ${ui.link(initiate.confirm_url)}`, {
      color: "wine",
      title: "sign in",
    });
    let handedOff = false;
    try {
      const openMod = await import("open");
      await openMod.default(initiate.confirm_url);
      handedOff = true;
    } catch {
      // ignore — user copies the URL
    }
    // A spawned default browser is a browser that opened; Squire just did not
    // place it and cannot say where it went.
    options.placed.value = handedOff
      ? {
          kind: "unknown",
          reason: "handed to this machine's default browser; Squire did not place it",
        }
      : { kind: "none" };
    const handoff: ConnectBrowserLocation = options.placed.value;
    options.reportSignInOpen(initiate.confirm_url, handoff);
    const ok = await pollForClaim(apiBase, initiate.setup_code);
    if (ok === "expired") return { kind: "expired", browser_location: handoff };
    if (ok === null) {
      return {
        kind: "unclaimed",
        confirm_url: initiate.confirm_url,
        browser_location: handoff,
      };
    }
    return {
      kind: "claimed",
      browser_location: handoff,
      session: {
        ...applyInstallPreferences(baseSession, ok.preferences, options.applyServerPrefs),
        api_base_url: apiBase,
        saved_at: new Date().toISOString(),
        agent_session_token: ok.token,
        account_id: ok.account_id,
      },
    };
  }

  // Default: run the confirm INSIDE the bot's Chrome. The user signs
  // The wizard page reads provider state from /v1/auth/whoami so no
  // CLI-side hint is needed.
  const result = await openInstallConfirmInBotChrome({
    confirmUrl: initiate.confirm_url,
    pollUntilClaimed: pollOnce,
    heartbeatMessage: () => claimHeartbeatMessage(state.value !== null),
    profileDir: options.profileDir,
    onBrowserPlacement: (placement, ownBrowserPid) => {
      options.placed.value = placement;
      options.placed.ownBrowserPid = ownBrowserPid;
      options.reportSignInOpen(initiate.confirm_url, placement);
    },
    deadline: ceremonyDeadline,
    ...(options.forceReloginProviders?.length
      ? { forceReloginProviders: options.forceReloginProviders }
      : {}),
  });
  // No path reported a placement, so nothing was shown anywhere — which is
  // `unreachable`, named with the failure that caused it, not a fourth
  // spelling a caller has to read English to interpret.
  const browser_location: ConnectBrowserLocation = options.placed.value ?? {
    kind: "unreachable",
    reason: result.detail ?? "the ceremony ended without showing the page anywhere",
  };
  options.placed.value = browser_location;

  // rc.33 — surface the underlying error instead of letting the outer
  // wrapper print a generic "browser confirm step never finished."
  // Surface the underlying browser-launch error rather than replacing it
  // with a generic confirmation timeout.
  if (result.status === "error") {
    if (expired.value) return { kind: "expired", browser_location };
    return {
      kind: "confirm_failed",
      detail: result.detail ?? "unknown error",
      confirm_url: initiate.confirm_url,
      browser_location,
    };
  }

  // Reachable only by the ceremony deadline elapsing, and that deadline IS the
  // pairing token's life — so there is no live URL left to hand anyone.
  if (result.status !== "claimed" || state.value === null) {
    return { kind: "expired", browser_location };
  }

  return {
    kind: "claimed",
    browser_location,
    session: {
      ...applyInstallPreferences(baseSession, state.value.preferences, options.applyServerPrefs),
      api_base_url: apiBase,
      saved_at: new Date().toISOString(),
      agent_session_token: state.value.token,
      account_id: state.value.account_id,
    },
  };
}

// Overlay the server's stored install_preferences onto the local session. Only
// when `applyServerPrefs` (the non-interactive path): in the interactive flow the
// user just answered these questions, so baseSession is authoritative and applying
// stale server prefs would silently discard a fresh consent choice. Exported for
// tests.
export function applyInstallPreferences(
  baseSession: SessionData,
  preferences: ClaimResult["preferences"] | undefined,
  applyServerPrefs: boolean,
): SessionData {
  if (!applyServerPrefs || preferences === undefined) return baseSession;
  return {
    ...baseSession,
    consent_skillify_telemetry: preferences.registry_enabled === true,
    consent_operator_inbox_otp: preferences.consent_operator_inbox_otp !== false,
  };
}

// Thrown rather than exited so connect still reports before the process ends;
// `runCli` keeps the exit code the guidance above has always used.
class TargetUnresolvedError extends Error {}

async function resolveTarget(explicit: AgentTarget | undefined): Promise<AgentTarget> {
  if (explicit !== undefined) return explicit;
  const detected = await detectInstalledAgents();
  if (detected.length === 1) {
    console.warn(`Detected ${detected[0]!.display_name}. Configuring squire for it.`);
    return detected[0]!.target;
  }
  if (detected.length > 1) {
    console.error("Multiple agents detected. Please pass --target=<agent>:");
    for (const a of detected) console.error(`  --target=${a.target}  (${a.display_name})`);
    throw new TargetUnresolvedError("multiple agents detected");
  }
  console.error("No coding agents auto-detected. Pass --target= explicitly:");
  for (const a of Object.values(AGENTS)) {
    console.error(`  --target=${a.target}  (${a.display_name})`);
  }
  throw new TargetUnresolvedError("no coding agents auto-detected");
}

// Logs out ONE account — the one most recently connected, or `--account=<id>`.
// Other accounts installed on this machine keep their sessions, and the servers
// serving them keep working.
async function logout(args: Argv): Promise<void> {
  const storage = await openSessionStorage();
  const target = args.account ?? (await storage.currentAccountId());
  if (target === null || (args.account !== undefined && (await storage.read(target)) === null)) {
    console.warn("✓ No local session to clear.");
    return;
  }
  await storage.clear(target);
  const remaining = await storage.listAccounts();
  console.warn(
    `✓ Cleared local session for account ${target} (${storage.path}).` +
      (remaining.length > 0 ? ` Still installed: ${remaining.join(", ")}.` : ""),
  );
}

function printHelp(): void {
  ui.heading("Trusty Squire");
  ui.hint("Connect a coding agent to your squire.");
  console.warn("");
  console.warn(`${chalk.bold("Commands")}`);
  console.warn(`  ${ui.code("connect")}                       set up this machine (default)`);
  console.warn(`  ${ui.code("settings")}                      edit registry and OTP choices`);
  console.warn(`  ${ui.code("logout [--account=<id>]")}       clear ONE account's local session`);
  console.warn("");
  console.warn(`${chalk.bold("Flags for connect")}`);
  console.warn(`  --target=<${Object.keys(AGENTS).join("|")}>`);
  console.warn(`  --skip-browser               don't launch a browser (CI mode)`);
  console.warn(
    `  --force-relogin[=google|github] re-sign-in: switch the bound account or refresh one provider`,
  );
  console.warn(`  --no-registry                disable managed registry participation`);
  console.warn(`  --no-interactive             skip the TUI picker (use flag defaults only)`);
  console.warn(
    `  --json                       print one machine-readable connect report on stdout ` +
      `(implies --no-interactive)`,
  );
  console.warn("");
  console.warn(`${chalk.bold("Example")}`);
  console.warn(`  ${ui.code("npx @trusty-squire/mcp connect")}`);
  console.warn("");
}

interface ClaimResult {
  token: string;
  account_id: string;
  preferences?: {
    registry_enabled?: boolean;
    consent_operator_inbox_otp?: boolean;
  };
}

async function pollForClaim(
  apiBase: string,
  setupCode: string,
  intervalMsOrOpts: number | { intervalMs?: number; timeoutMs?: number } = {},
  timeoutMsArg?: number,
): Promise<ClaimResult | "expired" | null> {
  const opts =
    typeof intervalMsOrOpts === "number"
      ? { intervalMs: intervalMsOrOpts, timeoutMs: timeoutMsArg }
      : intervalMsOrOpts;
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await installPoll(apiBase, setupCode);
    if (status.status === "claimed" && status.agent_session_token !== undefined) {
      return {
        token: status.agent_session_token,
        account_id: status.account_id ?? "",
        ...(status.install_preferences !== undefined
          ? { preferences: status.install_preferences }
          : {}),
      };
    }
    if (status.status === "expired") return "expired";
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Print a class-appropriate message about the network we detected.
// Datacenter gets a clear warning + link; residential gets a brief
// confirmation; unknown gets a heads-up. All to stderr.
function printAsnWarning(asn: AsnInfo): void {
  const orgDisplay = asn.org ?? "(unknown ASN)";
  switch (asn.class) {
    case "datacenter":
      ui.panel(
        `Detected network: ${ui.code(orgDisplay)}\n\n` +
          `This looks like a datacenter / cloud network (Codespaces, AWS, ` +
          `Hetzner, etc.). Some signups — especially those gated by ` +
          `reCAPTCHA v2 — are likely to be blocked because anti-bot scoring ` +
          `weighs network reputation heavily.\n\n` +
          `For best results: run Trusty Squire from a laptop/desktop on a ` +
          `home or office network. Cloud dev environments can still provision ` +
          `services that don't gate signup with reCAPTCHA (Resend, IPInfo, ` +
          `etc.), but Postmark/MailerSend and similar will likely fail.`,
        { title: "⚠  Datacenter network", color: "yellow" },
      );
      return;
    case "residential":
      ui.success(`Detected network: ${orgDisplay} (residential — captchas should pass cleanly)`);
      return;
    case "unknown":
      ui.info(`Detected network: ${orgDisplay} (couldn't classify — proceed and we'll see)`);
      return;
  }
}

export {
  connect,
  logout,
  parseArgs,
  pollForClaim,
  printAsnWarning,
  resolveCopiedNpxServerLaunch,
  resolveServerLaunch,
};
