// Universal signup bot - main entry point
// Orchestrates browser + AI agent to sign up for any service

import { randomBytes } from "crypto";
import { BrowserController } from "./browser.js";
import { humanLocalPart } from "./inbox-client.js";
import {
  SignupAgent,
  type SignupResult,
  type ExtractFailureUploader,
  type RoundUploader,
  LLMCallBudgetExceeded,
} from "./agent.js";
import type { AgentInbox } from "./agent.js";
import { withSignupLock } from "./signup-lock.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import type { LLMClient, LLMPair } from "./llm-client.js";
import {
  capturedAnyRoundForService,
  captureRunOutcome,
  resetCaptureChain,
} from "./onboarding-capture.js";
import { classifyFailureStage } from "./failure-stage.js";
import { classifyUnwinnable } from "./unwinnable-services.js";

export {
  type SignupResult,
  type ExtractFailureUploader,
  type RoundUploader,
  LLMCallBudgetExceeded,
};
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
  // Explicit install consent for polling the operator's inbox for matching
  // OTP/device-confirmation messages. Missing/false means do not poll.
  allowOperatorInboxOtp?: boolean | undefined;
  // Verify-fleet identity binding. When the housekeeper runs a fresh-signup
  // verification AS a specific robot identity, these route the run through that
  // identity's Chrome profile (its logged-in Google session) and its egress —
  // so the bot signs up as a genuinely fresh user instead of the shared
  // returning-user profile. Omitted → the default shared profile + env proxy.
  profileDir?: string | undefined;
  proxyUrl?: string | undefined;
  // The Google account the bot should sign up AS, when its Chrome profile holds
  // more than one. Google's account chooser ("Choose an account") otherwise
  // gets the first card blindly — wrong identity on a multi-account profile.
  // With this set, the chooser picks the card whose email matches. Single-
  // account profiles (the common end-user install) ignore it — one card, no
  // ambiguity. fresh-verify passes the robot's own identity email.
  oauthAccountEmail?: string | undefined;
}

export class UniversalSignupBot {
  private generateEmail(): string {
    // Human-looking personal address — never a `bot-…`/service-named local
    // part (an obvious signup-form bot tell). Shared with the inbox-alias
    // generator. Only a fallback: discover/CLI pass an explicit inbox alias.
    return `${humanLocalPart()}@trustysquire.ai`;
  }

  private generatePassword(): string {
    // Password policies vary wildly, and several SaaS forms reject "random
    // enough" strings unless they visibly contain multiple classes. Keep the
    // shape boring and policy-safe: upper/lower/digits plus common symbols,
    // with extra hex entropy for uniqueness. Avoid punctuation like '&'/'%'
    // that some forms mishandle in controlled inputs or backend validators.
    return `Tq9!vR4#zLm82@XpQ7-${randomBytes(6).toString("hex")}`;
  }

  async signup(request: UniversalSignupRequest): Promise<SignupResult> {
    // Every signup run (OAuth AND form-fill) launches Chrome from the ONE
    // shared persistent profile, which Chrome single-instances — so they must
    // serialize. withSignupLock is the explicit CROSS-process locked queue:
    // it queues same-process callers, serializes across processes via a file
    // lock that RECLAIMS a dead/hung holder, and arms a watchdog that
    // hard-exits a run overrunning the hold cap — so a stuck run can never
    // accumulate as a lock-starving orphan (the 2026-06-12 failure: ~26
    // hung discover processes). Subsumes the in-process-only withOAuthLock.
    const label = `${request.service}:${request.oauthProvider ?? "form"}`;
    return withSignupLock(label, () => this.runSession(request));
  }

  private async runSession(request: UniversalSignupRequest): Promise<SignupResult> {
    // AB6 — short-circuit known-unwinnable services BEFORE launching Chrome.
    // A 0% prospect (SPA won't automate, max anti-bot, human SMS/TOTP/card gate)
    // wastes ~6min + LLM calls per run for nothing. Route it to manual with a
    // clear reason. Override for a deliberate re-test with
    // UNIVERSAL_BOT_FORCE_UNWINNABLE=1.
    const manual = classifyUnwinnable(request.service);
    if (manual !== null && process.env.UNIVERSAL_BOT_FORCE_UNWINNABLE !== "1") {
      console.error(
        `[UniversalBot] ${request.service}: known manual-only signup (${manual.gate}) — skipping bot run`,
      );
      return {
        success: false,
        error: `manual_signup_required: ${manual.reason}`,
        failure_stage: "manual",
        steps: [
          `${request.service}: routed to manual (${manual.gate}) — ${manual.reason} ` +
            `[set UNIVERSAL_BOT_FORCE_UNWINNABLE=1 to attempt anyway]`,
        ],
      };
    }
    // rc.17 — reset the disk-capture chain state so this signup starts
    // a fresh runId + empty chainHead. Otherwise back-to-back signups
    // in the same bot process share runId and the second one's chain
    // looks up the first one's last hash as prev_hash, failing
    // verifyCaptureChain with prev_hash_mismatch.
    resetCaptureChain(request.service);
    // Defaults: humanize=true (production behavior — we want to pass
    // Cloudflare/reCAPTCHA scoring). Tests can pass `humanize: false`
    // to skip the behavior-simulation overhead.
    const browser = new BrowserController({
      humanize: request.humanize ?? true,
      // Verify-fleet identity binding (per-identity profile + egress); omitted
      // fields fall back to the shared profile + env proxy.
      ...(request.profileDir !== undefined ? { profileDir: request.profileDir } : {}),
      ...(request.proxyUrl !== undefined ? { proxyUrl: request.proxyUrl } : {}),
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
        allowOperatorInboxOtp: request.allowOperatorInboxOtp,
        forceForm: request.forceForm,
        oauthAccountEmail: request.oauthAccountEmail,
      });

      console.error(`[UniversalBot] Result: ${result.success ? "SUCCESS" : "FAILED"}`);
      if (result.success && result.credentials) {
        console.error(`[UniversalBot] Credentials:`, Object.keys(result.credentials));
      }
      if (result.error) {
        console.error(`[UniversalBot] Error: ${result.error}`);
      }

      // B1 — tag the structured terminal stage onto the result so telemetry
      // and the outcome sidecar share one value (the flakiness histogram is
      // built from it). reachedOnboarding = did any post-verify round capture.
      result.failure_stage = classifyFailureStage(
        result,
        capturedAnyRoundForService(request.service),
      );

      // A2 — write the run-outcome sidecar next to this run's captured
      // rounds so the offline eval (A3) can label them: rounds from a
      // successful run are good next-step examples; rounds from a failed
      // one feed the reject list. No-op when capture is off or no rounds
      // were captured. Best-effort — never fails the signup.
      captureRunOutcome(request.service, result);

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
