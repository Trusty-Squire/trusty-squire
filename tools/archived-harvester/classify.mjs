// Failure classifier — rule-based first pass, with explicit `null`
// for "unknown" so callers can fall through to LLM-classification
// (subagent Phase 3 territory, capped at 10/day per design doc).
//
// Categories drive the Phase 3 subagent's decision tree:
//   code_bug         → propose a fix PR (subagent's primary work)
//   environment      → digest entry only; escalate to investigation
//                      issue if same (service, category) persists >7d
//   external_block   → tag service with blocked_reason in services.yaml,
//                      cooldown 30d before retry
//   upstream_change  → trigger a fresh universal-bot capture; if
//                      that ALSO fails 3×, promote to code_bug
//
// Important: this is a SEPARATE classifier from the harvester's
// outcome classification (failed / needs-manual / replay-ok /
// promotion-only / skill-replay-failed). Those drive GitHub labels
// and retry policy. The classify.mjs output is the subagent's
// decision input. The two coexist in the failure-report.json:
//   - classification:    harvester outcome (existing field)
//   - failure_category:  new field, this module's output
//
// Codex caveat (folded from the eng review): `selector_not_found`
// and planner errors are flagged as `code_bug` here, but the
// subagent's first move on these MUST be to attempt a fresh capture
// (selector drift is often auto-recoverable). Repeated failure
// across captures is what actually proves "code bug."

export const FAILURE_CATEGORIES = [
  "code_bug",
  "environment",
  "external_block",
  "upstream_change",
];

// Returns one of FAILURE_CATEGORIES or null when the rules abstain.
// Pure — caller assembles `final` and `steps` from the run result.
export function classifyFailure(final, steps = []) {
  const status = final?.status ?? null;
  const error = String(final?.error ?? "").toLowerCase();
  const stepText = (steps ?? []).join("\n").toLowerCase();

  // ── ENVIRONMENT: anti-bot, scoring, transient upstream
  // Not fixable by editing our bot; needs fingerprint/IP improvements
  // or upstream stops being hostile. Subagent logs to digest.
  if (status === "captcha_blocked") return "environment";
  if (status === "anti_bot_blocked") return "environment";
  // verification_not_sent: most often inbox/SES; classified as
  // environment with a re-eval prompt if it persists >7d on the same
  // (service) pair (= might be upstream change).
  if (status === "verification_not_sent") return "environment";
  // Generic upstream 5xx (uncommon in our flow; the bot mostly sees
  // these via the verification-link click)
  const httpCode = error.match(/\bhttp\s*(\d{3})\b/);
  if (httpCode !== null && Number(httpCode[1]) >= 500) return "environment";

  // ── EXTERNAL_BLOCK: upstream needs the user (phone, payment,
  // GitHub-only OAuth without a session). Subagent never PRs these;
  // it tags services.yaml with blocked_reason + cooldown.
  if (status === "payment_required") return "external_block";
  if (status === "oauth_required") return "external_block";
  if (status === "needs_login") return "external_block";
  if (status === "oauth_consent_needs_review") return "external_block";
  if (status === "onboarding_blocked") return "external_block";
  // Phone/SMS gates — surfaced via error text since the bot doesn't
  // have a dedicated status code yet (TODO: F12 user-relayed SMS).
  if (/phone[\s-]?verification|sms[\s-]?required|please verify your phone/.test(error)) {
    return "external_block";
  }

  // ── UPSTREAM_CHANGE: captured skill no longer replays. Could be
  // selector drift, page redesign, new captcha gate, etc. Subagent's
  // recovery is to attempt a fresh universal-bot capture.
  if (/\[skill-promoter\] (?:full replay|dry replay) failed/.test(stepText)) {
    return "upstream_change";
  }

  // ── CODE_BUG: our bot's planner or executor messed up. Subagent
  // proposes a fix PR. PER CODEX CAVEAT: subagent should verify via
  // a fresh capture first; deterministic mapping here would generate
  // bad PRs if the planner / extractor is the real culprit.
  if (status === "planning_failed") return "code_bug";
  if (status === "submit_failed") return "code_bug";
  if (status === "extraction_failed") return "code_bug";
  if (/selector.*not found|no element matched/.test(error)) return "code_bug";
  if (/planner (?:returned|gave|error|crashed)/.test(error)) return "code_bug";

  // ── ABSTAIN: timeout / unknown status / generic failure with no
  // specific signal. Subagent (Phase 3) will fall through to LLM-
  // classification on these, capped at 10/day. For Phase 2 there's
  // no LLM-fallback yet; null bubbles up to the failure-report.
  return null;
}
