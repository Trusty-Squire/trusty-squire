// Setup CLI — connect / settings / logout / login subcommands.
//
//   npx @trusty-squire/mcp connect --target=claude-code
//     Issues a machine token, then opens the trustysquire install-
//     confirm page in the bot's own Chrome. The user signs in there
//     once with Google — that single sign-in does TWO things:
//       (a) trustysquire claims the install and binds the machine to
//           the user's account, and
//       (b) the bot's Chrome profile gains a provider session it can
//           ride on future signups (Resend, Postmark, etc.).
//     One Google login, both jobs done.
//
//   npx @trusty-squire/mcp login [--provider=google|github]
//     Add an additional provider session to the bot's profile. If you
//     signed in to install with Google but want the bot to also sign
//     you up via GitHub-only services, run this.
//
//   npx @trusty-squire/mcp logout
//
// Flags:
//   --target=<agent>     skip auto-detection
//   --api-base=<url>     override the API base URL
//   --provider=google|github   choose provider for `login`
//   --skip-browser       don't launch the bot's Chrome; just print the
//                        confirm URL and expect the user to open it in
//                        their own browser (CI / scripted installs)
//   --proxy-url=<url>    bake a residential proxy into the MCP config's
//                        env (UNIVERSAL_BOT_PROXY_URL)
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
  type AgentTarget,
  type AgentDefinition,
} from "./agents.js";
import { detectAsn, type AsnInfo } from "../bot/index.js";
import {
  detectActiveProviderSessions,
  ensureOAuthSession,
  openInstallConfirmInBotChrome,
  profileHasProviderCookies,
} from "../bot/google-login.js";
import { isOAuthProviderId, type OAuthProviderId } from "../bot/oauth-providers.js";
import {
  clearAllProviderMarkers,
  clearBrowserProfile,
  clearProviderCookies,
  clearProviderLoggedIn,
  loggedInProviders,
  markProviderLoggedIn,
} from "../bot/login-state.js";
import { waitForProfileFree } from "../bot/profile.js";
import { VERSION } from "../version.js";
import { ensureLatestVersion } from "./version-check.js";
import * as ui from "./ui.js";
import {
  runInteractiveSetup,
  runSettingsSetup,
  shouldRunInteractive,
  showOutro,
} from "./interactive.js";
import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";
import { normalizeProxyUrl } from "./proxy-url.js";

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
// Managed skill-registry URL. Advanced setup decides whether this is written
// into the MCP config; the URL itself is product-owned and not user-editable.
const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

type ProviderArg = "google" | "github";

type Argv = {
  command: string;
  target?: AgentTarget;
  apiBase: string;
  // Residential proxy URL to bake into the written MCP config's env as
  // UNIVERSAL_BOT_PROXY_URL — so the proxy is set once at install time
  // and the user never hand-edits the config env.
  proxyUrl?: string;
  // Optional 2Captcha API key from advanced setup. Stored ENCRYPTED in the
  // vault (never written to the MCP config) by maybeStoreTwoCaptchaKey once the
  // session is paired; the bot spends it through the injecting proxy.
  twoCaptchaKey?: string;
  // Skill registry is product-owned infrastructure. Advanced setup controls
  // whether this install participates; registry ON is also the user's consent
  // to contribute successful non-personal signup recipes back to the registry.
  noRegistry: boolean;
  registryConfigured?: boolean;
  // OAuth provider — for `login`, picks which provider to sign in to.
  // For `connect`, the provider is chosen by the user inside the
  // trustysquire confirm page (Google or GitHub button), so this flag
  // is ignored there.
  providerArg?: ProviderArg;
  // --skip-browser:
  // don't launch the bot's Chrome at the confirm URL. Print the URL
  // for the user to open in their own browser, then poll for claim.
  // The bot's Chrome profile won't gain a provider session — the user
  // will need `mcp login` before their first OAuth-based signup.
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
  // --profile-dir=<path>: for `login`, target an ISOLATED Chrome profile
  // dir instead of the shared bot profile. Use this to keep a secondary
  // Google identity (e.g. a personal consumer Gmail that can create GCP
  // projects under "No organization", which the trustysquire.ai Workspace
  // robots cannot) in its own profile without clobbering the operator's
  // session. Pair with BOT_GOOGLE_PROFILE_DIR on the discover side.
  profileDir?: string;
  advancedConfigured?: boolean;
  consentOperatorInboxOtp?: boolean;
};

interface InstallConsent {
  skillifyTelemetry: boolean;
  operatorInboxOtp: boolean;
}

function parseArgs(argv: string[]): Argv {
  const positional = argv.filter((a) => !a.startsWith("--"));
  // Default (no positional) → `connect` because the most common invocation is
  // `npx @trusty-squire/mcp` with no args, and that should kick off setup.
  const command = positional[0] ?? "connect";
  if (command === "install") {
    rejectDeprecatedCli(
      "`install` has been removed. Use `npx @trusty-squire/mcp connect`.",
    );
  }
  let target: AgentTarget | undefined;
  let apiBase = DEFAULT_API_BASE;
  let proxyUrl: string | undefined;
  let noRegistry = false;
  let registryConfigured = false;
  let providerArg: ProviderArg | undefined;
  let profileDir: string | undefined;
  let skipBrowser = false;
  let forceRelogin = false;
  let forceReloginProvider: ProviderArg | undefined;
  let noInteractive = false;
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      const t = arg.slice("--target=".length);
      if (!isAgentTarget(t)) {
        // Silent-drop is the footgun behind the pre-0.4.2 Goose mishap
        // (--target=goose-typo → auto-detect → wrong agent configured).
        // Fail loud with the valid list so the user sees the mismatch.
        console.error(
          `unknown --target '${t}'. Valid targets: ${Object.keys(AGENTS).join(", ")}`,
        );
        process.exit(64);
      }
      target = t;
    } else if (arg.startsWith("--api-base=")) {
      apiBase = arg.slice("--api-base=".length);
    } else if (arg.startsWith("--proxy-url=")) {
      const rawProxyUrl = arg.slice("--proxy-url=".length);
      const normalized = normalizeProxyUrl(rawProxyUrl);
      if (rawProxyUrl.length > 0 && normalized === undefined) {
        console.error(
          "invalid --proxy-url. Use http://user:pass@host:port or socks5://host:port.",
        );
        process.exit(64);
      }
      proxyUrl = normalized;
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
      const p = arg.slice("--provider=".length);
      if (p === "google" || p === "github") providerArg = p;
    } else if (arg.startsWith("--profile-dir=")) {
      profileDir = arg.slice("--profile-dir=".length);
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
    noInteractive,
  };
  if (target !== undefined) args.target = target;
  if (proxyUrl !== undefined && proxyUrl.length > 0) args.proxyUrl = proxyUrl;
  if (providerArg !== undefined) args.providerArg = providerArg;
  if (profileDir !== undefined && profileDir.length > 0) args.profileDir = profileDir;
  return args;
}

function rejectDeprecatedCli(message: string): never {
  console.error(`[trusty-squire] ${message}`);
  process.exit(64);
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
  const stableBin = join(
    stableNodeModules,
    "@trusty-squire",
    "mcp",
    "dist",
    "bin.js",
  );
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
  const args = parseArgs(argv);
  // Auto-load the operator's harvester.env so a `login`/`connect` here picks
  // up UNIVERSAL_BOT_PROXY_URL — establishing the provider session through the
  // SAME residential egress the bot's signups use. Without it, an operator who
  // forgets `set -a; source harvester.env` creates the session from the box's
  // datacenter IP; the proxied signups then hit the provider from a residential
  // IP and the jump silently kills the auth cookie (the GitHub-session-keeps-
  // getting-wiped bug). No-op for end users (no harvester.env) + non-
  // overwriting, so an explicitly-set env always wins.
  loadHarvesterEnvFile();
  switch (args.command) {
    case "connect":
      // `npx …/mcp connect` reuses a stale local copy instead of fetching the
      // latest, and connect then pins the host config to that stale version.
      // Re-exec on the current release first so the one-liner alone lands it.
      await ensureLatestVersion(argv);
      await connect(args);
      return;
    case "logout":
      await logout();
      return;
    case "login":
      await login(args);
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
}

// Store the user-supplied 2Captcha key in the vault (encrypted, never written
// to the MCP config). Idempotent + best-effort: a failure here must never fail
// the install — the bot just won't have the Tier-3 solver. Runs after pairing,
// so the session carries a usable agent_session_token. Clears args.twoCaptchaKey
// on success so the secret doesn't linger in memory longer than needed.
async function maybeStoreTwoCaptchaKey(args: Argv): Promise<void> {
  const key = args.twoCaptchaKey?.trim();
  if (key === undefined || key.length === 0) return;
  const storage = await openSessionStorage();
  const session = await storage.read();
  if (session?.agent_session_token === undefined) {
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
    ui.warn(
      `Couldn't vault the 2Captcha key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function settings(args: Argv): Promise<void> {
  const storage = await openSessionStorage();
  const session = await storage.read();
  if (session === null) {
    ui.fail(`No local Trusty Squire session found. Run ${ui.code("npx @trusty-squire/mcp connect")} first.`);
    process.exit(1);
  }

  if (!args.noInteractive && process.stdin.isTTY === true) {
    const picker = await runSettingsSetup({
      ...(args.target !== undefined ? { initialTarget: args.target } : {}),
      ...(session.proxy_url !== undefined ? { initialProxyUrl: session.proxy_url } : {}),
      initialRegistryEnabled: session.consent_skillify_telemetry === true,
      initialConsentOperatorInboxOtp: session.consent_operator_inbox_otp === true,
    });
    args.target = picker.target;
    if (picker.proxyUrl !== undefined) args.proxyUrl = picker.proxyUrl;
    args.noRegistry = !picker.registryEnabled;
    args.advancedConfigured = true;
    args.consentOperatorInboxOtp = picker.consentOperatorInboxOtp === true;
    if (picker.twoCaptchaKey !== undefined) args.twoCaptchaKey = picker.twoCaptchaKey;
  } else {
    if (args.target === undefined) {
      ui.fail(`Pass ${ui.code("--target=<agent>")} when running settings outside an interactive terminal.`);
      process.exit(64);
    }
    if (args.registryConfigured !== true) {
      args.noRegistry = session.consent_skillify_telemetry !== true;
    }
    if (args.proxyUrl === undefined && session.proxy_url !== undefined) {
      args.proxyUrl = session.proxy_url;
    }
  }

  const target = await resolveTarget(args.target);
  const agent = AGENTS[target];
  const updated: SessionData = {
    ...session,
    saved_at: new Date().toISOString(),
    consent_skillify_telemetry: !args.noRegistry,
    consent_operator_inbox_otp: args.consentOperatorInboxOtp === true,
    ...(args.proxyUrl !== undefined && args.proxyUrl.trim().length > 0
      ? { proxy_url: args.proxyUrl.trim() }
      : {}),
  };
  await storage.write(updated);
  await writeAgentConfig(target, agent, args);
  await maybeStoreTwoCaptchaKey(args);
  ui.success(`${agent.display_name} settings saved.`);
}

async function connect(args: Argv): Promise<void> {
  // Interactive picker (clack). Walks the user through agent + advanced setup
  // before the browser install ceremony fires. The picker fills in args so the
  // rest of this function is unchanged.
  const wantInteractive =
    !args.noInteractive &&
    shouldRunInteractive({
      hasTty: process.stdin.isTTY === true,
      skipBrowser: args.skipBrowser,
      forceRelogin: args.forceRelogin,
    });
  if (wantInteractive) {
    // The bot's Chrome profile may already have provider cookies from
    // 0.8.2 — picker no longer asks about OAuth providers. The
    // install wizard rendered in the bot's Chrome handles the
    // Google + (optional) GitHub flow directly; the CLI just
    // surfaces agent + advanced.
    const picker = await runInteractiveSetup({
      ...(args.target !== undefined ? { initialTarget: args.target } : {}),
      ...(args.proxyUrl !== undefined ? { initialProxyUrl: args.proxyUrl } : {}),
      initialRegistryEnabled: !args.noRegistry,
    });
    args.target = picker.target;
    if (picker.proxyUrl !== undefined) args.proxyUrl = picker.proxyUrl;
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
  const agent = AGENTS[target];

  // Preflight: an existing install is "connected" only when BOTH the
  // account-bound plumbing still works and the bot profile has a confirmed
  // Google session. A bare machine/agent token can talk to Trusty Squire, but
  // it cannot act as the user at third-party sites, so it must not skip the
  // browser confirm. Pass --force-relogin to bypass (e.g. to switch Google).
  if (!args.forceRelogin) {
    const preflight = await checkAlreadyProvisioned();
    if (preflight !== null) {
      ui.divider();
      await hydrateArgsFromStoredPreferences(args);
      await ensureConsentRecorded(consentFromArgs(args), args.advancedConfigured === true);
      await writeAgentConfig(target, agent, args);
      await maybeStoreTwoCaptchaKey(args);
      ui.success(
        `Already connected (${preflight.providers.join(" + ")}). ` +
          `${agent.display_name} config refreshed.`,
      );
      printProviderState(preflight.providers);
      // Backfill connected_providers from the bot-side marker on
      // pre-rc.5 sessions, so the preflight cache is current.
      for (const p of preflight.providers) await recordConnectedProvider(p);
      // Connect session validation: we short-circuited because Google is
      // valid + bound, but if the bot's GitHub session validated DEAD, proactively
      // offer to reconnect it — a dead GitHub session is exactly why people re-run
      // connect (GitHub-OAuth signups fail). Skippable; non-interactive notices.
      if (!preflight.providers.includes("github")) {
        await offerGithubReloginIfDead(args, target, agent);
      }
      ui.hint(
        `Pass ${ui.code("--force-relogin")} to switch accounts or to refresh a ` +
          `stale/expired session (this "connected" check reads cached cookies, ` +
          `which can outlive the real session).`,
      );
      return;
    }
  }

  console.warn("");
  console.warn(
    "Opening the Trusty Squire install page in a browser. " +
      "The page walks you through signing in with Google and (optionally) GitHub.",
  );
  // If the preflight keeps missing a valid session, connect re-opens this page
  // every run. The usual cause on a headless box is an ephemeral OS keychain
  // that doesn't persist the session between logins — point people at the
  // durable file backend so they don't loop.
  if ((await openSessionStorage()).backendName() === "keytar") {
    ui.hint(
      `If ${ui.code("connect")} re-opens this page on every run, your OS keychain may not be ` +
        `persisting the session. Set ${ui.code("TRUSTY_SQUIRE_SESSION_FILE=1")} (globally) to use a durable session file.`,
    );
  }

  // --force-relogin means "redo the OAuth dance from scratch". The scoped
  // form clears only one provider; bare --force-relogin is the full-profile
  // account-switch escape hatch.
  if (args.forceRelogin) {
    if (args.forceReloginProvider !== undefined) {
      clearProviderLoggedIn(args.forceReloginProvider);
    } else {
      clearAllProviderMarkers();
    }
    const free = await waitForProfileFree(undefined, {
      deadlineMs: 120_000,
      onWait: () =>
        ui.hint("Waiting for the bot browser to finish before clearing the old session…"),
    });
    if (!free) {
      ui.fail(
        "The bot browser is still using the profile, so I can't safely switch accounts yet. " +
          "Close the running signup/login browser and retry with --force-relogin.",
      );
      process.exit(1);
    }
    if (args.forceReloginProvider !== undefined) {
      await clearProviderCookies(undefined, args.forceReloginProvider);
    } else {
      clearBrowserProfile();
      await clearProviderCookies();
    }
  }

  // Connect session validation: a SCOPED force-relogin=github on an
  // already-bound account is a GitHub-only login — Google's gate is already
  // satisfied (the account is bound + its session is what we'd re-bind), so we
  // must NOT drag the Google-first account-binding confirm page into it. Route
  // straight to the provider-scoped login (the `login --provider=github` path):
  // it opens a GitHub-only login (account chooser, since cookies were cleared
  // above), never touching Google. Falls through to the full confirm flow only
  // when the account isn't bound yet (nothing to skip) or the scope is google
  // (which can re-bind the account and so needs the claim).
  if (args.forceReloginProvider === "github" && (await checkAlreadyBound())) {
    const ok = await reloginGithubOnly(args, target, agent, { writeConfig: true });
    if (ok) return;
    process.exit(1);
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

  // Browser confirm: bind this machine + seed the bot's Chrome.
  // The user signs into trustysquire from inside the bot's persistent
  // Chrome profile (with display, or noVNC on a headless box). That
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
  const session = await runInstallClaim(
    args.apiBase,
    target,
    baseSession,
    args.skipBrowser,
    {
      applyServerPrefs: !wantInteractive,
      completeOnClaim: args.forceRelogin,
    },
  );
  if (session === null) {
    ui.fail(
      `Install didn't complete — browser confirm never finished. ` +
        `Try again: ${ui.code("npx @trusty-squire/mcp connect")}`,
    );
    process.exit(1);
  }

  const storage = await openSessionStorage();
  await storage.write(session);
  ui.success(`Session saved (${storage.backendName()})`);
  args.noRegistry = session.consent_skillify_telemetry !== true;
  args.consentOperatorInboxOtp = session.consent_operator_inbox_otp === true;
  if (session.proxy_url !== undefined) args.proxyUrl = session.proxy_url;

  // 0.8.1 — the bot's persistent profile may have a stale provider
  // marker from a previous install (the marker is sticky on disk).
  // The install confirm above only seeded one provider (whichever
  // OAuth button the user clicked on trustysquire.com), so trusting
  // the marker would make the step-2 secondary-provider prompt
  // short-circuit incorrectly. Probe live cookies + rewrite the
  // marker so loggedInProviders() returns ground truth.
  try {
    const actual = await ui.withSpinner({
      start: "Checking provider sessions",
      done: "Provider sessions checked",
      fail: () => "Provider session check failed (continuing)",
      // validate=true: confirm each session is LIVE (not just cookie-present),
      // so a dead-but-present GitHub session isn't shown as connected.
      task: () => detectActiveProviderSessions(),
    });
    if (actual !== null) {
      clearAllProviderMarkers();
      for (const p of actual) markProviderLoggedIn(p);
    }
  } catch (err) {
    // Best-effort: a probe failure (rare — playwright launch should
    // succeed if the install confirm just opened Chrome there) just
    // leaves the marker as-is. The downstream secondary prompt's
    // logic still has the maybeOfferSecondaryProvider escape hatch
    // (yes/no prompt with the default-yes), so the user can still
    // reach GitHub even if we mis-identified the live state.
    //
    // Surface the reason on stderr so this never recurs invisibly: the
    // empty catch once hid a launch error (probe missing channel:"chrome",
    // reaching for an absent bundled Chromium) behind the bare "(continuing)"
    // ✗ for months, while the stale marker still printed "connected".
    console.error(
      `[connect] provider-session probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Backfill connected_providers from the (now-fresh) bot-side marker.
  const providers = loggedInProviders();
  for (const p of providers) await recordConnectedProvider(p);
  printProviderState(providers);

  await writeAgentConfig(target, agent, args);
  await maybeStoreTwoCaptchaKey(args);
  if (args.skipBrowser) {
    ui.panel(
      `--skip-browser was set, so the bot's Chrome didn't observe your sign-in.\n` +
        `Before your first OAuth signup, run:\n` +
        `  ${ui.code("npx @trusty-squire/mcp login [--provider=google|github]")}`,
      { title: "Heads up", color: "yellow" },
    );
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

async function hydrateArgsFromStoredPreferences(args: Argv): Promise<void> {
  if (args.advancedConfigured === true) return;
  try {
    const session = await (await openSessionStorage()).read();
    if (session === null) return;
    args.noRegistry = session.consent_skillify_telemetry !== true;
    args.consentOperatorInboxOtp = session.consent_operator_inbox_otp === true;
    if (session.proxy_url !== undefined) args.proxyUrl = session.proxy_url;
  } catch {
    // Best-effort. Missing preferences fall back to the privacy-safe defaults.
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
// once — that single sign-in claims the install AND seeds the bot's
// profile with a provider session for future OAuth signups. The
// pollUntilClaimed callback closes the Chrome window as soon as the
// API flips the install to claimed.
//
// Fallback (`skipBrowser=true`): prints the URL, attempts a best-
// effort `open()` to the user's default browser, polls the API for
// claim. The bot's Chrome never starts, so the bot won't have a
// provider session afterwards — the user must run `mcp login` before
// their first OAuth signup. This path is for CI / scripted installs.
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

// Pure gate for the `connect` fast path: given the read session, whether its
// agent token still validated, and the bot's confirmed provider sessions,
// decide whether connect can (re)write the MCP config WITHOUT a browser
// re-claim.
//
// Account-bound plumbing is not enough. The product-level connection is the
// bot-profile Google session: without it the host agent may be able to call the
// Trusty Squire API, but cannot act as the user at third-party services.
// GitHub is optional headroom; Google is the required primary identity.
export function decideProvisioned(
  session: SessionData | null,
  tokenValid: boolean,
  providers: OAuthProviderId[],
): { providers: OAuthProviderId[] } | null {
  if (
    session === null ||
    session.machine_token === undefined ||
    session.agent_session_token === undefined ||
    session.account_id === undefined
  ) {
    return null;
  }
  if (!tokenValid) return null;
  if (!providers.includes("google")) return null;
  return { providers };
}

async function checkAlreadyProvisioned(): Promise<{ providers: OAuthProviderId[] } | null> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
    // Need the token present before we can validate it; an incomplete
    // session is decided (→ null) without an API round-trip.
    if (
      session === null ||
      session.machine_token === undefined ||
      session.agent_session_token === undefined ||
      session.account_id === undefined
    ) {
      return null;
    }
    // Don't short-circuit on a present-but-expired token — re-pair.
    const stillValid = await agentTokenStillValid(
      session.api_base_url,
      session.agent_session_token,
    );
    // Probe the profile cookies instead of trusting the marker. The marker is a
    // cache that can lie after logout/expiry; connect is rare enough to pay this
    // cost, and this keeps "Already connected" aligned with the bot's real
    // ability to wear the user's Google identity. validate=true so a dead-but-
    // present GitHub session isn't persisted into connected_providers.
    //
    // BUT a BUSY profile (another Chromium already using it — a live operate
    // session, a background heal run, an orphaned Chrome) makes the probe throw.
    // That must NOT read as "not provisioned": forcing a re-pair (the noVNC
    // dance) on a transient lock is the connect-loops-forever bug. Fall back to
    // the session's cached connected_providers instead — a busy profile, if
    // anything, means the bot IS wearing its browser session.
    let providers: OAuthProviderId[];
    try {
      providers = await detectActiveProviderSessions();
      await syncConnectedProviders(providers);
    } catch {
      providers = (session.connected_providers ?? []).filter(isOAuthProviderId);
    }
    return decideProvisioned(session, stillValid, providers);
  } catch {
    return null;
  }
}

// Is the account already BOUND? — a valid session (machine + agent token +
// account id) whose agent token still validates. Unlike checkAlreadyProvisioned
// this does NOT require a live Google session: it answers "is the install
// claimed to an account", which is what a scoped GitHub force-relogin needs to
// know it can skip the Google-binding confirm page.
async function checkAlreadyBound(): Promise<boolean> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (
      session === null ||
      session.machine_token === undefined ||
      session.agent_session_token === undefined ||
      session.account_id === undefined
    ) {
      return false;
    }
    return await agentTokenStillValid(session.api_base_url, session.agent_session_token);
  } catch {
    return false;
  }
}

// A GitHub-only login in the bot's profile (the provider-scoped path) — clears
// the GitHub session and opens a fresh GitHub login (account chooser). Used by
// `--force-relogin=github` and by the proactive prompt when connect detects a
// dead GitHub session. Returns true on success.
async function reloginGithubOnly(
  args: Argv,
  target: AgentTarget,
  agent: AgentDefinition,
  opts: { writeConfig: boolean },
): Promise<boolean> {
  ui.heading("Sign in to GitHub");
  clearProviderLoggedIn("github");
  const result = await ensureOAuthSession({
    provider: "github",
    apiBaseUrl: args.apiBase,
    forceOpen: true,
  });
  if (result.status === "logged_in" || result.status === "already_valid") {
    await recordConnectedProvider("github");
    if (opts.writeConfig) await writeAgentConfig(target, agent, args);
    ui.success("Signed in to GitHub. The bot is ready.");
    return true;
  }
  ui.fail(
    result.status === "timeout"
      ? "GitHub sign-in timed out."
      : `GitHub sign-in failed: ${result.detail ?? "unknown error"}`,
  );
  return false;
}

// Connect short-circuited (Google valid + bound) but the bot's GitHub session
// validated DEAD. GitHub is optional, but a dead session is exactly why a user
// re-runs connect (GitHub-OAuth signups were failing), so PROACTIVELY offer to
// fix it rather than just noticing. Skippable; non-interactive falls back to a
// notice so scripted installs never block.
async function offerGithubReloginIfDead(
  args: Argv,
  target: AgentTarget,
  agent: AgentDefinition,
): Promise<void> {
  const reconnectHint = `run ${ui.code("npx @trusty-squire/mcp connect --force-relogin=github")} when a service needs GitHub`;
  if (process.stdout.isTTY !== true || args.noInteractive) {
    ui.hint(`GitHub session is not active — ${reconnectHint}.`);
    return;
  }
  const answer = await confirm({
    message: "Your GitHub session looks dead (GitHub-only signups will fail). Reconnect GitHub now?",
    initialValue: true,
  });
  if (isCancel(answer) || answer !== true) {
    ui.hint(`Skipped GitHub — ${reconnectHint}.`);
    return;
  }
  await reloginGithubOnly(args, target, agent, { writeConfig: false });
}

async function syncConnectedProviders(providers: OAuthProviderId[]): Promise<void> {
  clearAllProviderMarkers();
  for (const p of providers) markProviderLoggedIn(p);
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (session === null) return;
    await storage.write({
      ...session,
      connected_providers: [...providers],
      saved_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — marker/session drift only affects fast-path UX. The next
    // connect/login/provision probe can repair it.
  }
}

// Persist `provider` into session.connected_providers (idempotent).
// Called after a successful ensureOAuthSession so the install
// preflight on the next run can read both providers off the session
// file without having to load the bot's profile-dir marker.
async function recordConnectedProvider(provider: OAuthProviderId): Promise<void> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (session === null) return;
    const current = new Set(session.connected_providers ?? []);
    if (current.has(provider)) return;
    current.add(provider);
    await storage.write({
      ...session,
      connected_providers: [...current],
      saved_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — the bot-side login-state.json marker is the
    // primary source of truth; session.connected_providers is a
    // convenience cache for the preflight path. A failed write here
    // just means the next install runs the secondary prompt again,
    // which is recoverable.
  }
}

function consentFromArgs(args: Argv): InstallConsent {
  return {
    skillifyTelemetry: !args.noRegistry,
    operatorInboxOtp: args.consentOperatorInboxOtp === true,
  };
}

async function ensureConsentRecorded(
  consent: InstallConsent,
  overwrite: boolean,
): Promise<void> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
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
    // Best-effort. If we can't persist consent, runtime treats missing
    // fields as not approved.
  }
}

// Writes the host agent's MCP config — extracted so both the normal
// install path and the preflight-already-provisioned shortcut share
// one implementation.
async function writeAgentConfig(
  target: AgentTarget,
  agent: (typeof AGENTS)[AgentTarget],
  args: Argv,
): Promise<void> {
  // Tokens themselves are NOT in the env — the MCP server reads them
  // from session storage (keychain / file), which keeps them out of
  // any child-process listing or shell history.
  const launch = resolveServerLaunch();
  const env: Record<string, string> = {
    TRUSTY_SQUIRE_AGENT_IDENTITY: target,
  };
  if (args.proxyUrl !== undefined) {
    env.UNIVERSAL_BOT_PROXY_URL = args.proxyUrl;
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
  if (args.proxyUrl !== undefined) {
    ui.hint(`  Residential proxy baked in: ${args.proxyUrl}`);
  }
  if (args.noRegistry) {
    ui.hint(
      "  Skill registry disabled — signups are driven fresh by your agent each time " +
        "(no shared skill replay).",
    );
  }
}

// A confirm-flow page URL that means the claim is finished and the
// browser (and any headless noVNC tunnel) should be torn down. Matches
// the explicit Finish target (/install/done) and the app landing pages
// an already-provisioned account is redirected to (/vault, /agents) —
// the latter is what left the noVNC hanging for returning users.
export function isClaimTerminalUrl(url: string): boolean {
  // Match on the PATH only — a login page like `/login?next=/vault`
  // must NOT count as terminal just because the query mentions /vault.
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return (
    path === "/install/done" ||
    path === "/vault" ||
    path === "/agents" ||
    path.startsWith("/vault/") ||
    path.startsWith("/agents/")
  );
}

// First-time setup stays open after the account claim so the user can finish
// optional setup. A forced re-login has no remaining onboarding contract — but
// the account claim (agent token) is NOT the end of the interactive sign-in.
// The API flips to `claimed` the moment the OAuth identity lands, which on a
// cold profile is BEFORE the provider's browser session is fully seeded (Google
// can still be mid-flow with a second cold-profile challenge). Tearing down on
// the bare claim killed the noVNC out from under that challenge — the "two
// number picks with a red-close between them" bug. So force-relogin now waits
// for the provider session to actually seed (or an explicit terminal page)
// before it closes; the deadline still bounds the wait.
export function shouldCompleteInstallClaim(
  claimed: boolean,
  completeOnClaim: boolean,
  sessionSeeded: boolean,
  installPageUrl: string | undefined,
): boolean {
  if (!claimed) return false;
  const terminal =
    installPageUrl !== undefined && isClaimTerminalUrl(installPageUrl);
  if (completeOnClaim) return sessionSeeded || terminal;
  // Normal onboarding waits for the explicit Finish (terminal URL) when a
  // browser URL is available to watch. The PLAIN login browser (connect claim,
  // no CDP) has NO URL signal — installPageUrl is undefined — so fall back to
  // "claimed AND provider session seeded", which means the account is bound and
  // the Google/GitHub session landed: functionally done.
  if (installPageUrl === undefined) return sessionSeeded;
  return terminal;
}

// During normal onboarding, claim happens before the browser's Finish step.
// Keep the terminal message aligned with that two-phase flow.
export function claimHeartbeatMessage(claimed: boolean): string {
  return claimed
    ? "Sign-in complete — click Finish in the browser to close it and continue."
    : "Still waiting for you to finish signing in — the URL/window above stays live until you do.";
}

async function runInstallClaim(
  apiBase: string,
  target: AgentTarget,
  baseSession: SessionData,
  skipBrowser: boolean,
  options: {
    // Whether to let the SERVER's stored install_preferences override the local
    // session's consent/proxy. Only for the non-interactive path (CI / re-install
    // inheritance). In the interactive flow the user JUST answered these questions,
    // so baseSession is authoritative — applying stale server prefs there silently
    // discarded a fresh "yes" to inbox-OTP consent (readInboxConsent → false →
    // await_verification refused despite the user consenting).
    applyServerPrefs: boolean;
    // Forced re-login is complete when the fresh account claim succeeds. Normal
    // onboarding stays open for its explicit Finish step and optional setup.
    completeOnClaim: boolean;
  },
): Promise<SessionData | null> {
  console.warn(`Connecting this machine to your account…`);
  const initiate = await installInitiate(
    apiBase,
    target,
    baseSession.machine_token ?? null,
  );

  // Track the claimed token outside the poll closure so the in-Chrome
  // flow's pollUntilClaimed can read it once the API reports claimed.
  // Wrapper object so TS can narrow `state.value` after a `=== null`
  // check at the call site — bare closure-captured `let` doesn't.
  const state: { value: ClaimResult | null } = { value: null };
  // 0.8.2 — the normal wizard's "Finish" button navigates to
  // /install/done. First-time onboarding waits for that URL so the user gets a
  // chance to complete optional setup. Forced re-login instead ends at the API
  // claim because there is no remaining onboarding contract to wait for.
  // Plain-login predicate: the connect claim browser runs plain (no CDP — a CDP
  // attach fails Google's OAuth "secure browser" check), so completion is read
  // from the API (claim) + the on-disk cookie store (seed), NOT a live context.
  const pollOnce = async (profileDir: string): Promise<boolean> => {
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
        // Bail loudly: state.value stays null and the caller
        // reports the install never completed.
        return true;
      }
    }
    // Tear down once the account is claimed AND the provider session has
    // actually seeded — not on the bare claim, which can land while Google is
    // still writing cookies on a cold profile. Read the seed straight off the
    // profile's on-disk cookie store (no live context in plain mode). Either
    // provider satisfies it: the binding sign-in seeds whichever the user used.
    const claimed = state.value !== null;
    const sessionSeeded =
      claimed &&
      (profileHasProviderCookies(profileDir, "google") ||
        profileHasProviderCookies(profileDir, "github"));
    // No browser URL to watch in plain mode — pass undefined so completion keys
    // off claimed+seeded for BOTH force-relogin and normal onboarding.
    const tearDown = shouldCompleteInstallClaim(
      claimed,
      options.completeOnClaim,
      sessionSeeded,
      undefined,
    );
    if (tearDown) {
      return true;
    }
    if (claimedThisPoll) {
      console.error(chalk.dim(`   ✓ ${claimHeartbeatMessage(true)}`));
    }
    return false;
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
    ui.panel(
      `Open this URL to sign in and confirm:\n\n  ${ui.link(initiate.confirm_url)}`,
      { color: "wine", title: "sign in" },
    );
    try {
      const openMod = await import("open");
      await openMod.default(initiate.confirm_url);
    } catch {
      // ignore — user copies the URL
    }
    const ok = await pollForClaim(apiBase, initiate.setup_code);
    if (ok === null) return null;
    return {
      ...applyInstallPreferences(
        baseSession,
        ok.preferences,
        options.applyServerPrefs,
      ),
      api_base_url: apiBase,
      saved_at: new Date().toISOString(),
      agent_session_token: ok.token,
      account_id: ok.account_id,
    };
  }

  // Default: run the confirm INSIDE the bot's Chrome. The user signs
  // The wizard page reads provider state from /v1/auth/whoami so no
  // CLI-side hint is needed. apiBaseUrl threads through to the
  // headless rig so it can shorten the cloudflared tunnel URL to
  // `trustysquire.ai/g/<slug>` before printing it in the banner (G15).
  const result = await openInstallConfirmInBotChrome({
    confirmUrl: initiate.confirm_url,
    pollUntilClaimed: pollOnce,
    apiBaseUrl: apiBase,
    heartbeatMessage: () => claimHeartbeatMessage(state.value !== null),
  });

  // rc.33 — surface the underlying error instead of letting the outer
  // wrapper print a generic "browser confirm step never finished."
  // Most common case: a fresh headless box without the noVNC stack
  // (x11vnc/novnc/websockify/cloudflared) — the runHeadlessChrome
  // requireBinaries() throw already names the missing binaries and
  // the apt-get install line, but the message was getting swallowed.
  if (result.status === "error") {
    ui.fail(`Couldn't open the confirm page: ${result.detail ?? "unknown error"}`);
    process.exit(1);
  }

  if (result.status !== "claimed" || state.value === null) {
    return null;
  }

  return {
    ...applyInstallPreferences(
      baseSession,
      state.value.preferences,
      options.applyServerPrefs,
    ),
    api_base_url: apiBase,
    saved_at: new Date().toISOString(),
    agent_session_token: state.value.token,
    account_id: state.value.account_id,
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
  const proxy = preferences.proxy_url?.trim();
  return {
    ...baseSession,
    consent_skillify_telemetry: preferences.registry_enabled === true,
    consent_operator_inbox_otp: preferences.consent_operator_inbox_otp === true,
    ...(proxy !== undefined && proxy.length > 0 ? { proxy_url: proxy } : {}),
  };
}

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
    process.exit(2);
  }
  console.error("No coding agents auto-detected. Pass --target= explicitly:");
  for (const a of Object.values(AGENTS)) {
    console.error(`  --target=${a.target}  (${a.display_name})`);
  }
  process.exit(2);
}

async function logout(): Promise<void> {
  const storage = await openSessionStorage();
  await storage.clear();
  console.warn(`✓ Cleared local session (${storage.backendName()}).`);
}

// Establish (or confirm) a provider session in the bot's persistent
// Chrome profile — the one-time interactive login the OAuth-first
// signup path needs. With a display this opens a Chrome window;
// headless, it prints a URL to log in from any browser. Defaults to
// Google; `login --provider=github` logs the same profile into GitHub.
// Unlike the login stage inside `install`, this command fails loud on
// timeout/error — it's the explicit retry path.
async function login(args: Argv): Promise<void> {
  const provider: OAuthProviderId =
    args.providerArg ?? args.forceReloginProvider ?? "google";
  const label = provider === "github" ? "GitHub" : "Google";
  ui.heading(`Sign in to ${label}`);
  // --force-relogin wipes this provider's cookies (via forceOpen below),
  // so drop its marker up front too. Otherwise a stale marker from a
  // prior successful login survives a re-login that the user abandons or
  // that times out (e.g. GitHub's 2FA "verify it's you" never finished) —
  // leaving logged-in-providers.json claiming a session whose auth cookie
  // (user_session) no longer exists. ensureOAuthSession re-adds the marker
  // only when it confirms a live cookie, so success still records it.
  if (args.forceRelogin) clearProviderLoggedIn(provider);
  const result = await ensureOAuthSession({
    provider,
    apiBaseUrl: args.apiBase,
    // --profile-dir pins login to an isolated profile (a secondary
    // personal Google identity) instead of the shared bot profile.
    ...(args.profileDir !== undefined ? { profileDir: args.profileDir } : {}),
    // 0.8.3-rc.1 — --force-relogin now also applies to the bare
    // `login` command. Without this, a valid cached session
    // short-circuits the flow and the operator has no way to open
    // the noVNC URL — even when the actual problem is a service-
    // side challenge (GitHub's "verify it's you" / Google's device-
    // prompt drift) that only an interactive browser session can
    // clear.
    ...(args.forceRelogin ? { forceOpen: true } : {}),
  });
  switch (result.status) {
    case "already_valid":
      await recordConnectedProvider(provider);
      ui.success(`Already signed in to ${label}.`);
      return;
    case "logged_in":
      await recordConnectedProvider(provider);
      ui.success(`Signed in to ${label}. The bot is ready.`);
      return;
    case "timeout":
      ui.fail(`Sign-in timed out. Retry: ${ui.code("npx @trusty-squire/mcp login")}`);
      process.exit(1);
    case "error":
      ui.fail(`Sign-in failed: ${result.detail ?? "unknown error"}`);
      process.exit(1);
  }
}

function printHelp(): void {
  ui.heading("Trusty Squire");
  ui.hint("Connect a coding agent to your squire.");
  console.warn("");
  console.warn(`${chalk.bold("Commands")}`);
  console.warn(`  ${ui.code("connect")}                       set up this machine (default)`);
  console.warn(`  ${ui.code("login --provider=<p>")}          add a Google or GitHub session`);
  console.warn(`  ${ui.code("settings")}                      edit registry, OTP, and proxy choices`);
  console.warn(`  ${ui.code("logout")}                        clear the local session`);
  console.warn("");
  console.warn(`${chalk.bold("Flags for connect")}`);
  console.warn(`  --target=<${Object.keys(AGENTS).join("|")}>`);
  console.warn(`  --skip-browser               don't launch a browser (CI mode)`);
  console.warn(`  --force-relogin[=google|github] switch the bound account or one provider`);
  console.warn(`  --proxy-url=<url>            bake a residential proxy into the bot env`);
  console.warn(`  --no-registry                disable managed registry participation`);
  console.warn(`  --no-interactive             skip the TUI picker (use flag defaults only)`);
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
    proxy_url?: string;
  };
}

async function pollForClaim(
  apiBase: string,
  setupCode: string,
  intervalMsOrOpts: number | { intervalMs?: number; timeoutMs?: number } = {},
  timeoutMsArg?: number,
): Promise<ClaimResult | null> {
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
    if (status.status === "expired") return null;
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
      ui.success(
        `Detected network: ${orgDisplay} (residential — captchas should pass cleanly)`,
      );
      return;
    case "unknown":
      ui.info(
        `Detected network: ${orgDisplay} (couldn't classify — proceed and we'll see)`,
      );
      return;
  }
}

export {
  connect,
  logout,
  login,
  parseArgs,
  pollForClaim,
  printAsnWarning,
  resolveCopiedNpxServerLaunch,
  resolveServerLaunch,
};
