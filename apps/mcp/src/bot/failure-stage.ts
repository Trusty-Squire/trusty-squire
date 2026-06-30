// failure-stage.ts — the canonical terminal-failure taxonomy
// (docs/ARCHITECTURE.md, B1). One classifier, one enum,
// used by the A2 run-outcome sidecar AND any telemetry sink, so the stage
// labels can't drift across call sites.
//
// The point (Workstream B is flakiness-first): bucket every terminal failure
// into exactly ONE stage so a K×M batch yields a per-stage histogram — the
// "where is the noise" map — instead of a pile of free-text error strings.

export type FailureStage =
  // terminal success
  | "none"
  // — the flakiness taxonomy (B1) —
  | "oauth_handshake" // OAuth flow / SSO callback failed
  | "account_chooser" // Google account-chooser step
  | "consent" // OAuth consent / scope-grant screen
  | "proxy_timeout" // residential-proxy / egress timeout
  | "hydration" // SPA didn't hydrate in time (Clerk/Stytch/etc.)
  | "planner_loop" // planner stalled: no plan, max rounds, stuck nav, submit no-op
  | "extract" // reached the key page but couldn't extract a credential
  | "verify_email" // email-verification / OTP gate
  | "run_timeout" // overall run budget exhausted
  // — walls + gates that aren't navigation flakiness, kept distinct so the
  //   histogram doesn't lump them into the noise we're trying to measure —
  | "captcha"
  | "anti_bot"
  | "phone"
  | "payment"
  // deliberately not attempted — a known-unwinnable service routed to manual (AB6)
  | "manual"
  // — pre-onboarding generic form failure / unmapped —
  | "form"
  | "other";

// Every FailureStage value — handy for tests + the aggregator's stable
// histogram ordering.
export const ALL_FAILURE_STAGES: readonly FailureStage[] = [
  "none",
  "oauth_handshake",
  "account_chooser",
  "consent",
  "proxy_timeout",
  "hydration",
  "planner_loop",
  "extract",
  "verify_email",
  "run_timeout",
  "captcha",
  "anti_bot",
  "phone",
  "payment",
  "manual",
  "form",
  "other",
];

// The minimal slice of a finished run the classifier reads. Kept local (not
// Pick<SignupResult>) so this module has no dependency on agent.ts — both the
// outcome sidecar and agent.ts can import the stage type without a cycle.
export interface FailureSignal {
  success: boolean;
  error?: string;
  captcha?: { blocked: boolean };
}

// Total function: every (result, reachedOnboarding) maps to exactly one
// stage. `reachedOnboarding` is true when the run captured at least one
// post-verify round — it disambiguates a pre-onboarding form bail from a
// navigation-loop stall when the error string alone is generic.
export function classifyFailureStage(
  result: FailureSignal,
  reachedOnboarding: boolean,
): FailureStage {
  if (result.success) return "none";
  if (result.captcha?.blocked === true) return "captcha";

  const err = (result.error ?? "").toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => err.includes(n));

  // AB6 — a known-unwinnable service that was routed to manual before the run.
  if (has("manual_signup_required")) return "manual";

  // Order matters: most-specific signal first.
  if (has("run_timeout", "run budget", "overall timeout")) return "run_timeout";
  if (has("proxy")) return "proxy_timeout";
  if (has("anti_bot", "anti-bot")) return "anti_bot";
  if (has("captcha")) return "captcha";
  if (has("account_chooser", "account chooser", "choose an account", "chooser")) return "account_chooser";
  if (has("consent", "scope_grant", "scope grant", "grant access", "allow access")) return "consent";
  // "reached the dashboard but couldn't surface a key" is an EXTRACT-stage
  // failure, not OAuth — check it BEFORE oauth so "post-OAuth navigation did
  // not surface a key" (no_credentials_after_already_signed_in) doesn't get
  // mis-bucketed by the bare "oauth" substring.
  if (has("no_credential", "no credentials", "did not surface", "not surface", "no api key", "already_signed_in")) {
    return "extract";
  }
  // Tightened: oauth_required / sso / a literal oauth callback — NOT bare
  // "oauth" (which appears in "post-OAuth navigation …" success-path prose).
  if (has("oauth_session_not_persisted", "oauth_required", "sso", "sso-callback", "oauth callback", "oauth-callback", "oauth handshake")) {
    return "oauth_handshake";
  }
  if (has("hydrat", "clerk", "stytch", "not loaded", "spa ")) return "hydration";
  // phone before verify_email: a "phone verification" gate is more specific
  // than the generic email/OTP verification bucket. Keep this intentionally
  // strict; passwordless email flows also say "verification code".
  if (
    /\b(phone|mobile) (?:number|verification|verify|code)\b/.test(err) ||
    /\b(?:verify|enter|confirm).{0,24}\b(phone|mobile)\b/.test(err) ||
    /\bsms (?:code|verification|message)\b/.test(err) ||
    /\btext message\b/.test(err)
  ) {
    return "phone";
  }
  if (has("email_otp", "verification_not_sent", "verify", "verification", "otp")) return "verify_email";
  if (has("payment", "quota", "billing")) return "payment";
  if (has("extract", "no key", "masked", "copy button", "copy-button")) return "extract";
  if (has("planning_failed", "planner", "max_rounds", "max rounds", "stuck", "loop")) {
    return "planner_loop";
  }
  if (has("submit")) return reachedOnboarding ? "planner_loop" : "form";

  // No specific signal: a stall after onboarding began is a planner loop;
  // anything earlier is a generic pre-onboarding form failure.
  return reachedOnboarding ? "planner_loop" : "form";
}
