// Unit tests for the pure OAuth/consent decision REDUCER (strangler slice 2 —
// docs/DESIGN-oauth-consent-engine.md). Browser-free: (state, observation) in,
// (action, nextState) out. Pins the security invariants (never type into a login
// form; never blind-approve a non-basic scope), the consent ORDERING (F16), and
// each of the 8 fidelity gaps the eng review surfaced.

import { describe, expect, it } from "vitest";
import {
  decideOAuthStep,
  isAccountChooserUrl,
  type OAuthDeps,
  type OAuthObservation,
  type OAuthState,
} from "../oauth-flow.js";

// google's basic-scope predicate, good enough for tests: openid/email/profile.
const googleBasic = (scopes: readonly string[]): boolean =>
  scopes.every((s) => /(^openid$)|email|profile/.test(s));
const deps: OAuthDeps = { scopesAreBasic: googleBasic };

const state = (over: Partial<OAuthState> = {}): OAuthState => ({
  providerId: "google",
  consentAlreadyApproved: false,
  omniauthPostTried: false,
  allowBlindOAuthConsent: false,
  allowExtraOAuthScopes: [],
  ...over,
});
const obs = (over: Partial<OAuthObservation> = {}): OAuthObservation => ({
  isChooser: false,
  authState: "consent",
  hasLoginForm: false,
  omniAuthPassthru: false,
  scopes: null,
  dangerPhrases: [],
  domBasicFromDom: false,
  domBasicGis: false,
  ...over,
});

describe("isAccountChooserUrl", () => {
  it("matches chooser URLs, not consent/auth", () => {
    expect(isAccountChooserUrl("https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount?x")).toBe(true);
    expect(isAccountChooserUrl("https://accounts.google.com/AccountChooser")).toBe(true);
    expect(isAccountChooserUrl("https://accounts.google.com/signin/oauth/consent?x")).toBe(false);
  });
});

describe("decideOAuthStep — non-consent states", () => {
  it("chooser is handled first, before the auth-state branch", () => {
    const { action } = decideOAuthStep(state(), obs({ isChooser: true, authState: "consent" }), deps);
    expect(action).toEqual({ kind: "click_account_card" });
  });

  it("not_provider + fresh OmniAuth passthru → re-POST, marks omniauthPostTried", () => {
    const { action, nextState } = decideOAuthStep(state(), obs({ authState: "not_provider", omniAuthPassthru: true }), deps);
    expect(action).toEqual({ kind: "recover_omniauth_post" });
    expect(nextState.omniauthPostTried).toBe(true);
  });
  it("not_provider + passthru already tried → settle_left_provider (the live `break`, NOT terminal)", () => {
    const { action } = decideOAuthStep(state({ omniauthPostTried: true }), obs({ authState: "not_provider", omniAuthPassthru: true }), deps);
    expect(action).toEqual({ kind: "settle_left_provider" });
  });
  it("not_provider, no passthru → settle_left_provider", () => {
    const { action } = decideOAuthStep(state(), obs({ authState: "not_provider" }), deps);
    expect(action).toEqual({ kind: "settle_left_provider" });
  });

  it("challenge → handle_challenge", () => {
    expect(decideOAuthStep(state(), obs({ authState: "challenge" }), deps).action).toEqual({ kind: "handle_challenge" });
  });

  it("needs_login → abort needs_login WITH clearProviderLoggedIn (gap #7)", () => {
    expect(decideOAuthStep(state(), obs({ authState: "needs_login" }), deps).action).toEqual({
      kind: "abort", reason: "needs_login", clearProviderLoggedIn: true,
    });
  });
});

describe("decideOAuthStep — INVARIANT #1 (never type into a login form)", () => {
  it("consent page carrying a live login form → abort needs_login (clears marker)", () => {
    expect(decideOAuthStep(state(), obs({ authState: "consent", hasLoginForm: true }), deps).action).toEqual({
      kind: "abort", reason: "needs_login", clearProviderLoggedIn: true,
    });
  });
});

describe("decideOAuthStep — readable-scope gate (invariant #2)", () => {
  it("basic scopes → approve", () => {
    expect(decideOAuthStep(state(), obs({ scopes: ["openid", "email", "profile"] }), deps).action).toEqual({
      kind: "advance_consent", mode: "approve", onAdvanceFail: "abort",
    });
  });
  it("unauthorized non-basic scope → abort review, names the scope", () => {
    const { action } = decideOAuthStep(state(), obs({ scopes: ["openid", "https://www.googleapis.com/auth/drive"] }), deps);
    expect(action).toEqual({
      kind: "abort", reason: "oauth_consent_needs_review", clearProviderLoggedIn: false,
      unauthorizedScopes: ["https://www.googleapis.com/auth/drive"],
    });
  });
  it("GAP #2: a non-basic scope the user PRE-APPROVED (allowExtraOAuthScopes) → approve", () => {
    const drive = "https://www.googleapis.com/auth/drive";
    const { action } = decideOAuthStep(state({ allowExtraOAuthScopes: [drive] }), obs({ scopes: ["openid", drive] }), deps);
    expect(action).toEqual({ kind: "advance_consent", mode: "approve", onAdvanceFail: "abort" });
  });
  it("GAP #1: provider-aware predicate — GitHub basic scopes approve (not the Google-only import)", () => {
    const ghDeps: OAuthDeps = { scopesAreBasic: (s) => s.every((x) => ["read:user", "user:email"].includes(x)) };
    const { action } = decideOAuthStep(state({ providerId: "github" }), obs({ scopes: ["read:user", "user:email"] }), ghDeps);
    expect(action).toEqual({ kind: "advance_consent", mode: "approve", onAdvanceFail: "abort" });
  });
});

describe("decideOAuthStep — unreadable-scope ordering (mirrors agent.ts; F16)", () => {
  it("1. danger phrases → abort review (checked first)", () => {
    expect(decideOAuthStep(state(), obs({ scopes: null, dangerPhrases: ["See and download your Drive files"] }), deps).action).toMatchObject({
      kind: "abort", reason: "oauth_consent_needs_review",
    });
  });
  it("2. google + first page + basic-from-DOM → approve recover", () => {
    expect(decideOAuthStep(state(), obs({ scopes: null, domBasicFromDom: true }), deps).action).toEqual({
      kind: "advance_consent", mode: "approve", onAdvanceFail: "abort",
    });
  });
  it("2-guard: basic-from-DOM does NOT fire once consentAlreadyApproved (defers to soft-advance)", () => {
    const { action } = decideOAuthStep(state({ consentAlreadyApproved: true }), obs({ scopes: null, domBasicFromDom: true }), deps);
    expect(action).toEqual({ kind: "advance_consent", mode: "soft", onAdvanceFail: "wait_nav" });
  });
  it("3. F16: consentAlreadyApproved → soft-advance, AND it wins over blind + GIS", () => {
    const { action } = decideOAuthStep(
      state({ consentAlreadyApproved: true, allowBlindOAuthConsent: true }),
      obs({ scopes: null, domBasicGis: true }),
      deps,
    );
    expect(action).toEqual({ kind: "advance_consent", mode: "soft", onAdvanceFail: "wait_nav" });
  });
  it("4. GAP #3: blind consent → blind advance with bounded hydrate retry", () => {
    expect(decideOAuthStep(state({ allowBlindOAuthConsent: true }), obs({ scopes: null }), deps).action).toEqual({
      kind: "advance_consent", mode: "blind", onAdvanceFail: "bounded_wait",
    });
  });
  it("5. GIS basic-identity recover (second DOM check, distinct from #2)", () => {
    expect(decideOAuthStep(state(), obs({ scopes: null, domBasicGis: true }), deps).action).toEqual({
      kind: "advance_consent", mode: "approve", onAdvanceFail: "abort",
    });
  });
  it("6. nothing recovers → conservative abort review", () => {
    expect(decideOAuthStep(state(), obs({ scopes: null }), deps).action).toEqual({
      kind: "abort", reason: "oauth_consent_needs_review", clearProviderLoggedIn: false,
    });
  });
});

describe("decideOAuthStep — covers every ProviderAuthState", () => {
  it("no silent fallthrough", () => {
    for (const s of ["consent", "needs_login", "challenge", "not_provider"] as const) {
      expect(decideOAuthStep(state(), obs({ authState: s }), deps).action).toBeDefined();
    }
  });
});
