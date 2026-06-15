// oauth-flow.ts — the PURE decision core of the OAuth/consent phase, carved out
// of runOAuthFlow's 1450-line state machine (strangler slice 2 — see
// docs/DESIGN-oauth-consent-engine.md). Browser-free and exhaustively unit-
// tested so the security-critical decisions (the consent scope gate, the
// never-type-into-a-login-form guarantee) are verifiable in isolation.
//
// This module is DECISION ONLY. The I/O — clicking affordances, the account
// chooser, challenge handling (number-match / 2FA / device / operator-tap),
// OmniAuth POST recovery, notifications — stays in agent.ts, which calls these
// planners and executes their verdict. Extract first; wire behind a flag later
// (DESIGN migration step 2). Not yet wired: changing this file cannot regress
// the live OAuth path.

import { scopesAreBasic } from "./google-login.js";

// Provider-agnostic auth state, as `provider.classifyAuthState(url, body)`
// returns it. (Google's classifyGoogleAuthState uses "not_google"; the provider
// layer normalizes to "not_provider".)
export type ProviderAuthState = "consent" | "needs_login" | "challenge" | "not_provider";

// The Google "Choose an account" chooser. Its "…to continue to <app>" copy
// matches the consent classifier, but it is an account PICKER, not a scope
// grant — it must be clicked through BEFORE the consent decision runs. Pure.
const ACCOUNT_CHOOSER_URL = /\/(?:accountchooser|chooseaccount|oauthchooseaccount)/i;
export function isAccountChooser(url: string): boolean {
  return ACCOUNT_CHOOSER_URL.test(url);
}

// ── The consent scope gate (security invariant #2) ─────────────────────────
// Decide whether a consent screen may be auto-approved. Auto-approve ONLY a
// basic (openid/email/profile-family) grant; anything non-basic or ambiguous is
// held for manual review — never blind-approve a dangerous scope.
//
//   scopes parsed:
//     basic     → approve
//     non-basic → needs_review
//   scopes === null (Google's opaque part= consent URL hides scope=):
//     DOM lists scope-grant verb phrases → needs_review (it IS a real grant)
//     DOM lists only basic grants        → approve (recover the happy path)
//     otherwise (ambiguous)              → needs_review (conservative default)
export type ConsentDecision = "approve" | "needs_review";
export function planConsentDecision(input: {
  scopes: readonly string[] | null;
  dangerPhrases: readonly string[]; // scrapeGoogleScopePhrases(body) result
  domLooksBasic: boolean; // DOM lists ONLY openid/email/profile grants
}): ConsentDecision {
  if (input.scopes !== null) {
    return scopesAreBasic(input.scopes) ? "approve" : "needs_review";
  }
  if (input.dangerPhrases.length > 0) return "needs_review";
  if (input.domLooksBasic) return "approve";
  return "needs_review";
}

// ── The high-level state→action map ────────────────────────────────────────
export type OAuthAction =
  | { kind: "click_account_card" } // the chooser — pick the account, reloop
  | { kind: "approve_consent" } // basic-scope consent — advance
  | { kind: "handle_challenge" } // verify-it's-you / 2FA / device — I/O in agent
  | { kind: "recover_omniauth_post" } // OmniAuth GET-passthru — re-POST, reloop
  | { kind: "leave_provider" } // not_provider, no recovery — back on the service
  | { kind: "abort"; reason: "needs_login" | "oauth_consent_needs_review" };

// Map the current page to the next high-level OAuth action. PURE. The chooser is
// checked first (it precedes the auth-state classification in the live loop);
// the login-form backstop enforces invariant #1 (never type into a login form)
// even when the text classifier called it a consent page.
export function planOAuthAction(input: {
  authState: ProviderAuthState;
  isChooser: boolean;
  // not_provider only: a bare OmniAuth GET-passthru page we can re-POST, and
  // whether we still have a recovery attempt left (token present, not yet tried).
  omniAuthRecoverable: boolean;
  // consent only: a credential field is live in the DOM → it's really a login
  // form, not a consent screen → abort needs_login (never type).
  hasLoginForm: boolean;
  // consent only: the verdict from planConsentDecision.
  consent: ConsentDecision;
}): OAuthAction {
  if (input.isChooser) return { kind: "click_account_card" };
  switch (input.authState) {
    case "not_provider":
      return input.omniAuthRecoverable
        ? { kind: "recover_omniauth_post" }
        : { kind: "leave_provider" };
    case "challenge":
      return { kind: "handle_challenge" };
    case "needs_login":
      return { kind: "abort", reason: "needs_login" };
    case "consent":
      if (input.hasLoginForm) return { kind: "abort", reason: "needs_login" };
      return input.consent === "approve"
        ? { kind: "approve_consent" }
        : { kind: "abort", reason: "oauth_consent_needs_review" };
  }
}
