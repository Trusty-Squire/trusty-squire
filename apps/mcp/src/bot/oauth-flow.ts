// oauth-flow.ts — the PURE decision REDUCER for the OAuth/consent phase, carved
// out of runOAuthFlow's ~1450-line state machine (strangler slice 2 — see
// docs/DESIGN-oauth-consent-engine.md). Eng-reviewed (Claude + Codex): an
// action-only function was too thin for a stateful machine, so this models the
// whole decision as a reducer:
//
//     decideOAuthStep(state, observation, deps) → { action, nextState }
//
// Browser-free and exhaustively unit-tested so the security-critical decisions
// (never type into a login form; never blind-approve a non-basic scope) and the
// intricate consent ORDERING are verifiable in isolation.
//
// BOUNDARY: the reducer DECIDES; the executor (agent.ts) does the I/O and owns
// the advance-success bookkeeping. Specifically the executor, not the reducer:
//   • gathers the `observation` (reads the browser: url, scopes, DOM checks),
//   • performs the consent advance (`advanceOAuthConsent`) for advance_consent
//     actions and handles its !advanced micro-logic per `onAdvanceFail`,
//   • flips `consentAlreadyApproved` → true on a SUCCESSFUL advance (the live
//     code only sets it after the advance lands),
//   • owns the hydrate-retry budget (`consentAdvanceWaits`) — pure I/O timing,
//     not a decision,
//   • runs the challenge mechanics, OmniAuth POST, notifications.
// The reducer never touches a browser and only mutates `omniauthPostTried`
// (a POST is "tried" regardless of outcome — a decision-relevant fact).

import type { OAuthProviderId } from "./oauth-providers.js";

// Provider-agnostic auth state, as `provider.classifyAuthState(url, body)`
// returns it. (Google's classifyGoogleAuthState uses "not_google"; the provider
// layer normalizes to "not_provider".)
export type ProviderAuthState = "consent" | "needs_login" | "challenge" | "not_provider";

// The Google "Choose an account" chooser. Its "…to continue to <app>" copy
// matches the consent classifier, but it is an account PICKER, not a scope
// grant — it must be clicked through BEFORE the consent decision runs. The live
// loop gates this on Google (eng-review #8); the executor passes `isChooser`
// already provider-gated, but the helper is exported for that computation.
const ACCOUNT_CHOOSER_URL = /\/(?:accountchooser|chooseaccount|oauthchooseaccount)/i;
export function isAccountChooserUrl(url: string): boolean {
  return ACCOUNT_CHOOSER_URL.test(url);
}

// Loop-carried DECISION state (what the reducer reads + may mutate). I/O-timing
// state (consentAdvanceWaits) lives in the executor, deliberately not here.
export interface OAuthState {
  providerId: OAuthProviderId;
  consentAlreadyApproved: boolean;
  omniauthPostTried: boolean;
  allowBlindOAuthConsent: boolean;
  allowExtraOAuthScopes: readonly string[];
}

// The I/O-gathered facts the executor reads from the browser each loop pass.
export interface OAuthObservation {
  isChooser: boolean; // already provider-gated (Google + chooser URL)
  authState: ProviderAuthState;
  hasLoginForm: boolean; // a live credential field → it's a login form, not consent
  // not_provider: a bare OmniAuth GET-passthru page we could re-POST.
  omniAuthPassthru: boolean;
  // consent scope signals:
  scopes: readonly string[] | null; // extractOAuthScopes(url) — null = opaque part= URL
  dangerPhrases: readonly string[]; // scrapeGoogleScopePhrases(body) — scope-grant verbs
  domBasicFromDom: boolean; // googleConsentIsBasicFromDom(body) — recover #1
  domBasicGis: boolean; // googleGisConsentIsBasic(body) — recover #2
}

export type AdvanceMode = "approve" | "blind" | "soft";
export type OAuthAction =
  | { kind: "click_account_card" }
  // Perform advanceOAuthConsent; on !advanced follow onAdvanceFail:
  //   "abort"        → oauth_consent_needs_review (basic-DOM recover, GIS recover)
  //   "bounded_wait" → retry up to MAX_CONSENT_ADVANCE_WAITS, then abort (blind)
  //   "wait_nav"     → just wait for the page to navigate (post-grant soft-advance)
  | { kind: "advance_consent"; mode: AdvanceMode; onAdvanceFail: "abort" | "bounded_wait" | "wait_nav" }
  | { kind: "recover_omniauth_post" } // re-POST the OmniAuth endpoint, reloop
  | { kind: "settle_left_provider" } // not_provider, no recovery — the live `break`
  | { kind: "handle_challenge" } // verify-it's-you / 2FA / device — mechanics in agent
  | {
      kind: "abort";
      reason: "needs_login" | "oauth_consent_needs_review";
      // Clear the provider's logged-in marker BEFORE aborting so the next signup
      // doesn't optimistically retake OAuth and fail the same way (eng-review #7).
      clearProviderLoggedIn: boolean;
      // Non-basic scopes that tripped a readable-scope review (for the message).
      unauthorizedScopes?: readonly string[];
    };

export interface OAuthStep {
  action: OAuthAction;
  nextState: OAuthState;
}

export interface OAuthDeps {
  // The PROVIDER's basic-scope predicate (provider.scopesAreBasic), NOT the
  // Google-only import (eng-review #1) — so GitHub basic scopes don't regress.
  scopesAreBasic: (scopes: readonly string[]) => boolean;
}

// Decide the next OAuth step. PURE. Mirrors the live loop's branch ORDER exactly
// (the consent ordering is security- and correctness-critical — see the inline
// step numbers against agent.ts).
export function decideOAuthStep(
  state: OAuthState,
  obs: OAuthObservation,
  deps: OAuthDeps,
): OAuthStep {
  const keep = (action: OAuthAction): OAuthStep => ({ action, nextState: state });

  // The account chooser is handled FIRST, before the auth-state branch.
  if (obs.isChooser) return keep({ kind: "click_account_card" });

  switch (obs.authState) {
    case "not_provider":
      // OmniAuth GET-passthru → re-POST once; else the flow left the provider.
      if (obs.omniAuthPassthru && !state.omniauthPostTried) {
        return {
          action: { kind: "recover_omniauth_post" },
          nextState: { ...state, omniauthPostTried: true },
        };
      }
      return keep({ kind: "settle_left_provider" });

    case "challenge":
      return keep({ kind: "handle_challenge" });

    case "needs_login":
      return keep({ kind: "abort", reason: "needs_login", clearProviderLoggedIn: true });

    case "consent": {
      // INVARIANT #1: a live login form on a "consent"-classified page → never
      // type; abort needs_login.
      if (obs.hasLoginForm) {
        return keep({ kind: "abort", reason: "needs_login", clearProviderLoggedIn: true });
      }
      // ── readable scopes (scope gate, invariant #2) ──
      if (obs.scopes !== null) {
        const nonBasic = obs.scopes.filter((s) => !deps.scopesAreBasic([s]));
        const unauthorized = nonBasic.filter((s) => !state.allowExtraOAuthScopes.includes(s));
        if (unauthorized.length > 0) {
          return keep({
            kind: "abort",
            reason: "oauth_consent_needs_review",
            clearProviderLoggedIn: false,
            unauthorizedScopes: unauthorized,
          });
        }
        // basic, or every non-basic scope pre-approved → approve.
        return keep({ kind: "advance_consent", mode: "approve", onAdvanceFail: "abort" });
      }
      // ── scopes unreadable (opaque part= URL) — ORDER MIRRORS agent.ts ──
      // 1. danger scope-grant verb phrases in the DOM → abort (it IS a grant).
      if (obs.dangerPhrases.length > 0) {
        return keep({
          kind: "abort",
          reason: "oauth_consent_needs_review",
          clearProviderLoggedIn: false,
        });
      }
      // 2. basic-only DOM recover (only on the FIRST consent page) [agent.ts:7648].
      if (state.providerId === "google" && !state.consentAlreadyApproved && obs.domBasicFromDom) {
        return keep({ kind: "advance_consent", mode: "approve", onAdvanceFail: "abort" });
      }
      // 3. F16: post-grant page after an earlier approval → soft-advance [7679].
      if (state.consentAlreadyApproved) {
        return keep({ kind: "advance_consent", mode: "soft", onAdvanceFail: "wait_nav" });
      }
      // 4. blind-consent (user delegated) → advance with bounded hydrate retry [7705].
      if (state.allowBlindOAuthConsent) {
        return keep({ kind: "advance_consent", mode: "blind", onAdvanceFail: "bounded_wait" });
      }
      // 5. GIS basic-identity recover (second DOM check) [7742].
      if (obs.domBasicGis) {
        return keep({ kind: "advance_consent", mode: "approve", onAdvanceFail: "abort" });
      }
      // 6. conservative abort — unreadable scopes, no recovery signal [7753].
      return keep({
        kind: "abort",
        reason: "oauth_consent_needs_review",
        clearProviderLoggedIn: false,
      });
    }
  }
}
