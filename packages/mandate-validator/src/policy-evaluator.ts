// Policy evaluator — decides silent / needs_approval / reject for a
// proposed action against a verified mandate.
//
// This file is security-critical (it's the gate that decides whether
// the runtime can spend without further confirmation) and carries 100%
// line coverage. The eight short-circuit checks below are the spec's
// fixed order — early-exit as soon as a hard reject hits, otherwise
// accumulate every applicable step-up reason.

import type {
  ApprovalReason,
  EvaluationContext,
  Mandate,
  MandateValidatorDeps,
  PolicyDecision,
  ProposedAction,
  SilentApproval,
} from "./types.js";

const NOT_BEFORE_SKEW_MS = 60_000; // ±60s tolerance per spec
const ROLLING_WINDOW_DAYS = 30;
const DAILY_NEAR_LIMIT_RATIO = 0.8; // 80% of daily silent max
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function evaluateAction(
  mandate: Mandate,
  action: ProposedAction,
  ctx: EvaluationContext,
  deps: MandateValidatorDeps,
): Promise<PolicyDecision> {
  const now = Date.parse(ctx.now);
  if (Number.isNaN(now)) {
    return { kind: "reject", reason: "invalid_context_clock" };
  }

  // (1) signature: presumed valid by caller (verifyMandateSignature
  // succeeded before evaluateAction is called). Documented invariant.

  // (2) validity window with ±60s skew on not_before only
  const notBefore = Date.parse(mandate.not_before);
  const notAfter = Date.parse(mandate.not_after);
  if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) {
    return { kind: "reject", reason: "mandate_invalid_window" };
  }
  if (now + NOT_BEFORE_SKEW_MS < notBefore) {
    return { kind: "reject", reason: "mandate_not_yet_valid" };
  }
  if (now > notAfter) {
    return { kind: "reject", reason: "mandate_expired" };
  }

  // (3) revocation
  const revoked = await deps.getRevokedMandates();
  if (revoked.has(mandate.id)) {
    return { kind: "reject", reason: "mandate_revoked" };
  }

  // (4) category
  if (!mandate.allowed_categories.includes(action.category)) {
    return { kind: "reject", reason: "category_not_allowed" };
  }

  // (5) blocked services list
  if (mandate.blocked_services.includes(action.service)) {
    return { kind: "reject", reason: "service_blocked" };
  }

  // (6) allow-list (or wildcard)
  if (mandate.allowed_services !== "*") {
    if (!mandate.allowed_services.includes(action.service)) {
      return { kind: "reject", reason: "service_not_allowed" };
    }
  }

  // (7) monthly budget — rolling 30-day window
  const since = new Date(now - ROLLING_WINDOW_DAYS * ONE_DAY_MS);
  const recentSpend = await deps.getRecentSpend(mandate.account_id, since);
  if (recentSpend + action.cost_cents > mandate.monthly_budget_cents) {
    return { kind: "reject", reason: "monthly_budget_exhausted" };
  }

  // (8) step-up reasons
  const reasons: ApprovalReason[] = [];
  const silentEntry = mandate.silently_approved_services.find(
    (s) => s.service === action.service,
  );

  if (silentEntry !== undefined) {
    // Pre-blessed service: only above_silent_max applies (against the
    // remembered cap). novel_service / new_category /
    // recurring_commitment are skipped — the user already said yes.
    if (action.cost_cents > silentEntry.max_monthly_cents) {
      reasons.push("above_silent_max");
    }
  } else {
    if (action.cost_cents > mandate.per_action_silent_max_cents) {
      reasons.push("above_silent_max");
    }
    if (await isNovelService(deps, mandate.account_id, action.service)) {
      reasons.push("novel_service");
    }
    if (await isNewCategory(deps, mandate.account_id, action.category)) {
      reasons.push("new_category");
    }
    if (action.recurrence === "monthly" || action.recurrence === "yearly") {
      reasons.push("recurring_commitment");
    }
  }

  // Daily-limit + session anomaly always apply, even for pre-blessed
  // services — they're guard rails on the runtime's behaviour, not on
  // the choice of service.
  if (await wouldCrossDailyLimit(deps, mandate, action, now)) {
    reasons.push("near_daily_limit");
  }
  if (ctx.session_anomaly_flags.length > 0) {
    reasons.push("session_anomaly");
  }

  if (reasons.length === 0) {
    return { kind: "silent", mandate_id: mandate.id };
  }

  return {
    kind: "needs_approval",
    mandate_id: mandate.id,
    reasons,
    required_confidence: mandate.confidence_requirements[action.type],
  };
}

// ── Helpers ──────────────────────────────────────────────────

async function isNovelService(
  deps: MandateValidatorDeps,
  accountId: string,
  service: string,
): Promise<boolean> {
  const services = await deps.getProvisionedServices(accountId);
  return !services.includes(service);
}

async function isNewCategory(
  deps: MandateValidatorDeps,
  accountId: string,
  category: string,
): Promise<boolean> {
  const categories = await deps.getProvisionedCategories(accountId);
  return !categories.includes(category);
}

async function wouldCrossDailyLimit(
  deps: MandateValidatorDeps,
  mandate: Mandate,
  action: ProposedAction,
  now: number,
): Promise<boolean> {
  const since = new Date(now - ONE_DAY_MS);
  const dailySpend = await deps.getRecentSpend(mandate.account_id, since);
  const limit = Math.floor(mandate.daily_silent_max_cents * DAILY_NEAR_LIMIT_RATIO);
  return dailySpend + action.cost_cents > limit;
}

// Re-exported so it shows up in barrels / docs — also consumed in tests.
export type { SilentApproval };
