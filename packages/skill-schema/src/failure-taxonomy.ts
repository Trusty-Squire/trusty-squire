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

// A replay step can fail two very different ways that BOTH surface as the
// rot kind `step_failed`: the recorded selector/action went stale (genuine
// rot — SHOULD demote), or the page never loaded at all (a navigation /
// network / proxy failure — must NOT demote). The outcome kind can't tell
// them apart, so the producer (the verifier) inspects the failure REASON
// and downgrades a network failure to the transient `nav_timeout` kind
// before it reaches the demote counter.
//
// Load-bearing: every verifier replay egresses through a shared residential
// proxy tunnel, which blips. MEASURED 2026-06-06: a 60s page.goto timeout on
// a transient tunnel stall retired the `render` skill (it was at 2 strikes,
// the blip was strike 3). `nav_timeout` is NOT in ROT_FAILURE_KINDS, so it
// classifies transient via the default and records the stat without
// advancing consecutive_verifier_failures.
export const NAV_TIMEOUT_KIND = "nav_timeout";

const NAV_NETWORK_REASON_RE =
  /(page\.goto|net::err|err_timed_out|err_connection|err_network|err_name_not_resolved|err_proxy_connection_failed|err_socks|err_tunnel_connection_failed|ns_error_net|econnreset|econnrefused|etimedout|socket hang up|navigation timeout|timeout \d+ms exceeded)/i;

// True when a failure reason indicates the page never loaded — a network /
// navigation / proxy failure — rather than a stale selector or a failed
// validator. Such failures classify as transient, never rot.
export function isNavNetworkFailure(reason: string | null | undefined): boolean {
  if (reason === null || reason === undefined) return false;
  return NAV_NETWORK_REASON_RE.test(reason);
}

// A signup-with-onboarding recipe replayed against an ALREADY-REGISTERED
// operator account diverges from its fresh-signup capture: OAuth lands on the
// returning-user dashboard, the onboarding form is absent, and the
// credential-minting step (a disabled Create button, a vanished "New token"
// affordance) fails as `step_failed` — the rot kind. But this is NOT rot: the
// recipe works fine for a real fresh user; the verifier simply can't reproduce
// the first-run flow with a reused account. We CANNOT tell genuine rot from
// returning-user divergence here, so the safe default is don't-demote.
//
// The replay path tags such failures with this marker (it knows it skipped an
// absent onboarding fill earlier in the same run); the verifier downgrades the
// kind to `account_already_registered` (transient → never advances the
// 3-strike counter). MEASURED 2026-06-06: anthropic-api + planetscale replayed
// past a skipped onboarding fill, then false-failed `step_failed` at the
// credential step under the reused operator account.
export const ACCOUNT_EXISTS_KIND = "account_already_registered";

// Matches both the original onboarding-fill marker and the broadened
// authenticated-session marker (an element absent on an authenticated
// returning-user replay — likely UI divergence, not rot).
const RETURNING_USER_MARKER_RE = /returning-user: (?:onboarding fill was absent|authenticated session diverged)/i;

// True when a step_failed reason carries the replay path's returning-user
// marker — the credential step diverged from the fresh-signup capture because
// the operator account is already registered. Reclassify to transient.
export function isReturningUserDivergence(
  reason: string | null | undefined,
): boolean {
  if (reason === null || reason === undefined) return false;
  return RETURNING_USER_MARKER_RE.test(reason);
}

// A replay step/validator/extraction failure (the rot kinds) can mean genuine
// skill rot OR replay brittleness against a service that is STILL servable — a
// synthesized step matched a gloss-text element that the planner happened to
// re-render, the page selector drifted, etc. The bug this guards against
// (MEASURED 2026-06-13, fly.io): the verifier retired a servable skill because
// one step failed on a brittle text_match ("Tokens matched 2 elements") — the
// service had not rotted; the recipe was brittle. Retiring on brittleness throws
// away a working skill.
//
// The guard: before a rot failure counts toward demotion, the verifier probes
// the live signup page (affordance-probe). If the page still shows the service's
// expected affordances — an OAuth provider button OR an email-signup form —
// AND nothing that would itself explain a real wall (a card-gate-only page, an
// anti-bot interstitial), the failure is brittleness, not rot: downgrade it to
// this transient kind so it records the stat WITHOUT advancing the 3-strike
// demote counter, and flag it for re-synthesis instead of retiring it.
export const BRITTLE_PROBE_KIND = "brittle_replay_servable";

// The affordance shape the probe reports back, kept browser-free here so the
// taxonomy stays a pure dependency of both deployed artifacts. Mirrors the
// classification fields of PageAffordances (apps/mcp/src/bot/affordance-probe).
export interface ProbedAffordances {
  providers: readonly string[];
  has_email_signup: boolean;
  card_gate: boolean;
  interstitial: boolean;
}

// True when a probe of the signup page CLEARLY shows the service is still
// servable: a real entry affordance is present (an OAuth provider OR an
// email-signup form) and nothing on the page itself explains a real wall (an
// anti-bot interstitial). Conservative by design — it gates a DOWNGRADE (rot →
// non-demoting), so it must err toward false: an ambiguous or empty probe leaves
// the original demoting classification intact. Never upgrades.
export function probeShowsServable(
  affordances: ProbedAffordances | null | undefined,
): boolean {
  if (affordances === null || affordances === undefined) return false;
  // A real wall on the page itself explains the replay failure — not brittleness.
  if (affordances.interstitial) return false;
  const hasEntryAffordance =
    affordances.providers.length > 0 || affordances.has_email_signup;
  // A card-gate with no real entry affordance is a payment wall, not a servable
  // signup; a card-gate ALONGSIDE an OAuth/email entry is just an upsell and is
  // accepted because hasEntryAffordance is satisfied independently.
  return hasEntryAffordance;
}
