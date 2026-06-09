// Setup CLI — install / logout / login subcommands.
//
//   npx @trusty-squire/mcp install --target=claude-code
//     Issues a machine token, then opens the trustysquire install-
//     confirm page in the bot's own Chrome. The user signs in there
//     once (Google or GitHub) — that single sign-in does TWO things:
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
//   --registry-url=<url> override the default skill registry URL
//                        (default: https://registry.trustysquire.ai).
//                        Baked into the MCP config's env as
//                        TRUSTY_SQUIRE_REGISTRY_URL so the Tier-2
//                        router is on out of the box.
//   --no-registry        omit TRUSTY_SQUIRE_REGISTRY_URL from the
//                        config → mcp skips the router entirely and
//                        every signup goes through the universal bot
//
// Pure module — `runCli()` is invoked by bin.ts. No shebang, no
// entrypoint guard, no top-level execution.

import process from "node:process";
import { cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { loadHarvesterEnvFile } from "../operator-env.js";
import { fileURLToPath } from "node:url";
import { installInitiate, installPoll, issueMachineToken } from "../api-client.js";
import { openSessionStorage, type SessionData } from "../session.js";
import {
  AGENTS,
  detectInstalledAgents,
  writeClaudeCodePermissions,
  type AgentTarget,
} from "./agents.js";
import { detectAsn, type AsnInfo } from "../bot/index.js";
import {
  detectActiveProviderSessions,
  ensureOAuthSession,
  openInstallConfirmInBotChrome,
} from "../bot/google-login.js";
import { type OAuthProviderId } from "../bot/oauth-providers.js";
import {
  clearAllProviderMarkers,
  clearProviderCookies,
  clearProviderLoggedIn,
  loggedInProviders,
  markProviderLoggedIn,
} from "../bot/login-state.js";
import type { BrowserContext } from "playwright";
import { VERSION } from "../version.js";
import * as ui from "./ui.js";
import { runInteractiveSetup, shouldRunInteractive, showOutro } from "./interactive.js";
import chalk from "chalk";

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
// Default skill-registry URL. Wired into the MCP config's env block
// so users don't have to set it manually — without it, mcp skips the
// Tier-2 router and every signup goes through the universal bot
// (fail-open by design, but a worse experience than just using the
// closed loop).
const DEFAULT_REGISTRY_URL =
  process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai";

type ProviderArg = "google" | "github";

type Argv = {
  command: string;
  target?: AgentTarget;
  apiBase: string;
  // Residential proxy URL to bake into the written MCP config's env as
  // UNIVERSAL_BOT_PROXY_URL — so the proxy is set once at install time
  // and the user never hand-edits the config env.
  proxyUrl?: string;
  // Skill registry URL — baked into the MCP config's env as
  // TRUSTY_SQUIRE_REGISTRY_URL. Defaults to the production registry;
  // override with --registry-url=<url> (staging / self-hosted),
  // disable with --no-registry (skip Tier-2 router entirely, every
  // signup goes through the universal bot).
  registryUrl?: string;
  noRegistry: boolean;
  // OAuth provider — for `login`, picks which provider to sign in to.
  // For `install`, the provider is chosen by the user inside the
  // trustysquire confirm page (Google or GitHub button), so this flag
  // is ignored there.
  providerArg?: ProviderArg;
  // --skip-browser (also accepts the legacy --skip-login spelling):
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
  // --no-interactive: skip the clack picker even in a TTY. Useful for
  // scripted runs that still want a normal Chrome confirm (i.e. don't
  // imply --skip-browser).
  noInteractive: boolean;
  // 0.8.1: choices the interactive picker collected (or that --llm /
  // --byok-key flags pre-filled). Threaded into writeAgentConfig.
  llmChoice?: import("./interactive.js").LlmChoice;
  byokKey?: string;
};

function parseArgs(argv: string[]): Argv {
  const positional = argv.filter((a) => !a.startsWith("--"));
  // `connect` is the canonical command as of 0.6.14. `install` is kept
  // as a hidden alias so any docs/scripts/blog-posts published against
  // ≤0.6.13 still work — it emits a one-line deprecation notice but
  // otherwise behaves identically. Default (no positional) → `connect`
  // because the most common invocation is `npx @trusty-squire/mcp` with
  // no args, and that should still kick off the setup flow.
  let command = positional[0] ?? "connect";
  if (command === "install") {
    console.warn(
      "[trusty-squire] `install` is now `connect`. " +
        "This alias still works but will be removed in a future major. " +
        "Update your docs/scripts to: `npx @trusty-squire/mcp connect`.",
    );
    command = "connect";
  }
  let target: AgentTarget | undefined;
  let apiBase = DEFAULT_API_BASE;
  let proxyUrl: string | undefined;
  let registryUrl: string | undefined;
  let noRegistry = false;
  let providerArg: ProviderArg | undefined;
  let skipBrowser = false;
  let forceRelogin = false;
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
      proxyUrl = arg.slice("--proxy-url=".length);
    } else if (arg.startsWith("--registry-url=")) {
      registryUrl = arg.slice("--registry-url=".length);
    } else if (arg === "--no-registry") {
      noRegistry = true;
    } else if (arg.startsWith("--provider=")) {
      const p = arg.slice("--provider=".length);
      if (p === "google" || p === "github") providerArg = p;
    } else if (arg === "--skip-browser" || arg === "--skip-login") {
      // --skip-login kept as an alias for the 0.5.0 spelling so any
      // scripted callers still work.
      skipBrowser = true;
    } else if (arg === "--force-relogin") {
      forceRelogin = true;
    } else if (arg === "--skip-secondary") {
      // No-op: kept as a flag for backwards-compat. The 0.8.2 wizard
      // collapsed step 1 + step 2 into one browser session, so there
      // is no "secondary" stage left to skip.
    } else if (arg === "--no-interactive") {
      noInteractive = true;
    }
  }
  const args: Argv = {
    command,
    apiBase,
    skipBrowser,
    forceRelogin,
    noRegistry,
    noInteractive,
  };
  if (target !== undefined) args.target = target;
  if (proxyUrl !== undefined && proxyUrl.length > 0) args.proxyUrl = proxyUrl;
  if (registryUrl !== undefined && registryUrl.length > 0) args.registryUrl = registryUrl;
  if (providerArg !== undefined) args.providerArg = providerArg;
  return args;
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
// 2. Ephemeral + stable version — the CLI was invoked via
//    `npx @trusty-squire/mcp@X.Y.Z`, which copies the package into
//    npx's throwaway cache. The cache CAN get swept, so we don't
//    pin the cache path; instead we write `npx @trusty-squire/mcp@<version>`
//    so the launch re-resolves against npm every time. Works as
//    long as the version is on the public npm registry.
//
// 3. Ephemeral + prerelease version — the CLI was invoked via
//    `npx <tarball-url>` (the GitHub-Release test pattern). The
//    version isn't on npm, so case 2 would fail with `ETARGET`.
//    We instead copy the package out of the ephemeral cache into
//    `~/.trusty-squire/lib/mcp` and write a `node <stable>/dist/bin.js`
//    launch. The stable copy survives npx-cache cleanup; if the user
//    re-installs they overwrite it.
//
// Prerelease detection: semver prerelease versions carry a `-` (e.g.
// `0.6.0-rc.1`). Stable versions don't. Cheap, reliable.
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
  const isPrerelease = VERSION.includes("-");
  if (!isPrerelease) {
    return { command: "npx", args: ["-y", `@trusty-squire/mcp@${VERSION}`, "server"] };
  }
  // Prerelease from GitHub Releases — copy the package PLUS the
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
      await connect(args);
      return;
    case "logout":
      await logout();
      return;
    case "login":
      await login(args);
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

async function connect(args: Argv): Promise<void> {
  // 0.8.1 — interactive picker (clack), Goose-flavored. Walks the
  // user through agent / OAuth providers / LLM choice / advanced
  // before the install ceremony fires. The picker fills in args so
  // the rest of this function is unchanged.
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
    // surfaces agent + LLM + advanced.
    const picker = await runInteractiveSetup({
      ...(args.target !== undefined ? { initialTarget: args.target } : {}),
      ...(args.proxyUrl !== undefined ? { initialProxyUrl: args.proxyUrl } : {}),
      ...(args.registryUrl !== undefined ? { initialRegistryUrl: args.registryUrl } : {}),
      registryEnabled: !args.noRegistry,
    });
    args.target = picker.target;
    args.llmChoice = picker.llmChoice;
    if (picker.byokKey !== undefined) args.byokKey = picker.byokKey;
    if (picker.proxyUrl !== undefined) args.proxyUrl = picker.proxyUrl;
    if (!picker.registryEnabled) {
      args.noRegistry = true;
    } else if (picker.registryUrl !== undefined) {
      args.registryUrl = picker.registryUrl;
    }
  } else {
    ui.heading("Trusty Squire");
    ui.hint("Setting up this machine.");
  }

  const target = await resolveTarget(args.target);
  const agent = AGENTS[target];

  // Preflight: an existing install that's fully provisioned (machine
  // token + agent session token + a bot Google session marker) doesn't
  // need to redo the browser confirm. Just rewrite the MCP config in
  // place so the host agent picks up the latest server entrypoint and
  // env. Pass --force-relogin to bypass (e.g. to switch Google account).
  if (!args.forceRelogin) {
    const preflight = await checkAlreadyProvisioned();
    if (preflight !== null) {
      ui.divider();
      await writeAgentConfig(target, agent, args);
      const provNote =
        preflight.providers.length > 0
          ? `Already provisioned (${preflight.providers.join(" + ")}).`
          : `Session valid — no bot OAuth login on this machine yet ` +
            `(run ${ui.code("npx @trusty-squire/mcp login")} to enable ` +
            `OAuth-preferring signups).`;
      ui.success(`${provNote} ${agent.display_name} config refreshed.`);
      // Backfill connected_providers from the bot-side marker on
      // pre-rc.5 sessions, so the preflight cache is current.
      for (const p of preflight.providers) await recordConnectedProvider(p);
      ui.hint(`Pass ${ui.code("--force-relogin")} to switch accounts.`);
      return;
    }
  }

  console.warn("");
  console.warn(
    "Opening the Trusty Squire install page in a browser. " +
      "The page walks you through signing in with Google and (optionally) GitHub.",
  );

  // --force-relogin means "redo the OAuth dance from scratch" — wipe
  // the bot's profile cookies + marker so the install wizard sees a
  // clean slate. The user signs in fresh inside the bot Chrome.
  if (args.forceRelogin) {
    clearAllProviderMarkers();
    await clearProviderCookies();
  }

  // Detect egress class so the asn rides along in the install payload
  // (API uses it to correlate captcha failures with network class).
  // Best-effort: a failure returns null and the install continues.
  const asn = await ui.withSpinner({
    start: "Detecting network",
    done: "Network detected",
    fail: () => "Network detection failed (continuing)",
    task: () => detectAsn(),
  });

  // The machine token is the bot-internal credential the universal
  // signup bot uses for the LLM proxy and the inbox alias service. It
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
  };
  const session = await runInstallClaim(args.apiBase, target, baseSession, args.skipBrowser);
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
      task: () => detectActiveProviderSessions(),
    });
    if (actual !== null) {
      clearAllProviderMarkers();
      for (const p of actual) markProviderLoggedIn(p);
    }
  } catch {
    // Best-effort: a probe failure (rare — playwright launch should
    // succeed if the install confirm just opened Chrome there) just
    // leaves the marker as-is. The downstream secondary prompt's
    // logic still has the maybeOfferSecondaryProvider escape hatch
    // (yes/no prompt with the default-yes), so the user can still
    // reach GitHub even if we mis-identified the live state.
  }

  // Backfill connected_providers from the (now-fresh) bot-side marker.
  for (const p of loggedInProviders()) await recordConnectedProvider(p);

  await writeAgentConfig(target, agent, args);
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
// install would establish. Returns the list of provider sessions
// detected, or null when anything's missing. Best-effort: any read
// error returns null and the caller proceeds with the normal flow.
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

// Pure gate for the `connect` fast path: given the read session, whether
// its agent token still validated, and the bot's provider markers, decide
// whether connect can (re)write the MCP config WITHOUT a browser re-claim.
//
// The provider marker is INFORMATIONAL — it tells the signup bot which
// providers to auto-prefer for OAuth, NOT whether the host agent can be
// wired up. A valid session (machine + agent token that just validated)
// is sufficient. Gating on a non-empty marker used to force a full
// browser re-claim on any box whose bot profile had no login yet (a fresh
// machine that restored session.json, or a headless box where the claim
// browser can't run) — leaving the user with NO config written and no
// clear reason. So an empty `providers` is fine; we still return
// provisioned. Exported for unit tests.
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
    return decideProvisioned(session, stillValid, loggedInProviders());
  } catch {
    return null;
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

// Y/n prompt with a default answer. Returns true on yes, false on no.
// Default is taken when the user just hits enter or when stdin isn't
// a TTY (CI / scripted contexts). Designed to match what the user
// expects from common CLI tooling — `[Y/n]` means default-yes.
async function promptYesNo(message: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(`${message} ${suffix} `, resolve);
    });
    const trimmed = answer.trim().toLowerCase();
    if (trimmed.length === 0) return defaultYes;
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
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
    UNIVERSAL_BOT_PREFER_CHEAP: "true",
  };
  if (args.proxyUrl !== undefined) {
    env.UNIVERSAL_BOT_PROXY_URL = args.proxyUrl;
  }
  // Skill registry URL — wired by default so the Tier-2 router is on
  // out of the box. Override with --registry-url=<url>; opt out
  // entirely with --no-registry (which omits the var → router skips).
  if (!args.noRegistry) {
    env.TRUSTY_SQUIRE_REGISTRY_URL = args.registryUrl ?? DEFAULT_REGISTRY_URL;
  }
  // 0.8.1 — LLM choice from the interactive picker (or future
  // --llm/--byok-key flags). BYOK paths write the provider key as
  // env; the server's LLM client picks the matching path. The
  // managed-free path omits keys entirely so the server routes
  // through our proxy (the rate-limited /v1/llm/chat endpoint).
  switch (args.llmChoice) {
    case "byok_openrouter":
      if (args.byokKey !== undefined) env.OPENROUTER_API_KEY = args.byokKey;
      break;
    case "byok_anthropic":
      if (args.byokKey !== undefined) env.ANTHROPIC_API_KEY = args.byokKey;
      break;
    case "byok_openai":
      if (args.byokKey !== undefined) env.OPENAI_API_KEY = args.byokKey;
      break;
    // "managed_free" / "skip" / undefined → no LLM env. The server's
    // proxy path is the default; "skip" means the user will set keys
    // themselves outside this CLI.
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
    ui.hint("  Skill registry disabled (--no-registry) — every signup goes through the universal bot");
  } else if (args.registryUrl !== undefined) {
    ui.hint(`  Skill registry: ${args.registryUrl}`);
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

async function runInstallClaim(
  apiBase: string,
  target: AgentTarget,
  baseSession: SessionData,
  skipBrowser: boolean,
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
  const state: { value: { token: string; account_id: string } | null } = { value: null };
  // 0.8.2 — the wizard's "Finish" button navigates to /install/done.
  // The bot waits for that URL before closing Chrome, so the user
  // gets a chance to complete optional step 2 (GitHub) AND any
  // future steps (payment). The API poll still runs so we cache
  // the agent_session_token from the /claim moment, but it no longer
  // triggers Chrome teardown on its own.
  const pollOnce = async (context: BrowserContext): Promise<boolean> => {
    // Keep state.value warm — the install moves to "claimed" the
    // instant the user finishes step 1, even though we don't tear
    // down until they hit /install/done.
    if (state.value === null) {
      const status = await installPoll(apiBase, initiate.setup_code);
      if (status.status === "claimed" && status.agent_session_token !== undefined) {
        state.value = {
          token: status.agent_session_token,
          account_id: status.account_id ?? "",
        };
      } else if (status.status === "expired") {
        // Bail loudly: state.value stays null and the caller
        // reports the install never completed.
        return true;
      }
    }
    // Tear down once the claim is in hand AND the confirm flow has
    // reached a terminal page. /install/done is the explicit Finish
    // target, but an already-provisioned account skips the wizard and
    // redirects straight to /vault — without recognizing that too, the
    // bot's Chrome (and the headless noVNC tunnel) never closes and the
    // user is left staring at a live tunnel after the claim already
    // succeeded. Gate on state.value so a stale /vault tab open BEFORE
    // the claim can't trigger a premature teardown.
    if (state.value !== null) {
      for (const page of context.pages()) {
        if (isClaimTerminalUrl(page.url())) return true;
      }
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
      ...baseSession,
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
    ...baseSession,
    api_base_url: apiBase,
    saved_at: new Date().toISOString(),
    agent_session_token: state.value.token,
    account_id: state.value.account_id,
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
    args.providerArg === "github" ? "github" : "google";
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
  console.warn(`  ${ui.code("logout")}                        clear the local session`);
  console.warn("");
  console.warn(`${chalk.bold("Flags for connect")}`);
  console.warn(`  --target=<${Object.keys(AGENTS).join("|")}>`);
  console.warn(`  --skip-secondary             don't prompt for the second provider`);
  console.warn(`  --skip-login                 don't launch a browser (CI mode)`);
  console.warn(`  --force-relogin              switch the bound account`);
  console.warn(`  --proxy-url=<url>            bake a residential proxy into the bot env`);
  console.warn(`  --registry-url=<url>         use a non-default skill registry`);
  console.warn(`  --no-registry                disable the Tier-2 router entirely`);
  console.warn(`  --no-interactive             skip the TUI picker (use flag defaults only)`);
  console.warn("");
  console.warn(`${chalk.bold("Example")}`);
  console.warn(`  ${ui.code("npx @trusty-squire/mcp connect")}`);
  console.warn("");
}

interface ClaimResult {
  token: string;
  account_id: string;
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

// Back-compat alias: external imports of `install` keep working at the module
// level. The CLI command got renamed; the function is the same.
export {
  connect,
  connect as install,
  logout,
  login,
  parseArgs,
  pollForClaim,
  printAsnWarning,
  resolveServerLaunch,
};
