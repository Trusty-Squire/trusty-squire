// provision_any — universal signup bot for any free API service.
//
// Runs the browser on the user's machine (their IP, their fingerprint).
// Aliases + inbox live on Trusty Squire's API so the SES forwarding
// pipeline (see apps/api/src/routes/ses-webhook.ts) can deliver
// verification emails.
//
// ASYNC MODEL: a real signup takes 3-8 minutes — well past the ~60s hard
// timeout Claude Code (and most MCP hosts) put on a single tool call. So
// `provision` does NOT block: it starts the run in the
// background inside this server process, returns a run_id immediately,
// and the caller polls `check_provision_status` until the run leaves the
// "running" state.
//
// Auth model: every install is account-bound. The session file carries
// the machine_token (for the bot's LLM proxy + inbox alias) and the
// agent_session_token (for vault writes), both bound to one account.

import { generateKeyPairSync } from "crypto";
import { z } from "zod";
import {
  UniversalSignupBot,
  InboxClient,
  ProxyLLMClient,
  BrowserController,
  replaySkill,
  type LLMPair,
} from "../bot/index.js";
import { makeEmailCodeFetcher } from "../bot/email-code-fetcher.js";
import { emitProvisionEvent, postCaptchaEvent } from "./signup-telemetry.js";
import { openSessionStorage } from "../session.js";
import type { ApiClient } from "../api-client.js";
import { getMachineStatus } from "../api-client.js";
import { VERSION } from "../version.js";
import {
  clientFromEnv,
  makeSkillUrlLookup,
  type ServiceHealthResponse,
  type SkillRegistryClient,
} from "../skill-registry-client.js";
import { categoryPeersOf } from "../data/service-categories.js";
import { promoteToSkill } from "../bot/promote-to-skill.js";
import { currentRunId, resolveCaptureDir } from "../bot/onboarding-capture.js";
import { redactCredentials, redactHtml } from "../bot/redact.js";
import { signSkillForPublish } from "../skill-cli/signing.js";
import { CliExit } from "../skill-cli/errors.js";
import { createProvisionRun, type ProvisionRun } from "../provision-run.js";


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
        "Use this ONLY after asking the user — if a previous run returned status=oauth_consent_needs_review with a requested_scopes list, ask the user 'Service X is requesting these scopes: [...] — approve?', and if they say yes, re-run provision with the same exact scope strings here. " +
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
  run_id: z.string().describe("The run_id returned by provision."),
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
      description: "The run_id returned by provision.",
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
  provisionRun: ProvisionRun;
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
- status="not_installed" → Trusty Squire isn't connected; tell the user to run \`npx @trusty-squire/mcp connect\`.
- status="error" → could not reach the API to set up the signup.`;

const CHECK_DESCRIPTION = `Check the status of a signup started by provision.

Pass the run_id from provision. Poll about once a minute
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
      user, ask "approve these scopes?", and if yes call provision AGAIN with
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

export const provisionTool = {
  name: "provision",
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
          "Trusty Squire isn't fully connected on this machine. " +
          "Run `npx @trusty-squire/mcp connect` to set up the squire (or reconnect " +
          "an install from before single-tier auth).",
      };
    }
    const apiBase = session.api_base_url;
    const inboxClient = new InboxClient({ baseUrl: apiBase, apiKey: session.machine_token });

    const provisionRun = createProvisionRun({
      service: input.service,
      accountId: session.account_id,
    });
    const runId = provisionRun.runId;
    const provisionId = provisionRun.provisionId;
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
      startedAt: provisionRun.startedAt,
      provisionRun,
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
      accountId: session.account_id,
      provisionRun,
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
          "or the MCP server restarted since it started. Start a new provision run.",
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
        recent_evidence: record.provisionRun.evidence.snapshot().slice(-20),
        evidence_path: record.provisionRun.evidencePath,
        evidence_persistence: record.provisionRun.evidence.persistenceStatus(),
        user_action_required: userActionRequired,
        message: userActionRequired
          ? "Signup is waiting on a user action — read recent_steps and relay the prompt to the user. Poll again in ~10 seconds."
          : "Signup still in progress. Poll again in about 30 seconds.",
      };
    }
    return await maybeAppendQuotaNudge({
      ...record.result,
      evidence: record.provisionRun.evidence.snapshot(),
      evidence_path: record.provisionRun.evidencePath,
      evidence_persistence: record.provisionRun.evidence.persistenceStatus(),
    });
  },
};

// Runway nudge: on a successful free-tier signup, tell the user how many free
// signups remain so the paywall isn't an ambush. Only fires in the 1..N band —
// a paid (unlimited) account reports quota_remaining 0, so it's never nudged,
// and 0 on a free account means the next run hits the wall anyway (the 402
// handles that). Best-effort: a status hiccup never alters or breaks the result.
const QUOTA_NUDGE_THRESHOLD = 3;

// Pure band logic: the nudge string when `remaining` is in the runway band
// (1..threshold), else null. A paid (unlimited) account reports remaining 0 so
// it's never nudged; 0 on a free account means the next run hits the wall
// anyway. Exported for testing.
export function quotaNudge(remaining: number, threshold = QUOTA_NUDGE_THRESHOLD): string | null {
  if (remaining > 0 && remaining <= threshold) {
    return (
      `Heads up: ${remaining} free signup${remaining === 1 ? "" : "s"} left — ` +
      `you'll be prompted to upgrade to unlimited ($19/mo) when they run out.`
    );
  }
  return null;
}

async function maybeAppendQuotaNudge(result: unknown): Promise<unknown> {
  const r = result as { status?: unknown; message?: unknown };
  if (r === null || typeof r !== "object" || r.status !== "success") return result;
  try {
    const session = await (await openSessionStorage()).read();
    if (session?.machine_token === undefined) return result;
    const status = await getMachineStatus(session.api_base_url, session.machine_token);
    const nudge = quotaNudge(status.quota_remaining);
    if (nudge !== null) {
      const base = typeof r.message === "string" ? r.message : "";
      return {
        ...(result as object),
        quota_remaining: status.quota_remaining,
        message: `${base} ${nudge}`.trim(),
      };
    }
  } catch {
    // best-effort — never let a status lookup change or break a real result
  }
  return result;
}

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
  // provision entry, propagated through every registry
  // call + bot run + vault write. Useful for forensics: one log
  // grep finds every event tied to this signup attempt.
  provisionRun: ProvisionRun;
  // The account_id the session is bound to; passed to the registry
  // client so replay-outcome writes are attributable.
  accountId: string;
  // Set true by tryReplayLearnedSkill when an active skill exists and a
  // replay was attempted. Read by the single ProvisionEvent emit to
  // distinguish "replay fell back to bot" (initial=replay, replay=miss)
  // from "no skill, bot direct" (initial=bot, replay=na). Optional so
  // existing RunContext construction sites need no change.
  replayAttempted?: boolean;
}

// Translate a ReplayOutcome (camelCase, from the replay engine) into
// the snake_case shape the registry's POST /skills/:id/replay-outcome
// endpoint expects. Centralized so a future field rename on either
// side can't drift silently — the two consumers (dry-mode and full-
// mode failure paths) shared an ad-hoc spread that quietly omitted any
// new field. Output omits `step_index` when the outcome carries none
// so the optional field stays unset rather than null.
function toReplayOutcomeBody(
  skillId: string,
  outcome: Awaited<ReturnType<typeof replaySkill>>,
  reason: string,
  provisionId: string,
): import("../skill-registry-client.js").PostReplayOutcomeInput {
  const outcomeKind: import("../skill-registry-client.js").PostReplayOutcomeInput["outcome"] =
    outcome.kind === "ok"
      ? "ok"
      : outcome.kind === "dry_pass"
        ? "dry_pass"
        : outcome.kind === "needs_login"
          ? "needs_login"
          : outcome.kind === "validator_failed"
            ? "validator_failed"
            : outcome.kind === "extraction_failed"
              ? "extraction_failed"
              : "step_failed";
  return {
    skill_id: skillId,
    outcome: outcomeKind,
    reason,
    provision_id: provisionId,
    ...("stepIndex" in outcome && typeof outcome.stepIndex === "number"
      ? { step_index: outcome.stepIndex }
      : {}),
  };
}


// Resolve the dispatch strategy/outcome for the ProvisionEvent from two
// facts the router knows: did a replay serve the request, and was a
// replay even attempted (a skill existed). Exported + pure so the three
// cases — including the tricky "replay fell back to bot" — are unit
// tested directly without standing up the whole router.
export function resolveDispatch(
  replayServed: boolean,
  replayAttempted: boolean,
): {
  initialStrategy: "replay" | "bot";
  finalStrategy: "replay" | "bot";
  replayOutcome: "ok" | "miss" | "na";
} {
  if (replayServed) {
    return { initialStrategy: "replay", finalStrategy: "replay", replayOutcome: "ok" };
  }
  if (replayAttempted) {
    // A skill existed and we tried it, but it didn't serve → bot took over.
    return { initialStrategy: "replay", finalStrategy: "bot", replayOutcome: "miss" };
  }
  // No skill for this service → bot direct.
  return { initialStrategy: "bot", finalStrategy: "bot", replayOutcome: "na" };
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
  const fetched = await client.fetchActiveSkill(serviceSlug, ctx.provisionRun.provisionId);

  if (fetched.kind !== "found") {
    return null;
  }

  const { skill } = fetched.result;
  // A skill exists → we're about to attempt a replay. Records this on
  // the run context so the ProvisionEvent emit can tell "replay fell
  // back to bot" apart from "no skill, bot direct".
  ctx.replayAttempted = true;
  // Surface that the router engaged so check_provision_status's
  // recent_steps log shows the skill attempt before any bot output.
  ctx.stepsSink.push(`[skill-promoter] fetched skill ${skill.skill_id} v${skill.version} for ${serviceSlug}`);

  // Show-once routing (post-Phase-E): when ANY credential in the
  // skill is marked visibility="show_once_at_creation" (Cloudinary
  // api_secret class), replay is structurally impossible — the
  // secret only existed visibly at the moment of original creation
  // and the dashboard masks it permanently after. Skip replay and
  // fall through to fresh-signup-each-time. The bot's universal
  // signup path naturally generates a new email alias → new account
  // → re-captures the secret while it's freshly visible.
  const hasShowOnce = skill.credentials.some(
    (c) => c.visibility === "show_once_at_creation",
  );
  if (hasShowOnce) {
    const showOnceNames = skill.credentials
      .filter((c) => c.visibility === "show_once_at_creation")
      .map((c) => c.name ?? "api_key")
      .join(", ");
    ctx.stepsSink.push(
      `[skill-promoter] skipping replay — skill has show_once_at_creation credential(s) [${showOnceNames}]; routing to fresh signup`,
    );
    return null;
  }

  // await_email_code skills (email-OTP signups) are ONE-SHOT: a dry walk
  // would consume the verification code and create the account, leaving the
  // full pass nothing to replay. Skip the dry pre-flight for them.
  const hasEmailCode = skill.steps.some((s) => s.kind === "await_email_code");
  const emailCodeFetcher = makeEmailCodeFetcher(ctx.inboxClient);

  const browser = new BrowserController({ humanize: true });
  let dryOutcome: Awaited<ReturnType<typeof replaySkill>>;
  try {
    await browser.start();
    if (hasEmailCode) {
      ctx.stepsSink.push(
        `[skill-promoter] await_email_code skill — skipping dry pre-flight (signup is one-shot)`,
      );
      dryOutcome = { kind: "dry_pass", stepsWalked: 0 };
    } else {
      // Dry first — D3 default. Walks every step except the
      // credential-creating click, so if the page diverged we abort
      // cheaply before touching the user's account.
      dryOutcome = await replaySkill({
        skill,
        browser,
        mode: "dry",
        templateValues: {
          EMAIL_ALIAS: ctx.alias,
          TOKEN_NAME: `mcp-${ctx.provisionRun.provisionId.slice(5)}`,
        },
      });
    }
  } catch (err) {
    ctx.stepsSink.push(`[skill-promoter] replay crashed: ${err instanceof Error ? err.message : String(err)}`);
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: "step_failed",
      reason: `replay engine crashed: ${err instanceof Error ? err.message : String(err)}`,
      provision_id: ctx.provisionRun.provisionId,
    });
    client.invalidateCache(serviceSlug);
    try { await browser.close(); } catch { /* noop */ }
    return null;
  }

  if (dryOutcome.kind !== "dry_pass") {
    // Dry-mode found a problem. Record + fall through.
    ctx.stepsSink.push(`[skill-promoter] dry replay failed: ${dryOutcome.kind}`);
    void client.postReplayOutcome(
      toReplayOutcomeBody(
        skill.skill_id,
        dryOutcome,
        `dry-mode pre-flight failed: ${JSON.stringify(dryOutcome)}`,
        ctx.provisionRun.provisionId,
      ),
    );
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
        TOKEN_NAME: `mcp-${ctx.provisionRun.provisionId.slice(5)}`,
      },
      fetchEmailCode: emailCodeFetcher,
    });
  } catch (err) {
    ctx.stepsSink.push(`[skill-promoter] full replay crashed: ${err instanceof Error ? err.message : String(err)}`);
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: "step_failed",
      reason: `full replay engine crashed: ${err instanceof Error ? err.message : String(err)}`,
      provision_id: ctx.provisionRun.provisionId,
    });
    client.invalidateCache(serviceSlug);
    try { await fullBrowser.close(); } catch { /* noop */ }
    return null;
  }

  try { await fullBrowser.close(); } catch { /* noop */ }

  // Branch on outcome. Single-cred and multi-cred success live in
  // separate code paths — the compiler enforces this via the
  // discriminated union; no silent coercion.
  if (fullOutcome.kind !== "ok" && fullOutcome.kind !== "ok_multi") {
    ctx.stepsSink.push(`[skill-promoter] full replay failed: ${fullOutcome.kind}`);
    void client.postReplayOutcome(
      toReplayOutcomeBody(
        skill.skill_id,
        fullOutcome,
        `full replay failed: ${JSON.stringify(fullOutcome)}`,
        ctx.provisionRun.provisionId,
      ),
    );
    client.invalidateCache(serviceSlug);
    return null;
  }

  if (fullOutcome.kind === "ok") {
    // Single-credential success path — unchanged from pre-multi-cred.
    ctx.stepsSink.push(`[skill-promoter] replay OK — credential extracted via ${fullOutcome.via}`);
    void client.postReplayOutcome({
      skill_id: skill.skill_id,
      outcome: "ok",
      reason: `extracted via ${fullOutcome.via}`,
      provision_id: ctx.provisionRun.provisionId,
    });
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

  // Multi-credential success path (Phase D per docs/DESIGN-multi-credential.md).
  // The bundle has been validated per-credential by the replay engine;
  // a future Phase F adds the bundle_sentinel call here. We turn the
  // bundle into a credentials map keyed by each credential's env_var_
  // suggestion (lowercased), matching what the agent SDK reads from
  // process.env.
  ctx.stepsSink.push(
    `[skill-promoter] replay OK (multi) — extracted ${Object.keys(fullOutcome.credentials).length} ` +
      `credentials: [${Object.keys(fullOutcome.credentials).join(", ")}]`,
  );
  void client.postReplayOutcome({
    skill_id: skill.skill_id,
    outcome: "ok",
    reason: `multi-cred extracted: [${Object.keys(fullOutcome.credentials).join(", ")}]`,
    provision_id: ctx.provisionRun.provisionId,
  });
  const credentials: Record<string, string> = {};
  for (const [produces, value] of Object.entries(fullOutcome.credentials)) {
    const spec = skill.credentials.find((c) => c.name === produces);
    // Synthesizer guarantees every produces references a credentials
    // entry; fall back to the produces name if a hand-edited skill
    // slips through with a mismatch (defensive).
    const key = (spec?.env_var_suggestion ?? produces).toLowerCase();
    credentials[key] = value;
  }
  return {
    success: true,
    credentials,
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
  // T45 — correlation id for this provision call. Threaded into every
  // round/extract upload AND the final attempt-recording so the
  // admin dashboard can JOIN per-attempt screenshots + step trail.
  const provisionId = ctx.provisionRun.provisionId;
  ctx.provisionRun.evidence.append("provision.signup_task.started", { service: input.service });
  // Wall-clock start, for the event's duration_ms.
  const startedAt = ctx.provisionRun.startedAt;
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
        // Replay served it — emit the unified event (replay/replay/ok).
        // Fire-and-forget: the MCP server stays up, so no need to await.
        void emitProvisionEvent(registry, {
          service: input.service,
          provisionId,
          startedAt,
          ...resolveDispatch(true, true),
          result: replayed,
          ...(input.signup_url !== undefined ? { signupUrl: input.signup_url } : {}),
          replayServed: true,
          // Memory-overhaul Phase 1 — a learned skill served this provision.
          mode: "replay",
        });
        // Persist to vault same as the bot path — credentials are real.
        if (replayed.success && replayed.credentials !== undefined) {
          const vault = await postCredentialsToVault(
            ctx.apiBase,
            ctx.agentSessionToken,
            input.service,
            replayed.credentials,
            signupObservedHosts(input.signup_url),
          );
          attachVaultPersistence(response, vault);
          ctx.provisionRun.evidence.append(
            "vault.persisted",
            vaultPersistenceEvidence(vault),
            vault.every((item) => item.ok) ? "info" : "warn",
          );
        }
        ctx.provisionRun.evidence.append("provision.run.completed", { status: "success", via: "skill" });
        const record = runStore.get(runId);
        if (record !== undefined) record.result = response;
        return;
      }
    }

    // T44 — compat-score preflight. If the registry already knows this
    // service is hard-blocked for our bot, attach a `recommendation`
    // to the eventual response so the agent can surface alternates to
    // the user. Best-effort: any registry trouble means no
    // recommendation this run.
    let preflightHealth: ServiceHealthResponse | null = null;
    if (registry !== null) {
      const peers = categoryPeersOf(input.service);
      const outcome = await registry.fetchServiceHealth(input.service, peers);
      if (outcome.kind === "ok") {
        preflightHealth = outcome.health;
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
      // No curated URL → let resolveSignupUrl reuse a promoted skill's
      // verified entry URL (registry-backed) before falling to the model.
      ...(registry !== null
        ? { lookupSkillUrl: makeSkillUrlLookup(registry, ctx.provisionRun.provisionId) }
        : {}),
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
      // Diagnostic uploader — auto-uploads DOM + screenshot snapshots
      // to the registry whenever extractCredentials() returns
      // null. Lets us diagnose UI-shape regressions without users
      // needing to enable debug env vars. Best-effort; failures here
      // never abort the signup. Scoped by account_id so the matching
      // MCP fetch tools (list_extract_failures / get_extract_failure)
      // see the same snapshots.
      extractFailureUploader: buildExtractFailureUploader(ctx.accountId, provisionId),
      // Per-round telemetry — every post-verify round's DOM +
      // screenshot lands in the registry, not just the ones that
      // fail at extract. Default-on as of 0.6.14-rc.11 so stuck-loop
      // bugs (Railway token-create no-op) are diagnosable without
      // needing to reproduce the run locally.
      roundUploader: buildRoundUploader(ctx.accountId, provisionId),
      // Heightened-auth notifier credentials — the agent's
      // notifyHeightenedAuth call (Google number-match) reads these
      // because session.json's machine_token is NOT exported as an
      // env var in MCP installs. Without this plumbing the notify
      // call silently no-ops (rc.12 and earlier).
      machineToken: ctx.machineToken,
      apiBase: ctx.apiBase,
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
        ...(result.stealth_profile !== undefined
          ? { stealth_profile: result.stealth_profile }
          : {}),
      });
    }

    response = buildSignupResponse(input, result);

    // T44 — if preflight saw hard-block, attach a recommendation to
    // the response. Soft hint only; agent decides what to do.
    if (
      preflightHealth !== null &&
      preflightHealth.state === "hard-block" &&
      preflightHealth.alternates.length > 0
    ) {
      const altReadable = preflightHealth.alternates
        .map((a) => a.service)
        .join(", ");
      response.recommendation = {
        reason:
          `trusty-squire's signup bot has struggled with ${input.service} ` +
          `recently (${preflightHealth.failed_count} failed of ` +
          `${preflightHealth.failed_count + preflightHealth.successful_count} ` +
          `attempts) — alternates with working skills: ${altReadable}.`,
        alternates: preflightHealth.alternates.map((a) => ({
          slug: a.service,
          state: a.state,
          has_active_skill: a.has_active_skill,
        })),
      };
    }

    // The single ProvisionEvent emit for the bot path (design Decision
    // 1). Best-effort; a failure here only means the dashboard/score
    // won't see this data point. dispatch resolves from whether a skill
    // replay was attempted first: skill present but fell through here =
    // replay/bot/miss; no skill = bot/bot/na.
    if (registry !== null) {
      // Fire-and-forget: the MCP server stays up, so no need to await.
      void emitProvisionEvent(registry, {
        service: input.service,
        provisionId,
        startedAt,
        ...resolveDispatch(false, ctx.replayAttempted === true),
        result,
        ...(input.signup_url !== undefined ? { signupUrl: input.signup_url } : {}),
        // Only attach the trail on failure — successful runs already
        // have richer artifacts on the corpus/skill path.
        ...(!result.success && ctx.stepsSink.length > 0
          ? { stepTrail: ctx.stepsSink.join("\n") }
          : {}),
        replayServed: false,
      });
    }

    // Persist the collected keys into the account's vault. Fire-and-
    // report — the credentials are already in `response`, so a vault
    // write failure is non-fatal, but it must be visible to the caller.
    if (result.success && result.credentials !== undefined) {
      const vault = await postCredentialsToVault(
        ctx.apiBase,
        ctx.agentSessionToken,
        input.service,
        result.credentials,
        signupObservedHosts(input.signup_url),
      );
      attachVaultPersistence(response, vault);
      ctx.provisionRun.evidence.append(
        "vault.persisted",
        vaultPersistenceEvidence(vault),
        vault.every((item) => item.ok) ? "info" : "warn",
      );
    }

    // Auto-promote on bot success. Closes the loop without an
    // operator running `mcp skill promote` between signups: the bot's
    // capture chain becomes a published skill the next provision will
    // replay. rc.13: with the ephemeral-key fallback in place, auto-
    // promote no longer requires operator-level signing infra to
    // succeed — so rc.14 flips the default from opt-in to ON. Opt
    // OUT with TRUSTY_SQUIRE_AUTO_PROMOTE=false (or 0 / off). The
    // server-side review gate still catches signup_url / oauth_
    // provider changes (lands as pending-review, not active).
    // Fire-and-forget — failures push to stepsSink with `[auto-
    // promote]` prefix and never fail the signup.
    if (result.success && isAutoPromoteEnabled(process.env)) {
      void runAutoPromote({
        service: input.service,
        stepsSink: ctx.stepsSink,
        accountId: ctx.accountId,
      });
    }
    ctx.provisionRun.evidence.append("provision.run.completed", {
      status: result.success ? "success" : "failed",
      via: "bot",
    }, result.success ? "info" : "warn");
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
        `then retry provision with oauth_provider. The error field names the exact command.`,
    };
  }

  // F14 / rc.33-task / 0.6.15-rc.5 — the page offers OAuth buttons
  // but the bot's chrome profile has no session for ANY of them.
  // Distinct from needs_login (which is "had a session, it broke"):
  // this is "never had a session for the provider this service
  // requires". Surface a specific copy-pasteable connect command per
  // the multi-provider onboarding design. agent.ts already builds the
  // error string with the right `--provider=<X>` flag — extract and
  // hand it to the host LLM verbatim.
  if (
    result.error !== undefined &&
    result.error.startsWith("needs_oauth_provider_session")
  ) {
    const match = /--provider=(google|github)/.exec(result.error);
    const provider = match?.[1] ?? "google";
    const providerLabel = provider === "github" ? "GitHub" : "Google";
    return {
      status: "needs_login",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service} requires ${providerLabel} OAuth but the bot has no ${providerLabel} ` +
        `session configured. Tell the user to run: ` +
        `\`npx @trusty-squire/mcp login --provider=${provider}\`. ` +
        `Once they confirm sign-in completed, retry provision.`,
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
            `explicit approval, and if granted re-run provision with ` +
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

// Best-effort hosts to seed a captured credential's allowlist, from the
// URL(s) the signup ran against. Returns bare lowercase hostnames; the
// vault normalises + unions them with its service-name table so the stored
// credential never lands with an empty allowlist. (A fuller guarantee would
// echo the bot's RESOLVED signup URL when input.signup_url is omitted —
// tracked as a follow-up; today this covers the explicit-URL + replay cases.)
function signupObservedHosts(...urls: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (u === undefined || u.length === 0) continue;
    try {
      out.add(new URL(u.includes("://") ? u : `https://${u}`).hostname.toLowerCase());
    } catch {
      /* unparseable — skip */
    }
  }
  return [...out];
}

// Stores the keys a signup yielded into the paired account's vault via
// POST /v1/vault/credentials (agent-authenticated). One request per
// credential. Failures are non-fatal because the keys are still returned to
// the caller, but they are part of the run outcome and must be visible.
type VaultPersistResult =
  | { ok: true; name: string; status: number }
  | { ok: false; name: string; error: string; status?: number };

function attachVaultPersistence(
  response: Record<string, unknown>,
  results: readonly VaultPersistResult[],
): void {
  if (results.length === 0) return;
  response.vault_persisted = results.every((item) => item.ok);
  response.vault_persistence = results.map((item) =>
    item.ok
      ? { name: item.name, ok: true, status: item.status }
      : {
          name: item.name,
          ok: false,
          error: item.error,
          ...(item.status !== undefined ? { status: item.status } : {}),
        },
  );
}

function vaultPersistenceEvidence(
  results: readonly VaultPersistResult[],
): Record<string, unknown> {
  return {
    total: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    credentials: results.map((item) =>
      item.ok
        ? { name: item.name, ok: true, status: item.status }
        : {
            name: item.name,
            ok: false,
            error: item.error,
            ...(item.status !== undefined ? { status: item.status } : {}),
          },
    ),
  };
}

async function postCredentialsToVault(
  apiBase: string,
  agentSessionToken: string,
  service: string,
  credentials: Record<string, string | undefined>,
  // Hosts observed during this signup (the signup URL's host). Sent so the
  // vault unions them into allowed_hosts — a captured credential never lands
  // with an empty allowlist (which would 403 every use_credential call).
  observedHosts: string[] = [],
): Promise<VaultPersistResult[]> {
  // "Resend" → "RESEND"; used to build an env-var-style key name.
  const prefix = service
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const results: VaultPersistResult[] = [];
  for (const [name, value] of Object.entries(credentials)) {
    if (value === undefined || value.length === 0) continue;
    try {
      const resp = await fetch(`${apiBase}/v1/vault/credentials`, {
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
          ...(observedHosts.length > 0 ? { observed_hosts: observedHosts } : {}),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const detail = body.length > 0 ? `: ${body.slice(0, 500)}` : "";
        results.push({
          ok: false,
          name,
          status: resp.status,
          error: `vault returned HTTP ${resp.status}${detail}`,
        });
        continue;
      }
      results.push({ ok: true, name, status: resp.status });
    } catch (err) {
      results.push({
        ok: false,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `[provision-any] vault store failed for ${service}/${name} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return results;
}

// Build the extract-failure diagnostic uploader. The bot calls this
// asynchronously (fire-and-forget) when extractCredentials() returns
// null despite the LLM planner asserting a credential was visible.
//
// Scoped by account_id so the matching MCP fetch tools (which use
// ApiClient, also configured with account_id) see the same data.
//
// All errors are swallowed: a snapshot upload failure must never
// abort a signup.
export function buildExtractFailureUploader(
  accountId: string,
  provisionId?: string,
): (input: {
  service: string;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  candidates: ReadonlyArray<string>;
  html: string;
  screenshot_jpeg_base64?: string;
}) => Promise<void> {
  // The registry lives at a separate origin. Resolution order
  // matches the rest of the MCP: explicit env override, then prod
  // default. Defined here (not as a module const) so tests can flip
  // the env var and re-build the uploader.
  const registryBase = process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai";
  return async (input) => {
    try {
      const body = {
        service: input.service,
        mcp_version: VERSION,
        url: input.url,
        title: input.title,
        step_label: input.step_label,
        // Phase 2 — redact secrets before anything leaves the box. The DOM
        // gets the full HTML scrub (captcha/auth/password + key shapes); the
        // prose reason + candidate strings get the key-shape redactor (they
        // routinely contain the LLM's verbatim view of an extracted value).
        extract_reason: redactCredentials(input.extract_reason),
        candidates: input.candidates.map(redactCredentials),
        html: redactHtml(input.html),
        ...(input.screenshot_jpeg_base64 !== undefined
          ? { screenshot_jpeg_base64: input.screenshot_jpeg_base64 }
          : {}),
        // T45 — tag with the parent provision_id so the admin
        // dashboard can group snapshots by attempt.
        ...(provisionId !== undefined ? { provision_id: provisionId } : {}),
      };
      await fetch(`${registryBase}/v1/extract-failures`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": accountId,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(
        `[provision-any] extract-failure upload failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

// Build the per-round telemetry uploader (rc.11). Fires on every post-
// verify round — gives us the full DOM + screenshot trail of any signup
// without needing to reproduce it. Reuses /v1/extract-failures because
// the on-disk schema (HTML+JPEG+title+url+step_label) is identical;
// `extract_reason: "round_telemetry"` differentiates the rows from
// real extract failures when listing.
//
// Same fire-and-forget contract as buildExtractFailureUploader: errors
// are logged but never propagate, and the round-uploader call site in
// agent.ts ALSO wraps in try/catch so the loop is bulletproof either
// way. Account-scoped identically.
export function buildRoundUploader(
  accountId: string,
  provisionId?: string,
): (input: {
  service: string;
  round: number;
  kind: string;
  url: string;
  title: string;
  inventory_count: number;
  observed_reason: string;
  html: string;
  screenshot_jpeg_base64?: string;
}) => Promise<void> {
  const registryBase = process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai";
  return async (input) => {
    try {
      const body = {
        service: input.service,
        mcp_version: VERSION,
        url: input.url,
        title: input.title,
        // `step_label` distinguishes rounds when listing the table;
        // keep it short + sortable. `extract_reason` carries the
        // planner's chosen reason so the trail is intelligible
        // without fetching the full row.
        step_label: `round-${input.round}-${input.kind}`,
        extract_reason: redactCredentials(
          `round_telemetry: ${input.observed_reason}`.slice(0, 4000),
        ),
        candidates: [`inventory_count=${input.inventory_count}`],
        // Phase 2 — redact secrets from the DOM before upload (every failure
        // kind now uploads its chain, so this path is the one that grows).
        html: redactHtml(input.html),
        ...(input.screenshot_jpeg_base64 !== undefined
          ? { screenshot_jpeg_base64: input.screenshot_jpeg_base64 }
          : {}),
        // T45 — same parent correlation id as the extract-failure path.
        ...(provisionId !== undefined ? { provision_id: provisionId } : {}),
      };
      await fetch(`${registryBase}/v1/extract-failures`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": accountId,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(
        `[provision-any] round-telemetry upload failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

// Decide whether auto-promote should fire after a successful signup.
// rc.14 — default is ON. Set TRUSTY_SQUIRE_AUTO_PROMOTE to one of
// "false" / "0" / "off" to disable. Any other value (including
// "true", unset, or empty) leaves it enabled. Exported for unit
// testing; the caller path uses it as an `if` condition.
export function isAutoPromoteEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TRUSTY_SQUIRE_AUTO_PROMOTE;
  if (raw === undefined) return true;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "false" || trimmed === "0" || trimmed === "off") return false;
  return true;
}

// Auto-promote on bot success (rc.10). Reads from process.env. As of
// rc.14 the feature is on by default — opt out with
// TRUSTY_SQUIRE_AUTO_PROMOTE=false. Never throws — all failures
// land in `stepsSink` with the `[auto-promote]` prefix.
//
// Exported for unit testing. Production callers pass {service,
// stepsSink: ctx.stepsSink, accountId: ctx.accountId}; tests inject
// a `fetchFn` to assert on the registry POST without a real network.
//
// Returns a discriminated result so callers (the housekeeper
// orchestrator's batch summary) can credit `promoted=N` accurately instead of
// rolling every discover task into `none`. stepsSink keeps the
// per-step narrative for the operator log; the return value is
// for counters.
export type AutoPromoteResult =
  | { kind: "published"; skill_id: string; version: string }
  | { kind: "idempotent"; skill_id: string; version: string }
  // No capture / env disabled / registry URL missing — there was
  // nothing to publish. Distinct from "rejected" so summary counts
  // don't conflate "we tried and failed" with "we didn't try."
  | { kind: "skipped"; reason: string }
  // Synthesizer rejected the capture, registry returned non-2xx,
  // network failed, etc. Real failure.
  | { kind: "rejected"; reason: string };

export async function runAutoPromote(args: {
  service: string;
  stepsSink: string[];
  accountId: string;
  fetchFn?: typeof globalThis.fetch;
}): Promise<AutoPromoteResult> {
  const { service, stepsSink } = args;
  const fetchFn = args.fetchFn ?? globalThis.fetch;
  try {
    // 1. Resolve the capture dir. rc.13 — use resolveCaptureDir()
    //    instead of reading the env directly so auto-promote picks
    //    up rc.11's default-on path (~/.trusty-squire/corpus/
    //    onboarding/) without the operator having to set the env
    //    var explicitly. Returns null only when the env is
    //    "off"/"0"/"false" or homedir() fails — in those cases
    //    there are genuinely no captures to promote.
    const captureDir = resolveCaptureDir();
    if (captureDir === null) {
      stepsSink.push(
        "[auto-promote] capture directory is disabled (TRUSTY_SQUIRE_ONBOARDING_CAPTURE=off) — nothing to promote.",
      );
      return { kind: "skipped", reason: "capture_dir_disabled" };
    }
    const runId = currentRunId();
    if (runId === undefined) {
      stepsSink.push(
        "[auto-promote] no captures written this run (bot may have taken the fast path) — skipping.",
      );
      return { kind: "skipped", reason: "no_capture_this_run" };
    }

    // 2. Registry URL must be configured.
    const registryUrl = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    if (registryUrl === undefined || registryUrl.trim().length === 0) {
      stepsSink.push(
        "[auto-promote] TRUSTY_SQUIRE_REGISTRY_URL is unset — no registry to publish to.",
      );
      return { kind: "skipped", reason: "no_registry_url" };
    }

    // 3. Synthesize. promoteToSkill is pure (filesystem + Zod); any
    //    rejection here is a structural issue with the capture, not
    //    a runtime failure.
    const serviceSlug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const result = promoteToSkill({
      dir: captureDir,
      service: serviceSlug,
      run_id: runId,
    });
    if (result.kind !== "ok") {
      stepsSink.push(
        `[auto-promote] synthesizer rejected: ${result.stage} / ${result.error_kind} — ${result.message}`,
      );
      return {
        kind: "rejected",
        reason: `synthesizer:${result.error_kind}`,
      };
    }

    // 4. Sign. rc.13 — when SKILL_SIGNING_PRIVATE_KEY is unset,
    //    generate an ephemeral Ed25519 keypair and sign with that.
    //    The on-wire signature is structurally valid (passes the
    //    registry's >=16-byte length check) and is accepted by the
    //    length-only-fallback mode the registry runs in today
    //    (SKILL_VERIFY_PUBLIC_KEY unset). When per-account signing
    //    rolls out, users will need to either configure
    //    SKILL_SIGNING_PRIVATE_KEY or register the public half of
    //    an ephemeral key at connect time — but that's future
    //    infra; today the goal is "every successful signup
    //    promotes a skill", which requires the no-key path to
    //    succeed silently. The explicit-signing CLI
    //    (`mcp skill promote`) still uses signSkillForPublish
    //    without the fallback, so operators get a loud error
    //    instead of accidentally publishing unsigned.
    let signature: string;
    try {
      signature = signSkillForPublish(result.skill).signature;
    } catch (err) {
      if (err instanceof CliExit) {
        const { privateKey } = generateKeyPairSync("ed25519");
        signature = signSkillForPublish(result.skill, { privateKey }).signature;
        stepsSink.push(
          "[auto-promote] SKILL_SIGNING_PRIVATE_KEY is not configured — signing with an ephemeral key. Acceptable while the registry runs in length-only fallback mode.",
        );
      } else {
        throw err;
      }
    }

    // 5. POST /skills. Raw fetch — RegistryHttpClient throws CliExit
    //    which is the wrong shape here. We want a quiet log on
    //    failure, never a throw.
    const url = `${registryUrl.replace(/\/+$/, "")}/skills`;
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": args.accountId,
        },
        body: JSON.stringify({ skill: result.skill, signature }),
      });
    } catch (err) {
      stepsSink.push(
        `[auto-promote] POST /skills failed (${err instanceof Error ? err.message : String(err)}).`,
      );
      return { kind: "rejected", reason: "network_error" };
    }

    if (resp.status === 201) {
      stepsSink.push(
        `[auto-promote] published ${serviceSlug} ${result.skill.version} ` +
          `(skill_id=${result.skill.skill_id}, status=pending-review). ` +
          `Verifier worker will validate and promote to active; next ${serviceSlug} signup hits the skill once it does.`,
      );
      return {
        kind: "published",
        skill_id: result.skill.skill_id,
        version: result.skill.version,
      };
    }
    if (resp.status === 200) {
      // Idempotent re-publish (same skill_id). Already in the registry
      // — same captures produced the same skill_id deterministically.
      stepsSink.push(
        `[auto-promote] ${serviceSlug} ${result.skill.version} already published (idempotent).`,
      );
      return {
        kind: "idempotent",
        skill_id: result.skill.skill_id,
        version: result.skill.version,
      };
    }
    if (resp.status === 401) {
      // Bad signature — either SKILL_VERIFY_PUBLIC_KEY mismatch on
      // the server, or our private key isn't the matching one.
      stepsSink.push(
        `[auto-promote] registry rejected signature (HTTP 401). Check that SKILL_SIGNING_PRIVATE_KEY here matches SKILL_VERIFY_PUBLIC_KEY on the registry.`,
      );
      return { kind: "rejected", reason: "signature_invalid" };
    }
    // Anything else: log status + try to surface the registry's detail.
    let detail = "";
    try {
      const body = (await resp.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? "";
    } catch {
      /* malformed JSON — skip */
    }
    stepsSink.push(
      `[auto-promote] HTTP ${resp.status} from registry${detail.length > 0 ? ": " + detail : ""}.`,
    );
    return { kind: "rejected", reason: `http_${resp.status}` };
  } catch (err) {
    // Defense-in-depth: any unexpected throw lands here. Never let
    // auto-promote take down the parent signup task.
    stepsSink.push(
      `[auto-promote] unexpected failure (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "rejected", reason: "unexpected_throw" };
  }
}
