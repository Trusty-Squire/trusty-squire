// Setup CLI — install / logout / login subcommands.
//
//   npx @trusty-squire/mcp install --target=claude-code
//     Issues a machine token, opens the browser to connect this machine
//     to your account, writes the MCP config, then runs the one-time
//     OAuth login (Google/GitHub) the signup bot rides. One command.
//
//   npx @trusty-squire/mcp login [--provider=google|github]
//     Re-runs the OAuth sign-in for the bot's persistent Chrome
//     profile. Different from the login stage inside `install` —
//     this one fails loud on timeout/error, so it's the right
//     command to use when you're explicitly retrying login.
//
//   npx @trusty-squire/mcp logout
//
// Flags:
//   --target=<agent>             skip auto-detection
//   --api-base=<url>             override the API base URL
//   --provider=google|github|both  pick the OAuth identity to connect
//                                during the install login stage
//   --skip-login                 skip the install login stage entirely
//                                (CI / scripted installs)
//   --proxy-url=<url>            bake a residential proxy into the MCP
//                                config's env (UNIVERSAL_BOT_PROXY_URL)
//
// Pure module — `runCli()` is invoked by bin.ts. No shebang, no
// entrypoint guard, no top-level execution.

import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { installInitiate, installPoll, issueMachineToken } from "../api-client.js";
import { openSessionStorage, type SessionData } from "../session.js";
import { AGENTS, detectInstalledAgents, type AgentTarget } from "./agents.js";
import { detectAsn, type AsnInfo } from "../bot/index.js";
import { ensureOAuthSession, type LoginResult } from "../bot/google-login.js";
import { type OAuthProviderId } from "../bot/oauth-providers.js";
import { VERSION } from "../version.js";

const DEFAULT_API_BASE = process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";

type ProviderArg = "google" | "github" | "both";

type Argv = {
  command: string;
  target?: AgentTarget;
  apiBase: string;
  // Residential proxy URL to bake into the written MCP config's env as
  // UNIVERSAL_BOT_PROXY_URL — so the proxy is set once at install time
  // and the user never hand-edits the config env.
  proxyUrl?: string;
  // OAuth provider selection. "both" connects Google then GitHub.
  // Absent → `install` prompts on a TTY / defaults to Google without
  // one; `login` defaults to Google.
  providerArg?: ProviderArg;
  // --skip-login: `install` writes the config + machine token but does
  // not run the OAuth login stage. For CI / scripted installs.
  skipLogin: boolean;
};

function parseArgs(argv: string[]): Argv {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = positional[0] ?? "install";
  let target: AgentTarget | undefined;
  let apiBase = DEFAULT_API_BASE;
  let proxyUrl: string | undefined;
  let providerArg: ProviderArg | undefined;
  let skipLogin = false;
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
      if (p === "google" || p === "github" || p === "both") providerArg = p;
    } else if (arg === "--skip-login") {
      skipLogin = true;
    }
  }
  const args: Argv = { command, apiBase, skipLogin };
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

// The MCP-config command that launches the server. An absolute
// `node <bin.js> server` is deterministic and offline — no npx package
// resolution every time the host agent spawns the server. But when this
// CLI is itself running from npx's throwaway cache, that path won't
// survive a cache sweep, so fall back to a version-pinned npx call.
function resolveServerLaunch(): { command: string; args: string[] } {
  const binPath = fileURLToPath(new URL("../bin.js", import.meta.url));
  const ephemeral = /[/\\]_npx[/\\]/.test(binPath);
  return ephemeral
    ? { command: "npx", args: ["-y", `@trusty-squire/mcp@${VERSION}`, "server"] }
    : { command: process.execPath, args: [binPath, "server"] };
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "install":
      await install(args);
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

async function install(args: Argv): Promise<void> {
  const target = await resolveTarget(args.target);
  const agent = AGENTS[target];

  // ── Detect egress class ───────────────────────────────────
  // Done before the install handshake so the asn class can ride along
  // in the initiate payload — lets the API correlate captcha failures
  // with network class for analytics. Best-effort.
  const asn = await detectAsn();

  // ── Issue a machine token for the bot's inbox + LLM-proxy ─
  // The machine token is the bot-internal credential the universal
  // signup bot uses for the LLM proxy and the inbox alias service. It
  // is NOT the user's auth — the agent_session_token (issued via the
  // browser confirm flow below) is. The MCP server reads both from the
  // session file.
  console.warn(`Setting up Trusty Squire on this machine…`);
  const machine = await issueMachineToken(args.apiBase, fetch, asn ?? undefined);

  // ── Warn datacenter users explicitly ──────────────────────
  // The whole captcha-bypass story depends on a residential egress IP.
  // Datacenter ASNs (Hetzner, AWS, Codespaces) get auto-rejected by
  // reCAPTCHA v2 regardless of fingerprint quality. Better to set
  // expectations now than have the user file a "Postmark doesn't work"
  // bug later.
  if (asn !== null) {
    printAsnWarning(asn);
  }

  // ── Browser confirm: bind this machine to the user's account ─
  // Opens a URL where the user signs in (Google/GitHub) and confirms
  // the machine. We poll for the agent_session_token and write it to
  // the local session alongside the machine_token.
  const baseSession: SessionData = {
    api_base_url: args.apiBase,
    saved_at: new Date().toISOString(),
    machine_token: machine.machine_token,
  };
  const session = await runInstallClaim(args.apiBase, target, baseSession);
  if (session === null) {
    console.error(
      "Install didn't complete — the browser confirm step never finished. " +
        "Try again with `npx @trusty-squire/mcp install`.",
    );
    process.exit(1);
  }

  const storage = await openSessionStorage();
  await storage.write(session);
  console.warn(`✓ Session saved (${storage.backendName()}).`);

  // ── Write the MCP config into the host agent ──────────────
  //
  // Env vars passed to the MCP child:
  //   - TRUSTY_SQUIRE_AGENT_IDENTITY: which host agent we're running under
  //   - UNIVERSAL_BOT_PREFER_CHEAP=true: the proxy enforces this server
  //     side too, but setting it here means users who run the bot CLI
  //     directly (outside MCP) also get the cheap path by default.
  //
  // The tokens themselves are NOT in the env — the MCP server reads
  // them from session storage (keychain / file), which keeps them out
  // of any child-process listing or shell history.
  const launch = resolveServerLaunch();
  const env: Record<string, string> = {
    TRUSTY_SQUIRE_AGENT_IDENTITY: target,
    UNIVERSAL_BOT_PREFER_CHEAP: "true",
  };
  // --proxy-url bakes the residential proxy into the config so the user
  // never hand-edits env. The bot still gates it at runtime — only
  // datacenter-class egress actually routes through it.
  if (args.proxyUrl !== undefined) {
    env.UNIVERSAL_BOT_PROXY_URL = args.proxyUrl;
  }
  await agent.writeConfig({
    command: launch.command,
    args: launch.args,
    env,
  });
  console.warn(`✓ Wrote ${agent.display_name} MCP config at ${agent.config_path()}.`);
  if (args.proxyUrl !== undefined) {
    console.warn(`  Residential proxy baked in: ${args.proxyUrl}`);
  }

  // ── Connect the OAuth identity the signup bot rides ───────
  // Folded into `install` so the friction lands at setup time, not
  // mid-task on the user's first provision. Non-fatal by contract —
  // see runLoginStage; the MCP config above is the durable artifact.
  await runLoginStage(args);

  console.warn(``);
  console.warn(`You're done. Restart ${agent.display_name} to pick up the new tools.`);
  console.warn(``);
  console.warn(`Try it now — ask your agent:`);
  console.warn(`  "sign me up for Resend"`);
}

// Runs the browser-based install confirm flow. Returns a session with
// agent_session_token + account_id set on success, null on timeout/expiry.
async function runInstallClaim(
  apiBase: string,
  target: AgentTarget,
  baseSession: SessionData,
): Promise<SessionData | null> {
  console.warn(`Connecting this machine to your account…`);
  const initiate = await installInitiate(
    apiBase,
    target,
    baseSession.machine_token ?? null,
  );
  console.warn(`Open this URL in your browser to sign in and confirm:`);
  console.warn(`  ${initiate.confirm_url}`);

  try {
    const openMod = await import("open");
    await openMod.default(initiate.confirm_url);
  } catch {
    // ignore — user copies the URL
  }

  const claim = await pollForClaim(apiBase, initiate.setup_code);
  if (claim === null) return null;

  return {
    ...baseSession,
    api_base_url: apiBase,
    saved_at: new Date().toISOString(),
    agent_session_token: claim.token,
    account_id: claim.account_id,
  };
}

// The OAuth login stage of `install`. Non-fatal by contract: it never
// throws and never exits the process — a timed-out, errored or skipped
// login still leaves a working install (the MCP config is the durable
// artifact). `loginFn` is injectable so the contract is unit-testable
// without launching a real browser.
export async function runLoginStage(
  args: Argv,
  loginFn: (opts: {
    provider: OAuthProviderId;
  }) => Promise<LoginResult> = ensureOAuthSession,
): Promise<void> {
  if (args.skipLogin) {
    console.warn(``);
    console.warn(`Skipping the OAuth login (--skip-login).`);
    console.warn(
      `Run \`npx @trusty-squire/mcp login\` before your first provision — ` +
        `without it the bot can't sign you up via Google/GitHub.`,
    );
    return;
  }
  const providers = await resolveLoginProviders(args);
  for (const provider of providers) {
    const label = provider === "github" ? "GitHub" : "Google";
    console.warn(``);
    console.warn(`Connecting your ${label} account…`);
    let result: LoginResult;
    try {
      result = await loginFn({ provider });
    } catch (err) {
      result = {
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    switch (result.status) {
      case "already_valid":
        console.warn(`✓ ${label} already connected.`);
        break;
      case "logged_in":
        console.warn(`✓ ${label} connected — the bot can now sign you up with it.`);
        break;
      case "timeout":
        console.warn(`⚠ ${label} login didn't finish in time. Install is otherwise complete.`);
        console.warn(`  Finish it later: \`npx @trusty-squire/mcp login --provider=${provider}\``);
        break;
      case "error":
        console.warn(`⚠ ${label} login couldn't run: ${result.detail ?? "unknown error"}`);
        console.warn(
          `  Install is otherwise complete. Retry: ` +
            `\`npx @trusty-squire/mcp login --provider=${provider}\``,
        );
        break;
    }
  }
}

// Which providers `install` connects: an explicit --provider wins;
// otherwise prompt on an interactive terminal, or default to Google
// when there is no TTY (CI / scripted installs must never block).
async function resolveLoginProviders(args: Argv): Promise<OAuthProviderId[]> {
  if (args.providerArg === "both") return ["google", "github"];
  if (args.providerArg === "github") return ["github"];
  if (args.providerArg === "google") return ["google"];
  if (process.stdin.isTTY !== true) return ["google"];
  return promptProvider();
}

async function promptProvider(): Promise<OAuthProviderId[]> {
  console.warn(``);
  console.warn(
    `Trusty Squire signs you up to services by riding your Google or GitHub login.`,
  );
  const answer = (await promptLine(`Connect which? [google] / github / both: `))
    .trim()
    .toLowerCase();
  if (answer === "github") return ["github"];
  if (answer === "both") return ["google", "github"];
  return ["google"];
}

// Read one line from stdin. The prompt goes to stderr so it never
// pollutes stdout, which the host agent may parse.
function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    // If stdin reaches EOF before an answer (closed or redirected
    // mid-run), resolve empty rather than hang forever — the caller
    // treats "" as the default. Promise resolve is idempotent, so the
    // question callback and this close handler cannot both win.
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
  const result = await ensureOAuthSession({ provider });
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
  console.warn(`mcp — install Trusty Squire into a coding agent`);
  console.warn(``);
  console.warn(`Commands:`);
  console.warn(
    `  install [--target=<agent>] [--provider=google|github|both] [--skip-login] [--proxy-url=<url>]`,
  );
  console.warn(`  login [--provider=google|github]   re-run the one-time OAuth sign-in`);
  console.warn(`  logout`);
  console.warn(``);
  console.warn(`Agents: ${Object.keys(AGENTS).join(", ")}`);
  console.warn(``);
  console.warn(`\`install\` writes the MCP config, opens a browser so you can sign in`);
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
      console.warn(``);
      console.warn(`⚠  Detected network: ${orgDisplay}`);
      console.warn(`   This looks like a datacenter / cloud network (Codespaces, AWS,`);
      console.warn(`   Hetzner, etc.). Some signups — especially those gated by`);
      console.warn(`   reCAPTCHA v2 — are likely to be blocked because anti-bot`);
      console.warn(`   scoring weighs network reputation heavily.`);
      console.warn(``);
      console.warn(`   For best results: run Trusty Squire from a laptop/desktop`);
      console.warn(`   on a home or office network. Cloud dev environments can`);
      console.warn(`   still provision services that don't gate signup with`);
      console.warn(`   reCAPTCHA (Resend, IPInfo, etc.), but Postmark/MailerSend`);
      console.warn(`   and similar will likely fail.`);
      console.warn(``);
      return;
    case "residential":
      console.warn(`✓ Detected network: ${orgDisplay} (residential — captchas should pass cleanly).`);
      return;
    case "unknown":
      console.warn(`ℹ Detected network: ${orgDisplay} (couldn't classify — proceed and we'll see).`);
      return;
  }
}

export { install, logout, login, parseArgs, pollForClaim, printAsnWarning, resolveServerLaunch };
