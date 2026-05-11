// Shared helpers for non-HTTP step executors.
//
// Builds StepRecord skeletons + translates between the chunk-2
// `EmailMatch` (string|string[] / pattern strings) and the inbox
// service's `EmailMatcher` (string|RegExp).

import type { EmailMatch } from "@trusty-squire/adapter-sdk";
import type { EmailMatcher } from "@trusty-squire/inbox";
import type { StepError, StepRecord, Tier } from "../types.js";

export interface BaseStepCtx {
  index: number;
  attempt: number;
  tier: Tier;
  now?: () => string;
}

export function nowIso(ctx: { now?: () => string }): string {
  return ctx.now?.() ?? new Date().toISOString();
}

export function newStepRecord(
  ctx: BaseStepCtx,
  stepId: string,
  type: string,
  startedAt: string,
  completedAt: string,
  status: "success" | "failure",
  request: unknown,
  response: unknown,
): StepRecord {
  return {
    index: ctx.index,
    step_id: stepId,
    type,
    attempt: ctx.attempt,
    tier: ctx.tier,
    started_at: startedAt,
    completed_at: completedAt,
    status,
    request,
    response,
    error: null,
    fixture_uri: null,
  };
}

// Convert chunk-2's EmailMatch into the inbox's EmailMatcher.
// `from: string[]` becomes a regex over escaped alternatives.
// `subject_pattern` / `body_pattern` are used as substring (case-insensitive
// via inbox's matchString) by default; if a string starts with `/.../flags`
// we treat it as a regex literal.
export function toInboxMatcher(match: EmailMatch): EmailMatcher {
  const out: EmailMatcher = {};
  if (match.from !== undefined) {
    if (Array.isArray(match.from)) {
      // Match if any of the listed addresses/domains is a substring of
      // the actual From — escape the parts so dots don't go wild.
      const escaped = match.from.map(escapeRegex);
      if (escaped.length > 0) out.from = new RegExp(escaped.join("|"), "i");
    } else {
      out.from = match.from;
    }
  }
  if (match.subject_pattern !== undefined) {
    const re = parseAsRegexLiteral(match.subject_pattern);
    out.subject = re ?? match.subject_pattern;
  }
  if (match.body_pattern !== undefined) {
    const re = parseAsRegexLiteral(match.body_pattern);
    out.body_contains = re ?? match.body_pattern;
  }
  return out;
}

const REGEX_LITERAL_RE = /^\/(.+)\/([gimsuy]*)$/;

export function parseAsRegexLiteral(s: string): RegExp | null {
  const m = s.match(REGEX_LITERAL_RE);
  if (m === null) return null;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch {
    return null;
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Standard StepError flag set. Defaults reasonable for "fatal,
// not-retryable, not-escalating" — most non-HTTP failures.
export function makeError(
  message: string,
  flags: Partial<Pick<StepError, "capability_violation" | "causes_tier_escalation" | "retryable">> = {},
  detail?: unknown,
): StepError {
  const err: StepError = {
    message,
    capability_violation: flags.capability_violation ?? false,
    causes_tier_escalation: flags.causes_tier_escalation ?? false,
    retryable: flags.retryable ?? false,
  };
  if (detail !== undefined) err.detail = detail;
  return err;
}
