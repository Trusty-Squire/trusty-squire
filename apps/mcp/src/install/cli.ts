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

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";

type ProviderArg = "google" | "github";

type Argv = {
  command: string;
  target?: AgentTarget;
  apiBase: string;
  // Residential proxy URL to bake into the written MCP config's env as
  // UNIVERSAL_BOT_PROXY_URL — so the proxy is set once at install time
  // and the user never hand-edits the config env.
  proxyUrl?: string;
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
  let providerArg: ProviderArg | undefined;
  let skipBrowser = false;
  let forceRelogin = false;
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
    } else if (arg.startsWith("--provider=")) {
      const p = arg.slice("--provider=".length);
      if (p === "google" || p === "github") providerArg = p;
    } else if (arg === "--skip-browser" || arg === "--skip-login") {
      // --skip-login kept as an alias for the 0.5.0 spelling so any
      // scripted callers still work.
      skipBrowser = true;
    } else if (arg === "--force-relogin") {
      forceRelogin = true;
    }
  }
  const args: Argv = { command, apiBase, skipBrowser, forceRelogin };
  if (target !== undefined) args.target = target;
  if (proxyUrl !== undefined && proxyUrl.length > 0) args.proxyUrl = proxyUrl;
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
  ui.heading("Setting up Trusty Squire on this machine");

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
      await writeAgentConfig(target, agent, args);
      ui.success(
        `Already provisioned (machine + ${preflight.providers.join("/")} session) — ` +
          `refreshed ${agent.display_name} MCP config without re-running the browser flow`,
      );
      ui.hint(`Pass ${ui.code("--force-relogin")} if you want to switch the bound account.`);
      return;
    }
  }

  // Detect egress class so the asn rides along in the install payload
  // (API uses it to correlate captcha failures with network class).
  // Best-effort: a failure returns null and the install continues.
  const asn = await ui.withSpinner({
    start: "Detecting your network…",
    done: "Network detected",
    fail: () => "Network detection failed (continuing anyway)",
    task: () => detectAsn(),
  });

  // The machine token is the bot-internal credential the universal
  // signup bot uses for the LLM proxy and the inbox alias service. It
  // is NOT the user's auth — the agent_session_token (issued via the
  // browser confirm flow below) is. The MCP server reads both from the
  // session file.
  const machine = await ui.withSpinner({
    start: "Issuing a machine token…",
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
      "Install didn't complete — the browser confirm step never finished. " +
        `Try again with ${ui.code("npx @trusty-squire/mcp connect")}.`,
    );
    process.exit(1);
  }

  const storage = await openSessionStorage();
  await storage.write(session);
  ui.success(`Session saved (${storage.backendName()})`);

  await writeAgentConfig(target, agent, args);
  if (args.skipBrowser) {
    ui.panel(
      `--skip-browser was set, so the bot's Chrome didn't observe your sign-in. ` +
        `Before your first OAuth-based signup, run:\n\n` +
        `  ${ui.code("npx @trusty-squire/mcp login [--provider=google|github]")}`,
      { title: "Heads up", color: "yellow" },
    );
  }

  console.warn("");
  ui.success(`You're done. Restart ${agent.display_name} to pick up the new tools.`);
  console.warn("");
  ui.hint("Try it now — ask your agent:");
  ui.hint(`  "sign me up for Resend"`);
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
  await agent.writeConfig({
    command: launch.command,
    args: launch.args,
    env,
  });
  ui.success(`Wrote ${agent.display_name} MCP config at ${ui.code(agent.config_path())}`);
  if (args.proxyUrl !== undefined) {
    ui.hint(`  Residential proxy baked in: ${args.proxyUrl}`);
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
    console.warn(`Open this URL in your browser to sign in and confirm:`);
    console.warn(`  ${initiate.confirm_url}`);
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
  console.warn(`Establishing a ${label} session for the bot…`);
  const result = await ensureOAuthSession({ provider, apiBaseUrl: args.apiBase });
  switch (result.status) {
    case "already_valid":
      console.warn(`✓ Already logged in — the bot's Chrome profile has a valid ${label} session.`);
      return;
    case "logged_in":
      console.warn(`✓ Logged in. The bot can now do OAuth signups with your ${label} identity.`);
      return;
    case "timeout":
      console.error(
        `Login timed out — no login completed. Re-run \`npx @trusty-squire/mcp login\`.`,
      );
      process.exit(1);
    case "error":
      console.error(`Login failed: ${result.detail ?? "unknown error"}`);
      process.exit(1);
  }
}

function printHelp(): void {
  console.warn(`mcp — connect Trusty Squire to a coding agent`);
  console.warn(``);
  console.warn(`Commands:`);
  console.warn(
    `  connect [--target=<agent>] [--provider=google|github|both] [--skip-login] [--proxy-url=<url>] [--force-relogin]`,
  );
  console.warn(`  login [--provider=google|github]   re-run the one-time OAuth sign-in`);
  console.warn(`  logout`);
  console.warn(``);
  console.warn(`Agents: ${Object.keys(AGENTS).join(", ")}`);
  console.warn(``);
  console.warn(`\`connect\` writes the MCP config, opens a browser so you can sign in`);
  console.warn(`(Google or GitHub) to confirm this machine, and then connects the`);
  console.warn(`OAuth identity the bot rides when it signs you up for services.`);
  console.warn(`Best run on a laptop or desktop — a headless box does a one-time`);
  console.warn(`remote-browser login instead. Use --skip-login for CI / scripted`);
  console.warn(`installs and run \`login\` later.`);
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
