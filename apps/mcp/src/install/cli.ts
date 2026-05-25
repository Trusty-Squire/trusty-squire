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
import { cpSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { installInitiate, installPoll, issueMachineToken } from "../api-client.js";
import { openSessionStorage, type SessionData } from "../session.js";
import { AGENTS, detectInstalledAgents, type AgentTarget } from "./agents.js";
import { detectAsn, type AsnInfo } from "../bot/index.js";
import {
  ensureOAuthSession,
  openInstallConfirmInBotChrome,
} from "../bot/google-login.js";
import { type OAuthProviderId } from "../bot/oauth-providers.js";
import { loggedInProviders } from "../bot/login-state.js";
import { VERSION } from "../version.js";
import * as ui from "./ui.js";
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
  // --skip-secondary: don't prompt for the secondary provider after
  // the primary install (or preflight-detected) completes. For CI /
  // scripted installs that only need one provider. Default: false
  // (i.e., user gets the prompt, default-answer yes).
  skipSecondary: boolean;
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
  let skipSecondary = false;
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
      skipSecondary = true;
    }
  }
  const args: Argv = { command, apiBase, skipBrowser, forceRelogin, noRegistry, skipSecondary };
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
 */
export function copyNpxNodeModules(src: string, dest: string): void {
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
  ui.heading("Trusty Squire");
  ui.hint("Setting up this machine.");

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
      ui.success(
        `Already provisioned (${preflight.providers.join(" + ")}). ` +
          `${agent.display_name} config refreshed.`,
      );
      // Backfill connected_providers from the bot-side marker on
      // pre-rc.5 sessions, so the preflight cache is current.
      for (const p of preflight.providers) await recordConnectedProvider(p);
      // Even on a fast-path preflight pass, offer the secondary
      // provider if only one is connected. This is the natural prompt
      // for users who originally chose "skip" at step 2.
      await maybeOfferSecondaryProvider(args);
      ui.hint(`Pass ${ui.code("--force-relogin")} to switch accounts.`);
      return;
    }
  }

  console.warn("");
  console.warn(
    "You need to connect your Google and/or GitHub OAuth accounts to use Trusty Squire.",
  );
  ui.section(1, 2, "Connect Google");

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

  // Backfill connected_providers from the bot-side marker the browser
  // confirm seeded. The user's provider choice on the web form
  // determines which one is present here.
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

  // Step 2 of the install ceremony — defaults to yes, opt out with
  // --skip-secondary. Silent no-op on --skip-browser runs (no primary
  // session was seeded so there's no basis for the prompt).
  if (!args.skipBrowser) {
    await maybeOfferSecondaryProvider(args);
  }

  ui.divider();
  ui.panel(
    `Squire on duty. Restart ${agent.display_name} to pick up the new tools.\n\n` +
      `Try it — ask your agent: ${ui.code(`"sign me up for Resend"`)}`,
    { color: "wine" },
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
// install would establish. Returns the list of provider sessions
// detected, or null when anything's missing. Best-effort: any read
// error returns null and the caller proceeds with the normal flow.
async function checkAlreadyProvisioned(): Promise<{ providers: OAuthProviderId[] } | null> {
  try {
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (
      session === null ||
      session.machine_token === undefined ||
      session.agent_session_token === undefined ||
      session.account_id === undefined
    ) {
      return null;
    }
    const providers = loggedInProviders();
    if (providers.length === 0) return null;
    return { providers };
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

// Step 2 of the install ceremony: offer to add a session for the
// OTHER provider so the bot can complete OAuth signups against
// services that only support the one we didn't pick at step 1.
//
// Triggers when:
//   - `connect` finished step 1 successfully (primary session seeded), AND
//   - the bot's profile has a session for exactly one of {google, github}, AND
//   - `--skip-secondary` is not set
//
// Defaults to yes — one extra noVNC sign-in at install time beats
// being surprised mid-run later. The user can dismiss with "n" and
// come back via `mcp login --provider=<other>` anytime.
async function maybeOfferSecondaryProvider(args: Argv): Promise<void> {
  if (args.skipSecondary) return;
  const present = new Set(loggedInProviders());
  if (present.size === 0) return; // step 1 didn't seed anything — no basis to ask
  if (present.has("google") && present.has("github")) return; // both already connected
  const missing: OAuthProviderId = present.has("google") ? "github" : "google";
  const missingLabel = missing === "google" ? "Google" : "GitHub";
  const missingExamples =
    missing === "github"
      ? "Railway, Vercel, parts of Cloudflare"
      : "Resend, IPInfo, Postmark";

  console.warn("");
  ui.hint(
    `Some services are ${missingLabel}-only (${missingExamples}).`,
  );
  ui.section(2, 2, `Connect ${missingLabel}`);
  const yes = await promptYesNo(`Add ${missingLabel}?`, true);
  if (!yes) {
    ui.hint(
      `Skipped. Add anytime: ${ui.code(`npx @trusty-squire/mcp login --provider=${missing}`)}`,
    );
    return;
  }
  console.warn(`Opening browser for ${missingLabel} sign-in…`);
  const result = await ensureOAuthSession({
    provider: missing,
    apiBaseUrl: args.apiBase,
  });
  if (result.status === "logged_in" || result.status === "already_valid") {
    await recordConnectedProvider(missing);
    ui.success(`${missingLabel} session added.`);
  } else {
    ui.warn(
      `${missingLabel} sign-in didn't complete (${result.status}). ` +
        `Retry: ${ui.code(`npx @trusty-squire/mcp login --provider=${missing}`)}`,
    );
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
  await agent.writeConfig({
    command: launch.command,
    args: launch.args,
    env,
  });
  ui.success(`Wrote ${agent.display_name} MCP config at ${ui.code(agent.config_path())}`);
  if (args.proxyUrl !== undefined) {
    ui.hint(`  Residential proxy baked in: ${args.proxyUrl}`);
  }
  if (args.noRegistry) {
    ui.hint("  Skill registry disabled (--no-registry) — every signup goes through the universal bot");
  } else if (args.registryUrl !== undefined) {
    ui.hint(`  Skill registry: ${args.registryUrl}`);
  }
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
  const pollOnce = async (): Promise<boolean> => {
    if (state.value !== null) return true;
    const status = await installPoll(apiBase, initiate.setup_code);
    if (status.status === "claimed" && status.agent_session_token !== undefined) {
      state.value = {
        token: status.agent_session_token,
        account_id: status.account_id ?? "",
      };
      return true;
    }
    // Expired: also stop Chrome (returning true) — the outer check
    // sees state.value === null and reports the install failed.
    return status.status === "expired";
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
  // in there once; that sign-in does both the trustysquire claim AND
  // the bot's provider-session seeding in one event. apiBaseUrl
  // threads through to the headless rig so it can shorten the
  // cloudflared tunnel URL to `trustysquire.ai/g/<slug>` before
  // printing it in the banner (G15).
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
  const result = await ensureOAuthSession({ provider, apiBaseUrl: args.apiBase });
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
