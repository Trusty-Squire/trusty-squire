// AI agent that controls browser navigation using Claude.
//
// Two responsibilities live here:
//   1. Plan how to fill a signup form (delegated to Claude — see analyzeSignupForm)
//   2. Execute the plan + handle the email-verification handshake
//
// The "plan" is a small JSON schema Claude emits, so this file stays a thin
// executor; the prompt is the contract. If a service breaks we tweak the
// prompt rather than threading service-specific logic through the agent.

import type { BrowserController, CaptchaKind, CaptchaVariant } from "./browser.js";
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

// What to do next after the verification link is clicked. Most services
// land you on a dashboard with the API key visible; some require one or
// two clicks ("create your first project", "skip tour", etc.) before the
// key appears. The post-verification loop asks Claude one of these on
// every round until it sees `done` or runs out of rounds.
export type PostVerifyStep =
  | { kind: "done"; reason: string }
  | { kind: "extract"; reason: string }
  | { kind: "click"; selector: string; reason: string }
  | { kind: "fill"; selector: string; value: string; reason: string }
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

export function parseSignupPlan(raw: string): SignupPlan {
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
  const notes = typeof obj["notes"] === "string" ? obj["notes"] : undefined;
  return notes !== undefined
    ? { actions, submit_selector: submitSelector, confidence, notes }
    : { actions, submit_selector: submitSelector, confidence };
}

export function parsePostVerifyStep(raw: string): PostVerifyStep {
  const obj = extractJsonObject(raw);
  const kind = obj["kind"];
  // `reason` is required by the schema but advisory; default it so a
  // model omitting it doesn't trip a retry on an otherwise-valid step.
  const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";
  switch (kind) {
    case "done":
      return { kind: "done", reason };
    case "extract":
      return { kind: "extract", reason };
    case "click":
      return {
        kind: "click",
        selector: requireString(obj, "selector", "post-verify click step"),
        reason,
      };
    case "fill":
      return {
        kind: "fill",
        selector: requireString(obj, "selector", "post-verify fill step"),
        value: requireString(obj, "value", "post-verify fill step"),
        reason,
      };
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
    /\bpk_(?:live|test)_[a-zA-Z0-9]{20,}\b/, // Stripe public
    /\bkey-[a-f0-9]{32}\b/, // Mailgun
    /\bphc_[a-zA-Z0-9]{32,}\b/, // PostHog
    /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\b/, // SendGrid
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
  ): Promise<void> {
    for (const action of plan.actions) {
      try {
        if (action.kind === "fill") {
          // `literal` is per-action; everything else is a fixed value.
          const value =
            action.value_kind === "literal"
              ? action.literal ?? ""
              : fillValues[action.value_kind];
          steps.push(`Fill ${action.value_kind} → ${action.selector}`);
          await this.browser.type(action.selector, value);
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

  async signup(task: SignupTask): Promise<SignupResult> {
    const steps: string[] = [];
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

      // Step 2: Plan the form fill with Claude.
      steps.push("Asking Claude to plan the signup form fill...");
      await saveDebugSnapshot(this.browser, "before-fill");
      const state = await this.browser.getState();
      const plan = await this.planSignupForm({
        service: task.service,
        url: state.url,
        html: state.html,
        screenshot: state.screenshot,
      });
      steps.push(`Plan: ${plan.actions.length} action(s), confidence=${plan.confidence}${plan.notes !== undefined ? ` — ${plan.notes}` : ""}`);

      // Step 3: Execute the plan.
      const fillValues: Record<FillValueKind, string> = {
        email: task.email,
        password,
        name: displayName,
        username,
        company: "Trusty Squire",
        // `literal` has no fixed value — resolved per-action below.
        literal: "",
      };
      await this.executePlan(plan, fillValues, steps);

      // Tier 2 captcha (pre-submit): check for a visible
      // Turnstile/reCAPTCHA widget rendered inline with the form.
      // Many sites render the widget alongside the form on first
      // load; failing to interact with it leaves cf-turnstile-response
      // empty and the submit gets server-side-rejected with a generic
      // validation error we'd waste a re-plan trying to debug.
      const preSubmitGate = await this.runCaptchaGate("Pre-submit", steps);
      if (preSubmitGate.blocked) {
        return {
          success: false,
          error: `captcha_blocked: visible ${preSubmitGate.kind} challenge did not resolve. The site flagged this session.`,
          steps,
          ...this.resultTail(),
        };
      }

      // Step 4: Submit. clickSubmit() disambiguates when the planned
      // selector matches several button[type=submit] (OAuth buttons are
      // submit-typed too). A submit click that fails means the form was
      // never submitted — fail fast here rather than fall through into
      // the multi-minute verification-email poll for an email that can
      // never arrive.
      steps.push(`Submit → ${plan.submit_selector}`);
      try {
        await this.browser.clickSubmit(plan.submit_selector);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        steps.push(`⚠ submit click failed: ${reason}`);
        return {
          success: false,
          error: `submit_failed: could not click the signup button — ${reason}`,
          steps,
          ...this.resultTail(),
        };
      }
      await this.browser.wait(5);

      // Tier 2 captcha (post-submit): some services only render the
      // challenge after form submission (deferred rendering). Same
      // shape as the pre-submit check.
      const postSubmitGate = await this.runCaptchaGate("Post-submit", steps);
      if (postSubmitGate.blocked) {
        return {
          success: false,
          error: `captcha_blocked: post-submit ${postSubmitGate.kind} challenge did not resolve.`,
          steps,
          ...this.resultTail(),
        };
      }
      if (postSubmitGate.found && postSubmitGate.solved) {
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

      await saveDebugSnapshot(this.browser, "after-submit");

      // Step 5: Detect post-submit validation errors — if visible text contains
      // hints like "required", "must be between", "please accept", we re-plan
      // once with the new state. This handles the Postmark-style server-side
      // validation case.
      const afterSubmitText = (await this.browser.extractText()).slice(0, 4000);
      if (this.looksLikeValidationFailure(afterSubmitText)) {
        steps.push("Post-submit text suggests validation errors — re-planning...");
        const state2 = await this.browser.getState();
        const plan2 = await this.planSignupForm({
          service: task.service,
          url: state2.url,
          html: state2.html,
          screenshot: state2.screenshot,
          hint: `Previous submit produced validation errors. Visible page text snippet: ${afterSubmitText.slice(0, 800)}`,
        });
        await this.executePlan(plan2, fillValues, steps);
        // Re-plan path: same captcha guard as initial submit. If the
        // first submit triggered captcha rendering, the second pass
        // sees it inline.
        const replanGate = await this.runCaptchaGate("Re-plan", steps);
        if (replanGate.blocked) {
          return {
            success: false,
            error: `captcha_blocked: re-plan ${replanGate.kind} challenge did not resolve.`,
            steps,
            ...this.resultTail(),
          };
        }
        try {
          await this.browser.clickSubmit(plan2.submit_selector);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          steps.push(`⚠ re-plan submit click failed: ${reason}`);
          return {
            success: false,
            error: `submit_failed: re-plan submit could not click the signup button — ${reason}`,
            steps,
            ...this.resultTail(),
          };
        }
        await this.browser.wait(5);
        await saveDebugSnapshot(this.browser, "after-resubmit");
      }

      // Step 6: Extract creds from page.
      steps.push("Extracting credentials from page...");
      let credentials = await this.extractCredentials();

      // Step 7: Email verification + post-verification navigation.
      if (credentials.api_key === undefined && credentials.username === undefined && task.inbox !== undefined) {
        const verificationTimeoutSeconds = task.verificationTimeoutSeconds ?? 300;
        steps.push(
          `No credentials on page — polling inbox for verification email (up to ${verificationTimeoutSeconds}s)...`,
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
                  email: task.email,
                  password,
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
          steps.push(`Inbox poll failed: ${err instanceof Error ? err.message : String(err)}`);
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
        error: "Could not find credentials on page or via email",
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

  // ------------ Claude planner ------------

  private async planSignupForm(input: {
    service: string;
    url: string;
    html: string;
    screenshot: string; // base64
    hint?: string;
  }): Promise<SignupPlan> {
    // Trim HTML to just <form>...</form> regions if possible — the prompt
    // budget matters and most pages have a lot of marketing chrome.
    const trimmedHtml = this.extractFormHtml(input.html);

    const systemPrompt = `You analyze a web signup form and emit a JSON plan describing how to fill it.
Output rules:
- Reply with ONE JSON object only. No prose, no markdown.
- Schema:
  {
    "actions": [
      {"kind":"fill","selector":"CSS_SELECTOR","value_kind":"email|password|name|username|company|literal","literal":"only when value_kind=literal","reason":"why"},
      {"kind":"check","selector":"CSS_SELECTOR","reason":"TOS / marketing-opt-in / etc."},
      {"kind":"click","selector":"CSS_SELECTOR","reason":"e.g. accept cookies before form is reachable"}
    ],
    "submit_selector": "CSS_SELECTOR for the primary signup button",
    "confidence": "high|medium|low",
    "notes": "optional caveats"
  }
- Prefer stable selectors: name attributes, id, then aria-label. Avoid nth-child unless unavoidable.
- Include the TOS/agree checkbox if one is required.
- If a cookie banner is blocking the form, click "Accept" first.
- Do NOT include password confirmation as a separate action unless the form has a visible second password field.
- Skip optional/marketing-opt-in checkboxes.
- For "name" use a realistic full name. For "username" generate a plausible 7-15 char handle.`;

    const userBlocks: LLMBlock[] = [
      { kind: "image", media_type: "image/png", data_base64: input.screenshot },
      {
        kind: "text",
        text: `Service: ${input.service}
URL: ${input.url}
${input.hint !== undefined ? `Hint: ${input.hint}\n` : ""}
Form HTML (trimmed):
${trimmedHtml}`,
      },
    ];

    return this.callLLM({
      system: systemPrompt,
      userBlocks,
      maxTokens: 1500,
      parse: parseSignupPlan,
    });
  }

  // Extract just <form> elements from the HTML — drops marketing + scripts.
  private extractFormHtml(html: string): string {
    const forms: string[] = [];
    const re = /<form\b[\s\S]*?<\/form>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) forms.push(m[0]);
    const joined = forms.join("\n");
    if (joined.length === 0) {
      // No <form> — fall back to body but cap aggressively
      return html.slice(0, 20000);
    }
    // Cap at 20k chars (~5k tokens) to leave room for the screenshot and reply
    return joined.slice(0, 20000);
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

  // After verification, drive the browser toward the API key. Each round
  // asks Claude what to do next given the current page; we stop when
  // Claude says "done" or when we extract a credential. Bounded by
  // maxRounds so a confused agent can't burn the whole context window.
  private async postVerifyLoop(args: {
    service: string;
    email: string;
    password: string;
    maxRounds: number;
    steps: string[];
  }): Promise<Record<string, string>> {
    let credentials = await this.extractCredentials();
    for (let round = 0; round < args.maxRounds; round++) {
      if (credentials.api_key !== undefined || credentials.username !== undefined) {
        args.steps.push(`Post-verify: credentials found on round ${round}.`);
        return credentials;
      }
      const state = await this.browser.getState();
      let nextStep: PostVerifyStep;
      try {
        nextStep = await this.planPostVerifyStep({
          service: args.service,
          email: args.email,
          password: args.password,
          round,
          maxRounds: args.maxRounds,
          state,
        });
      } catch (err) {
        args.steps.push(
          `Post-verify round ${round}: planner failed (${err instanceof Error ? err.message : String(err)}). Stopping.`,
        );
        break;
      }
      args.steps.push(`Post-verify ${round + 1}/${args.maxRounds}: ${nextStep.kind} — ${nextStep.reason}`);

      if (nextStep.kind === "done") break;
      try {
        if (nextStep.kind === "extract") {
          credentials = await this.extractCredentials();
        } else if (nextStep.kind === "click") {
          await this.browser.click(nextStep.selector);
          await this.browser.wait(2);
        } else if (nextStep.kind === "fill") {
          await this.browser.type(nextStep.selector, nextStep.value);
        } else if (nextStep.kind === "navigate") {
          await this.browser.goto(nextStep.url);
          await this.browser.wait(3);
        } else if (nextStep.kind === "wait") {
          await this.browser.wait(Math.min(nextStep.seconds, 15));
        }
      } catch (err) {
        args.steps.push(
          `Post-verify action failed (${nextStep.kind}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Don't bail — Claude may recover on the next round.
      }
      credentials = await this.extractCredentials();
    }
    return credentials;
  }

  private async planPostVerifyStep(input: {
    service: string;
    email: string;
    password: string;
    round: number;
    maxRounds: number;
    state: { url: string; title: string; html: string; screenshot: string };
  }): Promise<PostVerifyStep> {
    const visibleText = (input.state.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 2500);

    const systemPrompt = `You are driving a headless browser after a SaaS signup verification.
Your goal: surface the user's API key (or any credential — token, secret, app id) so it can be extracted from the page.

You may issue ONE step per turn. Reply with a single JSON object, no prose.

Schema:
  {"kind":"done","reason":"why we should stop"}
  {"kind":"extract","reason":"the API key is now visible on this page"}
  {"kind":"click","selector":"CSS","reason":"e.g. dismiss onboarding modal / open API keys page"}
  {"kind":"fill","selector":"CSS","value":"value","reason":"unusual — only for required project-name etc."}
  {"kind":"navigate","url":"https://...","reason":"e.g. go directly to /settings/api"}
  {"kind":"wait","seconds":N,"reason":"page is still loading"}

Strategy:
- If the API key text is visible, return {"kind":"extract"}.
- If there's a dashboard menu link like "API Keys" / "Tokens" / "Developer", click it.
- If there's an onboarding modal blocking, dismiss it.
- If we're on a "verify your phone" / "verify email" wall, return done (we can't solve those).
- If the page wants the user to create a project before showing keys, fill the minimum and click create.
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
${visibleText}`,
      },
    ];

    return this.callLLM({
      system: systemPrompt,
      userBlocks,
      maxTokens: 500,
      parse: parsePostVerifyStep,
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
    // IMPORTANT: pull credentials from the *visible* page text, not the raw
    // HTML. Reading from HTML matches anti-bot challenge JS (Cloudflare
    // Turnstile, hCaptcha) whose challenge tokens look like API keys to a
    // naive regex.
    const text = await this.browser.extractText();
    const credentials: Record<string, string> = {};
    const apiKey = extractApiKeyFromText(text);
    if (apiKey !== null) credentials.api_key = apiKey;
    return credentials;
  }
}
