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
// Auth model: Tier 0 machine token from the session file. No account or
// mandate required for free-tier signups.

import { randomBytes } from "crypto";
import { z } from "zod";
import {
  UniversalSignupBot,
  InboxClient,
  ProxyLLMClient,
  detectAsn,
  type LLMPair,
  type CaptchaVariant,
} from "../bot/index.js";
import { openSessionStorage } from "../session.js";
import type { ApiClient } from "../api-client.js";

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

If the user has a paired Trusty Squire account, call list_credentials
first — reuse an existing key rather than signing up again.

IMMEDIATE RESPONSES (no run started):
- status="started" + run_id → poll check_provision_status next.
- status="quota_exceeded" + cta_pair_url → tell the user to run \`npx @trusty-squire/mcp pair\`.
- status="not_installed" → Trusty Squire isn't installed; tell the user to run the installer.
- status="error" → could not reach the API to set up the signup.`;

const CHECK_DESCRIPTION = `Check the status of a signup started by provision_any_service.

Pass the run_id from provision_any_service. Poll about once a minute
until status is no longer "running".

RESPONSES:
- status="running" → still working; poll again in ~60s.
- status="success" + credentials → signup done; show the credentials to the user.
- status="verification_not_sent" → submitted, but the service sent no verification
  email (anti-abuse withholding, or it needs manual signup).
- status="captcha_blocked" → the site uses a captcha the bot can't pass; manual signup.
- status="oauth_required" → the service only offers OAuth signup; manual signup.
- status="needs_login" → an OAuth signup needs the bot's one-time Google login;
  tell the user to run \`npx @trusty-squire/mcp login\`, then retry.
- status="oauth_consent_needs_review" → the Google consent screen asked for more than
  basic profile access; the user must complete the OAuth signup manually.
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
    // Pull the machine token from session storage. The install CLI writes it.
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (session === null || session.machine_token === undefined) {
      const hasPartialSession = session !== null && session.agent_session_token !== undefined;
      return {
        status: "not_installed",
        message: hasPartialSession
          ? "This machine is paired (Tier 1) but has no Tier 0 machine_token, which provision_any_service requires. Run `node /home/chode/trusty-squire/apps/mcp/dist/install/cli.js install --target=goose` to issue one, or in production run `npx @trusty-squire/mcp install`."
          : "Trusty Squire isn't installed on this machine. In production run `npx @trusty-squire/mcp install`. For local dev against this repo run `node /home/chode/trusty-squire/apps/mcp/dist/install/cli.js install --target=goose`.",
      };
    }
    const apiBase = session.api_base_url;
    const inboxClient = new InboxClient({ baseUrl: apiBase, apiKey: session.machine_token });

    // Random suffix, not just a ms timestamp: two concurrent signups in
    // the same millisecond would otherwise share a run_id — and, for the
    // same service, the same inbox alias.
    const runId = `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    let alias: string;
    try {
      alias = await inboxClient.createAlias({
        account_id: session.account_id ?? "anonymous",
        service: input.service,
        run_id: runId,
      });
      // eslint-disable-next-line no-console
      console.error(`[provision-any] alias=${alias} apiBase=${apiBase}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The createAlias error body carries the structured payload; parse it back.
      if (/quota_exceeded/.test(message)) {
        const match = message.match(/\{.*\}/s);
        if (match !== null) {
          try {
            const parsed = JSON.parse(match[0]) as Record<string, unknown>;
            return {
              status: "quota_exceeded",
              service: input.service,
              quota_limit: parsed["quota_limit"],
              quota_used: parsed["quota_used"],
              cta_pair_url: parsed["cta_pair_url"],
              message:
                "You've used your free signups on this machine. " +
                "Run `npx @trusty-squire/mcp pair` (or open the cta_pair_url) to upgrade.",
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
    runStore.set(runId, { service: input.service, startedAt: Date.now(), result: undefined });

    // Start the signup in the background — do NOT await it. runSignupTask
    // never rejects; it writes the final response into runStore, which
    // check_provision_status then reads.
    void runSignupTask(runId, input, {
      apiBase,
      machineToken: session.machine_token,
      alias,
      inboxClient,
      agentSessionToken: session.agent_session_token ?? null,
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
      return {
        status: "running",
        run_id: input.run_id,
        service: record.service,
        elapsed_seconds: Math.round((Date.now() - record.startedAt) / 1000),
        message: "Signup still in progress. Poll again in about 60 seconds.",
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
  // Tier 1 agent-session bearer token, when this machine is paired.
  // Null for Tier 0 (anonymous) installs — no account, no vault.
  agentSessionToken: string | null;
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
      inbox: ctx.inboxClient,
      llm: llmPair,
      // T6/T13: route through the provider's OAuth path when the
      // caller asked for it (Google or GitHub).
      ...(input.oauth_provider !== undefined ? { oauthProvider: input.oauth_provider } : {}),
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

    // Tier 1 (paired) accounts: persist the collected keys into the
    // account's vault. Fire-and-forget — the credentials are already in
    // `response`, so a vault write failure is non-fatal.
    if (
      result.success &&
      result.credentials !== undefined &&
      ctx.agentSessionToken !== null
    ) {
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
  // does not auto-approve — a human must review it.
  if (result.error !== undefined && result.error.startsWith("oauth_consent_needs_review")) {
    return {
      status: "oauth_consent_needs_review",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service}'s Google consent screen needs human review (it asked for more than ` +
        `basic profile access). Tell the user to complete the OAuth signup manually at ` +
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

  // S3: the bot tags "form submitted but no verification email" with a
  // verification_not_sent: error prefix. Surface it as its own status.
  if (result.error !== undefined && result.error.startsWith("verification_not_sent")) {
    return {
      status: "verification_not_sent",
      service: input.service,
      error: result.error,
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message:
        `${input.service}'s form submitted, but no verification email arrived — the service most likely ` +
        `withheld it (anti-abuse) or needs manual signup. Tell the user to finish at ` +
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
