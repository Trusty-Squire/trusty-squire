// Universal signup bot - main entry point
// Orchestrates browser + AI agent to sign up for any service

import { randomBytes } from "crypto";
import { BrowserController } from "./browser.js";
import {
  SignupAgent,
  type SignupResult,
  type ExtractFailureUploader,
  type RoundUploader,
  LLMCallBudgetExceeded,
} from "./agent.js";
import type { AgentInbox } from "./agent.js";
import { withOAuthLock } from "./oauth-lock.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import type { LLMClient, LLMPair } from "./llm-client.js";
import { resetCaptureChain } from "./onboarding-capture.js";

export {
  type SignupResult,
  type ExtractFailureUploader,
  type RoundUploader,
  LLMCallBudgetExceeded,
};
export { withOAuthLock } from "./oauth-lock.js";
export { isOAuthProviderId, type OAuthProviderId } from "./oauth-providers.js";
export { BrowserController } from "./browser.js";
export type { CaptchaVariant, CaptchaKind } from "./browser.js";
export { replaySkill, type ReplayOutcome, type ReplayInput } from "./replay-skill.js";
export { InboxClient } from "./inbox-client.js";
export type { AgentInbox };
export { detectAsn, type AsnInfo, type AsnClass } from "./asn.js";
export {
  pickLLMClient,
  pickLLMPair,
  AnthropicDirectClient,
  OpenRouterClient,
  ProxyLLMClient,
  type LLMClient,
  type LLMPair,
  type LLMRequest,
  type LLMResponse,
} from "./llm-client.js";

export interface UniversalSignupRequest {
  service: string;
  signupUrl?: string | undefined;
  email?: string | undefined; // If not provided, generates one
  // Optional inbox for verification — accepts the in-process InboxService
  // or the HTTP InboxClient (both satisfy AgentInbox structurally).
  inbox?: AgentInbox | undefined;
  // Enable human-like browser timing (bezier mouse paths, variable
  // typing delays, post-load dwell). Defaults to true in production
  // because Cloudflare/reCAPTCHA scoring expects it. Disable in tests
  // and debugging runs where you want fast deterministic execution.
  humanize?: boolean | undefined;
  // Optional LLM override. Accepts either:
  //   - LLMClient: a single client; no premium-tier fallback on parse errors
  //   - LLMPair:   primary + optional premium for dual-mode
  // When omitted, the agent picks one from environment (proxy >
  // OpenRouter > Anthropic). Set this when you want explicit control
  // (e.g., from the MCP tool handler that knows the machine token).
  llm?: LLMClient | LLMPair | undefined;
  // OAuth-first signup (T6/T13). When set, the bot prefers the
  // provider's OAuth path — clicking "Sign in with <provider>" and
  // riding the session in the persistent Chrome profile — over
  // form-filling. Google or GitHub. OAuth runs are serialized (T8/D2):
  // they share the one persistent profile, which Chrome single-
  // instances, so a second OAuth run queues behind the first.
  oauthProvider?: OAuthProviderId | undefined;
  // Force the email/password form path even when OAuth is available — so
  // the run hits the form-side captcha (Turnstile/reCAPTCHA-v3) that OAuth
  // bypasses. See SignupTask.forceForm.
  forceForm?: boolean | undefined;
  // Free-text permission/scope hint that flows down to the post-verify
  // planner so it can pick option_text on token-permission dropdowns
  // intentionally. Default (undefined) → "max permissions" guidance.
  scopeHint?: string | undefined;
  // Shared step trail for live progress. Pushed-to by the bot in
  // place — read it from another tool call (check_provision_status)
  // to surface mid-run prompts like Google number-match.
  stepsSink?: string[] | undefined;
  // Extra OAuth scopes the caller has pre-approved beyond the
  // basic-identity allowlist. Surfaces in the consent gate (T7).
  allowExtraOAuthScopes?: readonly string[] | undefined;
  // Blind-approve opaque consent (GitHub Apps; scopes not in URL).
  // DOM danger-phrase scraper still gates.
  allowBlindOAuthConsent?: boolean | undefined;
  // Diagnostic uploader — best-effort. The MCP layer wires this to
  // the registry's POST /v1/extract-failures endpoint so the
  // agent can capture DOM + screenshots when extractCredentials()
  // fails despite the LLM asserting a credential was visible.
  // Undefined in unit tests and in installs that haven't yet paired
  // with an account (no apiClient available).
  extractFailureUploader?: ExtractFailureUploader | undefined;
  // Per-round telemetry uploader (0.6.14-rc.11). Fires on every post-
  // verify round so the registry captures the full DOM + screenshot
  // trail for any stuck run, not just extract failures. Same best-
  // effort contract; same MCP-layer ownership of wiring + account
  // scoping. Undefined in unit tests.
  roundUploader?: RoundUploader | undefined;
  // Machine token + API base for heightened-auth notifications
  // (Google number-match email). The MCP install path keeps the
  // token in session.json and never exports it as env, so the
  // notify call would silently no-op without these. Plumbed by
  // tools/provision-any.ts (rc.13).
  machineToken?: string | undefined;
  apiBase?: string | undefined;
}

export class UniversalSignupBot {
  private generateEmail(): string {
    const random = randomBytes(8).toString("hex");
    return `bot-${random}@trustysquire.ai`;
  }

  private generatePassword(): string {
    // Generate secure random password
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";
    const bytes = randomBytes(16);
    for (const byte of bytes) {
      password += chars[byte % chars.length];
    }
    return password;
  }

  async signup(request: UniversalSignupRequest): Promise<SignupResult> {
    // T8/D2 — OAuth runs all launch Chrome from the one shared
    // persistent profile, which Chrome single-instances. Serialize
    // them so a second concurrent run queues rather than corrupting
    // the profile lock. Form-fill runs are unaffected.
    if (request.oauthProvider !== undefined) {
      return withOAuthLock(() => this.runSession(request));
    }
    return this.runSession(request);
  }

  private async runSession(request: UniversalSignupRequest): Promise<SignupResult> {
    // rc.17 — reset the disk-capture chain state so this signup starts
    // a fresh runId + empty chainHead. Otherwise back-to-back signups
    // in the same bot process share runId and the second one's chain
    // looks up the first one's last hash as prev_hash, failing
    // verifyCaptureChain with prev_hash_mismatch.
    resetCaptureChain();
    // Defaults: humanize=true (production behavior — we want to pass
    // Cloudflare/reCAPTCHA scoring). Tests can pass `humanize: false`
    // to skip the behavior-simulation overhead.
    const browser = new BrowserController({
      humanize: request.humanize ?? true,
    });
    // request.llm is `LLMClient | LLMPair | undefined`; SignupAgent's
    // constructor handles all three shapes.
    const agent = new SignupAgent(browser, request.llm, {
      ...(request.extractFailureUploader !== undefined
        ? { extractFailureUploader: request.extractFailureUploader }
        : {}),
      ...(request.roundUploader !== undefined
        ? { roundUploader: request.roundUploader }
        : {}),
    });

    try {
      await browser.start();

      const email = request.email || this.generateEmail();
      // Logs MUST go to stderr. This module is loaded by the MCP server
      // (apps/mcp), whose stdout is a JSON-RPC stdio transport — any stray
      // bytes there corrupt the framing and the host closes the connection
      // with "Transport closed". stderr is the documented log channel for
      // MCP stdio servers.
      console.error(`[UniversalBot] Signing up for ${request.service}`);
      console.error(`[UniversalBot] Using email: ${email}`);

      const result = await agent.signup({
        service: request.service,
        signupUrl: request.signupUrl,
        email,
        generatePassword: () => this.generatePassword(),
        inbox: request.inbox,
        oauthProvider: request.oauthProvider,
        scopeHint: request.scopeHint,
        stepsSink: request.stepsSink,
        allowExtraOAuthScopes: request.allowExtraOAuthScopes,
        allowBlindOAuthConsent: request.allowBlindOAuthConsent,
        machineToken: request.machineToken,
        apiBase: request.apiBase,
        forceForm: request.forceForm,
      });

      console.error(`[UniversalBot] Result: ${result.success ? "SUCCESS" : "FAILED"}`);
      if (result.success && result.credentials) {
        console.error(`[UniversalBot] Credentials:`, Object.keys(result.credentials));
      }
      if (result.error) {
        console.error(`[UniversalBot] Error: ${result.error}`);
      }

      return result;
    } finally {
      await browser.close();
    }
  }
}

// CLI for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const serviceName = process.argv[2];
  const signupUrl = process.argv[3];

  if (!serviceName) {
    console.error("Usage: node index.js <service-name> [signup-url]");
    process.exit(1);
  }

  const bot = new UniversalSignupBot();
  const result = await bot.signup({
    service: serviceName,
    signupUrl,
  });

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}
