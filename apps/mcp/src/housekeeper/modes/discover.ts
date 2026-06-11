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
import { UniversalSignupBot, type SignupResult } from "../../bot/index.js";
import { pickLLMPair } from "../../bot/llm-client.js";
import { InboxClient } from "../../bot/inbox-client.js";
import {
  isAutoPromoteEnabled,
  runAutoPromote,
} from "../../tools/provision-any.js";
import { emitProvisionEvent, postCaptchaEvent } from "../../tools/signup-telemetry.js";
import { clientFromEnv, generateProvisionId } from "../../skill-registry-client.js";
import type { HousekeeperTask } from "../queues/index.js";
import type { HousekeeperOpts } from "../orchestrator.js";
import {
  classifyProvisionState,
  unknownStateSignature,
  type ProvisionState,
} from "@trusty-squire/skill-schema";

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
      state?: ProvisionState;
    }
  // The named provision state drives the orchestrator's per-state policy.
  // `signature` is set only for `state: "unknown"` — the bucket key the
  // single-escalation tracker counts attempts against.
  | { kind: "blocked"; reason: string; state?: ProvisionState }
  | { kind: "failed"; reason: string; state?: ProvisionState; signature?: string };

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

// Emit the same telemetry the provision router emits, so harvest runs
// show up in the operator dashboard's funnel + failure views (they were
// previously blind — DESIGN-antibot-hardening.md D1). Dispatch is always
// bot→bot (the discover worker never replays a skill). Fire-and-forget +
// fail-open: a telemetry error never changes the discover outcome. We
// deliberately do NOT emit a UniversalBotFailureRecord here — that table
// is the end-user demand signal this worker's own queue consumes, and
// self-feeding it would make the bot re-harvest its own failures.
// AWAITED, unlike the provision server's fire-and-forget: the housekeeper
// `--once` process calls process.exit() right after the batch, so an
// un-awaited POST is killed before it lands (this is exactly why early
// discover runs recorded NOTHING). We await both emits here, bounded by
// the clients' own timeouts, so the events flush before the process exits.
async function recordDiscoverTelemetry(
  input: { service: string; signupUrl?: string },
  result: SignupResult,
  ctx: {
    accountId: string;
    apiBase: string;
    machineToken: string;
    provisionId: string;
    startedAt: number;
    stepsSink: readonly string[];
  },
): Promise<void> {
  try {
    const registry = clientFromEnv(ctx.accountId);
    if (registry !== null) {
      await emitProvisionEvent(registry, {
        service: input.service,
        provisionId: ctx.provisionId,
        startedAt: ctx.startedAt,
        initialStrategy: "bot",
        finalStrategy: "bot",
        replayOutcome: "na",
        result,
        ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
        ...(ctx.stepsSink.length > 0 ? { stepTrail: ctx.stepsSink.join("\n") } : {}),
        replayServed: false,
      });
    }
    if (result.captcha !== undefined) {
      await postCaptchaEvent(ctx.apiBase, ctx.machineToken, {
        service: input.service,
        captcha_kind: result.captcha.kind,
        blocked: result.captcha.blocked,
        proxied: result.proxied ?? false,
        captcha_variant: result.captcha.variant,
        challenge_rendered: result.captcha.challenge_rendered,
        signup_succeeded: result.success,
        ...(result.stealth_profile !== undefined
          ? { stealth_profile: result.stealth_profile }
          : {}),
      });
    }
  } catch (err) {
    process.stderr.write(
      `[housekeeper] ${input.service}: telemetry emit failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

export async function runDiscover(
  input: {
    service: string;
    oauthProvider?: "google" | "github";
    /** Canonical signup URL (curated YAML override). */
    signupUrl?: string;
    /**
     * Force the email/password form path (skip OAuth) so the run hits the
     * form-side captcha. From the YAML `force_form` or the
     * UNIVERSAL_BOT_FORCE_FORM env (ad-hoc A/B runs).
     */
    forceForm?: boolean;
    /**
     * Extra OAuth scopes the operator pre-approves for THIS service (curated
     * YAML `allow_extra_oauth_scopes`). Without it the bot aborts
     * oauth_consent_needs_review on any non-basic scope — correct for an
     * end-user, but the operator's own discovery run for a service that
     * legitimately needs e.g. GitHub `read:org` (defang) should proceed.
     * Opt-in per service; the DOM danger-phrase scraper still hard-aborts on
     * sensitive grants (Drive/Gmail/contacts) regardless.
     */
    allowExtraOAuthScopes?: readonly string[];
  },
  cfg: DiscoveryBotConfig = {},
): Promise<DiscoveryBotOutcome> {
  // Env override lets an ad-hoc `--service=…` A/B run force the form path
  // without editing the YAML.
  const forceForm =
    input.forceForm === true || process.env.UNIVERSAL_BOT_FORCE_FORM === "1";
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
  // Telemetry correlation + duration baseline — shared by the success,
  // failure, and crash emits below.
  const provisionId = generateProvisionId();
  const startedAt = Date.now();
  const telemetryCtx = {
    accountId,
    apiBase,
    machineToken,
    provisionId,
    startedAt,
    stepsSink,
  };
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
      ...(forceForm ? { forceForm: true } : {}),
      ...(input.allowExtraOAuthScopes !== undefined && input.allowExtraOAuthScopes.length > 0
        ? { allowExtraOAuthScopes: input.allowExtraOAuthScopes }
        : {}),
      // The housekeeper is the operator provisioning on their OWN behalf,
      // so approve a benign OAuth consent (email/profile) blind instead of
      // pausing oauth_consent_needs_review when the scopes aren't readable
      // from the URL (Google's opaque part=-token consents — meilisearch,
      // uploadcare). The DOM danger-phrase scraper still HARD-ABORTS on
      // sensitive scope-grant verbs (Drive/Gmail/contacts), so this only
      // auto-approves basic sign-in consent.
      allowBlindOAuthConsent: true,
    });
  } catch (err) {
    // Dump the step trail before bailing — without it, debugging
    // mid-run failures requires re-running the whole thing.
    flushStepTrail(stepsSink, input.service);
    // Record the crash as a failed ProvisionEvent so the dashboard sees
    // it (no captcha info on a crash). Awaited so it flushes before exit.
    await recordDiscoverTelemetry(
      input,
      { success: false, error: "bot_crash", steps: [...stepsSink] },
      telemetryCtx,
    );
    return {
      kind: "failed",
      reason: `bot crash: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Always flush — operator wants to see what happened on success
  // (to vet the capture) AND on failure (to diagnose).
  flushStepTrail(stepsSink, input.service);

  // Emit ProvisionEvent (+ CaptchaEvent when a captcha was hit) for the
  // finished run. Awaited so the POSTs land before the --once process
  // exits (see recordDiscoverTelemetry).
  await recordDiscoverTelemetry(input, result, telemetryCtx);

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
      state: "success",
    };
  }

  // Map the bot's terminal-error vocabulary to a named ProvisionState (the
  // single source of truth — provision-state.ts). The orchestrator then applies
  // the per-state policy. `wall` → blocked (auto-skip; don't keep hammering a
  // service that needs human-side action); everything else → failed (the loop's
  // retryable bucket), tagged with the state. `unknown` additionally carries a
  // signature so the single-escalation tracker can count attempts.
  //
  // email_otp_required / oauth_required stay failed (= fixable, not walls): the
  // bot polls the operator inbox for the code, and oauth_required is usually a
  // wrong-URL nav bug. Both classify as transient/email_pending, never wall.
  const error = result.error ?? "unknown_failure";
  const state = classifyProvisionState({ failure_kind: error, credential_present: false });
  if (state === "wall") {
    return { kind: "blocked", reason: error, state };
  }
  if (state === "unknown") {
    // Bucket by (entry url path + the error's HEAD token) so repeats of the
    // SAME novel terminal on the SAME service share a 3-attempt count, while a
    // different novel state is its own fresh count.
    const headToken = error.trim().split(/[:\s]/, 1)[0] ?? error;
    const signature = unknownStateSignature({
      ...(input.signupUrl !== undefined ? { url: input.signupUrl } : {}),
      element_fingerprints: [headToken],
    });
    return { kind: "failed", reason: error, state, signature };
  }
  return { kind: "failed", reason: error, state };
}

export type DiscoveryBotRunner = (input: {
  service: string;
  oauthProvider?: "google" | "github";
  signupUrl?: string;
  allowExtraOAuthScopes?: readonly string[];
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
    ...(task.forceForm === true ? { forceForm: true } : {}),
    ...(task.allowExtraOAuthScopes !== undefined
      ? { allowExtraOAuthScopes: task.allowExtraOAuthScopes }
      : {}),
  });
  log(`discover end:   ${task.service} → ${outcome.kind} (${outcome.reason.slice(0, 120)})`);
  return outcome;
}
