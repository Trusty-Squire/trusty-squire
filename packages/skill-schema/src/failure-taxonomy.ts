// Canonical failure taxonomy — the single source of truth for "what does
// this failure_kind mean" across the registry (demotion classifier +
// demand damper) and the mcp client (signup telemetry). Lives in
// skill-schema because both separately-deployed artifacts must agree:
// if one classifies `email_otp_required` as a wall and the other doesn't,
// a service one machine quarantines the other keeps retrying.
//
// The classes exist to answer ONE question for the self-healing loop:
// should this failure advance a skill's 3-strike demote counter? Only
// `rot` does. Everything else means "the skill is fine, something else
// went wrong" and must not demote it.

export type FailureClass =
  | "wall" // terminal anti-bot wall (captcha / bot gateway) — quarantine, don't count
  | "infra" // our-side delivery failure (inbox/email) — infra alert, don't count
  | "transient" // retryable / session / operator (oauth, timeout, planner) — don't count
  | "rot"; // genuine skill staleness (step/selector/validator/extract) — COUNTS

// Anti-bot walls. The service got harder, not the skill staler. The bot
// can't pass these; route the service to the manual pile. Matches the
// legacy WALL_FAILURE_KINDS that lived (duplicated) in the registry's
// provision-event-store and the mcp signup-telemetry.
export const WALL_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "captcha_blocked",
  "anti_bot_blocked",
  "captcha",
]);

// Our-side email/inbox delivery failures. The skill submitted the form
// fine; the verification mail never arrived (fresh-MX withholding, a dead
// alias domain, a poll timeout). Demoting a skill for this would punish
// it for our inbox. Field-proven dominant: the 2026-06-02 harvest hit
// verification_not_sent on services whose signup actually succeeded.
export const INFRA_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "verification_not_sent",
  "inbox_empty",
  "email_delivery_failed",
]);

// Genuine skill staleness — a recorded step's selector/action/validator/
// extraction no longer matches the live page. This is the ONLY class that
// advances the demote counter. Kept a TIGHT explicit allowlist: the
// replay path's terminal failures (replay-skill.ts: step_failed,
// validator_failed, extraction_failed) plus the discover form-submit
// failure. Everything not listed here defaults to transient.
export const ROT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "step_failed",
  "validator_failed",
  "extraction_failed",
  "submit_failed",
  "selector_not_found",
]);

// Classify a failure_kind. failure_kind strings are often
// "<kind>: <human detail>" (e.g. "verification_not_sent: form submitted
// but…"), so we match on the leading token before any ':' or whitespace.
//
// UNKNOWN KINDS DEFAULT TO `transient`, NOT `rot`. This is deliberate and
// load-bearing: a false demote costs a ~6-minute bot rediscovery and may
// publish a worse skill; a missed demote just waits one more freshness
// sweep. Erring toward not-demoting keeps the loop from thrashing on a
// novel failure string.
export function classifyFailure(kind: string | null | undefined): FailureClass {
  if (kind === null || kind === undefined) return "transient";
  const head = kind.trim().toLowerCase().split(/[:\s]/, 1)[0] ?? "";
  if (head.length === 0) return "transient";
  if (WALL_FAILURE_KINDS.has(head)) return "wall";
  if (INFRA_FAILURE_KINDS.has(head)) return "infra";
  if (ROT_FAILURE_KINDS.has(head)) return "rot";
  return "transient";
}

// Convenience for the demotion path: does this failure advance the
// 3-strike demote counter? True only for genuine rot.
export function failureCountsTowardDemotion(
  kind: string | null | undefined,
): boolean {
  return classifyFailure(kind) === "rot";
}

// Convenience for the demand damper / sourcing: is this a terminal wall
// (route the service to the manual pile rather than retrying)?
export function isWallFailure(kind: string | null | undefined): boolean {
  return classifyFailure(kind) === "wall";
}
