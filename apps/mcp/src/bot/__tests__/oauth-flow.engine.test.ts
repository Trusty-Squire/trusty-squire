// Unit tests for the pure OAuth/consent decision core (strangler slice 2 —
// docs/DESIGN-oauth-consent-engine.md). Browser-free: state in, decision out.
// The security invariants (never type into a login form; never blind-approve a
// non-basic scope) are pinned here so a future wiring step can't quietly break
// them.

import { describe, expect, it } from "vitest";
import {
  isAccountChooser,
  planConsentDecision,
  planOAuthAction,
  type ProviderAuthState,
} from "../oauth-flow.js";

describe("isAccountChooser", () => {
  it("matches Google's account-chooser URLs", () => {
    expect(isAccountChooser("https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount?x=1")).toBe(true);
    expect(isAccountChooser("https://accounts.google.com/AccountChooser?continue=x")).toBe(true);
    expect(isAccountChooser("https://accounts.google.com/signin/oauth/chooseaccount?y")).toBe(true);
  });
  it("does NOT match consent / auth / service URLs", () => {
    expect(isAccountChooser("https://accounts.google.com/signin/oauth/consent?x")).toBe(false);
    expect(isAccountChooser("https://accounts.google.com/signin/oauth/id?authuser=0")).toBe(false);
    expect(isAccountChooser("https://app.service.com/dashboard")).toBe(false);
  });
});

describe("planConsentDecision (the scope gate — invariant #2)", () => {
  it("approves a basic openid/email/profile grant", () => {
    expect(planConsentDecision({ scopes: ["openid", "email", "profile"], dangerPhrases: [], domLooksBasic: false })).toBe("approve");
  });
  it("holds a non-basic scope for review (never blind-approve)", () => {
    expect(planConsentDecision({ scopes: ["openid", "https://www.googleapis.com/auth/drive"], dangerPhrases: [], domLooksBasic: false })).toBe("needs_review");
  });
  it("scopes unreadable + DOM shows scope-grant phrases → review (it IS a grant)", () => {
    expect(planConsentDecision({ scopes: null, dangerPhrases: ["See, edit, and delete your Google Drive files"], domLooksBasic: false })).toBe("needs_review");
  });
  it("scopes unreadable + DOM lists only basic grants → approve (recover the happy path)", () => {
    expect(planConsentDecision({ scopes: null, dangerPhrases: [], domLooksBasic: true })).toBe("approve");
  });
  it("scopes unreadable + ambiguous (no danger, not clearly basic) → conservative review", () => {
    expect(planConsentDecision({ scopes: null, dangerPhrases: [], domLooksBasic: false })).toBe("needs_review");
  });
});

describe("planOAuthAction (state → action)", () => {
  const base = { isChooser: false, omniAuthRecoverable: false, hasLoginForm: false, consent: "approve" as const };

  it("account chooser is handled first, before any auth-state branch", () => {
    // Even on a 'consent'-classified URL, the chooser flag wins.
    expect(planOAuthAction({ ...base, authState: "consent", isChooser: true })).toEqual({ kind: "click_account_card" });
  });

  it("INVARIANT #1: a consent page carrying a live login form → abort needs_login (never type)", () => {
    expect(planOAuthAction({ ...base, authState: "consent", hasLoginForm: true })).toEqual({ kind: "abort", reason: "needs_login" });
  });

  it("basic-scope consent → approve", () => {
    expect(planOAuthAction({ ...base, authState: "consent", consent: "approve" })).toEqual({ kind: "approve_consent" });
  });
  it("review-verdict consent → abort oauth_consent_needs_review", () => {
    expect(planOAuthAction({ ...base, authState: "consent", consent: "needs_review" })).toEqual({ kind: "abort", reason: "oauth_consent_needs_review" });
  });

  it("needs_login → abort needs_login", () => {
    expect(planOAuthAction({ ...base, authState: "needs_login" })).toEqual({ kind: "abort", reason: "needs_login" });
  });
  it("challenge → handle_challenge (I/O happens in agent)", () => {
    expect(planOAuthAction({ ...base, authState: "challenge" })).toEqual({ kind: "handle_challenge" });
  });

  it("not_provider with a recoverable OmniAuth passthru → recover_omniauth_post", () => {
    expect(planOAuthAction({ ...base, authState: "not_provider", omniAuthRecoverable: true })).toEqual({ kind: "recover_omniauth_post" });
  });
  it("not_provider with nothing to recover → leave_provider", () => {
    expect(planOAuthAction({ ...base, authState: "not_provider", omniAuthRecoverable: false })).toEqual({ kind: "leave_provider" });
  });

  it("covers every ProviderAuthState (no silent fallthrough)", () => {
    const states: ProviderAuthState[] = ["consent", "needs_login", "challenge", "not_provider"];
    for (const s of states) {
      expect(planOAuthAction({ ...base, authState: s })).toBeDefined();
    }
  });
});
