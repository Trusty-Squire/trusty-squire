// drive-feedback.ts — the deterministic half of the drive loop's feedback
// loop: what an action actually did, the goal phase the decider should reason
// in, and the one dry extraction the loop trusts for a "key" goal.
//
// The decider (Jev) answers narrow questions about a state. Everything that is
// control flow, memory, or verification belongs in code (TypeSafe's own
// guidance). This module owns:
//   • outcome classification — after every executed action, name the
//     consequence in one deterministic token (navigated/changed/no_change/
//     not_executed/bounced_back/text_appeared) instead of leaving the model to
//     infer it from prose.
//   • goal phase + done_when — stated as concrete conditions over the page,
//     never "advance the goal".
//
// The key-goal evidence and DONE condition are not a drive-local check: the
// drive calls the capture flow operate_extract runs (`driveKeyCredentials` in
// operate-drive.ts, which calls capture.ts's `extractCredentials`). No second
// credential policy lives here.
//
// Browser-free.

export const DRIVE_TRAIL_CAP = 8;
export const DRIVE_TRAIL_STORE_CAP = 32;
export const DRIVE_PAGE_TEXT_MAX = 2048;
export const DRIVE_TRAIL_TEXT_MAX = 160;
export const DRIVE_FIXED_NONE_OF_THESE = "NONE_OF_THESE";
export const DRIVE_FIXED_GO_BACK = "GO_BACK";

/** Volatile query keys stripped from a page identity (OAuth state, OTP codes,
 * one-shot nonces). Kept identical to the drive's own stable-page identity. */
export const VOLATILE_QUERY_KEY =
  /^(?:state|nonce|code|ts|t|timestamp|session(?:_?id)?|sid|request_id|rid|csrf|xsrf|authuser)$/i;

/** URL with volatile query values removed, for the trail's page identity. */
export function stripVolatileQuery(url: string): string {
  try {
    const parsed = new URL(url);
    const kept = [...parsed.searchParams.entries()].filter(
      ([key]) => !VOLATILE_QUERY_KEY.test(key),
    );
    kept.sort(([left], [right]) => left.localeCompare(right) || left.length - right.length);
    parsed.search = "";
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Origin + path only: the trail identity for "a page already visited". */
export function feedbackPagePath(url: string): string {
  try {
    const parsed = new URL(stripVolatileQuery(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export type DriveGoalPhase = "sign_in" | "verify" | "find_keys" | "create_or_reveal" | "done";

const VERIFY_GOAL_RE =
  /\bverif(?:y|ication)|confirm(?:ation)?(?:\s+your)?\s+e-?mail|check your e-?mail|otp|one[- ]time code|verification code|email code/;
const FIND_KEYS_GOAL_RE =
  /\bapi\s*key|access\s*token|api\s*token|credential|secret key|personal access token|bearer token/;
const SIGN_IN_GOAL_RE =
  /\bsign[\s-]*in|log[\s-]*in|login|signin|oauth|continue with (?:google|github|microsoft|apple)|single sign-on|\bsso\b/;
const CREATE_OR_REVEAL_GOAL_RE =
  /\bsign[\s-]*up|signup|create\s+(?:an?\s+)?account|register|create\s+(?:an?\s+)?(?:api\s+)?key|generate\s+(?:an?\s+)?(?:api\s+)?key|reveal|new key|add key/;

/** The phase the goal's own words put the drive in. Deterministic. */
export function goalPhase(goal: string): DriveGoalPhase {
  const text = goal.toLowerCase();
  if (VERIFY_GOAL_RE.test(text)) return "verify";
  if (FIND_KEYS_GOAL_RE.test(text)) return "find_keys";
  if (SIGN_IN_GOAL_RE.test(text)) return "sign_in";
  if (CREATE_OR_REVEAL_GOAL_RE.test(text)) return "create_or_reveal";
  return "done";
}

/** The exact page condition that satisfies the goal, in literal terms. */
export function goalDoneWhen(goal: string): string {
  switch (goalPhase(goal)) {
    case "find_keys":
      return "an unmasked secret-shaped value is on the page";
    case "create_or_reveal":
      return "the page confirms the account or resource was created";
    case "verify":
      return "the page confirms the email address or verification code was accepted";
    case "sign_in":
      return "the page shows an authenticated session for the provided account";
    default:
      return "the page shows the requested result";
  }
}

export function goalPhaseAndDoneWhen(goal: string): {
  phase: DriveGoalPhase;
  done_when: string;
} {
  return { phase: goalPhase(goal), done_when: goalDoneWhen(goal) };
}

/** True when the goal's finish line is a secret-shaped value on the page. */
export function isKeyGoal(goal: string): boolean {
  return goalPhase(goal) === "find_keys";
}

export function truncateDriveTrailText(text: string, cap = DRIVE_TRAIL_TEXT_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= cap ? collapsed : collapsed.slice(0, cap);
}

export interface DriveTrailEntry {
  step: number;
  page: string;
  action: string;
  outcome: string;
}

export interface DriveOutcomeInput {
  beforeUrl: string;
  afterUrl: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  /** False when the act layer refused or the loop withheld the action. */
  executed: boolean;
  /** The act layer's own reason: covered, stale, refused, dialog. */
  notExecutedReason?: string;
  /** The loop already knows this action returned to where it started. */
  bounced?: boolean;
  beforeText?: string;
  afterText?: string;
  notices?: readonly string[];
  /** Origin+path values already visited before this action. */
  visitedPaths?: readonly string[];
}

/** New visible text the action produced, or undefined when nothing new. */
export function freshDriveText(
  beforeText: string,
  afterText: string,
  notices: readonly string[] = [],
): string | undefined {
  const normalize = (text: string): string[] =>
    text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
  const before = new Set(normalize(beforeText).map((line) => line.toLowerCase()));
  const seen = new Set<string>();
  for (const line of [...normalize(afterText), ...notices.flatMap((notice) => normalize(notice))]) {
    const key = line.toLowerCase();
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    return truncateDriveTrailText(line);
  }
  return undefined;
}

/** One deterministic token naming what an action actually did. */
export function classifyDriveOutcome(input: DriveOutcomeInput): string {
  if (!input.executed) return `not_executed:${input.notExecutedReason ?? "stale"}`;
  if (input.bounced === true) return "bounced_back";
  const beforePath = feedbackPagePath(input.beforeUrl);
  const afterPath = feedbackPagePath(input.afterUrl);
  if (beforePath !== afterPath) {
    if ((input.visitedPaths ?? []).includes(afterPath)) return "bounced_back";
    return `navigated:${afterPath}`;
  }
  if (input.beforeFingerprint !== input.afterFingerprint) return "changed";
  const appeared = freshDriveText(input.beforeText ?? "", input.afterText ?? "", input.notices);
  if (appeared !== undefined) return `text_appeared:${appeared}`;
  return "no_change";
}

/** Compose the visible text the decider may see: notices first, then the page
 * body, capped so unrelated prose cannot act as a distractor. */
export function composeDrivePageText(
  notices: readonly string[],
  body: string,
  cap = DRIVE_PAGE_TEXT_MAX,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [...notices, body]) {
    const value = (part ?? "").replace(/\r/g, "").trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    parts.push(value);
    if (parts.join("\n").length >= cap) break;
  }
  return parts.join("\n").slice(0, cap);
}
