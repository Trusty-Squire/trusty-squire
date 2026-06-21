import type { ObservationFrame } from "./observation-frame.js";
import {
  classifyObservationFrame,
  type StateVerdict,
} from "./state-classifier.js";

// Post-OAuth API key pages that require billing/payment before key issuance.
const ONBOARDING_PAYWALL_PATTERNS: readonly RegExp[] = [
  /\badd\s+a\s+payment\s+method\b/i,
  /\badd\s+(?:a\s+)?credit\s+card\b/i,
  /\bpayment\s+method\s+(?:is\s+)?required\b/i,
  /\bcredit\s+card\s+required\b/i,
  /\benter\s+your\s+card\b/i,
  /\benter\s+your\s+payment\b/i,
  /\benter\s+payment\s+details\b/i,
  /\bconnect\s+a(?:\s+valid)?\s+payment\s+method\b/i,
  /\byour\s+(?:free\s+)?trial\s+(?:is\s+)?ending\b/i,
  /\bupgrade\s+your\s+plan\s+to\b/i,
  /\bstart\s+your\s+paid\s+plan\b/i,
  /\brequir(?:es?|ing)\s+(?:a\s+)?credit\s+card\b/i,
  /\b(?:credit\s+card|payment)\s+wall\b/i,
  /\bcredit\s+card\s+verification\b/i,
  /\b(?:plan\s+|account\s+)?payment\s+required\b/i,
  /\bcomplet(?:e|ing)\s+(?:billing|payment)\b/i,
  /\bbilling\s+setup\s+(?:is\s+)?required\b/i,
  /\bpayment\s+form\b/i,
  /\binput(?:ting)?\s+payment\s+information\b/i,
  /\benter(?:ing)?\s+payment\s+information\b/i,
];

const PAYWALL_NEGATION_PREFIX =
  /\b(?:no|without|doesn'?t\s+(?:need|require)|don'?t\s+(?:need|require)|isn'?t)\s+$/i;
const PAYWALL_NEGATION_TEXT =
  /\b(?:no\s+(?:credit\s+card|payment|payment\s+method)\s+required|without\s+(?:credit\s+card|payment|payment\s+method)\s+required|doesn'?t\s+require\s+(?:a\s+)?(?:credit\s+card|payment|payment\s+method)|don'?t\s+(?:need|require)\s+(?:a\s+)?(?:credit\s+card|payment|payment\s+method))\b/i;

export function isAtPaywall(text: string): boolean {
  for (const pattern of ONBOARDING_PAYWALL_PATTERNS) {
    const m = pattern.exec(text);
    if (m === null) continue;
    const start = Math.max(0, m.index - 30);
    const prefix = text.slice(start, m.index);
    if (PAYWALL_NEGATION_PREFIX.test(prefix)) continue;
    return true;
  }
  return false;
}

function hasPaywallNegation(text: string): boolean {
  return PAYWALL_NEGATION_TEXT.test(text);
}

const ACCOUNT_REVIEW_GATE_PATTERNS: readonly RegExp[] = [
  /\bwaiting\s+room\b/i,
  /\b(?:join|on|added\s+to)\s+(?:the\s+|our\s+)?waitlist\b/i,
  /\byou'?re\s+on\s+the\s+(?:list|waitlist)\b/i,
  /\brequest\s+(?:early\s+)?access\b/i,
  /\baccess\s+(?:is\s+)?pending\b/i,
  /\bmore\s+information\s+to\s+approve\s+your\s+account\b/i,
  /\bto\s+speed\s+up\s+your\s+approval\b/i,
  /\byou[’']?ll\s+receive\s+an\s+email\s+when\s+your\s+account\s+is\s+approved\b/i,
  /\b(?:your\s+)?account\s+is\s+pending\b/i,
  /\bpending\s+approval\b/i,
  /\baccount\s+(?:is\s+)?(?:currently\s+)?under\s+review\b/i,
  /\byour\s+account\s+is\s+being\s+reviewed\b/i,
  /\bwe'?ll\s+email\s+you\s+when\b/i,
  /\bawaiting\s+(?:approval|access)\b/i,
];

export function isAtAccountReviewGate(text: string): boolean {
  return ACCOUNT_REVIEW_GATE_PATTERNS.some((p) => p.test(text));
}

export function isOnboardingReviewGate(
  verificationFailed: string | undefined,
  pageText: string,
): boolean {
  return verificationFailed === undefined && isAtAccountReviewGate(pageText);
}

export function isAtPhoneGate(text: string): boolean {
  return /phone verification|verify your phone|enter your phone|sms code|text message/i.test(text);
}

const SIGNUPS_CLOSED_PATTERNS: readonly RegExp[] = [
  /\bsign[\s-]?ups?\s+(?:are|is)\s+(?:currently\s+)?(?:closed|disabled|paused|not\s+(?:open|available|being\s+accepted))\b/i,
  /\b(?:we\s+are|we're)\s+not\s+(?:currently\s+)?accepting\s+(?:new\s+)?(?:sign[\s-]?ups|registrations|users|accounts)\b/i,
  /\bregistration\s+(?:is\s+)?(?:currently\s+)?(?:closed|disabled)\b/i,
  /\b(?:sign[\s-]?up|registration|access)\s+is\s+(?:by\s+)?invite[\s-]?only\b/i,
  /\binvite[\s-]?only\s+(?:beta|access|signup|registration)\b/i,
  /\brequest\s+an\s+invite\b/i,
];

export function isSignupsClosed(text: string): boolean {
  return SIGNUPS_CLOSED_PATTERNS.some((p) => p.test(text));
}

export type TerminalGateKind =
  | "none"
  | "signups_closed"
  | "payment"
  | "phone"
  | "account_review";

export interface TerminalGateInput {
  frame: ObservationFrame | null;
  fallbackText: string;
  lastDoneReason: string | null;
}

export interface TerminalGateVerdict {
  kind: TerminalGateKind;
  text: string;
  stateVerdict: StateVerdict | null;
}

export function classifyTerminalGate(input: TerminalGateInput): TerminalGateVerdict {
  const text =
    input.lastDoneReason !== null
      ? `${input.fallbackText}\n${input.lastDoneReason}`
      : input.fallbackText;
  const stateVerdict =
    input.frame !== null
      ? classifyObservationFrame({ ...input.frame, visibleText: text })
      : null;

  if (isSignupsClosed(text)) {
    return { kind: "signups_closed", text, stateVerdict };
  }
  if (stateVerdict?.state === "phone_gate" || isAtPhoneGate(text)) {
    return { kind: "phone", text, stateVerdict };
  }
  if (isAtPaywall(text) || (stateVerdict?.state === "payment_gate" && !hasPaywallNegation(text))) {
    return { kind: "payment", text, stateVerdict };
  }
  if (
    stateVerdict?.state === "account_review_gate" ||
    isAtAccountReviewGate(text)
  ) {
    return { kind: "account_review", text, stateVerdict };
  }
  return { kind: "none", text, stateVerdict };
}
