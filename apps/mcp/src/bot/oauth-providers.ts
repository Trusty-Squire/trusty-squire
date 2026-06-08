// oauth-providers.ts — T13. The provider abstraction behind the
// OAuth-first signup flow.
//
// Phase 1 was Google-only (D7). Phase 2 adds GitHub: for a developer
// audience "Sign in with GitHub" is as common as Google. The signup
// flow (agent.ts runOAuthFlow) is identical in shape per provider —
// click the affordance, walk the consent screens, scope-gate them —
// so the per-provider differences are captured in one descriptor:
// how to classify the provider's auth pages and which scopes are
// basic enough to auto-approve.
//
// D7 — the consent gate is provider-aware: Google-OIDC scope vocabulary
// (openid/email/profile) would abort every GitHub signup, and GitHub's
// repo/admin/org scopes must abort. Each provider carries its own
// allowlist.

import {
  classifyGoogleAuthState,
  scopesAreBasic as googleScopesAreBasic,
  extractOAuthScopes,
} from "./google-login.js";

// extractOAuthScopes reads the `scope` query parameter — provider-
// agnostic (Google and GitHub both carry it on the consent URL), so
// the agent imports it from here alongside the provider registry.
export { extractOAuthScopes };

export type OAuthProviderId = "google" | "github";

// The state of a provider's auth page mid-handshake. The shared
// vocabulary across providers — Google's classifier reports the same
// shape via `not_google`, normalized to `not_provider` below.
export type OAuthAuthState =
  | "consent" // a valid session — the provider is asking to authorize the service
  | "needs_login" // session absent/expired — the provider wants credentials
  | "challenge" // 2FA / verify-it's-you — the provider interrupted
  | "not_provider"; // not on the provider's auth pages (flow moved on / completed)

// --- GitHub auth-page classifier (the GitHub analogue of T5) ---------
// After the bot clicks "Sign in with GitHub" the browser lands on a
// github.com page. This classifies which one, so the consent flow
// proceeds ONLY on the authorize screen and otherwise hands back.
// CRITICAL (mirrors the Google guarantee): a `needs_login`/`challenge`
// result means the bot stops and NEVER types into GitHub's form.
export function classifyGitHubAuthState(url: string, bodyText: string): OAuthAuthState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not_provider";
  }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) {
    return "not_provider";
  }
  const path = parsed.pathname.toLowerCase();
  const text = bodyText.toLowerCase();

  // Challenge — 2FA or device verification. Checked first: a 2FA page
  // also sits under /sessions, and GitHub gates a new-app authorize
  // behind it.
  if (
    path.includes("/sessions/two-factor") ||
    path.includes("/sessions/verified-device") ||
    path.includes("/two-factor") ||
    // A GENUINE 2FA interstitial — heading-based ("Verify your two-factor
    // authentication settings"), not a passing mention. The old bare
    // text.includes("two-factor authentication") matched GitHub's plain OAuth
    // /authorize CONSENT screen (its account-security copy mentions 2FA), so a
    // fully signed-in verifier classified consent as `challenge` and bailed
    // needs_login instead of clicking Authorize. These helpers fire only on
    // the real 2FA-settings page (forced wall or dismissible nag).
    isGitHubForced2faVerification(bodyText) ||
    isGitHubDismissible2faSetup(bodyText) ||
    text.includes("verify your device") ||
    text.includes("device verification")
  ) {
    return "challenge";
  }

  // Consent — the OAuth authorize screen OR a GitHub APP install flow.
  // Many services (northflank) use a GitHub App, not plain OAuth: after
  // sign-in GitHub routes to /apps/<app>/installations/select_target (pick
  // which account to install on) → /installations/new (the Install +
  // permissions screen). Reaching these means the SESSION IS VALID and the
  // app just needs installing — classifying them as needs_login (the old
  // default) wrongly aborted a signed-in run and cleared the github marker.
  // The path is the reliable signal; the text fallback catches re-styles.
  if (
    path.includes("/login/oauth/authorize") ||
    /\/apps\/[^/]+\/installations\/(?:select_target|new|permissions)/.test(path) ||
    path.includes("/installations/select_target") ||
    text.includes("wants to access your") ||
    text.includes("by clicking authorize") ||
    (text.includes("install") &&
      (text.includes("on your account") || text.includes("github app")))
  ) {
    return "consent";
  }

  // Everything else on github.com → GitHub wants credentials. Erring
  // toward needs_login is the safe default (mirrors the Google
  // classifier) — it stops the bot rather than risk it proceeding
  // into a page it must not automate.
  return "needs_login";
}

// GitHub's one-time 2FA-sanity-check page is overlaid on the OAuth
// /authorize URL when the user recently (re)configured 2FA on their
// account. Heading: "Verify your two-factor authentication (2FA)
// settings." It has a "skip 2FA verification at this moment" link
// that defers the check to tomorrow — clicking it dismisses the
// overlay and the OAuth handshake continues. This is NOT a real
// security challenge (auth itself is complete; this is a periodic
// nag), but classifyGitHubAuthState above flags it as `challenge`
// because the body text matches "two-factor authentication." The
// agent's OAuth flow uses this helper to distinguish the two and
// auto-skip when possible.
//
// Detection: normalized substring match on the surrounding sentence.
// GitHub renders this with a quirky structure — the dismiss link is
// a <button> containing only "skip 2FA verification", and "at this
// moment, we'll remind you again tomorrow" sits as a sibling text
// node outside the button. textContent preserves the whitespace
// between them, so the raw body has the phrases separated by line
// breaks; we collapse whitespace before the substring check so the
// natural English phrase matches.
//
// Errs toward false-negative (bot aborts as before, operator clicks
// manually) over false-positive (bot clicks the wrong thing on a
// real 2FA challenge).
export function isGitHubDismissible2faSetup(bodyText: string): boolean {
  const text = bodyText.toLowerCase().replace(/\s+/g, " ");
  return (
    text.includes("skip 2fa verification at this moment") ||
    // Defensive: GitHub historically used "skip 2FA verification for
    // now" too. Match both phrasings.
    text.includes("skip 2fa verification for now")
  );
}

// Literal text inside the dismiss <button> on GitHub's 2FA sanity
// page. SHORTER than the full sentence — the surrounding "at this
// moment..." text lives outside the button in a sibling text node,
// so Playwright's text-locator needs the button's own label only.
export const GITHUB_DISMISSIBLE_2FA_SKIP_TEXT = "skip 2FA verification";

// The NON-dismissible escalation of the 2FA-settings wall. Once GitHub
// decides the user "can no longer delay" it drops the skip link and shows
// a "Verify 2FA now" button: heading "Verify your two-factor
// authentication (2FA) settings", body "one-time verification of your
// recently configured 2FA credentials ... you can no longer delay".
//
// Critically, NONE of the bot's clear-paths apply: there is no skip link,
// the device-confirmation email is never sent (auth is already complete —
// this is an account-settings nag), and a phone-tap does nothing. Only the
// operator clicking "Verify 2FA now" in a real browser and completing the
// 2FA flow clears it. The agent uses this to abort the OAuth attempt
// IMMEDIATELY with that instruction, instead of burning the 60s gmail poll
// + 4-min phone-tap wait on a page neither can clear. Conservative: must
// match the heading AND a forced-escalation phrase, so it never fires on
// the dismissible "skip 2FA verification" variant.
export function isGitHubForced2faVerification(bodyText: string): boolean {
  const text = bodyText.toLowerCase().replace(/\s+/g, " ");
  if (!text.includes("verify your two-factor authentication")) return false;
  // If the deferrable skip link is present it's the dismissible nag, NOT
  // the forced wall — let isGitHubDismissible2faSetup's path skip it. The
  // dismissible page also carries "Verify 2FA now" + "one-time
  // verification…", so this exclusion is what keeps the two apart.
  if (text.includes("skip 2fa verification")) return false;
  return (
    text.includes("can no longer delay") ||
    text.includes("verify 2fa now") ||
    text.includes("one-time verification of your recently configured")
  );
}

// --- GitHub consent scope gate ---------------------------------------
// GitHub's scope vocabulary is its own. Basic identity is `read:user`
// and `user:email` (D7). Anything broader — repo, admin:*, write:*,
// delete_repo, org, gist, workflow, notifications — must abort for
// human review: a prompt-injected agent must not be able to grant the
// bot's GitHub a repo-write or org-admin scope.
const GITHUB_BASIC_SCOPES: ReadonlySet<string> = new Set(["read:user", "user:email"]);

// True when EVERY requested scope is basic-identity. Empty list →
// false: no scopes parsed means we cannot confirm, so we do not
// auto-approve (consistent with the Google gate). Exported for tests.
export function githubScopesAreBasic(scopes: readonly string[]): boolean {
  return scopes.length > 0 && scopes.every((s) => GITHUB_BASIC_SCOPES.has(s));
}

// --- provider descriptor ---------------------------------------------
export interface OAuthProvider {
  id: OAuthProviderId;
  label: string; // human name for step logs / messages
  // Words the bot looks for in a "Sign in with <provider>" affordance.
  buttonKeyword: string;
  classifyAuthState(url: string, bodyText: string): OAuthAuthState;
  scopesAreBasic(scopes: readonly string[]): boolean;
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProvider> = {
  google: {
    id: "google",
    label: "Google",
    buttonKeyword: "google",
    classifyAuthState: (url, body) => {
      const state = classifyGoogleAuthState(url, body);
      return state === "not_google" ? "not_provider" : state;
    },
    scopesAreBasic: googleScopesAreBasic,
  },
  github: {
    id: "github",
    label: "GitHub",
    buttonKeyword: "github",
    classifyAuthState: classifyGitHubAuthState,
    scopesAreBasic: githubScopesAreBasic,
  },
};

// Narrow an arbitrary string to a known provider id.
export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return value === "google" || value === "github";
}
