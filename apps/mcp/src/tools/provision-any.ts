// provision_any — universal signup bot for any free API service.
//
// Runs the browser on the user's machine (their IP, their fingerprint).
// Aliases + inbox live on Trusty Squire's API so the SES forwarding
// pipeline (see apps/api/src/routes/ses-webhook.ts) can deliver
// verification emails.
//
// ASYNC MODEL: a real signup takes 3-8 minutes — well past the ~60s hard
// timeout Claude Code (and most MCP hosts) put on a single tool call. So
// `provision_any_service` does NOT block: it starts the run in the
// background inside this server process, returns a run_id immediately,
// and the caller polls `check_provision_status` until the run leaves the
// "running" state.
//
// Auth model: every install is account-bound. The session file carries
// the machine_token (for the bot's LLM proxy + inbox alias) and the
// agent_session_token (for vault writes), both bound to one account.

import { randomBytes } from "crypto";
import { z } from "zod";
import {
  UniversalSignupBot,
  InboxClient,
  ProxyLLMClient,
  detectAsn,
  BrowserController,
  replaySkill,
  type LLMPair,
  type CaptchaVariant,
} from "../bot/index.js";
import { openSessionStorage } from "../session.js";
import type { ApiClient } from "../api-client.js";
import {
  clientFromEnv,
  generateProvisionId,
  type SkillRegistryClient,
} from "../skill-registry-client.js";


type SignupResult = Awaited<ReturnType<UniversalSignupBot["signup"]>>;

export const provisionAnyInputSchema = z.object({
  service: z.string().describe("Name of the service to sign up for (e.g., 'Postmark', 'Mailgun')"),
  signup_url: z.string().optional().describe("Direct URL to signup page (optional, will search if not provided)"),
  oauth_provider: z
    .enum(["google", "github"])
    .optional()
    .describe(
      "Force OAuth signup through a specific provider. Usually unnecessary — the bot already auto-prefers OAuth when the service offers Google/GitHub sign-in and a login session exists. Set this only to pin one provider. OAuth needs a one-time `npx @trusty-squire/mcp login [--provider=github]`.",
    ),
  scope_hint: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Optional permission/scope guidance for the API key the bot creates. Free text the LLM passes through to the signup planner. " +
        "Examples: 'admin' / 'read-only' / 'write access to upload source maps' / 'just enough to send emails'. " +
        "Without this hint, the bot defaults to MAXIMUM available permissions on token-creation forms (Admin > Write > Read), since most agent use-cases need write access and a too-restrictive key fails downstream. " +
        "Pass this when the user explicitly asked for a limited token or when the use-case clearly only needs read.",
    ),
  allow_extra_oauth_scopes: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "OAuth scopes the user has EXPLICITLY approved beyond basic identity (openid/email/profile). " +
        "Use this ONLY after asking the user — if a previous run returned status=oauth_consent_needs_review with a requested_scopes list, ask the user 'Service X is requesting these scopes: [...] — approve?', and if they say yes, re-run provision_any_service with the same exact scope strings here. " +
        "Do NOT preemptively pass scopes the user hasn't seen. The bot enforces the consent boundary; this parameter is how the user lifts it.",
    ),
  allow_blind_oauth_consent: z
    .boolean()
    .optional()
    .describe(
      "Blind-approve a GitHub-App-class OAuth consent screen whose scopes cannot be parsed from the URL (e.g. client_id prefix `Iv1.`). " +
        "DEFAULT: true. The user signed up to delegate this provisioning; halting on every opaque-scope GitHub App for an extra confirmation defeats that. " +
        "A DOM safety scraper still aborts the run if the consent page visibly lists scope-grant verb phrases (Drive/Gmail/contacts/etc.), so dangerous scopes still surface as oauth_consent_needs_review. " +
        "Pass false ONLY when the user explicitly asked for a per-service confirmation prompt.",
    ),
});

export type ProvisionAnyInput = z.infer<typeof provisionAnyInputSchema>;

export const checkProvisionStatusInputSchema = z.object({
  run_id: z.string().describe("The run_id returned by provision_any_service."),
});

export type CheckProvisionStatusInput = z.infer<typeof checkProvisionStatusInputSchema>;

// JSON Schema for MCP `tools/list`. The SDK forwards `inputSchema` verbatim
// to the host agent; a zod object stringifies to `{}` and leaves the LLM
// blind to required parameters, so these mirror the zod schemas above.
const PROVISION_ANY_JSON_SCHEMA = {
  type: "object",
  required: ["service"],
  properties: {
    service: {
      type: "string",
      description: "Name of the service to sign up for (e.g., 'Postmark', 'Mailgun', 'IPInfo').",
    },
    signup_url: {
      type: "string",
      description: "Direct URL to the service's signup page. Optional — the bot will navigate from the service name if omitted.",
    },
    oauth_provider: {
      type: "string",
      enum: ["google", "github"],
      description:
        "Force OAuth signup through a specific provider. Usually unnecessary — the bot auto-prefers OAuth whenever the service offers Google/GitHub sign-in and a session exists (`npx @trusty-squire/mcp login`). Set this only to pin one provider.",
    },
    scope_hint: {
      type: "string",
      description:
        "Optional permission/scope guidance for the API key. Free-text hint the LLM passes through to the signup planner. Examples: 'admin', 'read-only', 'write access to upload source maps', 'just enough to send emails'. " +
        "Default WITHOUT this hint: MAXIMUM available permissions on token-creation forms (Admin > Write > Read) — most agent use-cases need write access and a too-restrictive key fails downstream. Pass this only when the user explicitly asked for a limited token or the use-case clearly only needs read.",
    },
    allow_extra_oauth_scopes: {
      type: "array",
      items: { type: "string" },
      description:
        "OAuth scopes the user has EXPLICITLY approved beyond basic identity (openid/email/profile). Use this ONLY after asking the user. If a previous run returned status=oauth_consent_needs_review with requested_scopes, show that list to the user, get their approval, and re-run with the approved scope strings here. The bot enforces the consent boundary; this parameter is how the user lifts it. Do NOT preemptively pass scopes the user hasn't seen.",
    },
    allow_blind_oauth_consent: {
      type: "boolean",
      default: true,
      description:
        "Blind-approve a GitHub-App-class OAuth consent screen whose scopes can't be parsed from the URL. DEFAULT: true — the user signed up to delegate this provisioning, so opaque-scope GitHub Apps auto-approve. A DOM safety scraper still aborts if the consent page visibly lists scope-grant verb phrases (Drive/Gmail/contacts), so dangerous scopes still surface as oauth_consent_needs_review. Pass false ONLY when the user explicitly asked for a per-service confirmation prompt.",
    },
  },
} as const;

const CHECK_STATUS_JSON_SCHEMA = {
  type: "object",
  required: ["run_id"],
  properties: {
    run_id: {
      type: "string",
      description: "The run_id returned by provision_any_service.",
    },
  },
} as const;

// --- background run store ---------------------------------------------
// A signup runs in the background inside this MCP server process; the
// caller polls check_provision_status by run_id. The store is in-memory
// and lives only as long as the server process: if the server restarts
// mid-run the run is lost and check_provision_status reports unknown_run.
interface RunRecord {
  service: string;
  startedAt: number;
  // undefined while the run is in flight; the final tool response once done.
  result: Record<string, unknown> | undefined;
  // Mutable, shared with the bot. Surfaces mid-run prompts (Google
  // number-match etc.) via check_provision_status's recent_steps.
  stepsSink: string[];
}
const runStore = new Map<string, RunRecord>();
// Cap so a long session cannot leak memory; oldest run evicted first.
const MAX_RUNS = 50;

const PROVISION_DESCRIPTION = `Start signing up for any free API service using browser automation.

ASYNC — IMPORTANT: a signup takes several minutes, longer than a single
tool call may stay open. This tool does NOT wait for the signup. It
starts the run and returns immediately with a run_id and status="started".
You MUST then poll check_provision_status with that run_id (about once a
minute) until its status is no longer "running".

WHEN TO CALL THIS TOOL:
- The user needs an account or API key for any SaaS service.
- Free-tier developer services. The bot auto-signs-up via Google/GitHub
  OAuth when the service offers it and the user has run
  \`npx @trusty-squire/mcp login\` once; otherwise it fills the email form.

Call list_credentials first — reuse an existing key rather than signing
up again.

IMMEDIATE RESPONSES (no run started):
- status="started" + run_id → poll check_provision_status next.
- status="payment_required" + cta_billing_url → the account hit the free
  signup limit; the user can upgrade at cta_billing_url.
- status="not_installed" → Trusty Squire isn't installed; tell the user to run \`npx @trusty-squire/mcp install\`.
- status="error" → could not reach the API to set up the signup.`;

const CHECK_DESCRIPTION = `Check the status of a signup started by provision_any_service.

Pass the run_id from provision_any_service. Poll about once a minute
until status is no longer "running".

A "running" response carries recent_steps (the bot's live progress trail)
and user_action_required (true when the latest steps include a
user-action prompt). When user_action_required is true, IMMEDIATELY
relay the latest recent_steps entry to the user — common case is
"Google: match the number 28 on your phone — open the Google app and
tap 28" — then keep polling.

RESPONSES:
- status="running" → still working. Read recent_steps; if
  user_action_required is true, relay the latest prompt to the user
  and poll again in ~10s. Otherwise poll again in ~30-60s.
- status="success" + credentials → signup done; show the credentials to the user.
- status="verification_not_sent" → the service needs an email verification the bot
  can't complete; show the message and tell the user to sign up manually.
- status="captcha_blocked" → the site uses a captcha the bot can't pass; manual signup.
- status="oauth_required" → the service only offers OAuth signup; manual signup.
- status="anti_bot_blocked" → the site's anti-bot gateway (Cloudflare/Sucuri/DataDome/Imperva)
  held the bot on its "Just a moment..." page indefinitely. IP/fingerprint risk-score block.
  Tell the user to sign up manually.
- status="needs_login" → an OAuth signup needs the bot's one-time Google login;
  tell the user to run \`npx @trusty-squire/mcp login\`, then retry.
- status="oauth_consent_needs_review" → the OAuth consent screen needs a human call. Two sub-cases:
  (a) requested_scopes is non-empty (URL-parseable scopes): SHOW unauthorized_scopes to the
      user, ask "approve these scopes?", and if yes call provision_any_service AGAIN with
      allow_extra_oauth_scopes set to that list.
  (b) requested_scopes is EMPTY (GitHub Apps and similar — permissions in the app manifest,
      not the URL): the bot's DOM safety scraper saw a scope-grant verb phrase (Drive/Gmail/
      contacts/etc.) and refused even though allow_blind_oauth_consent defaults to true. Show
      the unauthorized_scopes / verb_phrases list to the user, ask whether they want to
      proceed anyway; if yes, currently there is no override path — tell them to sign up
      manually. If no verb phrases appear, the bot auto-approves and you never see this
      status for GitHub Apps.
- status="onboarding_blocked" → signed in via Google, but the API key is behind a
  billing/payment wall; the user must add a payment method.
- status="failed" → the form filled but yielded no credentials; show steps[].
- status="error" → the run crashed; show error.
- status="unknown_run" → no such run (it expired, or the MCP server restarted).`;

export const provisionAnyTool = {
  name: "provision_any_service",
  description: PROVISION_DESCRIPTION,
  jsonInputSchema: PROVISION_ANY_JSON_SCHEMA,
  inputSchema: provisionAnyInputSchema,
  handler: async (input: ProvisionAnyInput, _api: ApiClient | null) => {
    // Every install is account-bound. The CLI writes machine_token,
    // agent_session_token, and account_id together; if any is missing
    // the install is from before the single-tier collapse and needs
    // re-running.
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (
      session === null ||
      session.machine_token === undefined ||
      session.agent_session_token === undefined ||
      session.account_id === undefined
    ) {
      return {
        status: "not_installed",
        message:
          "Trusty Squire isn't fully installed on this machine. " +
          "Run `npx @trusty-squire/mcp install` to set up the squire (or reconnect " +
          "an install from before single-tier auth).",
      };
    }
    const apiBase = session.api_base_url;
    const inboxClient = new InboxClient({ baseUrl: apiBase, apiKey: session.machine_token });

    // Random suffix, not just a ms timestamp: two concurrent signups in
    // the same millisecond would otherwise share a run_id — and, for the
    // same service, the same inbox alias.
    const runId = `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    // Skill promoter correlation ID (D8). Distinct from runId — runId
    // identifies the universal-bot run, provisionId spans the whole
    // tool invocation including the registry-router phase that runs
    // before the bot might even start.
    const provisionId = generateProvisionId();
    let alias: string;
    try {
      alias = await inboxClient.createAlias({
        account_id: session.account_id,
        service: input.service,
        run_id: runId,
      });
      // eslint-disable-next-line no-console
      console.error(`[provision-any] alias=${alias} apiBase=${apiBase}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The createAlias error body carries the structured payload; parse it back.
      // The API may still emit the old `quota_exceeded` error code during a
      // rollout window — accept both shapes and surface a single
      // payment_required status to the LLM.
      if (/quota_exceeded|payment_required/.test(message)) {
        const match = message.match(/\{.*\}/s);
        if (match !== null) {
          try {
            const parsed = JSON.parse(match[0]) as Record<string, unknown>;
            return {
              status: "payment_required",
              service: input.service,
              quota_limit: parsed["quota_limit"],
              quota_used: parsed["quota_used"],
              cta_billing_url: parsed["cta_billing_url"] ?? parsed["cta_pair_url"],
              message:
                "Your account has hit the free signup limit. " +
                "Open cta_billing_url to upgrade — until then signups are paused.",
            };
          } catch {
            // fall through
          }
        }
      }
      return {
        status: "error",
        service: input.service,
        error: message,
        message: `Couldn't reach Trusty Squire's API to set up an alias.`,
      };
    }

    // Register the run, evicting the oldest if the store is full.
    if (runStore.size >= MAX_RUNS) {
      const oldest = runStore.keys().next().value;
      if (oldest !== undefined) runStore.delete(oldest);
    }
    const stepsSink: string[] = [];
    runStore.set(runId, {
      service: input.service,
      startedAt: Date.now(),
      result: undefined,
      stepsSink,
    });

    // Start the signup in the background — do NOT await it. runSignupTask
    // never rejects; it writes the final response into runStore, which
    // check_provision_status then reads.
    void runSignupTask(runId, input, {
      apiBase,
      machineToken: session.machine_token,
      alias,
      inboxClient,
      agentSessionToken: session.agent_session_token,
      stepsSink,
      provisionId,
      accountId: session.account_id,
    });

    return {
      status: "started",
      run_id: runId,
      service: input.service,
      message:
        `Signup for ${input.service} started in the background. ` +
        `Poll check_provision_status with run_id="${runId}" about once a minute ` +
        `until its status is no longer "running" (typically 3-6 minutes).`,
    };
  },
};

export const checkProvisionStatusTool = {
  name: "check_provision_status",
  description: CHECK_DESCRIPTION,
  jsonInputSchema: CHECK_STATUS_JSON_SCHEMA,
  inputSchema: checkProvisionStatusInputSchema,
  handler: async (input: CheckProvisionStatusInput, _api: ApiClient | null) => {
    const record = runStore.get(input.run_id);
    if (record === undefined) {
      return {
        status: "unknown_run",
        run_id: input.run_id,
        message:
          "No signup run with that run_id. It may have finished and been evicted, " +
          "or the MCP server restarted since it started. Start a new provision_any_service run.",
      };
    }
    if (record.result === undefined) {
      // Surface the live step trail so the host LLM can read mid-run
      // prompts (Google number-match, captcha, oauth nav, etc.) and
      // relay them to the user without waiting for the final result.
      // Last 15 is plenty for context — older entries are usually
      // navigation noise.
      const recentSteps = record.stepsSink.slice(-15);
      const userActionRequired = recentSteps.some((s) =>
        /match the number|tap \d+ on your phone|verify it's you|captcha/i.test(s),
      );
      return {
        status: "running",
        run_id: input.run_id,
        service: record.service,
        elapsed_seconds: Math.round((Date.now() - record.startedAt) / 1000),
        recent_steps: recentSteps,
        user_action_required: userActionRequired,
        message: userActionRequired
          ? "Signup is waiting on a user action — read recent_steps and relay the prompt to the user. Poll again in ~10 seconds."
          : "Signup still in progress. Poll again in about 30 seconds.",
      };
    }
    return record.result;
  },
};

interface RunContext {
  apiBase: string;
  machineToken: string;
  alias: string;
  inboxClient: InboxClient;
  // Account-bound bearer token used to write captured credentials to
  // the user's vault. Always present in the single-tier model — the
  // install CLI requires a successful browser confirm before writing
  // the session.
  agentSessionToken: string;
  // Shared step trail the bot pushes into in place; check_provision_status
  // reads it for live mid-run progress (Google number-match etc.).
  stepsSink: string[];
  // Correlation ID for the skill promoter (D8). Generated at
  // provision_any_service entry, propagated through every registry
  // call + bot run + vault write. Useful for forensics: one log
  // grep finds every event tied to this signup attempt.
  provisionId: string;
  // The account_id the session is bound to; passed to the registry
  // client so replay-outcome writes are attributable.
  accountId: string;
}

// Skill promoter — Tier 2 router (0.7.0).
//
// Before falling through to the universal bot (Tier 1), try the
// registry: if there's an active learned skill for this service,
// fetch it, run replaySkill in dry mode first (cheap pre-flight),
// then full mode if dry passes. Post replay-outcome both ways so the
// registry can track health + auto-demote.
//
// Returns:
//   - SignupResult with `via: "skill"` on full success — caller
//     short-circuits the universal bot.
//   - `null` for ANY other reason: no registry configured, registry
//     unavailable, skill not found, dry pass failed, full replay
//     failed, captcha hit during replay, needs_login. Caller falls
//     through to the universal bot path.
//
// This function is FAIL-OPEN by design (D4). A registry that returns
// garbage, times out, or 500s never blocks a signup — the worst case
// is one extra second of latency before the bot kicks in.
async function tryReplayLearnedSkill(
  client: SkillRegistryClient,
  input: ProvisionAnyInput,
  ctx: RunContext,
): Promise<SignupResult | null> {
  const serviceSlug = input.service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const fetched = await client.fetchActiveSkill(serviceSlug, ctx.provisionId);

  if (fetched.kind !== "found") {
    return null;
  }

  const { skill } = fetched.result;
  // Surface that the router engaged so check_provision_status's
  // recent_steps log shows the skill attempt before any bot output.
  ctx.stepsSink.push(`[skill-promoter] fetched skill ${skill.skill_id} v${skill.version} for ${serviceSlug}`);

  const browser = new BrowserController({ humanize: true });
  let dryOutcome: Awaited<ReturnType<typeof replaySkill>>;
  try {
    await browser.start();
    // Dry first — D3 default. Walks every step except the
    // credential-creating click, so if the page diverged we abort
    // cheaply before touching the user's account.
    dryOutcome = await replaySkill({
      skill,
      browser,
      mode: "dry",
      templateValues: {
        EMAIL_ALIAS: ctx.alias,
        TOKEN_NAME: `mcp-${ctx.provisionId.slice(5)}`,
      },
    });
  } catch (err) {
    ctx.stepsSink.push(`[skill-promoter] replay crashed: ${err instanceof Error ? err.message : String(err)}`);
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: "step_failed",
      reason: `replay engine crashed: ${err instanceof Error ? err.message : String(err)}`,
      provision_id: ctx.provisionId,
    });
    client.invalidateCache(serviceSlug);
    try { await browser.close(); } catch { /* noop */ }
    return null;
  }

  if (dryOutcome.kind !== "dry_pass") {
    // Dry-mode found a problem. Record + fall through.
    ctx.stepsSink.push(`[skill-promoter] dry replay failed: ${dryOutcome.kind}`);
    const outcomeKind = dryOutcome.kind === "needs_login"
      ? "needs_login"
      : dryOutcome.kind === "validator_failed"
        ? "validator_failed"
        : dryOutcome.kind === "extraction_failed"
          ? "extraction_failed"
          : "step_failed";
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: outcomeKind,
      reason: `dry-mode pre-flight failed: ${JSON.stringify(dryOutcome)}`,
      ...("stepIndex" in dryOutcome && typeof dryOutcome.stepIndex === "number"
        ? { step_index: dryOutcome.stepIndex }
        : {}),
      provision_id: ctx.provisionId,
    });
    client.invalidateCache(serviceSlug);
    try { await browser.close(); } catch { /* noop */ }
    return null;
  }

  // Dry passed → restart the browser fresh and do full replay. We
  // restart rather than reusing because the dry-mode walk left the
  // browser at some intermediate page; full replay starts at step 0
  // again.
  try { await browser.close(); } catch { /* noop */ }
  const fullBrowser = new BrowserController({ humanize: true });
  let fullOutcome: Awaited<ReturnType<typeof replaySkill>>;
  try {
    await fullBrowser.start();
    fullOutcome = await replaySkill({
      skill,
      browser: fullBrowser,
      mode: "full",
      templateValues: {
        EMAIL_ALIAS: ctx.alias,
        TOKEN_NAME: `mcp-${ctx.provisionId.slice(5)}`,
      },
    });
  } catch (err) {
    ctx.stepsSink.push(`[skill-promoter] full replay crashed: ${err instanceof Error ? err.message : String(err)}`);
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: "step_failed",
      reason: `full replay engine crashed: ${err instanceof Error ? err.message : String(err)}`,
      provision_id: ctx.provisionId,
    });
    client.invalidateCache(serviceSlug);
    try { await fullBrowser.close(); } catch { /* noop */ }
    return null;
  }

  try { await fullBrowser.close(); } catch { /* noop */ }

  if (fullOutcome.kind !== "ok") {
    ctx.stepsSink.push(`[skill-promoter] full replay failed: ${fullOutcome.kind}`);
    const outcomeKind = fullOutcome.kind === "needs_login"
      ? "needs_login"
      : fullOutcome.kind === "validator_failed"
        ? "validator_failed"
        : fullOutcome.kind === "extraction_failed"
          ? "extraction_failed"
          : "step_failed";
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: outcomeKind,
      reason: `full replay failed: ${JSON.stringify(fullOutcome)}`,
      ...("stepIndex" in fullOutcome && typeof fullOutcome.stepIndex === "number"
        ? { step_index: fullOutcome.stepIndex }
        : {}),
      provision_id: ctx.provisionId,
    });
    client.invalidateCache(serviceSlug);
    return null;
  }

  // Full replay succeeded — credential in hand. Post the success
  // outcome, build a SignupResult-shaped object the rest of the
  // pipeline can consume.
  ctx.stepsSink.push(`[skill-promoter] replay OK — credential extracted via ${fullOutcome.via}`);
  void client.postReplayOutcome({
    skill_id: skill.skill_id,
    outcome: "ok",
    reason: `extracted via ${fullOutcome.via}`,
    provision_id: ctx.provisionId,
  });

  // The skill's first credential spec carries the env_var_suggestion.
  // That's the key under which the value lands in the response —
  // mirrors what the bot itself does for api_key extractions.
  const credSpec = skill.credentials[0];
  const credentialKey = credSpec?.env_var_suggestion?.toLowerCase() ?? "api_key";

  return {
    success: true,
    credentials: {
      [credentialKey]: fullOutcome.credential,
    },
    steps: [...ctx.stepsSink],
    via: "skill",
    skill_id: skill.skill_id,
    skill_version: skill.version,
  };
}

// Runs the signup to completion and stores the final tool response in
// runStore. Never rejects — any throw is captured as an error result.
async function runSignupTask(
  runId: string,
  input: ProvisionAnyInput,
  ctx: RunContext,
): Promise<void> {
  let response: Record<string, unknown>;
  try {
    // ── Skill promoter Tier-2 router ────────────────────────────────
    // Before launching the universal bot, check the registry for an
    // active learned skill. If one exists and replays successfully,
    // skip the bot entirely. Fail-open: any registry trouble or
    // replay failure falls through transparently.
    const registry = clientFromEnv(ctx.accountId);
    if (registry !== null) {
      const replayed = await tryReplayLearnedSkill(registry, input, ctx);
      if (replayed !== null) {
        response = buildSignupResponse(input, replayed);
        // Persist to vault same as the bot path — credentials are real.
        if (replayed.success && replayed.credentials !== undefined) {
          void postCredentialsToVault(
            ctx.apiBase,
            ctx.agentSessionToken,
            input.service,
            replayed.credentials,
          );
        }
        const record = runStore.get(runId);
        if (record !== undefined) record.result = response;
        return;
      }
    }
    // The user pays nothing for LLM calls — the operator's OpenRouter
    // key handles them server-side, gated by the machine token's rolling
    // rate limit. Cheap tier is primary; premium is the fallback.
    const llmPair: LLMPair = {
      primary: new ProxyLLMClient({
        apiBaseUrl: ctx.apiBase,
        machineToken: ctx.machineToken,
        tier: "cheap",
      }),
      premium: new ProxyLLMClient({
        apiBaseUrl: ctx.apiBase,
        machineToken: ctx.machineToken,
        tier: "premium",
      }),
    };

    const bot = new UniversalSignupBot();
    const result = await bot.signup({
      service: input.service,
      ...(input.signup_url !== undefined ? { signupUrl: input.signup_url } : {}),
      email: ctx.alias,
      // SES inbound pipeline revived on trustysquire.com 2026-05-20
      // (TODOS M1). Pass the inbox client so signup() can poll for the
      // verification email after form submit. OAuth runs don't need
      // it; the agent ignores it on those paths.
      inbox: ctx.inboxClient,
      llm: llmPair,
      // T6/T13: route through the provider's OAuth path when the
      // caller asked for it (Google or GitHub).
      ...(input.oauth_provider !== undefined ? { oauthProvider: input.oauth_provider } : {}),
      // Forward the LLM's scope hint to the post-verify planner so
      // it can pick option_text values on permission dropdowns
      // (Sentry, similar) intentionally instead of defaulting to
      // first option / minimum scope.
      ...(input.scope_hint !== undefined ? { scopeHint: input.scope_hint } : {}),
      // OAuth scopes the user has pre-approved (lifted up by the LLM
      // through user dialog). Default empty → strict basic-only gate.
      ...(input.allow_extra_oauth_scopes !== undefined
        ? { allowExtraOAuthScopes: input.allow_extra_oauth_scopes }
        : {}),
      // GitHub-App / opaque-OAuth blind approval — defaults to true
      // (host agent flips it off explicitly when the user asked for a
      // per-service confirmation prompt). The DOM verb-phrase scraper
      // in the agent is still the safety net for dangerous scopes.
      allowBlindOAuthConsent: input.allow_blind_oauth_consent !== false,
      // Share the in-flight step trail so check_provision_status can
      // surface live progress (the bot pushes into ctx.stepsSink).
      stepsSink: ctx.stepsSink,
    });

    // Best-effort alias cleanup. Failure is non-fatal — the alias
    // TTL-expires anyway.
    try {
      await ctx.inboxClient.revokeAlias(ctx.alias);
    } catch {
      // noop
    }

    // Report any captcha encounter to the analytics ledger. Fire-and-forget.
    if (result.captcha !== undefined) {
      void postCaptchaEvent(ctx.apiBase, ctx.machineToken, {
        service: input.service,
        captcha_kind: result.captcha.kind,
        blocked: result.captcha.blocked,
        proxied: result.proxied ?? false,
        captcha_variant: result.captcha.variant,
        challenge_rendered: result.captcha.challenge_rendered,
        signup_succeeded: result.success,
      });
    }

    response = buildSignupResponse(input, result);

    // Persist the collected keys into the account's vault. Fire-and-
    // forget — the credentials are already in `response`, so a vault
    // write failure is non-fatal.
    if (result.success && result.credentials !== undefined) {
      void postCredentialsToVault(
        ctx.apiBase,
        ctx.agentSessionToken,
        input.service,
        result.credentials,
      );
    }
  } catch (err) {
    response = {
      status: "error",
      service: input.service,
      error: err instanceof Error ? err.message : String(err),
      message: `The signup run for ${input.service} crashed before completing.`,
    };
  }

  const record = runStore.get(runId);
  if (record !== undefined) record.result = response;
}

// Maps a finished SignupResult to the response the caller sees via
// check_provision_status. Mirrors the status set documented on the
// tools. Exported for unit testing — the error-prefix → status
// mapping is the load-bearing logic.
export function buildSignupResponse(
  input: ProvisionAnyInput,
  result: SignupResult,
): Record<string, unknown> {
  if (result.success && result.credentials !== undefined) {
    return {
      status: "success",
      service: input.service,
      credentials: result.credentials,
      steps: result.steps,
      // Skill promoter (0.7.0): expose via + skill_id + skill_version
      // so the caller can tell whether the universal bot ran or a
      // Tier-2 learned skill served the result. Useful for the
      // operator console and for the "did we save an LLM call?"
      // telemetry pass in Phase 6.
      via: result.via ?? "bot",
      ...(result.skill_id !== undefined ? { skill_id: result.skill_id } : {}),
      ...(result.skill_version !== undefined ? { skill_version: result.skill_version } : {}),
      message: `Successfully signed up for ${input.service}. Credentials are in this response — show them to the user (or save to their .env).`,
    };
  }

  // Authoritative: the agent recorded a captcha encounter and marked it
  // blocked → captcha_blocked.
  if (result.captcha !== undefined && result.captcha.blocked) {
    return {
      status: "captcha_blocked",
      service: input.service,
      error: result.error ?? "Captcha challenge blocked automated signup.",
      steps: result.steps,
      captcha_kind: result.captcha.kind,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service} blocked automated signup with a ${result.captcha.kind} captcha. ` +
        `Tell the user to sign up manually at ${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`,
    };
  }

  // OAuth-only service: no email/password form to automate.
  if (result.error !== undefined && result.error.startsWith("oauth_required")) {
    return {
      status: "oauth_required",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service} only offers Google/GitHub (OAuth) signup — there is no email form the bot can fill. ` +
        `Tell the user to sign up manually at ${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`,
    };
  }

  // Anti-bot interstitial (Cloudflare/Sucuri/DataDome/Imperva) that
  // wouldn't clear after retries + reload. Distinct from
  // oauth_required: there IS a form behind the gate, the bot just
  // can't get to it. Common on Cloudflare's own dashboard (the most
  // aggressive bot-detection on the internet, by their own product).
  if (result.error !== undefined && result.error.startsWith("anti_bot_blocked")) {
    return {
      status: "anti_bot_blocked",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service}'s anti-bot gateway refused to let the bot through — IP/fingerprint risk ` +
        `score too high. Tell the user to sign up manually at ` +
        `${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`,
    };
  }

  // T7/T10 — OAuth: the bot's Google session is missing/expired, or
  // Google interrupted with a security challenge. The remedy for both
  // is the one-time interactive login.
  if (result.error !== undefined && result.error.startsWith("needs_login")) {
    return {
      status: "needs_login",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `The bot has no usable provider session for an OAuth signup. Tell the user to run ` +
        `\`npx @trusty-squire/mcp login\` once (add \`--provider=github\` for a GitHub signup), ` +
        `then retry provision_any_service with oauth_provider. The error field names the exact command.`,
    };
  }

  // T7/T10 — OAuth: the consent screen requested broader-than-basic
  // scopes (or its scopes could not be read). The bot deliberately
  // does not auto-approve — surface the parsed scope list so the LLM
  // can ask the user to approve them, then re-run with
  // allow_extra_oauth_scopes.
  if (result.error !== undefined && result.error.startsWith("oauth_consent_needs_review")) {
    const { allRequested, unauthorized } = parseConsentScopes(result.error, result.steps);
    return {
      status: "oauth_consent_needs_review",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      requested_scopes: allRequested,
      unauthorized_scopes: unauthorized,
      message:
        unauthorized.length > 0
          ? `${input.service}'s OAuth consent screen requested scopes the user has not approved: ` +
            `[${unauthorized.join(", ")}]. Show the full requested list to the user, ask for ` +
            `explicit approval, and if granted re-run provision_any_service with ` +
            `allow_extra_oauth_scopes=${JSON.stringify(unauthorized)}. ` +
            `Otherwise tell the user to sign up manually at ` +
            `${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`
          : `${input.service}'s OAuth consent screen could not be parsed for scopes. Tell the user ` +
            `to complete the OAuth signup manually at ` +
            `${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`,
    };
  }

  // T7/T10 — OAuth: signed in fine, but the API key sits behind a
  // billing / payment-method wall the bot will not cross.
  if (result.error !== undefined && result.error.startsWith("onboarding_blocked")) {
    return {
      status: "onboarding_blocked",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service} signed up via Google, but its API key is behind a billing/payment wall. ` +
        `Tell the user to add a payment method at ` +
        `${input.signup_url ?? `https://${input.service.toLowerCase()}.com`} to finish.`,
    };
  }

  // S3/M2: the bot tags a signup it can't confirm by email with a
  // verification_not_sent: error prefix — either the service withheld
  // the mail, or (M1) there is no inbox to receive it. Either way the
  // user finishes manually. Surface it as its own status.
  if (result.error !== undefined && result.error.startsWith("verification_not_sent")) {
    return {
      status: "verification_not_sent",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service} requires an email verification that Trusty Squire's automated ` +
        `signup couldn't complete. Tell the user to finish signing up manually at ` +
        `${input.signup_url ?? `https://${input.service.toLowerCase()}.com`}.`,
    };
  }

  return {
    status: "failed",
    service: input.service,
    error: result.error ?? "Unknown error",
    steps: result.steps,
    browser_channel: result.browser_channel ?? null,
    message: `Couldn't finish signing up for ${input.service}. Show the user the steps[] for debugging.`,
  };
}

// Extract the scope lists encoded in the oauth_consent_needs_review
// error message authored by agent.ts. The two bracketed lists are:
//   [<unauthorized scopes>] in "non-basic scopes: [...]"
//   [<all requested>]       in "All requested scopes: [...]"
// Falls back to a step-trail scan ("parsed consent scopes = [...]") so
// even the unreadable-scope abort path can surface what the bot saw.
function parseConsentScopes(
  errorMessage: string,
  steps: readonly string[],
): { allRequested: string[]; unauthorized: string[] } {
  const splitList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "<unreadable>");

  const allMatch = errorMessage.match(/All requested scopes: \[([^\]]*)\]/);
  const unauthorizedMatch = errorMessage.match(/non-basic scopes: \[([^\]]*)\]/);
  const allRequested = allMatch?.[1] !== undefined ? splitList(allMatch[1]) : [];
  const unauthorized = unauthorizedMatch?.[1] !== undefined ? splitList(unauthorizedMatch[1]) : [];

  if (allRequested.length === 0) {
    for (const step of steps) {
      const m = step.match(/parsed consent scopes = \[([^\]]*)\]/);
      if (m?.[1] !== undefined) {
        return { allRequested: splitList(m[1]), unauthorized };
      }
    }
  }
  return { allRequested, unauthorized };
}

// Best-effort POST to /v1/captcha-events. We don't care about the
// response — at worst the event is lost, which is no worse than the
// pre-instrumentation state. Captures fresh asn at event time when
// possible; the API also falls back to the install-time asn from the
// MachineToken row if we can't supply one here.
async function postCaptchaEvent(
  apiBase: string,
  machineToken: string,
  event: {
    service: string;
    captcha_kind: "turnstile" | "recaptcha";
    blocked: boolean;
    proxied: boolean;
    captcha_variant: CaptchaVariant;
    challenge_rendered: boolean;
    signup_succeeded: boolean;
  },
): Promise<void> {
  try {
    const asn = await detectAsn();
    const body = {
      service: event.service,
      captcha_kind: event.captcha_kind,
      blocked: event.blocked,
      proxied: event.proxied,
      captcha_variant: event.captcha_variant,
      challenge_rendered: event.challenge_rendered,
      signup_succeeded: event.signup_succeeded,
      ...(asn !== null
        ? {
            asn: { class: asn.class, org: asn.org, country: asn.country, number: asn.asn },
          }
        : {}),
    };
    await fetch(`${apiBase}/v1/captcha-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-machine-token": machineToken,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[provision-any] captcha event report failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Stores the keys a signup yielded into the paired account's vault via
// POST /v1/vault/credentials (agent-authenticated). Best-effort, one
// request per credential — a failure logs and is dropped, since the
// keys are still returned to the caller in the tool response.
async function postCredentialsToVault(
  apiBase: string,
  agentSessionToken: string,
  service: string,
  credentials: Record<string, string | undefined>,
): Promise<void> {
  // "Resend" → "RESEND"; used to build an env-var-style key name.
  const prefix = service
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  for (const [name, value] of Object.entries(credentials)) {
    if (value === undefined || value.length === 0) continue;
    try {
      await fetch(`${apiBase}/v1/vault/credentials`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agentSessionToken}`,
        },
        body: JSON.stringify({
          service,
          value,
          env_var_suggestion: `${prefix}_${name.toUpperCase()}`,
          type: "api_key",
        }),
      });
    } catch (err) {
      console.error(
        `[provision-any] vault store failed for ${service}/${name} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
