// Shared types for the codex-driven verify housekeeper.

// A failure_kind classifies why a verify attempt did NOT yield a credential.
// Only "real" failures advance the demote counter; transient/brittle ones do
// not (see classify.ts). login_wall is the operator-session-dead case — always
// transient, so a dead Google session can't spuriously demote every skill.
export type FailureKind =
  | "nav_timeout" // transient: network/navigation timeout
  | "account_exists" // transient: returning-user divergence, not a recipe failure
  | "brittle_probe" // transient: disabled target / flaky affordance probe
  | "login_wall" // transient: operator session dead / anti-bot interstitial
  | "captcha_blocked" // transient: captcha gate didn't clear this run
  | "no_credentials" // real: reached the end, no credential produced
  | "step_failed" // real: a provisioning step failed reproducibly
  | "other"; // real: unclassified

// The structured result the codex-exec runner parses out of a verify attempt.
export interface VerifyOutcome {
  ok: boolean;
  failure_kind?: FailureKind;
  detail?: string;
}

// The minimal skill shape the scheduler needs from the registry.
export interface SkillRef {
  id: string;
  service: string;
  signup_url: string;
  status: string;
}
