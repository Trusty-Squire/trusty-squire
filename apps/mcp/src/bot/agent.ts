// AI agent that controls browser navigation using Claude.
//
// Two responsibilities live here:
//   1. Plan how to fill a signup form (delegated to Claude — see analyzeSignupForm)
//   2. Execute the plan + handle the email-verification handshake
//
// The "plan" is a small JSON schema Claude emits, so this file stays a thin
// executor; the prompt is the contract. If a service breaks we tweak the
// prompt rather than threading service-specific logic through the agent.

import type {
  BrowserController,
  BrowserState,
  CaptchaKind,
  CaptchaVariant,
  InteractiveElement,
} from "./browser.js";
import { rankAndCapInventory, scoreSignupButton } from "./browser.js";
import {
  OAUTH_PROVIDERS,
  extractOAuthScopes,
  type OAuthProviderId,
} from "./oauth-providers.js";
import { saveDebugSnapshot } from "./debug.js";
import { wasRecentlyPrewarmed, recordPrewarmSuccess } from "./prewarm-cache.js";
import {
  pickLLMPair,
  type LLMBlock,
  type LLMClient,
  type LLMPair,
} from "./llm-client.js";

// Structural type the agent needs from an inbox source. Satisfied by both
// the in-process @trusty-squire/inbox InboxService and the HTTP InboxClient
// in this package — the agent doesn't care which.
export interface AgentInbox {
  waitForEmail(input: {
    alias: string;
    matcher: { subject?: RegExp; from?: RegExp; body_contains?: string };
    timeout_seconds: number;
  }): Promise<{
    subject: string;
    from_address: string;
    parsed_links: ReadonlyArray<string>;
  }>;
}

// Hard cap on LLM calls per signup. A signup that runs away to 20+ calls
// is both expensive and almost certainly stuck in a planning loop. 15
// covers: 2 initial form plans, 1 re-plan pair on validation, plus 6
// post-verify rounds, with headroom. Override via env when debugging.
const MAX_LLM_CALLS_PER_SIGNUP = Number.parseInt(
  process.env.UNIVERSAL_BOT_MAX_LLM_CALLS ?? "15",
  10,
);

// "Cheap mode" routes via OpenRouter to a budget vision model. Turn on
// when running large batches; turn off when you need maximum form-fill
// quality on tricky sites.
const PREFER_CHEAP_LLM = process.env.UNIVERSAL_BOT_PREFER_CHEAP === "true";

// S3: phrases a signup page shows when it genuinely expects the user to go
// check their inbox. If none appear after submit, the service most likely
// dispatched no verification email (anti-abuse withholding, or the submit
// was rejected) — so the bot runs a short probe instead of blind-waiting
// the full timeout for mail that is not coming.
const VERIFICATION_EXPECTED_PATTERNS: readonly string[] = [
  "check your email",
  "check your inbox",
  "verify your email",
  "verify your inbox",
  "confirm your email",
  "confirmation email",
  "verification email",
  "verification link",
  "we sent",
  "we've sent",
  "we have sent",
  "sent you an email",
  "sent a link",
  "activate your account",
  "almost there",
  "one more step",
];

// Short probe when the post-submit page never prompted the user to check
// their email. Legitimate verification mail almost always lands inside a
// minute; this catches the fast case without 300s of dead air.
const VERIFICATION_PROBE_SECONDS = 45;

// T7: page text that means the post-OAuth API key sits behind a
// billing / payment-method wall. When the OAuth onboarding loop ends
// without a key and the page reads like this, the run ends
// `onboarding_blocked` rather than grep-looping a wall it cannot
// satisfy (the S3-class trap named in the plan's failure modes).
const ONBOARDING_PAYWALL_PATTERNS: readonly string[] = [
  "add a payment method",
  "add a credit card",
  "add credit card",
  "payment method required",
  "a payment method is required",
  "credit card required",
  "enter your card",
  "enter your payment",
  "enter payment details",
  "upgrade your plan to",
  "start your paid plan",
];

// S3: does this post-submit page text indicate the service genuinely
// expects the user to confirm via email? Drives whether the bot polls the
// full verification timeout or runs only a short probe. Exported so the
// keyword set is unit-tested directly.
export function expectsVerificationEmail(pageText: string): boolean {
  const lower = pageText.toLowerCase();
  return VERIFICATION_EXPECTED_PATTERNS.some((p) => lower.includes(p));
}

export class LLMCallBudgetExceeded extends Error {
  constructor(budget: number) {
    super(`signup exceeded LLM call budget of ${budget}`);
    this.name = "LLMCallBudgetExceeded";
  }
}

export interface SignupTask {
  service: string;
  signupUrl?: string | undefined;
  email: string;
  generatePassword: () => string;
  inbox?: AgentInbox | undefined;
  // Max time to wait for a verification email. Default 5 minutes —
  // services like MailerSend buffer signup verifications for several
  // minutes as anti-abuse, so the old 60s default was wrong.
  verificationTimeoutSeconds?: number | undefined;
  // Max number of post-verification "what do I click next?" rounds.
  // Each round = one Claude vision call + a browser action. Set to 0
  // to disable the post-verification navigation loop entirely.
  postVerifyMaxRounds?: number | undefined;
  // OAuth-first signup (T6). When set, and the signup page carries a
  // matching "Sign in with <provider>" affordance, the bot takes the
  // OAuth path — clicking through the provider's consent screen using
  // the session in the persistent profile — instead of form-filling.
  // Absent (or no affordance found) → the form-fill path. T13 added
  // GitHub alongside Google.
  oauthProvider?: OAuthProviderId | undefined;
}

export interface SignupResult {
  success: boolean;
  credentials?: {
    api_key?: string;
    username?: string;
    password?: string;
    [key: string]: string | undefined;
  };
  error?: string;
  steps: string[];
  // How many LLM calls this run made. Useful for cost accounting and
  // for catching regressions where a refactor accidentally doubles the
  // round-trips.
  llm_calls?: number;
  // One entry per LLM call, identifying which backend handled it.
  // E.g. ["openrouter:google/gemini-flash-1.5", "openrouter:anthropic/claude-3.5-sonnet"]
  // means the cheap path was used twice and the premium fallback engaged
  // once. Useful for verifying dual-mode is actually saving money in
  // production rather than always landing on the premium fallback.
  llm_backends?: readonly string[];

  // Browser channel actually launched ("chrome", "msedge", or null for
  // bundled Chromium). Surfaced for telemetry: a captcha failure on
  // bundled Chromium is materially different signal from the same
  // failure on real Chrome.
  browser_channel?: string | null;

  // Whether this run's browser egress was routed through the
  // residential proxy (true) or went out direct (false). Lets the
  // CaptchaEvent ledger answer "did the proxy actually run?" — a
  // captcha block behind a residential proxy is a materially
  // different signal from one on a bare datacenter IP.
  proxied?: boolean;

  // Captcha encountered during the run. Populated only when the agent
  // hit at least one captcha widget — null/undefined otherwise. The
  // MCP tool layer reads this to emit a CaptchaEvent.
  captcha?: {
    kind: "turnstile" | "recaptcha";
    // Finer family classification + whether an image-grid challenge
    // actually rendered (vs a checkbox that passed, or score-only
    // reCAPTCHA). Spike telemetry — feeds CaptchaEvent (T3.2).
    variant: CaptchaVariant;
    challenge_rendered: boolean;
    // The bot's view of what happened. `blocked: true` means the run
    // bailed because the captcha didn't resolve; `blocked: false`
    // means the bot got past it (token populated client-side).
    blocked: boolean;
  };
}

// Plan emitted by Claude when looking at a signup form. One action per field.
export type FillAction =
  | { kind: "fill"; selector: string; value_kind: FillValueKind; literal?: string; reason: string }
  | { kind: "check"; selector: string; reason: string }
  | { kind: "click"; selector: string; reason: string };

export interface SignupPlan {
  actions: FillAction[];
  submit_selector: string;
  confidence: "high" | "medium" | "low";
  notes?: string;
}

// Outcome of planExecuteWithRetry — the form-fill + submit phase (F3
// T5). signup() maps each kind to a SignupResult, except `submitted`
// which falls through to credential extraction.
type PlanExecOutcome =
  | { kind: "submitted" }
  | { kind: "captcha_blocked"; captchaKind: string }
  | { kind: "submit_failed"; reason: string }
  | { kind: "planning_failed"; reason: string }
  | { kind: "oauth_required" }
  // T6: an OAuth-first signup found its provider affordance — the
  // selector of the "Sign in with Google" button to click. signup()
  // hands off to the OAuth consent flow instead of credential extraction.
  | { kind: "oauth"; selector: string };

// What to do next after the verification link is clicked. Most services
// land you on a dashboard with the API key visible; some require one or
// two clicks ("create your first project", "skip tour", etc.) before the
// key appears. The post-verification loop asks Claude one of these on
// every round until it sees `done` or runs out of rounds.
export type PostVerifyStep =
  | { kind: "done"; reason: string }
  | { kind: "extract"; reason: string }
  | { kind: "login"; reason: string }
  | { kind: "click"; selector: string; reason: string }
  | { kind: "fill"; selector: string; value: string; reason: string }
  // `select` — pick a valid option for a native <select> (a region /
  // role / country dropdown on a post-OAuth onboarding form). A plain
  // `click` cannot satisfy a <select>; this picks the first real option.
  | { kind: "select"; selector: string; reason: string }
  | { kind: "navigate"; url: string; reason: string }
  | { kind: "wait"; seconds: number; reason: string };

// The set of value_kinds the planner is allowed to emit. Kept as a
// runtime array so validation and the exhaustive `valueFor` switch
// share one source of truth.
const FILL_VALUE_KINDS = [
  "email",
  "password",
  "name",
  "username",
  "company",
  "literal",
] as const;
type FillValueKind = (typeof FILL_VALUE_KINDS)[number];

// Parsers/validators live at module scope so callLLM() can pass them
// as plain functions. Each parser MUST throw on any malformed reply —
// the throw is the signal callLLM uses to trigger the premium-fallback
// retry. The model output is untrusted: every field an executor later
// reads (selector, value_kind, url, ...) is validated here so a
// `{kind:"fill"}` with no selector can never reach browser.type().

// Shared fence-strip + `{...}` extraction + JSON.parse. Both planners
// take the same raw LLM reply shape, so the boilerplate lives once.
function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  // Tolerate models that wrap their reply in markdown fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced !== null && fenced[1] !== undefined ? fenced[1] : trimmed;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (match === null) {
    throw new Error(`no JSON object in reply: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("top-level JSON is not an object");
  }
  // A plain object's own enumerable string keys are exactly
  // Record<string, unknown> — no cast needed once we've ruled out
  // null/array above.
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) obj[k] = v;
  return obj;
}

// Narrow `unknown` to a non-null object map.
function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected an object`);
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) obj[k] = v;
  return obj;
}

// Narrow `unknown` to a non-empty string.
function requireString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${context}: missing or empty string field "${key}"`);
  }
  return v;
}

function isFillValueKind(value: unknown): value is FillValueKind {
  // .some() over the readonly tuple avoids a widening cast: each
  // element compares as the literal-union type against `value`.
  return (
    typeof value === "string" &&
    FILL_VALUE_KINDS.some((kind) => kind === value)
  );
}

function validateFillAction(obj: Record<string, unknown>): FillAction {
  const selector = requireString(obj, "selector", "fill action");
  const valueKind = obj["value_kind"];
  if (!isFillValueKind(valueKind)) {
    throw new Error(
      `fill action: invalid value_kind ${JSON.stringify(valueKind)}`,
    );
  }
  // `reason` is advisory only — tolerate it missing so a model that
  // skips the field doesn't trigger an otherwise-pointless retry.
  const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";
  const literal = typeof obj["literal"] === "string" ? obj["literal"] : undefined;
  if (valueKind === "literal" && literal === undefined) {
    throw new Error('fill action: value_kind "literal" requires a "literal" string');
  }
  return literal !== undefined
    ? { kind: "fill", selector, value_kind: valueKind, literal, reason }
    : { kind: "fill", selector, value_kind: valueKind, reason };
}

function validateAction(value: unknown, index: number): FillAction {
  const obj = asObject(value, `action[${index}]`);
  const kind = obj["kind"];
  switch (kind) {
    case "fill":
      return validateFillAction(obj);
    case "check":
      return {
        kind: "check",
        selector: requireString(obj, "selector", `action[${index}] (check)`),
        reason: typeof obj["reason"] === "string" ? obj["reason"] : "",
      };
    case "click":
      return {
        kind: "click",
        selector: requireString(obj, "selector", `action[${index}] (click)`),
        reason: typeof obj["reason"] === "string" ? obj["reason"] : "",
      };
    default:
      throw new Error(`action[${index}]: unknown kind ${JSON.stringify(kind)}`);
  }
}

export function parseSignupPlan(
  raw: string,
  allowedSelectors?: ReadonlySet<string>,
): SignupPlan {
  const obj = extractJsonObject(raw);
  const rawActions = obj["actions"];
  if (!Array.isArray(rawActions)) {
    throw new Error("signup plan missing actions[]");
  }
  const actions = rawActions.map((a, i) => validateAction(a, i));
  const submitSelector = requireString(obj, "submit_selector", "signup plan");
  const confidence = obj["confidence"];
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw new Error(`signup plan: invalid confidence ${JSON.stringify(confidence)}`);
  }
  // F3 T4: when the page inventory is supplied, every selector the
  // planner emits must be one the bot computed and put in the
  // inventory. This makes selector hallucination a parse-time
  // rejection (the throw triggers a re-plan) before any DOM
  // round-trip — and an invalid selector like `:contains()` simply
  // isn't in the inventory, so it is caught here too.
  if (allowedSelectors !== undefined) {
    for (const a of actions) {
      if (!allowedSelectors.has(a.selector)) {
        throw new Error(
          `signup plan: action selector ${JSON.stringify(a.selector)} is not in the page inventory`,
        );
      }
    }
    if (!allowedSelectors.has(submitSelector)) {
      throw new Error(
        `signup plan: submit_selector ${JSON.stringify(submitSelector)} is not in the page inventory`,
      );
    }
  }
  const notes = typeof obj["notes"] === "string" ? obj["notes"] : undefined;
  return notes !== undefined
    ? { actions, submit_selector: submitSelector, confidence, notes }
    : { actions, submit_selector: submitSelector, confidence };
}

// Render the element inventory as a compact text block for the
// planner — one line per element, ending with the verified
// `selector=` the planner must copy verbatim (F3 T3).
export function formatInventory(inventory: readonly InteractiveElement[]): string {
  if (inventory.length === 0) return "(no interactive elements found on the page)";
  return inventory
    .map((e) => {
      const bits: string[] = [`[${e.index}] ${e.tag}`];
      if (e.type !== null) bits.push(`type=${e.type}`);
      if (e.name !== null) bits.push(`name=${e.name}`);
      if (e.placeholder !== null) {
        bits.push(`placeholder=${JSON.stringify(e.placeholder)}`);
      }
      const label = e.labelText ?? e.ariaLabel;
      if (label !== null && label !== undefined) {
        bits.push(`label=${JSON.stringify(label)}`);
      }
      if (
        e.tag !== "input" &&
        e.tag !== "textarea" &&
        e.tag !== "select" &&
        e.visibleText !== null
      ) {
        bits.push(`text=${JSON.stringify(e.visibleText)}`);
      }
      if (e.inConsentWidget) bits.push("[cookie-consent — avoid]");
      bits.push(`selector=${e.selector}`);
      return bits.join("  ");
    })
    .join("\n");
}

// True when the page has no fillable text input AND no button that
// reads as an email-signup option — a genuinely OAuth/SSO-only
// service with no form to automate (F3 Issue 4).
export function isOauthOnlyChooser(
  inventory: readonly InteractiveElement[],
): boolean {
  const TEXTLIKE = new Set<string | null>([
    "text",
    "email",
    "password",
    "tel",
    null,
  ]);
  const hasFillableInput = inventory.some(
    (e) => (e.tag === "input" && TEXTLIKE.has(e.type)) || e.tag === "textarea",
  );
  if (hasFillableInput) return false;
  const hasEmailOption = inventory.some(
    (e) =>
      scoreSignupButton(
        `${e.visibleText ?? ""} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`,
      ) > 0,
  );
  return !hasEmailOption;
}

// Find a "Sign in with <provider>" affordance in the page inventory —
// the entry point for the OAuth-first path (T6/T13). Three signals, in
// confidence order — derived from a live sweep where the text-only
// heuristic missed real buttons:
//   1. href — an <a> whose link routes through the provider's OAuth
//      endpoint (/identity/login/google, /auth/github/callback, …).
//      Unambiguous: a marketing link to policies.google.com does not.
//   2. iconLabel — an icon-only button with no text at all, named only
//      by a descendant <img alt="Google"> / <svg><title> (Mistral).
//   3. text + an auth verb — "Continue with Google", "Sign up with
//      GitHub". The auth verb is what keeps a bare "Google" nav link
//      or "Google's Privacy Policy" out.
// Returns null when the page has no such affordance — the planner then
// falls back to form-fill. Exported for unit testing.
export function findOAuthButton(
  inventory: readonly InteractiveElement[],
  provider: OAuthProviderId,
): InteractiveElement | null {
  const keyword = OAUTH_PROVIDERS[provider].buttonKeyword;
  const keywordRe = new RegExp(`\\b${keyword}\\b`);
  const hrefRe = new RegExp(
    `(?:login|signin|sign-in|auth|oauth|connect|sso)[/_-]*${keyword}` +
      `|${keyword}[/_-]*(?:login|signin|auth|oauth|connect)`,
    "i",
  );
  for (const e of inventory) {
    const isButtonish =
      e.tag === "button" ||
      e.tag === "a" ||
      e.role === "button" ||
      e.type === "submit" ||
      e.type === "button";
    if (!isButtonish) continue;
    // 1. An <a> whose href routes through the provider's OAuth endpoint.
    const href = (e.href ?? "").toLowerCase();
    if (href.length > 0 && hrefRe.test(href)) return e;
    // 2. Icon-only button — named only by a descendant img/svg.
    if (keywordRe.test((e.iconLabel ?? "").toLowerCase())) return e;
    // 3. Visible text / accessible label naming the provider + an
    //    auth verb. The auth verb requirement rejects nav and policy
    //    links that merely mention the provider.
    const text = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!keywordRe.test(text)) continue;
    if (/\b(sign|signup|signin|continue|log ?in|connect|auth)\b/.test(text)) {
      return e;
    }
  }
  return null;
}

// Parse a post-verify step. When `allowedSelectors` is supplied, a
// `click`/`fill` selector that is not in the page inventory is a
// parse-time rejection — the same DOM-grounding F3 gave the signup
// planner (parseSignupPlan). It stops the post-OAuth onboarding
// planner from inventing CSS selectors that never resolve, which was
// the dominant onboarding-navigation failure mode.
export function parsePostVerifyStep(
  raw: string,
  allowedSelectors?: ReadonlySet<string>,
): PostVerifyStep {
  const obj = extractJsonObject(raw);
  const kind = obj["kind"];
  // `reason` is required by the schema but advisory; default it so a
  // model omitting it doesn't trip a retry on an otherwise-valid step.
  const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";
  const checkSelector = (selector: string, context: string): void => {
    if (allowedSelectors !== undefined && !allowedSelectors.has(selector)) {
      throw new Error(
        `${context}: selector ${JSON.stringify(selector)} is not in the page inventory`,
      );
    }
  };
  switch (kind) {
    case "done":
      return { kind: "done", reason };
    case "extract":
      return { kind: "extract", reason };
    case "login":
      return { kind: "login", reason };
    case "click": {
      const selector = requireString(obj, "selector", "post-verify click step");
      checkSelector(selector, "post-verify click step");
      return { kind: "click", selector, reason };
    }
    case "fill": {
      const selector = requireString(obj, "selector", "post-verify fill step");
      checkSelector(selector, "post-verify fill step");
      return {
        kind: "fill",
        selector,
        value: requireString(obj, "value", "post-verify fill step"),
        reason,
      };
    }
    case "select": {
      const selector = requireString(obj, "selector", "post-verify select step");
      checkSelector(selector, "post-verify select step");
      return { kind: "select", selector, reason };
    }
    case "navigate":
      return {
        kind: "navigate",
        url: requireString(obj, "url", "post-verify navigate step"),
        reason,
      };
    case "wait": {
      const seconds = obj["seconds"];
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error("post-verify wait step: invalid seconds");
      }
      return { kind: "wait", seconds, reason };
    }
    default:
      throw new Error(`post-verify step: unknown kind ${JSON.stringify(kind)}`);
  }
}

// Upper bound on a credential we'll accept from a labeled match.
// Real API keys / bearer tokens are short (Stripe ~32, JWT ~hundreds
// but our labeled patterns don't target JWTs). Captcha challenge
// tokens are very long: g-recaptcha-response runs ~500-2000 chars and
// cf-turnstile-response is similar. A 100-char ceiling cleanly admits
// real keys and rejects every captcha token shape we've seen.
const MAX_CREDENTIAL_LENGTH = 100;

// Substrings that, if present in a candidate, mark it as a
// challenge/cookie token rather than a credential. Cloudflare clearance
// cookies (`__cf`, `cf_clearance`), CDN challenge paths (`cdn-cgi`),
// and the visible field/param names of the two captcha widgets.
const CAPTCHA_TOKEN_MARKERS: readonly string[] = [
  "__cf",
  "cf_clearance",
  "cdn-cgi",
  "cf-turnstile-response",
  "g-recaptcha-response",
  "h-captcha-response",
];

// Distinctive service key prefixes. If a *labeled* match's value
// embeds one of these NOT at its start, the regex straddled glued UI
// text on a dense dashboard (e.g. Render's API-keys list rendered as
// "...Name bot-key Menu Key rnd_xxxx" with no separators) — the real
// key starts at the prefix, so the labeled match is contaminated and
// must be rejected. A clean labeled key either starts with its prefix
// (then the prefixed patterns above already caught it) or carries no
// known prefix at all.
const EMBEDDED_KEY_PREFIXES: readonly string[] = [
  "rnd_",
  "phc_",
  "sk_live_",
  "sk_test_",
  "pk_live_",
  "pk_test_",
];

// Pull an API key out of the *visible* page text.
//
// Two strategies, in priority order:
//   1. Known service-specific prefixes (re_, sk_live_, …) — high
//      confidence, the prefix itself is the proof.
//   2. Labeled patterns ("api key: <value>") — lower confidence, so
//      they carry guard rails: the value must sit IMMEDIATELY after
//      the label (a small bounded gap of spaces/colon/equals, NOT
//      arbitrary whitespace that could span unrelated page sections),
//      must be under MAX_CREDENTIAL_LENGTH, and must not look like a
//      captcha/cookie token. Without these, a `g-recaptcha-response`
//      value or a session token elsewhere in the body could be
//      mistaken for `credentials.api_key`.
//
// Exported for unit testing — the regex tuning here is the load-
// bearing logic and deserves direct coverage.
export function extractApiKeyFromText(text: string): string | null {
  const prefixed: readonly RegExp[] = [
    /\bre_[a-zA-Z0-9]{20,}\b/, // Resend
    /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}\b/, // Stripe secret
    // NOTE: Stripe PUBLISHABLE keys (pk_live_/pk_test_) are deliberately
    // NOT matched. A publishable key is public by design — it ships in
    // the client-side JS of every site that uses Stripe — so finding
    // one on a page means "this service embeds Stripe", not "here is
    // the user's API credential". Matching it produced a false success
    // on Mistral (its billing pk_live_ key, surfaced as the api_key).
    /\bkey-[a-f0-9]{32}\b/, // Mailgun
    /\bphc_[a-zA-Z0-9]{32,}\b/, // PostHog
    /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\b/, // SendGrid
    /\brnd_[a-zA-Z0-9]{20,}\b/, // Render
    /\bsntry[su]_[A-Za-z0-9_=\-]{20,}/, // Sentry org/user auth token
  ];
  for (const pattern of prefixed) {
    const match = text.match(pattern);
    if (match !== null) return match[0];
  }

  // Labeled patterns. The gap between label and value is
  // `[ \t]*[:=]?[ \t]*` — only spaces/tabs, never a newline — so the
  // value must be adjacent to its label. The value charset excludes
  // the captcha-token shape implicitly via the length ceiling, and we
  // re-check markers explicitly below for the dot-bearing bearer case.
  const labeled: readonly RegExp[] = [
    /(?:api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key)[ \t]*[:=]?[ \t]*([a-zA-Z0-9_\-]{20,})/i,
    /\b[Bb]earer[ \t]+([a-zA-Z0-9_\-.]{30,})/,
  ];
  for (const pattern of labeled) {
    const match = text.match(pattern);
    const candidate = match?.[1];
    if (candidate === undefined) continue;
    // A captcha challenge token: too long for a real key, and/or
    // carries a known cookie/widget marker.
    if (candidate.length > MAX_CREDENTIAL_LENGTH) continue;
    const lower = candidate.toLowerCase();
    if (CAPTCHA_TOKEN_MARKERS.some((marker) => lower.includes(marker))) continue;
    // Contaminated: the labeled match straddled glued dashboard text
    // onto a real key (the key prefix sits mid-candidate, not at 0).
    if (EMBEDDED_KEY_PREFIXES.some((p) => lower.indexOf(p) > 0)) continue;
    return candidate;
  }

  return null;
}

// Choose which link in a verification email to click. Scores each URL
// by keyword and picks the best — but only if it scored positive.
//
// Exported for unit testing. The all-negative case is the bug this
// guards: an email whose only links are unsubscribe/preferences scores
// <= 0 everywhere, and an earlier version returned links[0] anyway,
// navigating the bot straight to an unsubscribe URL.
export function pickVerificationLink(links: readonly string[]): string | null {
  const scored = links.map((url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (lower.includes("verify") || lower.includes("confirm")) score += 10;
    if (lower.includes("activate")) score += 8;
    if (lower.includes("welcome")) score += 3;
    if (lower.includes("unsubscribe") || lower.includes("preferences")) score -= 10;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top !== undefined && top.score > 0 ? top.url : null;
}

// Discriminates LLMPair from LLMClient. LLMPair has `primary` (an
// LLMClient); LLMClient has `createMessage`. They're mutually exclusive
// shapes so a structural check is reliable.
function isLLMPair(x: LLMClient | LLMPair): x is LLMPair {
  return "primary" in x && typeof x.primary === "object" && x.primary !== null;
}

export class SignupAgent {
  // Per-run counter so a single SignupAgent (which lives one run) can't
  // burn through more than MAX_LLM_CALLS_PER_SIGNUP. Reset isn't needed
  // because each signup gets a fresh SignupAgent in index.ts.
  private llmCallCount = 0;
  // Tracks which backend handled each call, for debugging cost/quality.
  // backends_used[i] is the .name string of the LLMClient that produced
  // the i-th reply this run.
  private readonly backendsUsed: string[] = [];
  private readonly llmPair: LLMPair;

  // Captcha encounter state for the current run. Updated by the
  // pre/post-submit/re-plan captcha gates in signup(); read by the
  // result builder. We track the *last* encounter (overwrites win)
  // because a "blocked" outcome is more diagnostic than an earlier
  // "solved" one and we always want the failure mode in the result.
  private captchaEncounter: SignupResult["captcha"] = undefined;

  // Helper: build the common trailing fields every SignupResult needs.
  // This used to be inlined at each return site (6 of them); a one-line
  // helper keeps the captcha field from being forgotten on a future
  // refactor that adds a 7th return path.
  private resultTail(): Pick<
    SignupResult,
    "llm_calls" | "llm_backends" | "browser_channel" | "proxied" | "captcha"
  > {
    return {
      llm_calls: this.llmCallCount,
      llm_backends: [...this.backendsUsed],
      browser_channel: this.browser.channel,
      proxied: this.browser.proxied !== null,
      ...(this.captchaEncounter !== undefined ? { captcha: this.captchaEncounter } : {}),
    };
  }

  // Run one Tier-2 visible-captcha gate. There are three gates in a
  // run (pre-submit, post-submit, re-plan). Each solveVisibleCaptcha()
  // call burns up to its 30s timeout.
  //
  // Short-circuit: Cloudflare/reCAPTCHA scoring is sticky per session
  // — once one gate reports `blocked`, every later gate is doomed to
  // the same outcome, so probing them just burns another 30s each (up
  // to 90s wasted on a run that's already lost). Once captchaEncounter
  // records a block, subsequent gates skip the browser call entirely
  // and report blocked immediately with the original kind.
  private async runCaptchaGate(
    label: string,
    steps: string[],
  ): Promise<{ found: boolean; solved: boolean; blocked: boolean; kind: CaptchaKind }> {
    if (this.captchaEncounter !== undefined && this.captchaEncounter.blocked) {
      const kind = this.captchaEncounter.kind;
      steps.push(`${label} captcha gate skipped — session already captcha-blocked (${kind}).`);
      return { found: true, solved: false, blocked: true, kind };
    }
    const result = await this.browser.solveVisibleCaptcha();
    if (!result.found) {
      return { found: false, solved: false, blocked: false, kind: "turnstile" };
    }
    steps.push(
      `${label} captcha (${result.kind}): ${result.solved ? "solved" : "NOT solved (timeout)"}`,
    );
    // Classify the widget for spike telemetry — a pure read, after the
    // solve attempt so the challenge grid (if any) has had time to render.
    const detected = await this.browser.detectCaptchaVariant();
    this.captchaEncounter = {
      kind: result.kind,
      variant: detected.variant,
      challenge_rendered: detected.challengeRendered,
      blocked: !result.solved,
    };
    return { found: true, solved: result.solved, blocked: !result.solved, kind: result.kind };
  }

  // Execute a planned set of fill/check/click actions. Used by both
  // the initial-plan and the validation re-plan paths so the step
  // logging stays consistent (the re-plan copy historically dropped
  // the per-action steps.push entries the initial path had).
  private async executePlan(
    plan: SignupPlan,
    fillValues: Record<FillValueKind, string>,
    steps: string[],
    bySelector: Map<string, InteractiveElement>,
  ): Promise<void> {
    for (const action of plan.actions) {
      const el = bySelector.get(action.selector);
      // Belt-and-suspenders: the planner is told to skip
      // cookie-consent elements; never act on one even if it slips
      // through (Render's TOS check hit an Osano consent toggle).
      if (el !== undefined && el.inConsentWidget) {
        steps.push(`Skip ${action.kind} ${action.selector} — inside a cookie-consent widget`);
        continue;
      }
      try {
        if (action.kind === "fill") {
          // `literal` is per-action; everything else is a fixed value.
          const value =
            action.value_kind === "literal"
              ? action.literal ?? ""
              : fillValues[action.value_kind];
          if (el !== undefined && el.tag === "select") {
            // A <select> needs selectOption, not type() (Sentry bug).
            steps.push(`Select ${action.selector}`);
            await this.browser.selectOption(action.selector);
          } else {
            steps.push(`Fill ${action.value_kind} → ${action.selector}`);
            await this.browser.type(action.selector, value);
          }
        } else if (action.kind === "check") {
          steps.push(`Check ${action.selector} (${action.reason})`);
          await this.browser.check(action.selector);
        } else {
          steps.push(`Click ${action.selector} (${action.reason})`);
          await this.browser.click(action.selector);
        }
      } catch (err) {
        steps.push(
          `⚠ action failed (${action.kind} ${action.selector}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // continue — a missing optional field shouldn't abort the whole signup
      }
    }
  }

  // F3 T5: the verify-and-replan loop. Builds a DOM-grounded element
  // inventory, has the planner pick from it, verifies the picks
  // resolve, executes, and submits. A bad pick re-plans instead of
  // cascading through 10s timeouts. Replan caps are split (Tension
  // 3): a selector-miss ("the bot erred") is capped tight; a reveal
  // click or a post-submit validation error ("the page advanced")
  // gets more headroom. All bounded by the 15-call LLM breaker + the
  // F2 top-level deadline.
  private async planExecuteWithRetry(
    task: SignupTask,
    fillValues: Record<FillValueKind, string>,
    steps: string[],
  ): Promise<PlanExecOutcome> {
    const MAX_ERROR_REPLANS = 2;
    const MAX_PROGRESS_REPLANS = 4;
    let errorReplans = 0;
    let progressReplans = 0;
    let emptyPlans = 0;
    let hint: string | undefined;

    const oauthProvider = task.oauthProvider;
    for (;;) {
      await this.browser.waitForFormReady();
      await saveDebugSnapshot(this.browser, "before-fill");
      const state = await this.browser.getState();
      const inventory = await this.buildInventory(steps, oauthProvider);

      // T6/T13 — OAuth-first: when an OAuth signup is requested and the
      // page carries a "Sign in with <provider>" affordance, the OAuth
      // button unconditionally outranks any form field (a rule, not
      // score arithmetic — spec refinement). Hand off to the OAuth
      // consent flow. Absent the affordance, fall through to form-fill.
      if (oauthProvider !== undefined) {
        const oauthButton = findOAuthButton(inventory, oauthProvider);
        const label = OAUTH_PROVIDERS[oauthProvider].label;
        if (oauthButton !== null) {
          steps.push(
            `OAuth-first: found a ${label} sign-in affordance ` +
              `(${JSON.stringify(oauthButton.visibleText ?? oauthButton.ariaLabel ?? label)}) ` +
              `— taking the OAuth path`,
          );
          return { kind: "oauth", selector: oauthButton.selector };
        }
        steps.push(
          `OAuth-first requested but no ${label} affordance on the page — ` +
            `falling back to form-fill`,
        );
      }

      // OAuth-only: no fillable input AND no button that reads as an
      // email-signup option — nothing to automate (Issue 4).
      if (isOauthOnlyChooser(inventory)) {
        return { kind: "oauth_required" };
      }

      steps.push("Asking Claude to plan the signup form fill...");
      let plan: SignupPlan;
      try {
        plan = await this.planSignupForm({
          service: task.service,
          url: state.url,
          inventory,
          screenshot: state.screenshot,
          ...(hint !== undefined ? { hint } : {}),
        });
      } catch (err) {
        // Parse/validation failure — includes a hallucinated selector
        // rejected by the inventory check. An error replan.
        const reason = err instanceof Error ? err.message : String(err);
        if (++errorReplans > MAX_ERROR_REPLANS) {
          return { kind: "planning_failed", reason: `planner output never validated: ${reason}` };
        }
        steps.push(`⚠ plan rejected (${reason}) — re-planning`);
        hint =
          "Your previous plan used a selector not in the inventory. Use ONLY selectors copied verbatim from a `selector=` field.";
        continue;
      }
      steps.push(
        `Plan: ${plan.actions.length} action(s), confidence=${plan.confidence}` +
          (plan.notes !== undefined ? ` — ${plan.notes}` : ""),
      );

      // Verify the picks resolve on the live page — also catches a
      // stale selector resolving to a recycled wrong node (Tension 4).
      const bySelector = new Map(inventory.map((e) => [e.selector, e]));
      const miss = await this.verifyPlan(plan, bySelector);
      if (miss !== null) {
        if (++errorReplans > MAX_ERROR_REPLANS) {
          return { kind: "planning_failed", reason: `planned selectors kept missing: ${miss}` };
        }
        steps.push(`⚠ planned selectors did not verify (${miss}) — re-planning`);
        hint = `These selectors did not resolve correctly: ${miss}. Pick different inventory entries.`;
        if (miss.includes("not a checkbox")) {
          // SendPulse: no real TOS checkbox exists, so the planner
          // kept picking the link, then the submit button. Tell it to
          // DROP the check rather than substitute another wrong pick.
          hint +=
            " If the inventory has NO input of type=checkbox, OMIT the check" +
            " action entirely — do not substitute a link or a button. The" +
            " agreement may be implicit or pre-accepted.";
        }
        continue;
      }

      await this.executePlan(plan, fillValues, steps, bySelector);

      // A plan with no fill actions either revealed/advanced the page
      // (a cookie banner, a two-stage "sign up with email" chooser) —
      // worth a re-plan — or found nothing actionable at all. A
      // 0-action plan revealed *nothing*: re-extracting the same
      // static page won't help, so a second consecutive empty plan is
      // a dead end. (The 0.1.12 loop spun this 4x on Axiom.)
      const hadFill = plan.actions.some((a) => a.kind === "fill");
      if (!hadFill) {
        if (plan.actions.length === 0) {
          emptyPlans += 1;
          if (emptyPlans >= 2) {
            return {
              kind: "planning_failed",
              reason:
                "no fillable form on the page — the planner found no input fields or actionable elements",
            };
          }
        } else {
          emptyPlans = 0;
        }
        if (++progressReplans > MAX_PROGRESS_REPLANS) {
          return { kind: "planning_failed", reason: "never reached a fillable form" };
        }
        steps.push(
          plan.actions.length === 0
            ? "Plan found nothing to act on — re-checking once for a late render"
            : "Plan only revealed the page — re-planning the now-visible form",
        );
        hint =
          "The previous step revealed or advanced the page. Plan the signup form that should now be visible.";
        continue;
      }

      // Captcha gate + submit.
      const preGate = await this.runCaptchaGate("Pre-submit", steps);
      if (preGate.blocked) return { kind: "captcha_blocked", captchaKind: preGate.kind };

      steps.push(`Submit → ${plan.submit_selector}`);
      try {
        await this.browser.clickSubmit(plan.submit_selector);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // A disabled submit means the form filled but a required
        // control gates submission — re-plan to satisfy it (a
        // progress replan), don't fail the run outright.
        if (reason.startsWith("submit_disabled")) {
          if (++progressReplans > MAX_PROGRESS_REPLANS) {
            return { kind: "submit_failed", reason };
          }
          steps.push(`⚠ ${reason} — re-planning to satisfy it`);
          hint =
            "The submit button is disabled — a required field or an agreement " +
            "was not satisfied. Find the agreement CHECKBOX (an input of " +
            "type=checkbox, NOT a link to the terms page) and check it.";
          continue;
        }
        steps.push(`⚠ submit click failed: ${reason}`);
        return { kind: "submit_failed", reason };
      }
      await this.browser.wait(5);

      const postGate = await this.runCaptchaGate("Post-submit", steps);
      if (postGate.blocked) return { kind: "captcha_blocked", captchaKind: postGate.kind };
      if (postGate.found && postGate.solved) {
        // Re-click submit so the populated token ships with the form.
        try {
          await this.browser.click(plan.submit_selector);
          await this.browser.wait(3);
        } catch (err) {
          steps.push(
            `⚠ post-captcha submit retry failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Post-submit validation errors → the page advanced; re-plan
      // against the new state (a progress replan).
      const afterText = (await this.browser.extractText()).slice(0, 4000);
      if (this.looksLikeValidationFailure(afterText)) {
        if (++progressReplans > MAX_PROGRESS_REPLANS) {
          // Out of replan headroom — proceed; credential extraction
          // confirms whether the signup actually went through.
          return { kind: "submitted" };
        }
        steps.push("Post-submit validation errors — re-planning");
        hint = `The previous submit produced validation errors. Visible page text: ${afterText.slice(0, 600)}`;
        continue;
      }
      return { kind: "submitted" };
    }
  }

  // Extract + rank the page's interactive elements (F3 T1/T2).
  // `oauthProvider` keeps that provider's OAuth affordance from being
  // ranked out of the capped inventory when an OAuth-first signup is
  // requested (T6/T13). `buttonCap` widens for the post-OAuth
  // onboarding loop: a dashboard carries far more nav links than a
  // signup form, and they do not score as signup buttons, so the
  // default cap would drop the "API Keys"/"Settings" links the
  // onboarding planner must reach.
  private async buildInventory(
    steps: string[],
    oauthProvider?: OAuthProviderId,
    buttonCap = 25,
  ): Promise<InteractiveElement[]> {
    const raw = await this.browser.extractInteractiveElements();
    const { inventory, buttonsDropped } = rankAndCapInventory(raw, buttonCap, oauthProvider);
    steps.push(
      `Inventory: ${inventory.length} element(s)` +
        (buttonsDropped > 0 ? ` (${buttonsDropped} low-ranked button(s) dropped)` : ""),
    );
    return inventory;
  }

  // Verify every selector the plan references still resolves on the
  // live page, and — when the inventory entry had an id — that it
  // resolves to that same element (Tension 4: a stale structural
  // selector can resolve to a recycled wrong node). Returns a
  // human-readable miss list, or null when every selector is good.
  private async verifyPlan(
    plan: SignupPlan,
    bySelector: Map<string, InteractiveElement>,
  ): Promise<string | null> {
    const selectors = [...plan.actions.map((a) => a.selector), plan.submit_selector];
    const misses: string[] = [];
    for (const sel of new Set(selectors)) {
      const info = await this.browser.inspectSelector(sel);
      if (info.count === 0) {
        misses.push(sel);
        continue;
      }
      const inv = bySelector.get(sel);
      if (inv !== undefined && inv.id !== null && info.id !== inv.id) {
        misses.push(`${sel} (resolved to the wrong element)`);
      }
    }
    // A `check` action must target an actual checkbox/radio. The
    // planner sometimes picks the adjacent "Terms of Service" *link*
    // (SendPulse) — page.check() can't tick a link, so reject it and
    // force a re-plan onto the real agreement checkbox.
    for (const a of plan.actions) {
      if (a.kind !== "check") continue;
      const el = bySelector.get(a.selector);
      const checkable =
        el !== undefined &&
        ((el.tag === "input" &&
          (el.type === "checkbox" || el.type === "radio")) ||
          el.role === "checkbox" ||
          el.role === "radio");
      if (!checkable) {
        misses.push(
          `${a.selector} (not a checkbox — pick the actual agreement checkbox, not a link)`,
        );
      }
    }
    return misses.length > 0 ? misses.join(", ") : null;
  }

  constructor(
    private browser: BrowserController,
    llm?: LLMClient | LLMPair,
  ) {
    if (llm === undefined) {
      this.llmPair = pickLLMPair({ preferCheap: PREFER_CHEAP_LLM });
    } else if (isLLMPair(llm)) {
      // Caller passed an explicit LLMPair — use it directly so they
      // control both primary and premium-fallback selection.
      this.llmPair = llm;
    } else {
      // Caller passed a single LLMClient — no premium fallback in that
      // case. Tests and the MCP-Sampling future path use this.
      this.llmPair = { primary: llm, premium: null };
    }
  }

  // Read-only view of how many calls landed on which backend. Exported
  // through SignupResult.llm_backends so tests and ops can verify the
  // dual-mode fallback is actually engaging when expected.
  get backends(): readonly string[] {
    return this.backendsUsed;
  }

  // Single entry point for every LLM call. Increments the per-run
  // counter, throws if we'd exceed the budget. When a `parse` callback
  // is supplied and the primary's reply fails to parse, this method
  // automatically retries once with the premium client (if available).
  // The retry counts against the same budget.
  private async callLLM<T>(args: {
    system: string;
    userBlocks: LLMBlock[];
    maxTokens: number;
    // Optional validator. When supplied, raw → T conversion happens here
    // so callLLM can detect a parse failure and trigger the premium
    // retry without the caller having to thread that logic through.
    parse?: (raw: string) => T;
  }): Promise<T extends undefined ? string : T> {
    // Use a typed helper because the conditional return type confuses
    // the inner narrowing.
    return (await this.callLLMInner(args)) as T extends undefined ? string : T;
  }

  private async callLLMInner<T>(args: {
    system: string;
    userBlocks: LLMBlock[];
    maxTokens: number;
    parse?: (raw: string) => T;
  }): Promise<T | string> {
    const callOne = async (client: LLMClient): Promise<string> => {
      if (this.llmCallCount >= MAX_LLM_CALLS_PER_SIGNUP) {
        throw new LLMCallBudgetExceeded(MAX_LLM_CALLS_PER_SIGNUP);
      }
      this.llmCallCount += 1;
      const resp = await client.createMessage({
        system: args.system,
        user: args.userBlocks,
        max_tokens: args.maxTokens,
      });
      this.backendsUsed.push(resp.backend);
      return resp.text;
    };

    const primaryRaw = await callOne(this.llmPair.primary);
    if (args.parse === undefined) return primaryRaw;
    try {
      return args.parse(primaryRaw);
    } catch (primaryErr) {
      // Primary couldn't produce a parseable reply. If we have a premium
      // fallback, retry once with it. The premium retry uses the SAME
      // prompt — Sonnet is consistently better at structured JSON, so a
      // fresh look at the same input usually suffices.
      if (this.llmPair.premium === null) throw primaryErr;
      const premiumRaw = await callOne(this.llmPair.premium);
      try {
        return args.parse(premiumRaw);
      } catch (premiumErr) {
        // Both failed. Surface the premium error because it's the more
        // informative one (Sonnet's "I can't comply" is more diagnostic
        // than Gemini's "{ actions: [... unbalanced bracket}").
        throw premiumErr;
      }
    }
  }

  // Run the right flavor of prewarm against a URL and update both the
  // visible step trail and the persistent cache. Failures are
  // swallowed (logged into steps[]) because prewarm is always best-
  // effort — its value is conditioning the next page load, and a
  // missing prewarm just means we hit that page cold.
  private async runPrewarm(url: string, steps: string[]): Promise<void> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      // Caller passed something un-parseable. Don't bother trying.
      return;
    }

    let mode: "fast" | "referrer-chain";
    try {
      mode = (await wasRecentlyPrewarmed(origin)) ? "fast" : "referrer-chain";
    } catch {
      // Cache read fail — bias toward the cheap mode so we don't blow
      // 30s on every signup when the cache file is unreadable.
      mode = "fast";
    }

    steps.push(`Prewarming ${origin} (${mode})`);
    try {
      await this.browser.prewarm(url, mode);
      // Only record on success — and only when we did the meaningful
      // (referrer-chain) prewarm. A fast prewarm against a cold cache
      // shouldn't pretend we've done the work.
      if (mode === "referrer-chain") {
        try {
          await recordPrewarmSuccess(origin);
        } catch {
          // Cache write failure already logged in prewarm-cache module.
        }
      }
    } catch (err) {
      steps.push(
        `⚠ prewarm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Hard top-level deadline (F2). Every sub-step is individually
  // bounded, but the 2026-05-16 sweep still produced 50-minute hangs —
  // a stall outside the timed paths (a wedged navigation or LLM call).
  // This race guarantees signup() always returns; the caller's
  // finally{} closes the browser, which aborts whatever Playwright
  // call hung. Override the 10-minute default with
  // UNIVERSAL_BOT_RUN_TIMEOUT_MS.
  async signup(task: SignupTask): Promise<SignupResult> {
    const steps: string[] = [];
    const rawTimeout = Number(process.env.UNIVERSAL_BOT_RUN_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<SignupResult>((resolve) => {
      timer = setTimeout(() => {
        const secs = Math.round(timeoutMs / 1000);
        steps.push(`⚠ run exceeded ${secs}s — aborting`);
        resolve({
          success: false,
          error: `run_timeout: exceeded ${secs}s`,
          steps,
          ...this.resultTail(),
        });
      }, timeoutMs);
    });
    const work = this.runSignup(task, steps);
    // If the deadline wins, runSignup keeps going until the browser is
    // closed under it — swallow that late rejection so it is not an
    // unhandled rejection.
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async runSignup(task: SignupTask, steps: string[]): Promise<SignupResult> {
    const password = task.generatePassword();
    const displayName = "Trusty Squire Bot";
    const username = `tsbot${Date.now().toString().slice(-7)}`;

    try {
      // Step 1: Navigate to signup page
      const signupUrl =
        task.signupUrl ?? `https://www.google.com/search?q=${encodeURIComponent(`${task.service} signup`)}`;

      // Prewarm the target origin before hitting the (often-strict) signup
      // page. Two things this buys us:
      //   1. First-party cookies on the root domain. Cloudflare's
      //      cf_clearance + reCAPTCHA v3's score JS both record a
      //      browsing-history signal; a cold landing on /sign_up reads
      //      as bot-like vs. a session that visited the marketing root
      //      first.
      //   2. A wall-clock window for the scoring JS to calibrate on a
      //      benign page. Postmark and Resend both ship reCAPTCHA v3 /
      //      Turnstile that scores the whole session, not just the
      //      submit moment.
      //
      // Mode selection: the heavy "referrer-chain" prewarm is what
      // actually moves the v3 score (~30-45s of wall clock; google
      // search → click → scroll → navigate). The light "fast" mode
      // is dwell-only (~2s). We use the cache to decide: cold cache
      // means do the heavy one and cache the result; warm cache means
      // we've recently established cookies for this domain and the
      // light version is enough.
      //
      // Skip entirely when the URL is a Google-search fallback (no
      // real origin to warm) or when prewarm itself fails (don't fail
      // the run just because the marketing site is down).
      if (task.signupUrl !== undefined) {
        await this.runPrewarm(signupUrl, steps);
      }

      steps.push(`Navigating to ${signupUrl}`);
      await this.browser.goto(signupUrl);
      await this.browser.wait(2);

      if (task.signupUrl === undefined) {
        steps.push("Searching for signup page...");
        const found = await this.findSignupLink();
        if (found !== null) {
          // Now that we know the real signup origin, prewarm it before
          // the deep navigation. Same rationale as above.
          await this.runPrewarm(found, steps);
          steps.push(`Found signup link: ${found}`);
          await this.browser.goto(found);
          await this.browser.wait(2);
        }
      }

      // Steps 2-5: plan the form, fill it, submit — via the
      // verify-and-replan loop (F3). The planner picks selectors from
      // a DOM-grounded element inventory; a bad pick re-plans instead
      // of cascading through 10s timeouts to total failure.
      const fillValues: Record<FillValueKind, string> = {
        email: task.email,
        password,
        name: displayName,
        username,
        company: "Trusty Squire",
        // `literal` has no fixed value — resolved per-action.
        literal: "",
      };
      const outcome = await this.planExecuteWithRetry(task, fillValues, steps);
      switch (outcome.kind) {
        case "captcha_blocked":
          return {
            success: false,
            error: `captcha_blocked: ${outcome.captchaKind} challenge did not resolve. The site flagged this session.`,
            steps,
            ...this.resultTail(),
          };
        case "submit_failed":
          return {
            success: false,
            error: `submit_failed: could not click the signup button — ${outcome.reason}`,
            steps,
            ...this.resultTail(),
          };
        case "planning_failed":
          return {
            success: false,
            error: `planning_failed: ${outcome.reason}`,
            steps,
            ...this.resultTail(),
          };
        case "oauth_required":
          return {
            success: false,
            error: `oauth_required: ${task.service} offers only OAuth/SSO signup — there is no email/password form to automate.`,
            steps,
            ...this.resultTail(),
          };
        case "oauth":
          // T6/T7 — OAuth-first path. runOAuthFlow drives the consent
          // handshake and post-OAuth onboarding to its own terminal
          // SignupResult; there is no form submit / email verification.
          return await this.runOAuthFlow(task, outcome.selector, steps);
        case "submitted":
          break;
      }
      await saveDebugSnapshot(this.browser, "after-submit");

      // Step 6: Extract creds from page.
      steps.push("Extracting credentials from page...");
      let credentials = await this.extractCredentials();

      // Step 7: Email verification + post-verification navigation.
      let verificationFailed: string | undefined;
      if (credentials.api_key === undefined && credentials.username === undefined && task.inbox !== undefined) {
        // S3: don't blind-wait. Read the post-submit page first. If it
        // explicitly tells the user to check their email, poll the full
        // timeout. If it does not, the service most likely sent no
        // verification email — run a short probe instead of dead air.
        const expectsEmail = expectsVerificationEmail(await this.browser.extractText());
        const verificationTimeoutSeconds = expectsEmail
          ? (task.verificationTimeoutSeconds ?? 180)
          : VERIFICATION_PROBE_SECONDS;
        steps.push(
          expectsEmail
            ? `Post-submit page asks to check email — polling inbox (up to ${verificationTimeoutSeconds}s)...`
            : `Post-submit page shows no "check your email" prompt — short ${verificationTimeoutSeconds}s probe (S3: the service likely sent no verification email)...`,
        );
        try {
          const email = await this.waitForVerificationEmail(
            task.inbox,
            task.email,
            verificationTimeoutSeconds,
          );
          steps.push(`Received: "${email.subject}" from ${email.from_address}`);

          if (email.parsed_links.length > 0) {
            const verifyLink = this.pickVerificationLink(Array.from(email.parsed_links));
            if (verifyLink !== null) {
              steps.push(`Following verification link: ${verifyLink}`);
              await this.browser.goto(verifyLink);
              await this.browser.wait(3);
              await saveDebugSnapshot(this.browser, "after-verify");

              // Try extracting first — many services drop the API key
              // straight onto the landing page after verification.
              credentials = await this.extractCredentials();

              // If no creds yet, run the Claude-planned navigation loop.
              if (credentials.api_key === undefined && credentials.username === undefined) {
                const maxRounds = task.postVerifyMaxRounds ?? 6;
                credentials = await this.postVerifyLoop({
                  service: task.service,
                  credentials: { email: task.email, password },
                  maxRounds,
                  steps,
                });
              }
            } else {
              steps.push("Email had no usable verification link.");
            }
          } else {
            steps.push("Email had no parsed links — skipping verification click.");
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          steps.push(`Inbox poll failed: ${detail}`);
          verificationFailed = expectsEmail
            ? `verification_not_sent: form submitted and the page asked to check email, but none arrived in ${verificationTimeoutSeconds}s — the service likely withheld it (anti-abuse) or requires manual signup`
            : `verification_not_sent: form submitted but the page never prompted to check email and none arrived in the ${verificationTimeoutSeconds}s probe — the service most likely dispatched no verification email`;
        }
      }

      if (credentials.api_key !== undefined || credentials.username !== undefined) {
        return {
          success: true,
          credentials: { ...credentials, password, email: task.email },
          steps,
          ...this.resultTail(),
        };
      }

      return {
        success: false,
        error: verificationFailed ?? "Could not find credentials on page or via email",
        steps,
        ...this.resultTail(),
      };
    } catch (error) {
      // Budget-exceeded is a structured error we want to surface as
      // such, rather than burying as a generic failure.
      const errorMessage =
        error instanceof LLMCallBudgetExceeded
          ? `LLM budget exceeded (${this.llmCallCount} calls) — likely stuck in a planning loop. Consider raising UNIVERSAL_BOT_MAX_LLM_CALLS or inspecting the steps.`
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        success: false,
        error: errorMessage,
        steps,
        ...this.resultTail(),
      };
    }
  }

  // ------------ OAuth-first signup (T6/T7/T13) ------------

  // Drive an OAuth signup (Google or GitHub) to a terminal
  // SignupResult. Entered from runSignup when planExecuteWithRetry
  // found the provider's affordance (T6). Steps: click the button →
  // walk the consent screens → scope-gate them → drive post-OAuth
  // onboarding to the API key.
  //
  // THE CRITICAL GUARANTEE (D4 / eng-review critical gap): if the flow
  // lands on the provider's credential form (expired/missing session)
  // or a security challenge, it hands back `needs_login` and NEVER
  // types into that form. Driving the provider's login is exactly what
  // trips its automation detection — and there is no password to give.
  private async runOAuthFlow(
    task: SignupTask,
    oauthSelector: string,
    steps: string[],
  ): Promise<SignupResult> {
    const provider = OAUTH_PROVIDERS[task.oauthProvider ?? "google"];
    const loginCmd =
      provider.id === "github"
        ? "npx @trusty-squire/mcp login --provider=github"
        : "npx @trusty-squire/mcp login";
    steps.push(`OAuth: clicking the ${provider.label} sign-in affordance`);
    await this.browser.startOAuth(oauthSelector);
    await this.browser.wait(3);
    await saveDebugSnapshot(this.browser, "oauth-after-click");

    // Bounded consent walk — handles account-chooser → consent as two
    // steps without ever spinning. Each iteration re-reads the page.
    const MAX_OAUTH_NAV = 6;
    for (let i = 0; i < MAX_OAUTH_NAV; i++) {
      if (this.browser.oauthPageClosed()) {
        steps.push(
          `OAuth: the ${provider.label} window closed — handshake returned to the service`,
        );
        break;
      }
      const url = this.browser.currentUrl();
      let body: string;
      try {
        body = (await this.browser.extractText()).slice(0, 4000);
      } catch {
        // The page is navigating between provider screens — re-read.
        await this.browser.wait(1);
        continue;
      }
      const authState = provider.classifyAuthState(url, body);
      steps.push(`OAuth: ${provider.label} auth state = ${authState}`);

      if (authState === "not_provider") break; // flow left the provider — back on the service

      if (authState === "challenge") {
        return this.oauthAbort(
          "needs_login",
          `${provider.label} interrupted the sign-in with a security challenge ("verify it's you"). ` +
            `Re-run \`${loginCmd}\`, clear the challenge in the window, then retry.`,
          steps,
        );
      }
      if (authState === "needs_login") {
        return this.oauthAbort(
          "needs_login",
          `the bot's ${provider.label} session is missing or expired — no consent screen was reached. ` +
            `Re-run \`${loginCmd}\` to re-establish it, then retry.`,
          steps,
        );
      }

      // authState === "consent". Backstop the page classifier with a
      // live-DOM check: if the page actually carries a credential
      // field it is a login form (the text classifier can catch a
      // login page that says "to continue to <app>"). Hand back —
      // never type into it.
      if (await this.oauthLoginFormPresent()) {
        return this.oauthAbort(
          "needs_login",
          `landed on a ${provider.label} sign-in form — the session is missing or expired. ` +
            `Re-run \`${loginCmd}\`, then retry. The bot will not type into ${provider.label}'s login form.`,
          steps,
        );
      }

      // Genuine consent screen / account chooser — scope-gate it (T7).
      const scopes = extractOAuthScopes(url);
      if (scopes === null) {
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `reached a ${provider.label} consent screen but could not read its requested scopes ` +
            `from the URL — pausing for manual review rather than approving blind.`,
          steps,
        );
      }
      if (!provider.scopesAreBasic(scopes)) {
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `the consent screen requests scopes beyond basic identity (${scopes.join(", ")}). ` +
            `Approve it manually — the bot only auto-approves basic-identity scopes.`,
          steps,
        );
      }
      steps.push(`OAuth: consent scopes all basic (${scopes.join(", ")}) — auto-approving`);
      const advanced = await this.browser.advanceOAuthConsent(provider.id);
      if (!advanced) {
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `reached a ${provider.label} consent screen but found no approve control to click — ` +
            `approve it manually.`,
          steps,
        );
      }
      await this.browser.wait(3);
    }

    // Handshake done — restore the product page (popup flow is a no-op
    // for same-tab redirects) and drive post-OAuth onboarding.
    await this.browser.settleAfterOAuth();
    await this.browser.wait(2);
    await saveDebugSnapshot(this.browser, "oauth-post-consent");
    steps.push(
      `OAuth: signed in via ${provider.label} — driving post-OAuth onboarding to the API key`,
    );

    let credentials = await this.extractCredentials();
    if (credentials.api_key === undefined) {
      credentials = await this.postVerifyLoop({
        service: task.service,
        maxRounds: task.postVerifyMaxRounds ?? 12,
        steps,
      });
    }
    if (credentials.api_key !== undefined) {
      return {
        success: true,
        credentials: { ...credentials },
        steps,
        ...this.resultTail(),
      };
    }

    // No API key. Distinguish a billing/card wall (onboarding_blocked)
    // from a generic navigation miss — never grep-loop a paid wall.
    const finalText = (await this.browser.extractText().catch(() => "")).toLowerCase();
    if (ONBOARDING_PAYWALL_PATTERNS.some((p) => finalText.includes(p))) {
      return {
        success: false,
        error:
          `onboarding_blocked: ${task.service}'s API key sits behind a billing or ` +
          `payment-method wall the bot will not cross — finish the signup manually.`,
        steps,
        ...this.resultTail(),
      };
    }
    return {
      success: false,
      error:
        `oauth_onboarding_failed: signed in to ${task.service} via ${provider.label} but ` +
        `could not reach an API key through post-OAuth onboarding.`,
      steps,
      ...this.resultTail(),
    };
  }

  // Build a terminal SignupResult for an aborted OAuth run. `prefix`
  // is the error tag provision-any.ts maps to a tool status
  // (needs_login, oauth_consent_needs_review).
  private oauthAbort(prefix: string, detail: string, steps: string[]): SignupResult {
    steps.push(`OAuth aborted (${prefix}): ${detail}`);
    return {
      success: false,
      error: `${prefix}: ${detail}`,
      steps,
      ...this.resultTail(),
    };
  }

  // Backstop for the critical guarantee (D4): true when the active
  // provider page carries a credential-entry field — an expired/missing
  // session dropped the bot on a login form. A genuine consent screen
  // or account chooser has buttons/tiles only, no text inputs.
  private async oauthLoginFormPresent(): Promise<boolean> {
    const inv = await this.browser.extractInteractiveElements();
    return inv.some(
      (e) =>
        e.tag === "input" &&
        (e.type === "email" ||
          e.type === "password" ||
          e.type === "text" ||
          e.type === "tel" ||
          e.type === null),
    );
  }

  // ------------ Claude planner ------------

  private async planSignupForm(input: {
    service: string;
    url: string;
    inventory: InteractiveElement[];
    screenshot: string; // base64
    hint?: string;
  }): Promise<SignupPlan> {
    const systemPrompt = `You plan how to fill a web signup form.

You are given a screenshot of the page and an INVENTORY of its
interactive elements — each line carries a precise \`selector=\` the
bot has already verified resolves. Your job: pick which inventory
elements to fill / check / click.

Output rules:
- Reply with ONE JSON object only. No prose, no markdown.
- Schema:
  {
    "actions": [
      {"kind":"fill","selector":"<a selector= copied verbatim from the inventory>","value_kind":"email|password|name|username|company|literal","literal":"only when value_kind=literal","reason":"why"},
      {"kind":"check","selector":"<from inventory>","reason":"TOS checkbox etc."},
      {"kind":"click","selector":"<from inventory>","reason":"e.g. reveal the email form"}
    ],
    "submit_selector": "<a selector= from the inventory — the primary signup button>",
    "confidence": "high|medium|low",
    "notes": "optional"
  }
- CRITICAL: every "selector" you emit MUST be copied verbatim from a
  \`selector=\` field in the inventory below. Never invent, guess, or
  modify a selector. A selector not in the inventory is rejected and
  you will be asked to re-plan.
- Include the TOS/agree checkbox ONLY if the inventory has a real input of type=checkbox for it. If there is no such checkbox, OMIT the check action entirely — never substitute a link or a button.
- Skip elements marked [cookie-consent — avoid], and skip optional
  marketing-opt-in checkboxes.
- Do NOT add a separate password-confirmation fill unless the
  inventory shows a second password field.
- Two-stage pages: if the inventory has only buttons (e.g. "Sign up
  with email" / "Continue with Google") and no input fields, emit a
  single click action on the EMAIL-signup button, and set
  submit_selector to that same button.
- For "name" use a realistic full name; for "username" a plausible
  7-15 char handle.`;

    const hintLine = input.hint !== undefined ? `\nHint: ${input.hint}` : "";
    const userBlocks: LLMBlock[] = [
      { kind: "image", media_type: "image/png", data_base64: input.screenshot },
      {
        kind: "text",
        text: `Service: ${input.service}
URL: ${input.url}${hintLine}

Interactive element inventory:
${formatInventory(input.inventory)}`,
      },
    ];

    // F3 T4: the planner may only pick selectors the bot supplied.
    const allowed = new Set(input.inventory.map((e) => e.selector));
    return this.callLLM({
      system: systemPrompt,
      userBlocks,
      maxTokens: 1500,
      parse: (raw) => parseSignupPlan(raw, allowed),
    });
  }

  private looksLikeValidationFailure(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes("must be between") ||
      t.includes("is required") ||
      t.includes("please accept") ||
      t.includes("required field") ||
      t.includes("invalid email") ||
      t.includes("password must")
    );
  }

  private pickVerificationLink(links: string[]): string | null {
    return pickVerificationLink(links);
  }

  // The InboxClient long-poll caps at 120s server-side (matches the API
  // contract). To wait longer we just loop. We also re-issue with a fresh
  // matcher each pass — services occasionally send a "complete signup"
  // email rather than "verify", and that broader matcher catches both.
  private async waitForVerificationEmail(
    inbox: AgentInbox,
    alias: string,
    totalSeconds: number,
  ): Promise<{
    subject: string;
    from_address: string;
    parsed_links: ReadonlyArray<string>;
  }> {
    const deadline = Date.now() + totalSeconds * 1000;
    const pattern = /verify|confirm|welcome|activate|complete|finish|set\s*up/i;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      const remainingSeconds = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
      const window = Math.min(remainingSeconds, 90);
      try {
        const email = await inbox.waitForEmail({
          alias,
          matcher: { subject: pattern },
          timeout_seconds: window,
        });
        return email;
      } catch (err) {
        lastErr = err;
        // EmailTimeoutError: keep looping until our own deadline.
        // Other errors (alias inactive, network): bail.
        const message = err instanceof Error ? err.message : String(err);
        if (!/timeout|timed out/i.test(message)) throw err;
      }
    }
    throw lastErr ?? new Error("verification email did not arrive in time");
  }

  // Drive the browser toward the API key after the account exists —
  // used by BOTH the email-verification path and the OAuth path (T9).
  // Each round asks Claude what to do next given the current page; we
  // stop when Claude says "done" or when we extract a credential.
  // Bounded by maxRounds so a confused agent can't burn the context.
  //
  // T9 — decoupled from email+password. `credentials` is present only
  // on the email-verification path, where the loop may need to sign in
  // with the just-created account (SendPulse). On the OAuth path it is
  // absent: there is no password, and the Google session already
  // authenticated the user — a `login` step is then a no-op.
  private async postVerifyLoop(args: {
    service: string;
    credentials?: { email: string; password: string } | undefined;
    maxRounds: number;
    steps: string[];
  }): Promise<Record<string, string>> {
    let credentials = await this.extractCredentials();
    let loginAttempts = 0;
    let planFailures = 0;
    const oauth = args.credentials === undefined;
    // Re-plan hint for the next round — set when an `extract` step
    // found no key, which means the visible key text is masked /
    // truncated (the S3-class trap: the planner sees a key-shaped
    // string and keeps asking to extract it forever), or when the
    // planner's last step was rejected.
    let hint: string | undefined;
    for (let round = 0; round < args.maxRounds; round++) {
      if (credentials.api_key !== undefined || credentials.username !== undefined) {
        args.steps.push(`Post-verify: credentials found on round ${round}.`);
        return credentials;
      }
      // Settle the page first — the previous round's click may have
      // triggered a navigation, and reading a page mid-navigation
      // throws "execution context destroyed". waitForFormReady is
      // best-effort (swallows its own timeouts).
      await this.browser.waitForFormReady();
      // DOM-grounded inventory so the planner picks verified selectors
      // instead of inventing CSS that never resolves. A dashboard has
      // far more nav links than a signup form, so the button cap is
      // widened (the "API Keys"/"Settings" links must survive ranking).
      // Reading state can still race a navigation — a transient throw
      // burns the round rather than crashing the whole run.
      let state: BrowserState;
      let inventory: InteractiveElement[];
      try {
        state = await this.browser.getState();
        inventory = await this.buildInventory(args.steps, undefined, 80);
      } catch (err) {
        args.steps.push(
          `Post-verify round ${round}: page was mid-navigation ` +
            `(${err instanceof Error ? err.message : String(err)}) — retrying`,
        );
        await this.browser.wait(2);
        continue;
      }
      let nextStep: PostVerifyStep;
      try {
        nextStep = await this.planPostVerifyStep({
          service: args.service,
          round,
          maxRounds: args.maxRounds,
          state,
          oauth,
          inventory,
          ...(hint !== undefined ? { hint } : {}),
        });
      } catch (err) {
        // The planner's output did not validate — most often a
        // selector not in the inventory (the model copied the whole
        // line, not just the `selector=` value). Re-plan with a hint
        // rather than abandon the run, the same resilience the
        // form-fill planner has. Bounded so a persistently broken
        // planner still terminates.
        const reason = err instanceof Error ? err.message : String(err);
        planFailures += 1;
        if (planFailures > 3) {
          args.steps.push(
            `Post-verify round ${round}: planner failed ${planFailures}x (${reason}) — stopping.`,
          );
          break;
        }
        args.steps.push(`Post-verify round ${round}: planner output rejected (${reason}) — re-planning.`);
        hint =
          "Your previous step was REJECTED. A click/fill/select `selector` must be " +
          "EXACTLY the value after `selector=` on one inventory line — copy only that " +
          "value (it runs to the end of the line), never the leading `[n] tag …` part " +
          "and never the whole line.";
        continue;
      }
      args.steps.push(`Post-verify ${round + 1}/${args.maxRounds}: ${nextStep.kind} — ${nextStep.reason}`);

      if (nextStep.kind === "done") break;
      hint = undefined;
      try {
        if (nextStep.kind === "extract") {
          credentials = await this.extractCredentials();
          if (credentials.api_key === undefined) {
            // The planner saw a key-shaped string but extraction got
            // nothing — the on-page key is masked/truncated. Steer the
            // next round off `extract` and toward creating a fresh key.
            hint =
              "Your last 'extract' found NO key — the key text on the page is " +
              "masked or truncated (e.g. shows '...' or dots). A masked existing " +
              "key cannot be extracted. Click 'Create API Key' / 'New API Key' to " +
              "generate a fresh one — its full value is shown once, on creation.";
          }
        } else if (nextStep.kind === "click") {
          await this.browser.click(nextStep.selector);
          await this.browser.wait(2);
        } else if (nextStep.kind === "fill") {
          await this.browser.type(nextStep.selector, nextStep.value);
        } else if (nextStep.kind === "select") {
          await this.browser.selectOption(nextStep.selector);
          await this.browser.wait(1);
        } else if (nextStep.kind === "navigate") {
          await this.browser.goto(nextStep.url);
          await this.browser.wait(3);
        } else if (nextStep.kind === "wait") {
          await this.browser.wait(Math.min(nextStep.seconds, 15));
        } else if (nextStep.kind === "login") {
          if (args.credentials === undefined) {
            // OAuth run — no password to give, and the Google session
            // already authenticated us. Treat `login` as a no-op note.
            args.steps.push(
              "Post-verify: planner asked to log in, but this is an OAuth run — " +
                "already authenticated via Google; skipping.",
            );
          } else if (loginAttempts >= 2) {
            args.steps.push("Post-verify: already attempted login twice — stopping.");
            break;
          } else {
            loginAttempts += 1;
            await this.loginWithCredentials(
              args.credentials.email,
              args.credentials.password,
              args.steps,
            );
          }
        }
      } catch (err) {
        args.steps.push(
          `Post-verify action failed (${nextStep.kind}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Don't bail — Claude may recover on the next round.
      }
      // Re-extract — but tolerate the page still navigating from the
      // step just taken; the next round settles and re-reads.
      try {
        credentials = await this.extractCredentials();
      } catch {
        // page mid-navigation — next round's waitForFormReady handles it
      }
    }
    return credentials;
  }

  // Sign in with the credentials created during signup, so the
  // post-verify flow can reach the authenticated dashboard (SendPulse:
  // confirming the email doesn't establish a session — the API-key
  // page is then login/CSRF-walled). DOM-grounded and LLM-free: a
  // login form is just email + password + submit, identifiable from
  // the F3 inventory by element type. Returns false when the page
  // isn't a login form.
  private async loginWithCredentials(
    email: string,
    password: string,
    steps: string[],
  ): Promise<boolean> {
    const inv = await this.buildInventory(steps);
    const emailEl =
      inv.find((e) => e.tag === "input" && e.type === "email") ??
      inv.find(
        (e) => e.tag === "input" && (e.type === "text" || e.type === null),
      );
    const pwEl = inv.find((e) => e.tag === "input" && e.type === "password");
    if (emailEl === undefined || pwEl === undefined) {
      steps.push("Login: no email/password fields on the page — skipped.");
      return false;
    }
    // Login submit: a submit-typed button, else one whose text reads
    // like a sign-in action, else the first button. (scoreSignupButton
    // drives "log in" negative — wrong scorer for a login form.)
    const buttons = inv.filter((e) => e.tag === "button" || e.type === "submit");
    const submitEl =
      buttons.find((e) => e.type === "submit") ??
      buttons.find((e) =>
        /\b(log ?in|sign ?in|continue|next|submit)\b/i.test(
          `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`,
        ),
      ) ??
      buttons[0];
    try {
      await this.browser.type(emailEl.selector, email);
      await this.browser.type(pwEl.selector, password);
      steps.push("Login: filled the signup credentials");
      if (submitEl !== undefined) {
        await this.browser.clickSubmit(submitEl.selector);
      }
      await this.browser.wait(4);
      return true;
    } catch (err) {
      steps.push(
        `Login attempt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async planPostVerifyStep(input: {
    service: string;
    round: number;
    maxRounds: number;
    state: { url: string; title: string; html: string; screenshot: string };
    // T9: an OAuth run is already authenticated via Google — the
    // planner must never ask to log in. The email-verification path
    // (oauth=false) keeps the login-wall recovery guidance.
    oauth: boolean;
    // DOM-grounded element inventory — `click`/`fill` selectors MUST be
    // copied from it (parsePostVerifyStep rejects anything else).
    inventory: InteractiveElement[];
    // Carried from the previous round when it did not make progress
    // (e.g. an `extract` that found only a masked key).
    hint?: string;
  }): Promise<PostVerifyStep> {
    const visibleText = (input.state.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 2500);

    const loginGuidance = input.oauth
      ? `- You are ALREADY signed in via Google — NEVER return {"kind":"login"}. If the page looks like a login wall, return {"kind":"navigate"} to the service's dashboard, or {"kind":"done"}.`
      : `- If the page is a LOGIN form, or says you must sign in, or you've been signed out, return {"kind":"login"} — the bot signs in with the signup email + password. Do NOT return done on a login wall.`;

    const systemPrompt = `You are driving a headless browser after a SaaS signup ${
      input.oauth ? "via Google OAuth" : "verification"
    }.
Your goal: surface the user's API key (or any credential — token, secret, app id) so it can be extracted from the page.

You may issue ONE step per turn. Reply with a single JSON object, no prose.

You are given a screenshot and an INVENTORY of the page's interactive
elements — each line ends with a precise \`selector=\` the bot has
verified resolves.

Schema:
  {"kind":"done","reason":"why we should stop"}
  {"kind":"extract","reason":"the API key is now visible on this page"}
  {"kind":"login","reason":"the page is a login form / we were signed out"}
  {"kind":"click","selector":"<a selector= copied verbatim from the inventory>","reason":"e.g. open the API keys page"}
  {"kind":"fill","selector":"<a selector= from the inventory>","value":"value","reason":"unusual — only for a required project-name etc."}
  {"kind":"select","selector":"<a selector= from the inventory, tag=select>","reason":"pick an option for a dropdown — region, role, country"}
  {"kind":"navigate","url":"https://...","reason":"e.g. go directly to /settings/api-keys"}
  {"kind":"wait","seconds":N,"reason":"page is still loading"}

- CRITICAL: every "selector" in a click/fill step MUST be copied
  verbatim from a \`selector=\` field in the inventory below. Never
  invent or guess a selector — one not in the inventory is rejected.
- If the element you want is NOT in the inventory, use {"kind":"navigate"}
  to a likely settings URL instead of guessing a selector.

Strategy:
- If a FULL, untruncated API key is visible, return {"kind":"extract"}.
- A key shown masked or truncated (with "...", dots, or "•") is NOT
  extractable — its full value is shown only once, at creation. Do NOT
  return "extract" for a masked key, and do not return "extract" twice
  in a row. Instead click "Create API Key" / "New API Key" / "Generate"
  to make a fresh key, then extract its full value.
- To reach API keys, prefer a {"kind":"navigate"} straight to the
  service's API-keys settings URL — note these usually live under the
  user/ACCOUNT settings, not a project or workspace's settings.
- Otherwise click a dashboard menu link like "API Keys" / "Tokens" /
  "Developer" / "Settings" — using its inventory selector.
- If there's an onboarding modal or a "Skip" link blocking, dismiss it.
${loginGuidance}
- If we're on a "verify your phone" / "verify email" wall, return done (we can't solve those).
- If the page wants the user to create a project/key before showing it, fill the minimum and click create.
- For a required dropdown (an inventory entry with tag=select — region, role, country), use {"kind":"select"} — a "click" cannot pick a <select> option, so do not click it repeatedly.
- A post-OAuth onboarding form (organization name, region, terms) is normal — fill/select/check its fields and click Continue to advance toward the dashboard; do not return "done" just because it is a form.
- Prefer the simplest credential path: a project- or organization-level API token / auth token usually needs only a name. A "personal token" with a grid of per-scope permission dropdowns is more work — choose it only if no simpler token type is offered.
- On a token-creation form whose permission/scope dropdowns default to "No Access" / "None", you MUST use a select step to set a non-default permission on at least one dropdown BEFORE clicking the create button — creating with all-default permissions does nothing. Do not click the create button repeatedly; set a permission first.
- Round ${input.round + 1} of ${input.maxRounds}. Prefer "done" if you're not making progress.`;

    const userBlocks: LLMBlock[] = [
      { kind: "image", media_type: "image/png", data_base64: input.state.screenshot },
      {
        kind: "text",
        text: `Service: ${input.service}
URL: ${input.state.url}
Title: ${input.state.title}
Round: ${input.round + 1}/${input.maxRounds}

Visible text (truncated):
${visibleText}

Interactive element inventory:
${formatInventory(input.inventory)}${
          input.hint !== undefined ? `\n\nIMPORTANT — ${input.hint}` : ""
        }`,
      },
    ];

    // The planner may only pick click/fill selectors the bot supplied.
    const allowed = new Set(input.inventory.map((e) => e.selector));
    return this.callLLM({
      system: systemPrompt,
      userBlocks,
      maxTokens: 500,
      parse: (raw) => parsePostVerifyStep(raw, allowed),
    });
  }

  private async findSignupLink(): Promise<string | null> {
    const html = (await this.browser.getState()).html;
    const re = /href="([^"]*(?:signup|register|sign-up|create-account|join)[^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (href === undefined) continue;
      if (href.includes("signin") || href.includes("login")) continue;
      if (href.startsWith("http")) return href;
      if (href.startsWith("//")) return `https:${href}`;
    }
    return null;
  }

  private async extractCredentials(): Promise<Record<string, string>> {
    // IMPORTANT: pull credentials from the *visible* page, not the raw
    // HTML. Reading from HTML matches anti-bot challenge JS (Cloudflare
    // Turnstile, hCaptcha) whose challenge tokens look like API keys to
    // a naive regex.
    //
    // Two visible surfaces, in priority order:
    //   1. Discrete credential candidates — copy-input values and each
    //      element's own direct text. A key is read whole here, un-glued
    //      from adjacent buttons; captcha tokens (hidden inputs) are
    //      excluded by the browser.
    //   2. The whole visible body text — fallback for a key shown as
    //      plain prose, accepting that body concatenation can glue
    //      neighbours (the extractApiKeyFromText guards catch the worst).
    const credentials: Record<string, string> = {};
    let apiKey: string | null = null;
    for (const candidate of await this.browser.extractCredentialCandidates()) {
      apiKey = extractApiKeyFromText(candidate);
      if (apiKey !== null) break;
    }
    if (apiKey === null) {
      apiKey = extractApiKeyFromText(await this.browser.extractText());
    }
    if (apiKey !== null) credentials.api_key = apiKey;
    return credentials;
  }
}
