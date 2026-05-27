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
// will later promote on N=2.

import { randomBytes } from "node:crypto";
import { UniversalSignupBot } from "../bot/index.js";
import { pickLLMPair } from "../bot/llm-client.js";
import { InboxClient } from "../bot/inbox-client.js";
import {
  isAutoPromoteEnabled,
  runAutoPromote,
} from "../tools/provision-any.js";

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
  | { kind: "ok"; reason: string; credential_kind?: string }
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
  input: { service: string; oauthProvider?: "google" | "github" },
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
  if (result.success && cfg.skipAutoPromote !== true && isAutoPromoteEnabled(process.env)) {
    try {
      await runAutoPromote({
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
    }
  }

  if (result.success) {
    const credCount =
      result.credentials !== undefined ? Object.keys(result.credentials).length : 0;
    return {
      kind: "ok",
      reason: `signed up via ${result.via ?? "bot"}; extracted ${credCount} credential(s)`,
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
  ];
  if (BLOCKED_PATTERNS.some((re) => re.test(error))) {
    return { kind: "blocked", reason: error };
  }
  return { kind: "failed", reason: error };
}
