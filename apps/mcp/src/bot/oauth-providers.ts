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
    text.includes("two-factor authentication") ||
    text.includes("verify your device") ||
    text.includes("device verification")
  ) {
    return "challenge";
  }

  // Consent — the OAuth authorize screen. The path is the reliable
  // signal; the text fallback catches a re-styled page.
  if (
    path.includes("/login/oauth/authorize") ||
    text.includes("wants to access your") ||
    text.includes("by clicking authorize")
  ) {
    return "consent";
  }

  // Everything else on github.com → GitHub wants credentials. Erring
  // toward needs_login is the safe default (mirrors the Google
  // classifier) — it stops the bot rather than risk it proceeding
  // into a page it must not automate.
  return "needs_login";
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
