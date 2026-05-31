// Discovery-bot wiring — closed-loop strategy Phase 6 follow-up.
//
// Glues the discovery loop's injected `runUniversalBot` callback to
// the actual universal signup bot. Replicates the minimum of
// provision-any.ts's runSignupTask that we need (machine token +
// account id + inbox alias + LLM pair + bot) without going through
// the MCP-tool indirection (the tool reads session.json from disk;
// the verifier worker is operator-driven, not user-driven).
//
// Env required:
//   TRUSTY_SQUIRE_API_BASE       (default https://trusty-squire-api.fly.dev)
//   TRUSTY_SQUIRE_MACHINE_TOKEN  (operator machine token for the LLM proxy + inbox)
//   TRUSTY_SQUIRE_ACCOUNT_ID     (operator account id for inbox alias scoping)
//
// On a successful signup, the function fires auto-promote (when
// TRUSTY_SQUIRE_AUTO_PROMOTE is set — default-on as of rc.14) so
// the captured corpus becomes a pending-review skill the verifier
// will later promote on the first verifier success.

import { randomBytes } from "node:crypto";
import { UniversalSignupBot } from "../../bot/index.js";
import { pickLLMPair } from "../../bot/llm-client.js";
import { InboxClient } from "../../bot/inbox-client.js";
import {
  isAutoPromoteEnabled,
  runAutoPromote,
} from "../../tools/provision-any.js";
import type { HousekeeperTask } from "../queues/index.js";
import type { HousekeeperOpts } from "../orchestrator.js";

export interface DiscoveryBotConfig {
  // Override env-read defaults — used by tests.
  machineToken?: string;
  apiBase?: string;
  accountId?: string;
  // For tests: mock the bot. Production constructs UniversalSignupBot.
  bot?: { signup: UniversalSignupBot["signup"] };
  // For tests: mock the inbox client.
  inboxClient?: { createAlias: InboxClient["createAlias"] };
  // For tests: skip the auto-promote network call.
  skipAutoPromote?: boolean;
}

export type DiscoveryBotOutcome =
  | {
      kind: "ok";
      reason: string;
      credential_kind?: string;
      // 0.8.2-rc.4 — surface the auto-promote outcome to the
      // orchestrator's summary counter. Undefined means
      // auto-promote didn't run (env disabled). Otherwise carries
      // the discriminated result from runAutoPromote so the
      // batch summary can credit promoted=N accurately.
      auto_promote?: import("../../tools/provision-any.js").AutoPromoteResult;
    }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string };

// Dumps the bot's step trail to stderr so the housekeeper log shows
// the full planner/inventory/Plan trace alongside the discover
// outcome. Without this, run_timeout / bot_crash failures look
// opaque ("exceeded 600s") with no diagnostic surface.
function flushStepTrail(steps: readonly string[], service: string): void {
  if (steps.length === 0) {
    process.stderr.write(`[housekeeper] ${service}: (no step trail captured)\n`);
    return;
  }
  process.stderr.write(
    `[housekeeper] ${service} step trail (${steps.length} step(s)):\n`,
  );
  for (const s of steps) {
    process.stderr.write(`  ${s}\n`);
  }
}

export async function runDiscoveryBot(
  input: {
    service: string;
    oauthProvider?: "google" | "github";
    /** Canonical signup URL (curated YAML override). */
    signupUrl?: string;
  },
  cfg: DiscoveryBotConfig = {},
): Promise<DiscoveryBotOutcome> {
  const machineToken = cfg.machineToken ?? process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  const apiBase =
    cfg.apiBase ??
    process.env.TRUSTY_SQUIRE_API_BASE ??
    "https://trusty-squire-api.fly.dev";
  const accountId = cfg.accountId ?? process.env.TRUSTY_SQUIRE_ACCOUNT_ID;

  if (machineToken === undefined || machineToken.length === 0) {
    return {
      kind: "failed",
      reason:
        "TRUSTY_SQUIRE_MACHINE_TOKEN is not set — discovery worker needs an operator machine token to use the LLM proxy + inbox service",
    };
  }
  if (accountId === undefined || accountId.length === 0) {
    return {
      kind: "failed",
      reason:
        "TRUSTY_SQUIRE_ACCOUNT_ID is not set — discovery worker needs an operator account id to scope inbox aliases + auto-promote attribution",
    };
  }

  const inboxClient =
    cfg.inboxClient ?? new InboxClient({ baseUrl: apiBase, apiKey: machineToken });

  // run_id is VarChar(26) on the inbox EmailAlias model. Keep the
  // prefix short ("hk-" for housekeeper) so timestamp + entropy fit.
  // Mirrors the `mcp-<ts>-<rand>` shape provision-any.ts produces,
  // which already fits comfortably.
  const runId =
    `hk-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

  let alias: string;
  try {
    alias = await inboxClient.createAlias({
      account_id: accountId,
      service: input.service,
      run_id: runId,
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `createAlias failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // pickLLMPair honors UNIVERSAL_BOT_LLM_TIER — verifier deploys
  // typically run with =free.
  const llm = pickLLMPair({ preferCheap: true });
  const stepsSink: string[] = [];

  const bot = cfg.bot ?? new UniversalSignupBot();
  let result;
  try {
    result = await bot.signup({
      service: input.service,
      email: alias,
      inbox: inboxClient as InboxClient,
      llm,
      stepsSink,
      machineToken,
      apiBase,
      // YAML-declared OAuth hint forces the bot's OAuth-first scan
      // to look for THIS provider. Without it the scan falls back
      // on the bot profile's logged-in-providers cache, which is
      // often empty (the cache only writes after a successful prior
      // OAuth handshake — chicken-and-egg for fresh services).
      ...(input.oauthProvider !== undefined
        ? { oauthProvider: input.oauthProvider }
        : {}),
      // YAML-declared signup URL overrides guessSignupUrl(slug). The
      // guess defaults to https://<slug>.com/signup which gets the
      // wrong host for any non-`.com` service (ipinfo.io, anthropic
      // console subdomain, etc.). Five oauth_required failures in the
      // overnight batch were really wrong-URL navigations to parked
      // / unrelated `.com` pages that didn't have the OAuth button.
      ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
    });
  } catch (err) {
    // Dump the step trail before bailing — without it, debugging
    // mid-run failures requires re-running the whole thing.
    flushStepTrail(stepsSink, input.service);
    return {
      kind: "failed",
      reason: `bot crash: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Always flush — operator wants to see what happened on success
  // (to vet the capture) AND on failure (to diagnose).
  flushStepTrail(stepsSink, input.service);

  // Auto-promote on success — same pipeline provision-any.ts fires
  // for end-user signups (Phase 2 makes this land as pending-review).
  let promoteOutcome:
    | import("../../tools/provision-any.js").AutoPromoteResult
    | undefined;
  if (result.success && cfg.skipAutoPromote !== true && isAutoPromoteEnabled(process.env)) {
    // Snapshot the sink length so we can flush ONLY the auto-promote
    // additions to stderr. Before this fix the bot's step trail was
    // flushed above and then auto-promote silently pushed new entries
    // onto the same array — they never reached stderr, so operators
    // saw `promoted=0` in the batch summary and had no diagnostic
    // surface for why every successful capture failed to publish.
    const sinkLenBeforePromote = stepsSink.length;
    try {
      promoteOutcome = await runAutoPromote({
        service: input.service,
        stepsSink,
        accountId,
      });
    } catch (err) {
      // Auto-promote failure is annotated but the discovery outcome
      // is still 'ok' — we did successfully discover a path through
      // the service, it just didn't reach the registry.
      stepsSink.push(
        `[discovery] auto-promote raised: ${err instanceof Error ? err.message : String(err)}`,
      );
      promoteOutcome = { kind: "rejected", reason: "unexpected_throw" };
    }
    const promoteSteps = stepsSink.slice(sinkLenBeforePromote);
    if (promoteSteps.length > 0) {
      process.stderr.write(
        `[housekeeper] ${input.service} auto-promote (${promoteSteps.length} step(s)):\n`,
      );
      for (const s of promoteSteps) {
        process.stderr.write(`  ${s}\n`);
      }
    }
  }

  if (result.success) {
    const credCount =
      result.credentials !== undefined ? Object.keys(result.credentials).length : 0;
    return {
      kind: "ok",
      reason: `signed up via ${result.via ?? "bot"}; extracted ${credCount} credential(s)`,
      ...(promoteOutcome !== undefined ? { auto_promote: promoteOutcome } : {}),
    };
  }

  // Map the bot's terminal-error vocabulary to the discovery-loop
  // outcome kinds. Anything classified as a real-world blocker
  // (billing, anti-bot, SSO restriction) goes to 'blocked' — the
  // discovery worker shouldn't keep hammering services that need
  // human-side action.
  const error = result.error ?? "unknown_failure";
  const BLOCKED_PATTERNS = [
    /^onboarding_blocked/,
    /^anti_bot_blocked/,
    /^captcha_blocked/,
    /^sso_restricted/,
    /^needs_oauth_provider_session/,
    /^oauth_consent_needs_review/,
    // A terminal email-OTP gate means the inbox poller couldn't fetch the
    // code — an unattended bot can't pass it, so it's a wall (human relay),
    // not a bot failure. (oauth_required is deliberately NOT here: it's
    // usually a wrong-URL navigation, which is a fixable bot bug.)
    /^email_otp_required/,
  ];
  if (BLOCKED_PATTERNS.some((re) => re.test(error))) {
    return { kind: "blocked", reason: error };
  }
  return { kind: "failed", reason: error };
}

export type DiscoveryBotRunner = (input: {
  service: string;
  oauthProvider?: "google" | "github";
  signupUrl?: string;
}) => Promise<DiscoveryBotOutcome>;

// Per-task dispatcher the orchestrator invokes for 'discover' tasks.
export async function handleDiscover(
  task: Extract<HousekeeperTask, { kind: "discover" }>,
  opts: HousekeeperOpts,
  log: (line: string) => void,
): Promise<DiscoveryBotOutcome> {
  if (opts.discover === undefined) {
    log(`skip discover: ${task.service} — no discover runner wired`);
    return { kind: "failed", reason: "no_discover_runner_wired" };
  }
  log(
    `discover start: ${task.service}${
      task.meta?.distinct_failures !== undefined
        ? ` (${task.meta.distinct_failures} user failures, top=${task.meta.top_error_kind})`
        : ""
    }`,
  );
  const outcome = await opts.discover({
    service: task.service,
    ...(task.oauthProvider !== undefined
      ? { oauthProvider: task.oauthProvider }
      : {}),
    ...(task.signupUrl !== undefined ? { signupUrl: task.signupUrl } : {}),
  });
  log(`discover end:   ${task.service} → ${outcome.kind} (${outcome.reason.slice(0, 120)})`);
  return outcome;
}
