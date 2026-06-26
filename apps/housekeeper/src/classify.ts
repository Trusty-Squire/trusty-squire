// Failure-kind classification + the transient/real distinction.
//
// The mechanical demote rule counts only GENUINE reproducible failures. A
// network blip, a returning-user divergence, a captcha that didn't clear, or a
// dead operator session must NOT advance the demote counter — otherwise three
// unlucky runs demote a perfectly good skill. This is a deterministic rule, not
// a judgment, so it belongs here, not in codex.

import type { FailureKind } from "./types.js";

// Transient kinds never count toward demotion. login_wall is the dead-operator-
// session / anti-bot-interstitial case (see DESIGN open question #4): a dead
// Google session would otherwise demote every skill in a single pass.
const TRANSIENT: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "nav_timeout",
  "account_exists",
  "brittle_probe",
  "login_wall",
  "captcha_blocked",
]);

const KNOWN: ReadonlySet<string> = new Set<FailureKind>([
  "nav_timeout",
  "account_exists",
  "brittle_probe",
  "login_wall",
  "captcha_blocked",
  "no_credentials",
  "step_failed",
  "other",
]);

export function isTransient(kind: FailureKind): boolean {
  return TRANSIENT.has(kind);
}

// Only real (non-transient) failures advance the demote counter.
export function failureCountsTowardDemotion(kind: FailureKind): boolean {
  return !isTransient(kind);
}

// Map an arbitrary string codex emitted (or a synonym) onto a known FailureKind.
// Defaults to "other" (a REAL failure) only when nothing matches — but note an
// EMPTY/undefined reason on a failed run is treated as a runner/infra problem
// upstream (infra_error), not classified here.
export function normalizeFailureKind(raw: string | undefined): FailureKind {
  if (raw === undefined) return "other";
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return "other";
  if (KNOWN.has(s)) return s as FailureKind;
  // Synonym buckets — order matters (most specific first).
  if (/(login|sign[\s_-]?in|needs[\s_-]?login|session|wall|interstitial|anti[\s_-]?bot)/.test(s)) {
    return "login_wall";
  }
  if (/(captcha|turnstile|recaptcha|challenge)/.test(s)) return "captcha_blocked";
  if (/(nav|timeout|timed[\s_-]?out|network|socket|econn|navigation)/.test(s)) return "nav_timeout";
  if (/(already|exists|returning|registered)/.test(s)) return "account_exists";
  if (/(brittle|disabled|flaky|probe)/.test(s)) return "brittle_probe";
  if (/(no[\s_-]?cred|missing[\s_-]?cred|no[\s_-]?key|no[\s_-]?api[\s_-]?key)/.test(s)) {
    return "no_credentials";
  }
  if (/(step|selector|element|click|form)/.test(s)) return "step_failed";
  return "other";
}
