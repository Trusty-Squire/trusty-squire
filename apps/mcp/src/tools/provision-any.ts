// provision_any — universal signup bot for any free API service.
//
// Runs the browser on the user's machine (their IP, their fingerprint).
// Aliases + inbox live on Trusty Squire's API so the SES forwarding
// pipeline (see apps/api/src/routes/ses-webhook.ts) can deliver
// verification emails.
//
// Auth model: Tier 0 machine token from the session file. No account or
// mandate required for free-tier signups. When the user hits their quota
// the API returns a structured quota_exceeded response and we tell Claude
// to surface a pairing CTA.

import { z } from "zod";
import {
  UniversalSignupBot,
  InboxClient,
  ProxyLLMClient,
  detectAsn,
  type LLMPair,
} from "../bot/index.js";
import { openSessionStorage } from "../session.js";
import type { ApiClient } from "../api-client.js";

export const provisionAnyInputSchema = z.object({
  service: z.string().describe("Name of the service to sign up for (e.g., 'Postmark', 'Mailgun')"),
  signup_url: z.string().optional().describe("Direct URL to signup page (optional, will search if not provided)"),
});

export type ProvisionAnyInput = z.infer<typeof provisionAnyInputSchema>;

// JSON Schema for MCP `tools/list`. The SDK forwards `inputSchema` verbatim
// to the host agent (Claude Code, Goose, etc.); a zod object stringifies to
// `{}` and leaves the LLM blind to required parameters. The schema here
// must mirror `provisionAnyInputSchema` above.
const PROVISION_ANY_JSON_SCHEMA = {
  type: "object",
  required: ["service"],
  properties: {
    service: {
      type: "string",
      description: "Name of the service to sign up for (e.g., 'Postmark', 'Mailgun', 'IPInfo')",
    },
    signup_url: {
      type: "string",
      description: "Direct URL to the service's signup page. Optional — the bot will navigate from the service name if omitted.",
    },
  },
} as const;

const DESCRIPTION = `Sign up for any free API service automatically using browser automation.

WHEN TO CALL THIS TOOL:
- The user wants an account for a service Trusty Squire doesn't have a native adapter for
- Call list_services first; if the service ISN'T in the directory, use this tool
- Best for free-tier developer services with traditional email/password signup

BEHAVIOR:
- Runs Playwright on the user's machine (uses their IP for captcha resilience)
- Receives verification emails via Trusty Squire's SES inbound infrastructure
- Returns API credentials directly on success
- Free for the first N signups per machine (Tier 0); after that, returns a
  pairing CTA the user clicks to upgrade

POSSIBLE RESPONSES:
- status="success" + credentials → use them immediately
- status="quota_exceeded" + cta_pair_url → tell the user to run \`npx @trusty-squire/mcp pair\`
  or open the URL to upgrade. Their next signup will work.
- status="captcha_blocked" → the signup site uses captcha we can't bypass. Tell the user
  to sign up manually at the service's signup URL.
- status="failed" → the form filled but submission didn't yield credentials. Show steps[].`;

export const provisionAnyTool = {
  name: "provision_any_service",
  description: DESCRIPTION,
  jsonInputSchema: PROVISION_ANY_JSON_SCHEMA,
  inputSchema: provisionAnyInputSchema,
  handler: async (input: ProvisionAnyInput, _api: ApiClient | null) => {
    // Pull the machine token from session storage. The install CLI writes it.
    const storage = await openSessionStorage();
    const session = await storage.read();
    if (session === null || session.machine_token === undefined) {
      // Production users hit this when they've never run the install CLI.
      // Local-dev users hit this if their session.json only has an
      // agent_session_token (Tier 1 pair without a machine_token issued).
      // Surface both paths so the agent can route the user correctly.
      const hasPartialSession = session !== null && session.agent_session_token !== undefined;
      return {
        status: "not_installed",
        message: hasPartialSession
          ? "This machine is paired (Tier 1) but has no Tier 0 machine_token, which provision_any_service requires. Run `node /home/chode/trusty-squire/apps/mcp/dist/install/cli.js install --target=goose` to issue one, or in production run `npx @trusty-squire/mcp install`."
          : "Trusty Squire isn't installed on this machine. In production run `npx @trusty-squire/mcp install`. For local dev against this repo run `node /home/chode/trusty-squire/apps/mcp/dist/install/cli.js install --target=goose`.",
      };
    }
    const apiBase = session.api_base_url;

    // Create an alias through the API (consumes one quota slot for Tier 0).
    const inboxClient = new InboxClient({
      baseUrl: apiBase,
      apiKey: session.machine_token,
    });

    const runId = `mcp-${Date.now().toString(36)}`;
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
      // The createAlias error body has the structured payload; parse it back.
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

    // Construct an LLMPair that routes through Trusty Squire's proxy.
    // The user pays nothing for LLM calls — the operator's OpenRouter
    // key handles them server-side, gated by the machine token's
    // rolling rate limit. Cheap mode (Gemini Flash) is the primary;
    // Sonnet is the parse-failure fallback.
    const llmPair: LLMPair = {
      primary: new ProxyLLMClient({
        apiBaseUrl: apiBase,
        machineToken: session.machine_token,
        tier: "cheap",
      }),
      premium: new ProxyLLMClient({
        apiBaseUrl: apiBase,
        machineToken: session.machine_token,
        tier: "premium",
      }),
    };

    // Run the bot locally with this alias. Bot uses the inboxClient to long-
    // poll the API for any verification emails that arrive via SES.
    const bot = new UniversalSignupBot();
    const result = await bot.signup({
      service: input.service,
      ...(input.signup_url !== undefined ? { signupUrl: input.signup_url } : {}),
      email: alias,
      inbox: inboxClient,
      llm: llmPair,
    });

    // Best-effort cleanup of the alias once we're done with it. Failure is
    // non-fatal — the alias TTL-expires anyway.
    try {
      await inboxClient.revokeAlias(alias);
    } catch {
      // noop
    }

    // If a captcha was encountered (whether or not we got past it),
    // report it to the API for the analytics ledger. The result.captcha
    // field is set by the agent's pre/post-submit/re-plan gates. We do
    // a fresh asn lookup at event time rather than relying on the
    // install-time one — users move networks, and "where was the
    // machine when this happened" is the analytically interesting bit.
    if (result.captcha !== undefined) {
      // Fire-and-forget; we don't want the captcha-event POST to
      // affect what the user sees. Failures here are logged to stderr
      // and otherwise ignored.
      void postCaptchaEvent(apiBase, session.machine_token, {
        service: input.service,
        captcha_kind: result.captcha.kind,
        blocked: result.captcha.blocked,
        proxied: result.proxied ?? false,
      });
    }

    if (result.success && result.credentials !== undefined) {
      return {
        status: "success",
        service: input.service,
        credentials: result.credentials,
        steps: result.steps,
        message: `Successfully signed up for ${input.service}. Credentials are in this response — show them to the user (or save to their .env).`,
      };
    }

    // Authoritative: if the agent recorded a captcha encounter and
    // marked it blocked, that's a captcha_blocked outcome. Replaces
    // the earlier substring heuristic which had to scan steps[].
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

    return {
      status: "failed",
      service: input.service,
      error: result.error ?? "Unknown error",
      steps: result.steps,
      browser_channel: result.browser_channel ?? null,
      message: `Couldn't finish signing up for ${input.service}. Show the user the steps[] for debugging.`,
    };
  },
};

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
  },
): Promise<void> {
  try {
    const asn = await detectAsn();
    const body = {
      service: event.service,
      captcha_kind: event.captcha_kind,
      blocked: event.blocked,
      proxied: event.proxied,
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
