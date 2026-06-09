// Provision state machine — the single named-state classifier the autonomous
// loop and the mcp client both consult. Lives in skill-schema (alongside
// failure-taxonomy.ts) so the registry-side loop and the separately-deployed
// mcp client agree on what a state means; a split here would have one machine
// escalate a state the other auto-handles.
//
// This formalizes signals that today are scattered across agent.ts (~20 ad-hoc
// terminal error strings + detectAlreadySignedIn), failure-taxonomy.ts
// (wall/infra/transient/rot, demotion-only), and discover.ts's BLOCKED_PATTERNS
// into ONE state enum with an explicit `unknown` fall-through. `unknown` is the
// ONLY state that ever surfaces to a human — see provision-policy.ts.
//
// DOM-FREE by design: this package can't import the browser/InteractiveElement
// types (mcp-only). Callers compute the boolean signals (already_signed_in via
// detectAlreadySignedIn, email_pending via expectsVerificationEmail, etc.) and
// pass them in as plain data. The classifier owns only the decision tree + the
// kind-set membership + the unknown-state signature.

import { classifyFailure } from "./failure-taxonomy.js";

export type ProvisionState =
  | "success" // a usable credential was produced
  | "virgin" // fresh signup form, no live session
  | "authenticated" // already-signed-in dashboard (operator/bot session)
  | "email_pending" // signup submitted, awaiting an email verification link/OTP
  | "rate_limited" // 429 / "too many requests" / IP-risk backoff — back off + requeue
  | "transient" // retryable: oauth hiccup, nav/timeout, planner, upstream blip
  | "wall" // terminal, known-unrecoverable: captcha/anti-bot/phone/SMS/billing/SSO
  | "infra" // our-side delivery failure (inbox/email) — never demotes a skill
  | "rot" // skill staleness (replay only): stale selector/validator/extract
  | "unknown"; // matched NO classifier — the ONLY human-surfacing state

// Terminal failure kinds that are KNOWN-unrecoverable walls. The service got
// harder, not the recipe staler; the loop marks it unservable and moves on
// (NO human surface). Superset of failure-taxonomy's WALL_FAILURE_KINDS with
// the agent.ts terminal codes that are equally hopeless for the bot.
export const WALL_STATE_KINDS: ReadonlySet<string> = new Set([
  "captcha_blocked",
  "anti_bot_blocked",
  "captcha",
  "sso_restricted",
  "needs_oauth_provider_session",
  "oauth_consent_needs_review",
  "onboarding_blocked",
  "payment_required",
  "manual_signup_required",
  "existing_account_no_extract",
]);

// Awaiting an emailed verification link / OTP. Retryable: the bot polls the
// operator inbox. A persistent failure here is `infra` (mail never arrived),
// not a wall.
export const EMAIL_PENDING_KINDS: ReadonlySet<string> = new Set([
  "email_otp_required",
  "email_verification_pending",
]);

// Service-side throttling. Back off (reuse pacing.ts) and requeue, capped.
export const RATE_LIMITED_KINDS: ReadonlySet<string> = new Set([
  "rate_limited",
  "too_many_requests",
]);

// Known retryable transients — oauth/session/timeout/planner/nav/upstream. These
// are NAMED so they don't fall through to `unknown`. classifyFailure already
// defaults unrecognized kinds to "transient", but the loop must distinguish a
// KNOWN transient (auto-retry) from a never-seen terminal (escalate after 3) —
// hence an explicit allowlist.
export const KNOWN_TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  "needs_login",
  "oauth_loop_detected",
  "oauth_session_not_persisted",
  "oauth_onboarding_failed",
  "oauth_required",
  "no_signup_link",
  "planner_stuck",
  "planning_failed",
  "run_timeout",
  "nav_timeout",
  "account_already_registered",
  "llm_proxy_unavailable",
  "bot_crash",
  "submit_failed",
]);

const RATE_LIMIT_TEXT_RE =
  /\b(rate[ -]?limit|too many (?:requests|attempts|signups)|slow down|try again later|temporarily blocked|429)\b/i;

// Head token of a failure kind ("verification_not_sent: form…" → "verification").
// Mirrors failure-taxonomy.classifyFailure's tokenization so set membership
// lines up with how kinds are actually emitted ("<kind>: <detail>").
function headOf(kind: string | null | undefined): string {
  if (kind === null || kind === undefined) return "";
  return kind.trim().toLowerCase().split(/[:\s]/, 1)[0] ?? "";
}

// Some kinds are multi-token before the colon (email_otp_required,
// anti_bot_blocked). classifyFailure splits on the FIRST [:\s] which would cut
// "email_otp_required" → "email_otp_required" (underscores aren't split) — good.
// But "anti bot blocked" with spaces would cut to "anti". The emitted kinds use
// underscores, so the full leading token (up to the first space/colon) is the
// stable key. headOf already returns that.

export interface ProvisionSignals {
  // SUCCESS — a usable credential was extracted/validated this run.
  credential_present?: boolean;
  // Mid-flow page signals (computed by the caller from the live page).
  already_signed_in?: boolean; // detectAlreadySignedIn(...)
  awaiting_email?: boolean; // expectsVerificationEmail(...) on the post-submit page
  http_status?: number | null; // last meaningful HTTP status (for 429)
  body_text?: string; // visible page text (rate-limit phrasing + unknown signature)
  // TERMINAL — the run ended with this error kind (null/undefined = no terminal failure yet).
  failure_kind?: string | null;
}

// The single classifier. Precedence is deliberate:
//   success > rate_limited > email_pending > (terminal kind) > authenticated >
//   virgin. A terminal failure_kind wins over the mid-flow virgin/authenticated
//   read because once the run aborted, the page state no longer matters.
export function classifyProvisionState(s: ProvisionSignals): ProvisionState {
  if (s.credential_present === true) return "success";

  const head = headOf(s.failure_kind);

  // Rate-limit can arrive as a kind, an HTTP 429, or page text.
  if (
    RATE_LIMITED_KINDS.has(head) ||
    s.http_status === 429 ||
    (s.body_text !== undefined && RATE_LIMIT_TEXT_RE.test(s.body_text))
  ) {
    return "rate_limited";
  }

  // Awaiting email — either an explicit kind or the mid-flow page signal.
  if (EMAIL_PENDING_KINDS.has(head) || (head.length === 0 && s.awaiting_email === true)) {
    return "email_pending";
  }

  if (head.length > 0) {
    // A terminal failure occurred — classify it.
    if (WALL_STATE_KINDS.has(head)) return "wall";
    const cls = classifyFailure(s.failure_kind);
    if (cls === "wall") return "wall";
    if (cls === "infra") return "infra";
    if (cls === "rot") return "rot";
    // classifyFailure defaults the unrecognized to "transient" — so consult the
    // explicit known-transient allowlist to tell a KNOWN transient (retry) from
    // a never-seen terminal (escalate). cls === "transient" AND not in the
    // allowlist === a genuinely novel terminal state.
    if (KNOWN_TRANSIENT_KINDS.has(head)) return "transient";
    return "unknown";
  }

  // No terminal failure — mid-flow page read.
  if (s.already_signed_in === true) return "authenticated";
  return "virgin";
}

// Stable signature for an `unknown` state so the loop counts repeats of the
// SAME novel state together (3-attempt escalation) and treats a DIFFERENT
// novel state as its own fresh count. Derived from the URL pathname + the
// sorted top-N interactive-element fingerprints the caller captured. NOT a
// cryptographic hash — a short, deterministic, human-readable digest is enough
// to bucket attempts. Excludes query strings / volatile ids.
export function unknownStateSignature(input: {
  url?: string;
  element_fingerprints?: readonly string[];
}): string {
  let path = "";
  try {
    path = input.url !== undefined ? new URL(input.url).pathname.toLowerCase() : "";
  } catch {
    path = (input.url ?? "").toLowerCase().slice(0, 80);
  }
  const els = [...(input.element_fingerprints ?? [])]
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .sort()
    .slice(0, 12)
    .join("|");
  return djb2(`${path}§${els}`);
}

// Tiny deterministic string hash (djb2) → base36. Stable across processes
// (no Math.random / Date), which the loop needs to match signatures across
// passes. Collisions are acceptable here (worst case: two distinct unknown
// states share a 3-count — still escalates, just bucketed together).
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
