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
  isGitHubDismissible2faSetup,
  GITHUB_DISMISSIBLE_2FA_SKIP_TEXT,
  type OAuthProviderId,
} from "./oauth-providers.js";
import { extractGoogleNumberMatch, scrapeGoogleScopePhrases } from "./google-login.js";
import { notifyHeightenedAuth } from "./notify-api.js";
import { sendTelegramHeightenedAuth } from "./telegram-notify.js";
import { redactCredentials } from "./redact.js";
import { readOperatorOtp, fromDomainFromUrl } from "./read-otp.js";
import { loggedInProviders, clearProviderLoggedIn } from "./login-state.js";
import { saveDebugSnapshot } from "./debug.js";
import { captureOnboardingRound } from "./onboarding-capture.js";
import { wasRecentlyPrewarmed, recordPrewarmSuccess } from "./prewarm-cache.js";
import {
  pickLLMPair,
  type LLMBlock,
  type LLMClient,
  type LLMPair,
} from "./llm-client.js";
import { getDomain } from "tldts";

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
  "verify your account",
  "confirm your account",
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
//
// rc.27 — patterns are regexes (not substrings) so word boundaries
// hold. `isAtPaywall` also rejects matches preceded by a negator
// ("no", "without", "doesn't require", …) so a free-plan blurb like
// "No credit card required, no hidden fees" — the exact phrase that
// false-positively halted the IPInfo run on rc.26 — no longer
// triggers a paywall verdict.
const ONBOARDING_PAYWALL_PATTERNS: readonly RegExp[] = [
  /\badd\s+a\s+payment\s+method\b/i,
  /\badd\s+(?:a\s+)?credit\s+card\b/i,
  /\bpayment\s+method\s+(?:is\s+)?required\b/i,
  /\bcredit\s+card\s+required\b/i,
  /\benter\s+your\s+card\b/i,
  /\benter\s+your\s+payment\b/i,
  /\benter\s+payment\s+details\b/i,
  /\bupgrade\s+your\s+plan\s+to\b/i,
  /\bstart\s+your\s+paid\s+plan\b/i,
];

// Negators that, if they appear in the ~30 characters immediately
// before a paywall pattern match, flip its meaning from a demand
// to a marketing reassurance. "No", "without", "doesn't require",
// "don't need", "isn't".
const PAYWALL_NEGATION_PREFIX =
  /\b(?:no|without|doesn'?t\s+(?:need|require)|don'?t\s+(?:need|require)|isn'?t)\s+$/i;

// Exported for unit testing — the post-OAuth heuristic distinguishing
// "the dashboard is asking for a card before issuing a key" from "the
// dashboard happens to mention cards on a marketing tile".
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

// Best-effort canonical signup URL for a service when the caller
// didn't pass one. Most dev-SaaS targets (Resend, Postmark, Mailgun,
// MailerSend, IPInfo, Stripe, PostHog) live at <name>.com/signup —
// the .com default catches them. The exceptions — services on .io,
// .ai, .dev — live in KNOWN_DOMAINS so a Sentry signup doesn't waste
// the long Google-search fallback path looking for sentry.com (which
// redirects weirdly to sentry.io and breaks looksLikeSignupPage).
// Anything still wrong falls through to the search-and-find path.
// Exported for unit testing.
// Either a hostname (default path: /signup) or a full URL (when the
// service's signup lives on a subdomain or uses a non-standard path —
// e.g. Cloudflare's dash.cloudflare.com/sign-up).
const KNOWN_DOMAINS: Record<string, string> = {
  sentry: "sentry.io",
  openrouter: "openrouter.ai",
  mistral: "mistral.ai",
  anthropic: "anthropic.com",
  mailtrap: "mailtrap.io",
  axiom: "axiom.co",
  loops: "loops.so",
  e2b: "e2b.dev",
  // railway.app + railway.com both 404 on /signup; the real entry
  // point is /login (which handles both signup and sign-in via an
  // OAuth chooser). railway.app permanent-redirects to railway.com.
  railway: "https://railway.com/login",
  supabase: "supabase.com",
  replicate: "replicate.com",
  modal: "modal.com",
  // PostHog uses posthog.com but the dashboard lives at us.posthog.com /
  // eu.posthog.com — signup is on the marketing site, .com is right.
  posthog: "posthog.com",
  // Cloudflare's marketing site has no signup form — it CTAs into the
  // dashboard. Skip the redirect chase and land on the real form.
  cloudflare: "https://dash.cloudflare.com/sign-up",
  // Vercel: marketing /signup redirects through OAuth provider tiles
  // but the actual email form sits on the dashboard.
  vercel: "https://vercel.com/signup",
};
export function guessSignupUrl(service: string): string {
  const slug = service.toLowerCase().replace(/[^a-z0-9]/g, "");
  const entry = KNOWN_DOMAINS[slug];
  if (entry !== undefined && /^https?:\/\//i.test(entry)) return entry;
  const host = entry ?? `${slug}.com`;
  return `https://${host}/signup`;
}

// BUG-2 GUARD — did `url` come from KNOWN_DOMAINS as a hardcoded full
// URL (vs the default /signup convention)? These were explicitly
// chosen because the default 404s and the real entry is non-obvious
// — e.g. Railway's /login, Cloudflare's dash.cloudflare.com/sign-up.
// Trust the mapping rather than falling back to a Google search.
// Exported for unit testing.
export function isKnownDomainFullUrlMatch(service: string, url: string): boolean {
  const slug = service.toLowerCase().replace(/[^a-z0-9]/g, "");
  const entry = KNOWN_DOMAINS[slug];
  return entry !== undefined && /^https?:\/\//i.test(entry) && entry === url;
}

// True when the URL is a Google search results page — used to gate
// the prewarm + the post-load "did we land somewhere useful?" check.
export function isGoogleSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "www.google.com" || u.hostname === "google.com") &&
      u.pathname.startsWith("/search")
    );
  } catch {
    return false;
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
  // Free-text guidance the post-verify planner uses when filling
  // permission/scope dropdowns on token-creation forms (Sentry et al).
  // Default (undefined) → planner is told to pick MAX permissions
  // (Admin > Write > Read). When supplied, planner picks option_text
  // values aligned with the hint ("read-only" / "write access" /
  // specific scopes).
  scopeHint?: string | undefined;
  // Shared step trail. When provided, the bot pushes step entries
  // into this exact array instead of allocating its own — the caller
  // can read it mid-run to surface progress (e.g., the Google
  // number-match prompt) without waiting for the final result.
  stepsSink?: string[] | undefined;
  // Extra OAuth scopes the caller has pre-approved beyond the
  // basic-identity allowlist (BASIC_OAUTH_SCOPES in google-login.ts /
  // GITHUB_BASIC_SCOPES in oauth-providers.ts). When the consent
  // screen requests any of these (plus basics), the bot auto-approves
  // instead of aborting with oauth_consent_needs_review. The LLM
  // should set this only after the USER has confirmed the scopes —
  // pushing the consent decision up to the user, not the LLM.
  allowExtraOAuthScopes?: readonly string[] | undefined;
  // For consent screens whose scopes can't be parsed from the URL —
  // notably GitHub Apps (client_id prefix `Iv1.`) and similar opaque-
  // permission OAuth flows — the URL scope walk returns null and the
  // bot would normally abort with oauth_consent_needs_review. With
  // this flag set, the bot auto-approves the consent IF the page
  // also doesn't visibly list scope-grant verb phrases ("See your
  // contacts", "Manage your Drive", etc. — the same defense-in-depth
  // scraper used elsewhere). User explicitly opted in for this run;
  // never set automatically.
  allowBlindOAuthConsent?: boolean | undefined;
  // Machine token + API base for fire-and-forget heightened-auth
  // notifications (Google number-match email). The MCP install path
  // mints the machine token to session.json — it is not exported via
  // env — so the agent's notify-api call must take it explicitly to
  // avoid a silent no-op. provision-any.ts plumbs both fields from
  // ctx; the dev harnesses that set TRUSTY_SQUIRE_MACHINE_TOKEN as an
  // env var leave these undefined and notify-api.ts falls back to env.
  machineToken?: string | undefined;
  apiBase?: string | undefined;
}

// Best-effort callback the MCP layer wires into SignupAgent so the
// agent can upload a DOM + screenshot diagnostic snapshot whenever
// `extractCredentials()` returned null despite the planner asserting
// a credential was visible. The implementation MUST NOT throw — the
// agent calls it from try/catch but a throw would surface as a
// "snapshot upload failed" step trail entry, which is just noise.
export type ExtractFailureUploader = (input: {
  service: string;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  candidates: ReadonlyArray<string>;
  html: string;
  screenshot_jpeg_base64?: string;
}) => Promise<void>;

// Per-round telemetry uploader. Fires on EVERY post-verify round, not
// just on failure — so we can reconstruct what the planner saw at each
// step without needing to reproduce the run locally. Same fire-and-
// forget contract as ExtractFailureUploader: best-effort, never throws,
// never blocks the signup. Default-on as of 0.6.14-rc.11; the MCP
// layer wires it to /v1/extract-failures with extract_reason set to
// "round_telemetry" so the round captures live alongside extract
// failures in the same registry table.
export type RoundUploader = (input: {
  service: string;
  round: number;
  kind: string;
  url: string;
  title: string;
  inventory_count: number;
  observed_reason: string;
  html: string;
  screenshot_jpeg_base64?: string;
}) => Promise<void>;

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

  // Skill promoter (0.7.0): when a SignupResult was produced by
  // replaying a Tier-2 learned skill (vs the universal bot), these
  // fields identify the skill so the caller can include them in the
  // tool response. `via: "bot"` is the default (universal bot path);
  // `via: "skill"` means the registry served a skill and replaySkill
  // executed it successfully end-to-end.
  via?: "bot" | "skill";
  skill_id?: string;
  skill_version?: string;

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
  // Phase 2 follow-up to G8 / Phase 3 rc.33 task — the page exposes
  // OAuth providers but the bot has NO session for any of them. The
  // operator action is `npx @trusty-squire/mcp login --provider=X`,
  // and the bot should name the provider rather than emit the
  // opaque `oauth_required`. `missingProviders` is the providers
  // visible on the page that the bot can't use (highest-priority
  // OAuth affordances). `haveSessions` is what the bot's profile
  // currently has, so the operator sees "you have Google, page
  // needs GitHub — run `mcp login --provider=github`".
  | {
      kind: "needs_oauth_provider_session";
      missingProviders: readonly OAuthProviderId[];
      haveSessions: readonly OAuthProviderId[];
    }
  // Cloudflare / Sucuri / DataDome / Imperva "Just a moment..." holding
  // page that the bot can't clear — usually a fingerprint/IP/ASN risk
  // score block, not a Turnstile challenge to solve. Surfaced as its
  // own status so the user gets accurate guidance (manual signup) vs.
  // the misleading oauth_required ("there is no form").
  | { kind: "anti_bot_blocked"; vendor: string }
  // T6: an OAuth-first signup found its provider affordance — the
  // selector of the "Sign in with Google" button to click. signup()
  // hands off to the OAuth consent flow instead of credential extraction.
  | { kind: "oauth"; selector: string; provider: OAuthProviderId }
  // F17 — the bot landed on a signup URL but the page renders a
  // dashboard / authenticated state instead. Happens when a prior
  // OAuth bind from a previous run completed but didn't extract
  // credentials, and on retry the service auto-redirects past the
  // sign-in widget. Skip OAuth + form-fill, go straight to the
  // post-OAuth navigation loop to find the API key.
  | { kind: "already_oauth" };

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
  // `select` — pick an option for a dropdown (native <select> OR a
  // custom ARIA combobox: Radix, Headless UI, React Aria, cmdk).
  // When `option_text` is given, the executor matches by visible text
  // (case-insensitive substring); otherwise picks the first real
  // option. Sentry's permissions picker is the canonical combobox
  // case — F11 added combobox support so this step works there.
  | {
      kind: "select";
      selector: string;
      reason: string;
      option_text?: string;
    }
  // `check` — tick a checkbox (a post-OAuth onboarding form's
  // terms-of-service / agreement box). A `click` lands on the box's
  // styled label or its TOS *link* and does not flip the input;
  // browser.check() force-ticks the underlying checkbox.
  | { kind: "check"; selector: string; reason: string }
  // `scroll` — scroll a ToS / agreement modal to the bottom so a
  // gated "Accept" button enables (Railway is the canonical case).
  // `selector` is OPTIONAL: the inventory only carries interactive
  // elements, so the planner usually can't name the scrollable div.
  // When absent the bot auto-detects the largest visible scrollable
  // container; when present it is used verbatim.
  | { kind: "scroll"; selector?: string; reason: string }
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
  // F7 / 0.6.15-rc.11 — stack-based first-balanced-object extraction.
  // The previous regex `\{[\s\S]*\}` was greedy and matched from the
  // first `{` to the LAST `}` in the string. When an LLM emitted
  // multiple JSON objects (e.g. {"kind":"fill",…}\n{"kind":"click",…}),
  // the greedy match spanned both and JSON.parse failed with
  // "Unexpected non-whitespace character after JSON at position N".
  // The stack walker finds the first balanced `{…}` block respecting
  // string-literal boundaries, so a single object always parses cleanly
  // even when the model appends trailing prose or extra objects.
  const objText = extractFirstBalancedObject(candidate);
  if (objText === null) {
    throw new Error(`no JSON object in reply: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objText);
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

// Find the first balanced `{ … }` block in `s`, respecting string
// literals and escapes. Returns the substring (inclusive of braces) or
// null when no balanced block exists. Tolerates trailing text after
// the closing brace (which is the whole reason we need it — the
// previous greedy regex couldn't).
function extractFirstBalancedObject(s: string): string | null {
  const open = s.indexOf("{");
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return null;
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
//
// F15 — when multiple elements share the same effective text
// (visibleText / ariaLabel / labelText, normalized), tag each with
// its enclosing HTML5 landmark (header / main / footer / nav / etc.)
// so the planner has a discriminator. Without this, a Railway page
// with "Email" both in the body CTA and the footer made the planner
// pick the wrong one and loop. Single-occurrence text is rendered
// without the landmark tag to keep the inventory terse.
//
// rc.17 — split keyboard-shortcut suffixes out of button labels.
// Resend / Linear / Notion-style buttons render the shortcut hint
// glued to the label without a separator: "AddCtrl↩", "CancelEsc",
// "Save⌘↩". The planner reads "AddCtrl↩" and gets confused — the
// Resend trace showed the planner clicking "All domains" thinking
// it was the Add button (because "AddCtrl↩" didn't pattern-match
// "Add" cleanly). Exported for unit testing.
export function splitKeyboardShortcut(text: string): {
  label: string;
  shortcut: string | null;
} {
  // Trailing keyboard hint = optional modifier (Ctrl/⌘/Cmd/Shift/Alt/
  // Opt/Option/Meta), optional `+`, then one of: arrow-return symbols,
  // named keys (Enter/Esc/Tab/Space/Return), or a single letter / Fn key.
  // The suffix MUST start at a word boundary OR a transition from
  // lowercase to uppercase ("AddCtrl" — Add↑↓Ctrl). Anchored to end-
  // of-string.
  const re =
    /(?<=[a-z])(Ctrl|⌘|Cmd|Shift|Alt|Opt(?:ion)?|Meta)?\+?(?:[↩⏎⌫⌦⇧⌘⎋]|Enter|Esc|Tab|Space|Return|F\d{1,2})$/;
  const m = re.exec(text);
  if (m === null) return { label: text, shortcut: null };
  const label = text.slice(0, m.index).trim();
  if (label.length < 2) return { label: text, shortcut: null };
  const shortcut = m[0];
  return { label, shortcut };
}
export function formatInventory(inventory: readonly InteractiveElement[]): string {
  if (inventory.length === 0) return "(no interactive elements found on the page)";
  const textCounts = new Map<string, number>();
  const textKey = (e: InteractiveElement): string =>
    `${e.tag}|${(e.visibleText ?? e.ariaLabel ?? e.labelText ?? "").toLowerCase().trim()}`;
  for (const e of inventory) {
    const k = textKey(e);
    if (k.endsWith("|")) continue; // no text → skip
    textCounts.set(k, (textCounts.get(k) ?? 0) + 1);
  }
  const isDuplicated = (e: InteractiveElement): boolean =>
    (textCounts.get(textKey(e)) ?? 0) > 1;
  return inventory
    .map((e) => {
      const bits: string[] = [`[${e.index}] ${e.tag}`];
      if (e.type !== null) bits.push(`type=${e.type}`);
      if (e.name !== null) bits.push(`name=${e.name}`);
      if (e.placeholder !== null) {
        bits.push(`placeholder=${JSON.stringify(e.placeholder)}`);
      }
      // Surface the *current* value of an input/textarea so the
      // planner can distinguish empty (needs `fill`) from already-
      // populated (already filled — usually no action). Placeholder
      // text is shown separately above and is NOT the value; without
      // this signal Railway's planner saw `placeholder="Token name"`
      // and assumed the field was filled, then kept clicking Create.
      if (
        (e.tag === "input" || e.tag === "textarea") &&
        e.value !== null &&
        e.value !== undefined
      ) {
        bits.push(
          e.value.length === 0
            ? `value="" (EMPTY — fill before submitting)`
            : `value=${JSON.stringify(e.value.slice(0, 60))}`,
        );
      }
      // <select> state. `value=""` is the React-defaulted-placeholder
      // pattern (the first option's value is empty, common for
      // "No workspace" / "Select…" / "Choose…" prompts). React Hook
      // Form treats those fields as untouched and silently rejects
      // submits — Railway's token-creation form was the canonical
      // case. The planner needs the selected text and the option
      // list to issue an explicit `select` step before clicking
      // submit. Selectors run to end-of-line, so this annotation goes
      // BEFORE the trailing `selector=`.
      //
      // rc.17: suppress the DEFAULTED marker for selects we've already
      // selected (data-ts-touched). A successful selectOption to a
      // value="" option leaves value=="" but the form-state is
      // committed — without this suppression the planner would see
      // DEFAULTED again next round and re-select indefinitely.
      if (e.tag === "select") {
        const selectedText = e.selectedOptionText ?? "";
        const isDefaulted =
          e.value !== null && e.value !== undefined && e.value.length === 0;
        const alreadyTouched = e.interactedThisRun === true;
        bits.push(
          isDefaulted && !alreadyTouched
            ? `value="" selected=${JSON.stringify(selectedText)} (DEFAULTED — pick an explicit option before submitting)`
            : `value=${JSON.stringify((e.value ?? "").slice(0, 60))} selected=${JSON.stringify(selectedText)}${alreadyTouched ? " (touched — already selected by bot)" : ""}`,
        );
        if (e.selectOptions !== null && e.selectOptions !== undefined && e.selectOptions.length > 0) {
          const optionTexts = e.selectOptions
            .map((o) => o.text || `(value=${JSON.stringify(o.value)})`)
            .filter((t) => t.length > 0)
            .slice(0, 6)
            .map((t) => JSON.stringify(t))
            .join(", ");
          if (optionTexts.length > 0) bits.push(`options=[${optionTexts}]`);
        }
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
        const { label, shortcut } = splitKeyboardShortcut(e.visibleText);
        bits.push(`text=${JSON.stringify(label)}`);
        if (shortcut !== null) bits.push(`shortcut=${JSON.stringify(shortcut)}`);
      }
      if (e.inConsentWidget) bits.push("[cookie-consent — avoid]");
      // F15 — disambiguating landmark tag for text-duplicates.
      if (
        isDuplicated(e) &&
        e.landmark !== null &&
        e.landmark !== undefined
      ) {
        bits.push(`landmark=${e.landmark}`);
      }
      bits.push(`selector=${e.selector}`);
      return bits.join("  ");
    })
    .join("\n");
}

// Platform-as-a-service customer-tenant suffixes that the bundled PSL
// in `tldts` does NOT (yet) classify as public suffixes, but functionally
// behave like one: every label to the left is a distinct customer site,
// not an extension of the platform's own brand.
//
// Without this override, `getDomain("storysite-production.up.railway.app")`
// returns `"railway.app"` (first label "railway") and the guard wrongly
// matches it to slug "railway" — which is exactly the Railway bug this
// guard is meant to prevent.
//
// Keep this list short: only platforms where serving arbitrary 3rd-party
// content on `*.<suffix>` is the platform's primary purpose. Custom-domain-
// only platforms (e.g. heroku custom domains) don't belong here.
//
// Order matters — most-specific first. We pick the longest suffix the
// hostname ends with.
const PLATFORM_TENANT_SUFFIXES: readonly string[] = [
  "up.railway.app",
  "railway.app",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "fly.dev",
  "onrender.com",
  "herokuapp.com",
  "github.io",
  "gitlab.io",
  "workers.dev",
];

// Treat `hostname` as if `suffix` were a public suffix: return the label
// immediately to the left of the suffix, lowercased. Returns null if the
// hostname doesn't end with the suffix.
function tenantLabelUnderPlatformSuffix(
  hostname: string,
  suffix: string,
): string | null {
  const lc = hostname.toLowerCase();
  const dotSuffix = `.${suffix}`;
  if (!lc.endsWith(dotSuffix)) return null;
  const head = lc.slice(0, -dotSuffix.length);
  if (head.length === 0) return null;
  // The tenant label is the LAST label of head (rightmost-before-suffix).
  const parts = head.split(".");
  return parts[parts.length - 1] ?? null;
}

// BUG-1 GUARD — does `hostname` belong to the same registered domain as
// `serviceSlug` (the alphanumeric squashed service name like "railway",
// "postmark")?
//
// Uses PSL-aware eTLD+1 (via tldts) AND a hardcoded override for
// platform-tenant suffixes the bundled PSL doesn't cover yet, so platform
// subdomains like `*.up.railway.app` and `*.vercel.app` are correctly
// classified as distinct customer sites.
//
//   railway.com                          ↔ slug "railway" → MATCH
//   docs.railway.com                     ↔ slug "railway" → MATCH
//   storysite-production.up.railway.app  ↔ slug "railway" → REJECT
//                                          (matched by platform override —
//                                          tenant label is "storysite-production",
//                                          not "railway")
//   railway.app                          ↔ slug "railway" → MATCH
//                                          (the apex itself is the platform's
//                                          own brand; only labels to the left
//                                          are tenant sites)
//   railway.io (typosquat)               ↔ slug "railway" → MATCH
//                                          (intentional — we can't disambiguate
//                                          typosquats from TLD variants like
//                                          sentry.com vs sentry.io)
//
// Empty slug → permissive (return true), preserving prior behavior when
// no service name was provided to findSignupLink.
//
// Exported for unit testing.
export function hostMatchesServiceDomain(
  hostname: string,
  serviceSlug: string,
): boolean {
  if (serviceSlug.length === 0) return true;
  const lcHost = hostname.toLowerCase();

  // Platform-tenant override: if hostname is `*.<platform-suffix>`, the
  // tenant label (left of the suffix) is the "site name", not the
  // platform's brand. Pick the LONGEST matching suffix so e.g.
  // "x.up.railway.app" picks "up.railway.app" before "railway.app".
  let bestSuffix: string | null = null;
  for (const sfx of PLATFORM_TENANT_SUFFIXES) {
    if (
      lcHost.endsWith(`.${sfx}`) &&
      (bestSuffix === null || sfx.length > bestSuffix.length)
    ) {
      bestSuffix = sfx;
    }
  }
  if (bestSuffix !== null) {
    const tenant = tenantLabelUnderPlatformSuffix(lcHost, bestSuffix);
    if (tenant === null) return false;
    const normalizedTenant = tenant.replace(/[^a-z0-9]/g, "");
    return normalizedTenant === serviceSlug;
  }

  const registered = getDomain(lcHost);
  if (registered === null) return false;
  // The first label of the eTLD+1 is the "site name". For railway.com
  // that's "railway".
  const firstLabel = registered.split(".")[0]?.toLowerCase() ?? "";
  // Normalize: strip hyphens so "trusty-squire" matches slug "trustysquire".
  const normalized = firstLabel.replace(/[^a-z0-9]/g, "");
  return normalized === serviceSlug;
}

// BUG-3 GUARD — diagnostic flag for the Inventory snapshot. Stricter
// than detectAntiBotBlock (no "cf-turnstile" / "recaptcha" raw-HTML
// matches) because the previous regex false-positive matched legitimate
// signup pages that just embed a Turnstile/reCAPTCHA widget script.
// Match on visible-text patterns only.
//
// Exported for unit testing.
export function isAntiBotInterstitialText(visibleText: string): boolean {
  return /just a moment|verify you are human|attention required|are you a robot|checking your browser/i.test(
    visibleText,
  );
}

// Recognize a full-page anti-bot interstitial that's still up. Returns
// the vendor name (for the status message) or null. Pattern matching
// on visible text rather than markers — most vendors use the same UX
// template, and matching the user-visible copy is robust to the actual
// implementation underneath. Exported for unit testing.
export function detectAntiBotBlock(html: string): string | null {
  const text = html.toLowerCase();
  // Cloudflare "Just a moment..." / Turnstile pre-clear page. Strong
  // signal: the literal text + the cf-* class names + the title.
  if (
    /just a moment|cf-(challenge|browser-verification|turnstile)|performing security verification/i.test(
      text,
    )
  ) {
    return "Cloudflare";
  }
  if (/sucuri|sucuri website firewall/i.test(text)) return "Sucuri";
  if (/datadome|dd-captcha/i.test(text)) return "DataDome";
  if (/incapsula|imperva/i.test(text)) return "Imperva";
  return null;
}

// F17 — True when the page looks like an authenticated dashboard
// rather than a sign-up page. Triggers when a prior OAuth bind
// already linked the account and the service auto-redirects past
// the sign-in widget on the next visit.
//
// **Universal precondition**: no email/password/tel input visible.
// A true sign-up page virtually always has at least one; if any
// such input is present, we are NOT authenticated regardless of
// what other markers the page carries.
//
// **Positive signals (any one fires authentication)**:
//   1. Explicit nav keyword (Sign out / Log out / Dashboard /
//      Projects / Settings / Profile / Account / Workspaces) —
//      the canonical strict-match path. Works for Sentry,
//      OpenRouter, Postmark, etc. — sites with a real nav bar.
//   2. Billing / trial widget visible ("$X.XX left", "N days left",
//      "Trial") — these only render to authenticated users. Caught
//      Railway's `/new` page where the only post-login marker was
//      the "28 days or $5.00 leftTrial" button.
//   3. Dashboard-route URL (path contains /new, /dashboard,
//      /projects, /account, /settings, /workspace) AND a creation
//      CTA visible ("New project", "Create", "New <X>") — paired
//      signal that catches sparse SPAs whose entire layout is a
//      single create-form on a logged-in URL.
//
// rc.18: signals 2 and 3 added. Previously only signal 1 was
// checked; Railway's project-creation widget tripped the form-fill
// fallback (and a low-confidence LLM plan that filled "Empty
// Project" then waited for a verification email that never came).
export function detectAlreadySignedIn(args: {
  inventory: readonly InteractiveElement[];
  url: string;
}): boolean {
  const { inventory, url } = args;

  // Precondition: any visible credential input → not authenticated.
  const hasCredentialInput = inventory.some(
    (e) =>
      e.tag === "input" &&
      (e.type === "email" || e.type === "password" || e.type === "tel"),
  );
  if (hasCredentialInput) return false;

  const visibleTextOf = (e: InteractiveElement): string =>
    `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.trim();

  // Signal 1 — strict nav-keyword match (the canonical Sentry-class case).
  const AUTH_KEYWORDS =
    /^\s*(?:sign out|log out|dashboard|projects|settings|profile|my account|account settings|workspaces)\s*$/i;
  if (
    inventory.some((e) => AUTH_KEYWORDS.test((e.visibleText ?? e.ariaLabel ?? "").trim()))
  ) {
    return true;
  }

  // Signal 2 — billing / trial widget. Patterns observed in the wild:
  //   "28 days or $5.00 leftTrial" (Railway, no separator)
  //   "Trial" (most SaaS)
  //   "$N left" / "N days left" / "remaining"
  const BILLING =
    /(?:\$\d+(?:\.\d+)?\s*(?:left|remaining)|\d+\s*days?\s*(?:left|remaining|trial)|\btrial\b)/i;
  if (inventory.some((e) => BILLING.test(visibleTextOf(e)))) {
    return true;
  }

  // Signal 3 — dashboard-route URL + creation CTA visible.
  // The URL gate is conservative: a path that READS as dashboard,
  // not /login or /signup or /. Combined with a creation CTA
  // ("New project", "Create workspace", "+ New") it pins the
  // page as a post-login surface.
  let dashboardyPath = false;
  try {
    const parsed = new URL(url);
    dashboardyPath =
      /\/(?:new|dashboard|projects?|account|settings|workspace|home)(?:\/|$)/i.test(
        parsed.pathname,
      ) && !/\/(?:signup|sign-up|register|login|sign-in|signin)/i.test(parsed.pathname);
  } catch {
    // Malformed URL — skip URL signal.
  }
  if (dashboardyPath) {
    const CREATION_CTA =
      /^\s*(?:\+\s*)?(?:new\s+(?:project|workspace|team|app|site|deployment|api\s*key)|create(?:\s+(?:new|a|project|workspace))?)/i;
    if (
      inventory.some((e) => {
        const t = e.visibleText ?? e.ariaLabel ?? "";
        return CREATION_CTA.test(t.trim());
      })
    ) {
      return true;
    }
  }

  return false;
}

// True when the page has no fillable text input AND no button that
// reads as an email-signup option — a genuinely OAuth/SSO-only
// service with no form to automate (F3 Issue 4).
// rc.33-task — scan the inventory for any OAuth provider buttons,
// regardless of whether the bot has a session for them. Used by the
// OAuth-only-chooser branch to surface needs_oauth_provider_session
// with the SPECIFIC providers the page offers. Detection mirrors
// findOAuthButton's logic (visible text / aria-label / iconLabel
// containing the provider keyword + an auth verb, or href to the
// provider's OAuth endpoint).
//
// Returns providers in the order they were found in the inventory,
// deduped.
export function detectOAuthProvidersInInventory(
  inventory: readonly InteractiveElement[],
): OAuthProviderId[] {
  const found = new Set<OAuthProviderId>();
  const providers: OAuthProviderId[] = ["google", "github"];
  for (const provider of providers) {
    if (findOAuthButton(inventory, provider) !== null) {
      found.add(provider);
    }
  }
  return [...found];
}

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
//
// rc.12 — sanity-cap the element's own visible text. A real sign-in
// button is short ("Continue with Google" = 19 chars, "Sign in with
// GitHub" = 19). When the element's visibleText runs longer than the
// cap below, it is wrapping unrelated content — typically a marketing
// card with a small provider logo nested inside. The OpenRouter case:
// an <a> wrapping a model card whose textContent reads "anthropic/
// claude-opus-4.7Model routing visualization…" and whose descendant
// tree contains an <img alt="Google"> for a tiny G icon. The iconLabel
// path then fired against the wrong element. Capping at 60 chars also
// gates path 2 to truly icon-only elements (no own visible text) so a
// card wrapper with one stray <img alt> can never match.
const MAX_OAUTH_BUTTON_TEXT_CHARS = 60;
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
    const visibleText = (e.visibleText ?? "").trim();
    if (visibleText.length > MAX_OAUTH_BUTTON_TEXT_CHARS) continue;
    // 1. An <a> whose href routes through the provider's OAuth endpoint.
    const href = (e.href ?? "").toLowerCase();
    if (href.length > 0 && hrefRe.test(href)) return e;
    // 2. Icon-only button — named only by a descendant img/svg. Require
    //    the element to be truly icon-only (no own visible text); a
    //    populated visibleText means the iconLabel signal is redundant
    //    with path 3 below, and accepting it here lets a card wrapper
    //    with a stray <img alt="Google"> inside match.
    if (
      visibleText.length === 0 &&
      keywordRe.test((e.iconLabel ?? "").toLowerCase())
    ) {
      return e;
    }
    // 3. Visible text / accessible label naming the provider + an
    //    auth verb. The auth verb requirement rejects nav and policy
    //    links that merely mention the provider.
    const text = `${visibleText} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`
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

// rc.20 — true when the post-OAuth landing page LOOKS like the same
// login/auth UI the bot just OAuth'd from AND still surfaces an OAuth
// affordance for the same provider. Services like Groq complete the
// Google handshake server-side but bounce the user back to a
// /authenticate page that requires one more click of the provider
// button to actually finalize the session. Returns the OAuth button
// to click (so the caller can pass it to startOAuth) or null when the
// page is past that gate.
//
// Login-shaped path patterns: /login, /signin, /sign-in, /signup,
// /sign-up, /auth, /authenticate, /authorize. Excludes /callback
// (genuinely transient) and dashboard-shaped paths.
export function isLoginLoopState(
  url: string,
  inventory: readonly InteractiveElement[],
  provider: OAuthProviderId,
): InteractiveElement | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const loginPath =
    /\/(?:login|signin|sign-in|signup|sign-up|auth|authenticate|authorize)(?:\/|$)/.test(
      path,
    );
  if (!loginPath) return null;
  // Defense in depth: if the page also shows authenticated-state
  // markers (Sign out / Dashboard / billing widget) it isn't really
  // a login loop — the OAuth-buttons are decoration. detectAlreadySignedIn
  // returns false when ANY credential input is visible, but here we're
  // checking the inverse — markers despite the login path.
  if (detectAlreadySignedIn({ inventory, url })) return null;
  return findOAuthButton(inventory, provider);
}

// Path-only formatter for step trail entries. Same parse semantics as
// isLoginLoopState — best-effort, returns "(unparseable)" on failure.
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unparseable)";
  }
}

// rc.24 — three more early-abort detectors surfaced from the
// registry-snapshot review of 200 failed signups. Each catches a
// state where the bot has already OAuth'd but the service has
// erected a gate the bot definitionally cannot pass. Returning the
// gate kind lets the caller emit a precise terminal error rather
// than burning the post-verify budget.
export type PostOAuthGate =
  | { kind: "ok" }
  | { kind: "manual_login_fallback" }
  | { kind: "email_otp_required" }
  | { kind: "sso_restricted" };

// (a) Manual-login fallback. DigitalOcean + Hyperbolic completed the
// Google OAuth handshake on Google's side but the service didn't
// honour the callback — the bot lands back on a manual /login page
// with email + password inputs. Distinct from the rc.20 login-loop
// (which assumes the page still surfaces OAuth provider buttons).
export function detectManualLoginFallback(
  url: string,
  inventory: readonly InteractiveElement[],
): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  const loginPath =
    /\/(?:login|signin|sign-in|signup|sign-up|authenticate)(?:\/|$)/.test(path);
  if (!loginPath) return false;
  // Manual-login signal: email + password input pair on the page.
  const hasEmail = inventory.some(
    (e) => e.tag === "input" && e.type === "email",
  );
  const hasPassword = inventory.some(
    (e) => e.tag === "input" && e.type === "password",
  );
  return hasEmail && hasPassword;
}

// (b) Email-OTP wall. Porter, Koyeb (both WorkOS-backed) send a 6-
// or 8-digit code to the operator's email and gate further access
// behind it. Signal: URL path or title literal "email-verification"
// + a single short-numeric input in the inventory.
export function detectEmailOtpGate(
  url: string,
  title: string,
  pageText: string,
): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = "";
  }
  if (/email[-_]verification|verify[-_]email|email[-_]code|otp/.test(path)) {
    return true;
  }
  const titleLower = title.toLowerCase();
  if (
    titleLower.includes("verify your email") ||
    titleLower.includes("email verification")
  ) {
    return true;
  }
  // Page-text fallback for services that route OTP gates through
  // generic URLs (the bot has the rendered body anyway). Conservative
  // phrasing — must include a "we sent … code … to" or "enter …
  // code … sent" shape with a bounded gap.
  const lower = pageText.toLowerCase();
  return (
    /we sent[^.]{0,60}\bcode\b[^.]{0,40}to\b/.test(lower) ||
    /enter[^.]{0,40}\bcode\b[^.]{0,40}\b(?:sent|email)/.test(lower)
  );
}

// (c) SSO restriction (Fly.io class). Service rejects token-creation
// for accounts whose org enforces SSO/SAML. Signal: phrase fragments
// that explicitly name SSO/SAML/Single Sign-On as the blocker.
export function detectSsoRestriction(pageText: string): boolean {
  const lower = pageText.toLowerCase();
  // Common phrasings observed: "managed via SSO", "SSO-managed",
  // "Single Sign-On is required", "SSO organization membership".
  return /(?:managed\s+via\s+(?:sso|single\s+sign-?on)|sso[\s-]?managed|sso\s+organization|single\s+sign-?on\s+is\s+required|enforced\s+by\s+(?:sso|saml))/.test(
    lower,
  );
}

// (d) Stuck-on-Google-OAuth-screens (Upstash class). After
// settleAfterOAuth the URL is STILL on accounts.google.com — the
// handshake didn't redirect through to the service. Most common
// shape: Clerk-mediated OAuth (Upstash's auth.upstash.com → Google
// account chooser) where the chooser uses a clickable card the
// post-verify planner can't reliably target, and the bot loops
// trying. Defining trait: hostname accounts.google.com (or
// accounts.googleusercontent.com) at the post-OAuth gate.
export function detectStuckOnGoogleOAuth(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "accounts.google.com" ||
      h === "accounts.googleusercontent.com" ||
      h.endsWith(".accounts.google.com")
    );
  } catch {
    return false;
  }
}

// Scan the inventory for the first OAuth affordance among `providers`,
// in order — the auto-prefer decision passes every provider the
// profile has a session for. Returns the matched provider + element.
export function findFirstOAuthButton(
  inventory: readonly InteractiveElement[],
  providers: readonly OAuthProviderId[],
): { provider: OAuthProviderId; button: InteractiveElement } | null {
  for (const provider of providers) {
    const button = findOAuthButton(inventory, provider);
    if (button !== null) return { provider, button };
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
      // F11: `option_text` is optional — when present, the executor
      // picks the option whose visible text contains it (case-
      // insensitive substring). When absent, picks the first option.
      const optionText = obj["option_text"];
      return {
        kind: "select",
        selector,
        reason,
        ...(typeof optionText === "string" && optionText.length > 0
          ? { option_text: optionText }
          : {}),
      };
    }
    case "check": {
      const selector = requireString(obj, "selector", "post-verify check step");
      checkSelector(selector, "post-verify check step");
      return { kind: "check", selector, reason };
    }
    case "scroll": {
      // `selector` is optional. When the planner does name one (rare
      // — div containers aren't in the inventory) it does NOT need
      // to be in `allowedSelectors`; the bot's auto-detect handles
      // missing/wrong selectors gracefully and the inventory check
      // would otherwise force the planner to omit a valid hint.
      const sel = obj["selector"];
      return {
        kind: "scroll",
        reason,
        ...(typeof sel === "string" && sel.length > 0 ? { selector: sel } : {}),
      };
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
// True when `capturedKey` is followed by a truncation marker (`...`
// or the Unicode ellipsis `…`) in `sourceText`. That marker is the
// signal that the visible display masked the full secret — the
// regex captured everything up to but not including the marker, so
// the value LOOKS valid but is short. Used by F10's
// extract-via-Copy-button recovery path; without this check, the
// bot accepts the truncated value, stores it, and the user discovers
// the failure only when their next API call returns 401.
export function isTruncatedCapture(sourceText: string, capturedKey: string): boolean {
  const idx = sourceText.indexOf(capturedKey);
  if (idx < 0) return false;
  const after = sourceText.slice(
    idx + capturedKey.length,
    idx + capturedKey.length + 10,
  );
  // Whitespace OK between key and ellipsis (some modals render as
  // "sk-or-v1-xxxx ..."). Three OR MORE dots; two dots are ordinary
  // punctuation and would false-positive on e.g. "key value.." in
  // help text.
  return /^\s*(?:\.{3,}|…)/.test(after);
}

// rc.28 — when the regex library doesn't recognize the credential
// shape (e.g. IPInfo's 14-char hex token has no service-prefix and
// no nearby "API key" label, so extractApiKeyFromText returns null),
// the Claude vision planner often still quotes the value in its
// `extract` step reason — e.g. "The API token 'fd3afcbe09648c' is
// fully visible on the dashboard under 'API Access'". This pulls
// quoted credential-shaped substrings from the reason, then keeps
// only those that appear verbatim in the page text — the
// verbatim-in-DOM check is the guardrail against accepting a
// hallucinated value. Exported for unit testing.
export function extractQuotedTokenFromReason(
  reason: string,
  pageText: string,
): string | null {
  // Single/double/back quotes around a credential-shaped value.
  // Min 10 chars filters out short UI words ("Yes", "Copy"); max 80
  // is the same ceiling extractApiKeyFromText effectively uses via
  // its MAX_CREDENTIAL_LENGTH counterpart. Character class matches
  // what real API tokens look like: alphanumeric, underscores,
  // hyphens; no spaces, no punctuation that would gather UI text.
  const matches = reason.matchAll(/['"`]([A-Za-z0-9_\-]{10,80})['"`]/g);
  for (const m of matches) {
    const candidate = m[1];
    if (candidate === undefined) continue;
    if (pageText.includes(candidate)) return candidate;
  }
  return null;
}

export function extractApiKeyFromText(text: string): string | null {
  const prefixed: readonly RegExp[] = [
    /\bre_[a-zA-Z0-9_]{20,}\b/, // Resend (key body contains underscores)
    /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}\b/, // Stripe secret
    // NOTE: client-embedded PUBLIC keys are deliberately NOT matched —
    // Stripe publishable (pk_live_/pk_test_) and PostHog project
    // (phc_) keys ship in the client-side JS of every site that uses
    // those vendors, so finding one on a page means "this service
    // embeds Stripe/PostHog", not "here is the user's credential".
    // Each produced a false success on Mistral (its billing pk_live_,
    // then its analytics phc_, surfaced as the api_key).
    /\bkey-[a-f0-9]{32}\b/, // Mailgun
    /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\b/, // SendGrid
    /\brnd_[a-zA-Z0-9]{20,}\b/, // Render
    /\bsntry[su]_[A-Za-z0-9_=\-]{20,}/, // Sentry org/user auth token
    // Neon serverless Postgres. Modal renders `napi_<48-char-alnum>` and
    // also shows a truncated `napi_xxx…` in the visible text below the
    // input field. Without the prefix here, the bot saw the truncated
    // display, isTruncatedCapture rejected the partial value, every
    // pass returned null, and the planner gave up despite the full key
    // being in the input field's `value` attribute. rc.14 — surfaced
    // during the harvester rc.13 pass on Neon.
    /\bnapi_[a-zA-Z0-9]{30,80}\b/, // Neon
    // Replicate API tokens. `r8_<40-char alnum>` per their docs. Shown
    // in the table row after Create. The post-verify loop iterates,
    // adds rows, but extractCredentials returned null every round
    // until rc.20 because no regex matched. Added defensively after
    // the rc.13 verification pass showed Replicate burning the full
    // 12-round budget filling-creating tokens nobody could extract.
    /\br8_[a-zA-Z0-9]{30,60}\b/, // Replicate
    // rc.23 — added after the post-rc.22 registry-snapshot review of
    // 200 failed signups. Each pattern matches a token shape the
    // bot's planner had already QUOTED in its `reason` field (i.e.
    // the credential was visible on the page, just not in a shape
    // any prior regex recognised). The redact.{ts,mjs} pattern set
    // stays in lockstep with these.
    /\bpscale_tkn_[A-Za-z0-9]{30,60}\b/, // PlanetScale Service Token
    /\bsbp_[a-zA-Z0-9]{30,80}\b/, // Supabase Personal Access Token
    // Baseten: `<8-12 lowercase>.<30+ mixed-case>`. The dot separator
    // + alphanumeric body distinguishes it from version strings (too
    // short on either side) and dotted ULID-like keys (mostly lowercase
    // body). Verbatim-in-DOM check at the post-verify level rejects
    // any false positive.
    /\b[a-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/, // Baseten
    // Qdrant Cloud: `<UUID>|<55-char opaque>` — a literal pipe between
    // a key id and the secret body. Unique enough that no false-
    // positive guard is needed.
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9]{30,80}\b/i, // Qdrant
    // JWT (eyJ...eyJ...sig) — Convex's API "token" is a JWT. Other
    // services may emit JWTs as bearer secrets too. Three-segment
    // base64url with literal dots. Conservative bounds — under 20
    // chars per segment is almost never a real JWT.
    /\beyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/, // JWT
    // Zeabur's API key — `sk-<28-40 lowercase alnum>`. Shorter than
    // OpenAI legacy (which is 40+ mixed-case). The lowercase-only
    // character class differentiates from OpenAI legacy so this
    // pattern only fires on Zeabur-style keys. Surfaced from the
    // rc.23 snapshot review.
    /\bsk-[a-z0-9]{28,38}\b/, // Zeabur
    // OpenRouter, Anthropic, OpenAI — these are the dominant
    // OAuth-completed-then-copy-needed services. Specific-prefix
    // patterns first so a labeled-pattern fallback isn't load-
    // bearing for them. Putting `sk-or-v1-` before `sk-` so it wins
    // when both could match (cosmetic; both capture the same value).
    // 0.6.15-rc.8 — character-class anchored so the greedy match
    // doesn't glue trailing modal text. extractText() returns body
    // as one concatenated string, so a key followed by "Please copy
    // this" with no separator looked like `sk-or-v1-<64hex>Please…`.
    // The hex-only class terminates at the first non-hex char.
    /\bsk-or-v1-[a-f0-9]{40,80}/i, // OpenRouter (sk-or-v1-<64hex>)
    /\bsk-ant-[a-zA-Z0-9_-]{40,120}/, // Anthropic (sk-ant-<urlsafe-b64>)
    /\bsk-proj-[a-zA-Z0-9_-]{40,200}/, // OpenAI project key
    /\bsk-[a-zA-Z0-9]{40,60}/, // OpenAI legacy (`sk-` + ~48 chars, no dashes)
  ];
  for (const pattern of prefixed) {
    const match = text.match(pattern);
    if (match !== null) return match[0];
  }

  // Labeled patterns. The label and value MUST be separated by a real
  // separator — a colon/equals, or whitespace — `(?:[ \t]*[:=][ \t]*|[ \t]+)`,
  // never a newline. A MANDATORY separator is what keeps the regex from
  // latching the label onto glued dashboard nav text: a sidebar
  // rendering "API Keys" "Webhooks" "Settings" as adjacent links
  // concatenates in textContent to "API KeysWebhooksSettings…", and an
  // optional-gap regex would capture "sWebhooksSettings…" as the key
  // (Resend false-positive). Requiring `:`/`=`/space means "API Key"
  // followed immediately by a letter does not match.
  const labeled: readonly RegExp[] = [
    /(?:api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key)(?:[ \t]*[:=][ \t]*|[ \t]+)([a-zA-Z0-9_\-]{20,})/i,
    /\b[Bb]earer[ \t]+([a-zA-Z0-9_\-.]{30,})/,
    // UUID-style tokens (Railway uses bare UUIDs for API tokens; some
    // smaller services do too). MUST be labeled — bare UUIDs appear all
    // over dashboards as trace IDs, project IDs, and request IDs, so an
    // unlabeled UUID regex would false-positive on the first error page
    // the bot lands on. The label set is broader than the prefix-style
    // labeled regex above because Railway specifically renders "Token"
    // (not "API key") next to the value.
    /(?:api[_\s-]?token|api[_\s-]?key|access[_\s-]?token|new[_\s-]?token|\btoken|\bsecret)(?:[ \t\n]*[:=][ \t\n]*|[ \t\n]+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
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
    // rc.32 — forensic snapshot after the captcha attempt. Without
    // this, the only snapshot near the captcha is the pre-fill one
    // taken BEFORE the click, so when a Turnstile fails to solve we
    // can't tell whether (a) the bot's click didn't register (widget
    // remains in initial state), (b) the click registered but
    // Cloudflare immediately rejected it (red X / re-challenge), or
    // (c) the click registered and a challenge grid rendered that
    // we can't solve. Each path takes a different fix. Solved runs
    // also save the snapshot — green-checkmark state is useful
    // forensic data for tuning the success-detection regex.
    await saveDebugSnapshot(this.browser, `captcha-after-${result.solved ? "solved" : "timeout"}`);
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
    let oauthScanRetries = 0;
    let hint: string | undefined;
    // F14 — selectors the planner clicked WITHOUT advancing the page.
    // Each no-progress plan records its click selectors here; the next
    // plan that picks ONLY selectors in this set is failed as stuck
    // instead of looping. Cleared on any progress (fill action). The
    // Railway run that motivated F14 spun the same footer "Email" link
    // 5 times before timing out; this loop now bails after 2.
    let lastNoProgressClickSelectors: Set<string> = new Set();
    // rc.31 — once the bot has explicitly clicked an email-flow
    // button (e.g. Railway's "Log in using email" two-stage chooser),
    // stay on the email path. Without this, the auto-OAuth-first
    // detection on the *next* iteration sees the now-revealed
    // "Continue with Google" button and reroutes — exactly the
    // regression that produced the Security Code challenge on
    // methoxine's account during the rc.30 Railway run.
    let committedToEmailPath = false;

    const oauthCandidates = await this.resolveOAuthCandidates(task, steps);
    for (;;) {
      await this.browser.waitForFormReady();
      // Dismiss any cookie/consent banner so its overlay doesn't hide
      // the OAuth chooser or signup form. Only fires when a button
      // matching the canonical CTA vocabulary is visible — silent
      // when no banner is present.
      const dismissed = await this.browser.dismissConsentBanner();
      if (dismissed !== null) {
        steps.push(`Dismissed cookie consent: "${dismissed}"`);
      }
      await saveDebugSnapshot(this.browser, "before-fill");
      // PERF: getState() (page.content + title + screenshot) and
      // extractInteractiveElements (DOM walk) are independent
      // Playwright calls — fire them in parallel.
      const [state, inventory] = await Promise.all([
        this.browser.getState(),
        this.buildInventory(steps, oauthCandidates),
      ]);

      // OAuth-first (T6/T13 + auto-prefer): when the page carries a
      // "Sign in with <provider>" affordance for a provider the bot can
      // use, that button unconditionally outranks any form field — hand
      // off to the OAuth consent flow. `oauthCandidates` is the explicit
      // provider when one was requested, else every provider the profile
      // has a session for. Absent any affordance, fall through to
      // form-fill.
      //
      // rc.31 — skip the OAuth-first scan when we've already committed
      // to the email path on a previous round. Otherwise a two-stage
      // chooser ("Log in using email" → reveals a page with both an
      // email input AND a Google button) reroutes us back to OAuth on
      // the second round.
      if (oauthCandidates.length > 0 && !committedToEmailPath) {
        const hit = findFirstOAuthButton(inventory, oauthCandidates);
        if (hit !== null) {
          const label = OAUTH_PROVIDERS[hit.provider].label;
          steps.push(
            `OAuth-first: found a ${label} sign-in affordance ` +
              `(${JSON.stringify(hit.button.visibleText ?? hit.button.ariaLabel ?? label)}) ` +
              `— taking the OAuth path`,
          );
          return {
            kind: "oauth",
            selector: hit.button.selector,
            provider: hit.provider,
          };
        }
        // SSO buttons frequently load async — Mistral renders its
        // icon-only provider buttons after the email form. Re-extract
        // a couple of times before giving up on the OAuth path.
        if (oauthScanRetries < 2) {
          oauthScanRetries += 1;
          steps.push(
            `OAuth-first: no provider affordance yet — waiting for an ` +
              `async render (retry ${oauthScanRetries}/2)`,
          );
          await this.browser.wait(3);
          continue;
        }
        // F17 — already-signed-in detection. If the inventory shows
        // dashboard markers (Sign out / Dashboard / Projects / etc.)
        // AND no email/password form is visible, this is a previously-
        // authenticated state, not a sign-up flow. Skip the form-fill
        // path entirely and route to the post-OAuth navigation loop
        // to find the API key — same path Sentry/OpenRouter use post-
        // handshake.
        if (detectAlreadySignedIn({ inventory, url: state.url })) {
          steps.push(
            "Auto-OAuth: page shows authenticated-state markers (nav keyword, billing widget, or dashboard URL + create CTA) — " +
              "treating as already authenticated, jumping to post-verify navigation",
          );
          return { kind: "already_oauth" };
        }
        steps.push(
          "OAuth-first: no usable provider affordance on the page — " +
            "falling back to form-fill",
        );
        // Dump visible buttons/links so we can see what the OAuth-
        // first scan rejected. The previous diagnostic only fires for
        // tiny inventories; this one fires whenever the OAuth scan
        // exhausts its retries regardless of inventory size. Lets us
        // tell whether the GitHub/Google button was on the page but
        // mis-matched, or genuinely absent.
        const oauthDiag = inventory
          .slice(0, 20)
          .map((e) => {
            const t = (e.visibleText ?? e.ariaLabel ?? "").slice(0, 50);
            return `  ${e.tag}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(t)}`;
          })
          .join("\n");
        steps.push(
          `OAuth-first scan rejected — visible candidates (${inventory.length}):\n${oauthDiag}`,
        );
      }

      // Anti-bot interstitial that didn't clear (Cloudflare/Sucuri/
      // DataDome "Just a moment..." pages that BrowserController has
      // already attempted to wait + reload through). Detect by page
      // text — the inventory will be tiny because the interstitial
      // intentionally has 0 interactive elements. Surface as its own
      // status, not as oauth_required: the latter implies "service is
      // OAuth-only", which is wrong for Cloudflare et al.
      if (inventory.length < 10) {
        const block = detectAntiBotBlock(state.html);
        if (block !== null) {
          steps.push(
            `Anti-bot block: ${block} interstitial would not clear after retries — ` +
              `the bot's fingerprint/IP did not pass ${block}'s server-side risk score`,
          );
          return { kind: "anti_bot_blocked", vendor: block };
        }
      }

      // OAuth-only: no fillable input AND no button that reads as an
      // email-signup option — nothing to automate (Issue 4).
      if (isOauthOnlyChooser(inventory)) {
        // rc.33-task — distinguish "the bot has no session for the
        // provider the page offers" (operator action: `mcp login
        // --provider=X`) from "service is OAuth-only in general"
        // (operator action: manual signup). When the inventory has
        // OAuth buttons for providers the profile does NOT have a
        // session for AND the operator HAS sessions for other
        // providers, the situation is recoverable — surface the
        // specific provider to seed.
        const visibleProviders = detectOAuthProvidersInInventory(inventory);
        const haveSessions = loggedInProviders();
        const missingProviders = visibleProviders.filter(
          (p) => !haveSessions.includes(p),
        );
        if (
          missingProviders.length > 0 &&
          // Only surface needs_oauth_provider_session when the user
          // can actually act on it — i.e. they have at least one
          // OAuth session already (so they know how to seed
          // others). A fresh install with zero sessions still gets
          // the generic oauth_required (which the install/connect
          // flow has its own help text for).
          haveSessions.length > 0
        ) {
          return {
            kind: "needs_oauth_provider_session",
            missingProviders,
            haveSessions,
          };
        }
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

      // F14 — stuck-detection: if the plan picks ONLY click selectors
      // we already tried in the previous round without page progress,
      // it's a planner loop. Fail planning_failed with the offending
      // selector(s) so the operator sees what stalled. Doesn't fire
      // when the plan adds at least one new selector (legitimate
      // exploration). Doesn't fire on fill plans (forward progress).
      const planClickSelectors = plan.actions
        .filter((a) => a.kind === "click")
        .map((a) => a.selector);
      if (
        planClickSelectors.length > 0 &&
        lastNoProgressClickSelectors.size > 0 &&
        planClickSelectors.every((s) => lastNoProgressClickSelectors.has(s))
      ) {
        return {
          kind: "planning_failed",
          reason: `stuck — planner re-picked the same click selector(s) after no-progress: ${planClickSelectors.join(", ")}`,
        };
      }

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

      // rc.31 — flag the email-path commitment once we've executed a
      // click whose reason explicitly targets an "email" affordance
      // (Railway's "Log in using email", Vercel's "Continue with
      // email", etc.). Subsequent OAuth-first scans will then be
      // suppressed so we don't reroute back to Google/GitHub on the
      // revealed page (the rc.30 Railway regression: clicking the
      // email button revealed a page with BOTH an email input AND a
      // Google button; without this flag the bot picks Google and
      // triggers the Security Code challenge that methoxine can't
      // navigate). One-way flag — once we're on email, we stay.
      if (!committedToEmailPath) {
        const emailClick = plan.actions.find(
          (a) => a.kind === "click" && /\bemail\b/i.test(a.reason),
        );
        if (emailClick !== undefined) {
          committedToEmailPath = true;
          steps.push(
            "Committed to email-fill path — auto-OAuth-first scan suppressed for the rest of this signup",
          );
        }
      }

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
        // F14 — record the click selectors that didn't advance the
        // page. The next plan's stuck-detection check (above) bails
        // if it picks the same ones again. Hint also tells the
        // planner which selectors NOT to re-pick.
        lastNoProgressClickSelectors = new Set(planClickSelectors);
        const avoidHint =
          planClickSelectors.length > 0
            ? ` AVOID these selectors — they were clicked but the page did NOT advance: ${planClickSelectors.map((s) => JSON.stringify(s)).join(", ")}.`
            : "";
        hint =
          "The previous step revealed or advanced the page. Plan the signup form that should now be visible." +
          avoidHint;
        continue;
      }

      // F14 — fill action present = forward progress. Clear the
      // stuck-tracker so a legitimate later click isn't false-positive
      // rejected.
      lastNoProgressClickSelectors = new Set();

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
      // PERF: 5s was overcautious — runCaptchaGate has its own wait
      // for the captcha widget to render, and waitForFormReady at
      // the next planner iteration handles SPA settle.
      await this.browser.wait(2);

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
  // `oauthProviders` keeps those providers' OAuth affordances from
  // being ranked out of the capped inventory (T6/T13 + auto-prefer).
  // `buttonCap` widens for the post-OAuth onboarding loop: a dashboard
  // carries far more nav links than a signup form, and they do not
  // score as signup buttons, so the default cap would drop the "API
  // Keys"/"Settings" links the onboarding planner must reach.
  private async buildInventory(
    steps: string[],
    oauthProviders?: readonly OAuthProviderId[],
    buttonCap = 25,
  ): Promise<InteractiveElement[]> {
    const raw = await this.browser.extractInteractiveElements();
    const { inventory, buttonsDropped } = rankAndCapInventory(
      raw,
      buttonCap,
      oauthProviders,
    );
    steps.push(
      `Inventory: ${inventory.length} element(s)` +
        (buttonsDropped > 0 ? ` (${buttonsDropped} low-ranked button(s) dropped)` : ""),
    );
    // Diagnostic: a suspiciously tiny inventory usually means the page
    // either didn't finish rendering OR an anti-bot interstitial (CF
    // Turnstile, "Just a moment...", reCAPTCHA wall) is up. Surface the
    // page state into the step trail so the failure is debuggable from
    // outside the bot host.
    // Threshold tuned 0.6.1: a Railway signup at /signup landed with
    // 6 elements (no OAuth chooser yet — likely a CTA-only landing
    // page before the real signup form renders). 5 was too narrow.
    if (inventory.length < 10 && raw.length < 10) {
      try {
        const state = await this.browser.getState();
        const text = state.html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        // BUG-3 FIX: match on user-visible text only. Previous regex
        // hit `cf-turnstile` / `recaptcha` / `cloudflare` in raw HTML,
        // false-positive-firing on legitimate signup pages that embed
        // a Turnstile widget script.
        const antiBot = isAntiBotInterstitialText(text);
        steps.push(
          `Inventory diagnostic: title=${JSON.stringify(state.title.slice(0, 80))} ` +
            `url=${state.url.slice(0, 120)} text=${JSON.stringify(text)}` +
            (antiBot ? " ⚠ anti-bot interstitial detected" : ""),
        );
        // Also surface what the (few) elements actually ARE — selector
        // + visible text + tag — so we can see whether the remaining
        // visible affordance is an OAuth chooser, a "Continue" CTA, a
        // language picker, etc.
        if (inventory.length > 0 && inventory.length < 10) {
          const lines = inventory
            .slice(0, 8)
            .map((e) => {
              const text = (e.visibleText ?? e.ariaLabel ?? "").slice(0, 60);
              return `  ${e.tag}${e.type ? `[${e.type}]` : ""} text=${JSON.stringify(text)} sel=${e.selector.slice(0, 80)}`;
            })
            .join("\n");
          steps.push(`Element details (${inventory.length}):\n${lines}`);
        }
      } catch {
        // best-effort diagnostic; never abort on its failure
      }
    }
    return inventory;
  }

  // Which OAuth providers may this signup take? An explicit
  // task.oauthProvider forces that one. Otherwise the bot auto-prefers
  // OAuth — it returns every provider the persistent profile has a
  // login session for, so a "Continue with Google/GitHub" affordance is
  // used instead of a form-fill (which OAuth-gated dev services
  // routinely anti-abuse-flag).
  //
  // No datacenter gate (reversed from the 0.4.0 design): yes, Google /
  // GitHub may challenge OAuth from a datacenter IP (G7), but form-fill
  // on datacenter fails just as often — silent verification withholding,
  // the Resend-on-Hetzner case. An OAuth challenge at least surfaces a
  // clear `needs_login` the host agent can act on, vs. a silent 45-second
  // form-fill timeout. Better failure mode wins; the original gate was
  // protecting the bot from the wrong loss.
  private async resolveOAuthCandidates(
    task: SignupTask,
    steps: string[],
  ): Promise<OAuthProviderId[]> {
    if (task.oauthProvider !== undefined) {
      return [task.oauthProvider];
    }
    const loggedIn = loggedInProviders();
    if (loggedIn.length === 0) return [];
    // Stable tiebreak when both providers have a session: Google
    // first. Google's OAuth flow is one-click in the common case
    // (consent + redirect); GitHub's typically requires the explicit
    // authorize-then-grant double step. Lower friction, fewer
    // number-match challenges on warm sessions.
    const ordered = [...loggedIn].sort((a, b) => {
      if (a === b) return 0;
      if (a === "google") return -1;
      if (b === "google") return 1;
      return 0;
    });
    steps.push(
      `Auto-OAuth: profile has a session for ${ordered.join(", ")} — ` +
        "preferring OAuth if the page offers it",
    );
    return ordered;
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

  // Diagnostic uploader — best-effort. When set, the post-verify
  // loop uploads the current DOM + screenshot to the registry-api
  // after a failed extract pass, so UI-shape regressions can be
  // diagnosed without users needing to configure debug env vars.
  // Wired from the MCP layer; undefined in unit-test contexts.
  private readonly extractFailureUploader?: ExtractFailureUploader;
  // Per-round telemetry uploader (0.6.14-rc.11). Fires on every post-
  // verify round so the registry has the full DOM + screenshot trail
  // for any stuck signup, not just the ones that fail at extract.
  private readonly roundUploader?: RoundUploader;
  // Set per-task in signup(). Lets the uploader know which service
  // was being provisioned without threading it through every call.
  private currentService = "";
  // rc.27 — set when the email_otp_required gate handler successfully
  // fetched a code from the operator's gmail. Consumed by the next
  // post-verify round's planner prompt as a hint so the planner can
  // fill the verification input without burning rounds discovering
  // it. Cleared once the loop emits a step that targets the OTP
  // input, so the hint doesn't echo into later unrelated rounds.
  private pendingOtpCode: string | null = null;

  constructor(
    private browser: BrowserController,
    llm?: LLMClient | LLMPair,
    opts: {
      extractFailureUploader?: ExtractFailureUploader;
      roundUploader?: RoundUploader;
    } = {},
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
    if (opts.extractFailureUploader !== undefined) {
      this.extractFailureUploader = opts.extractFailureUploader;
    }
    if (opts.roundUploader !== undefined) {
      this.roundUploader = opts.roundUploader;
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
    // task.stepsSink lets a caller (provision-any) share the live step
    // trail so check_provision_status can surface mid-run prompts
    // (Google number-match etc.). Without it, the run still works —
    // steps are just only visible in the final result.
    const steps: string[] = task.stepsSink ?? [];
    // Stash the service name so the diagnostic uploader (called from
    // deep inside postVerifyLoop after a failed extract) can label
    // the snapshot without us threading task through every method.
    this.currentService = task.service;
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

    // F13 diagnostic: which Chrome launch mode start() chose, and
    // whether egress went through the configured proxy. Lets us tell
    // from outside the box whether the bot actually got an X display
    // surface AND whether the residential-proxy path engaged.
    steps.push(
      `Browser: launched mode=${this.browser.launchMode} ` +
        `proxy=${this.browser.proxied ?? "direct"} ` +
        `channel=${this.browser.channel ?? "bundled-chromium"}`,
    );

    try {
      // Step 1: Navigate to signup page
      //
      // When no signup_url is provided, GUESS the canonical
      // `https://<service>.com/signup` first — most dev-SaaS targets
      // (Resend, Postmark, Mailgun, IPInfo, MailerSend, ...) live
      // there. Falls back to a Google search + findSignupLink only if
      // the guess doesn't look like a usable signup page after load
      // (404, marketing page with no inputs/OAuth, etc.). The old
      // default ALWAYS started on Google search, which on top of
      // being slower had its own failure mode: the search-result
      // extractor often returned a docs URL or marketing root rather
      // than the signup page, and the bot would bail with
      // oauth_required when it landed on a page that didn't show the
      // OAuth buttons until you clicked "Sign up" first.
      const guessed = task.signupUrl ?? guessSignupUrl(task.service);
      let signupUrl = guessed;

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
      // The prewarm runs against the guessed (or explicit) origin —
      // skipped only when the URL is a Google-search URL itself.
      if (!isGoogleSearchUrl(signupUrl)) {
        await this.runPrewarm(signupUrl, steps);
      }

      steps.push(`Navigating to ${signupUrl}`);
      await this.browser.goto(signupUrl);
      // PERF: goto() awaits domcontentloaded; the subsequent
      // waitForFormReady in planExecuteWithRetry handles SPA settle.
      // No need for a blind 2s dwell here.

      // When we *guessed* (no signup_url provided) and the page after
      // load doesn't look like a signup page — no inputs, no OAuth
      // affordance, or an obvious 404/error title — fall back to the
      // search-and-find-link path. This is the safety net that lets
      // the bot recover from a wrong canonical guess (e.g. a service
      // that uses /register or a non-`.com` TLD).
      //
      // BUG-2 GUARD: when the guessed URL came from KNOWN_DOMAINS as a
      // full hardcoded URL (e.g. Railway → https://railway.com/login,
      // Cloudflare → https://dash.cloudflare.com/sign-up), trust the
      // mapping. These were explicitly chosen because the default
      // /signup path 404s and the real entry is non-obvious — falling
      // back to a Google search has produced cross-domain bugs (the
      // Railway run that ended up on storysite-production.up.railway.app).
      const usedKnownFullUrl = isKnownDomainFullUrlMatch(task.service, guessed);
      if (
        task.signupUrl === undefined &&
        !usedKnownFullUrl &&
        !(await this.looksLikeSignupPage())
      ) {
        steps.push(
          `${guessed} didn't look like a signup page — searching for the real one`,
        );
        const fallbackSearch = `https://www.google.com/search?q=${encodeURIComponent(`${task.service} signup`)}`;
        await this.browser.goto(fallbackSearch);
        // PERF: domcontentloaded from goto() + findSignupLink reads
        // the DOM itself — no blind dwell needed.
        signupUrl = fallbackSearch;
      }

      if (signupUrl !== guessed || isGoogleSearchUrl(signupUrl)) {
        steps.push("Searching for signup page...");
        const found = await this.findSignupLink(task.service);
        if (found !== null) {
          // Now that we know the real signup origin, prewarm it before
          // the deep navigation. Same rationale as above.
          await this.runPrewarm(found, steps);
          steps.push(`Found signup link: ${found}`);
          await this.browser.goto(found);
          // PERF: planner loop's waitForFormReady is next; no dwell.
        } else {
          // BUG-1 GUARD: findSignupLink filters off-domain candidates
          // (registered-domain match against the service slug). If
          // nothing remained AND we'd been sent here from a Google
          // fallback, the bot is sitting on a SERP with no usable
          // destination — abort rather than let the form-fill planner
          // happily fill the Google search box.
          if (isGoogleSearchUrl(signupUrl)) {
            return {
              success: false,
              error:
                `no_signup_link: searched for ${task.service}'s signup page and ` +
                `found no on-domain candidates. The service likely doesn't have ` +
                `a public self-serve signup, or the bot's domain guard rejected ` +
                `every match. Sign up manually.`,
              steps,
              ...this.resultTail(),
            };
          }
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
        case "needs_oauth_provider_session": {
          // rc.33-task — actionable: name the missing provider so
          // the user runs the right `mcp login` command. When more
          // than one provider is missing, the message lists them and
          // recommends any single one (operator picks).
          const missing = outcome.missingProviders;
          const have = outcome.haveSessions;
          const firstMissing = missing[0];
          const missingLabel = missing
            .map((p) => OAUTH_PROVIDERS[p].label)
            .join(" / ");
          const haveLabel =
            have.length > 0
              ? have.map((p) => OAUTH_PROVIDERS[p].label).join(", ")
              : "(none)";
          return {
            success: false,
            error:
              `needs_oauth_provider_session: ${task.service} offers ${missingLabel} OAuth ` +
              `but the bot's chrome profile has no ${missingLabel} session ` +
              `(currently signed in to: ${haveLabel}). ` +
              `Run \`npx @trusty-squire/mcp login --provider=${firstMissing}\` ` +
              `to seed the session, then retry.`,
            steps,
            ...this.resultTail(),
          };
        }
        case "anti_bot_blocked":
          return {
            success: false,
            error:
              `anti_bot_blocked: ${task.service}'s ${outcome.vendor} anti-bot interstitial would ` +
              `not clear — the bot's IP/fingerprint did not pass ${outcome.vendor}'s server-side ` +
              `risk score. This is a soft block (no challenge to solve); the user should sign up ` +
              `manually.`,
            steps,
            ...this.resultTail(),
          };
        case "oauth":
          // T6/T7 — OAuth-first path. runOAuthFlow drives the consent
          // handshake and post-OAuth onboarding to its own terminal
          // SignupResult; there is no form submit / email verification.
          return await this.runOAuthFlow(
            task,
            outcome.selector,
            outcome.provider,
            steps,
          );
        case "already_oauth": {
          // F17 — page rendered an authenticated dashboard (a
          // previous OAuth bind already linked the account). Skip
          // consent + form-fill, navigate straight to the API key.
          // Uses the same post-OAuth loop runOAuthFlow uses after a
          // successful handshake.
          let credentials = await this.extractCredentials();
          if (credentials.api_key === undefined) {
            credentials = await this.postVerifyLoop({
              service: task.service,
              maxRounds: task.postVerifyMaxRounds ?? 12,
              steps,
              ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
            });
          }
          if (credentials.api_key !== undefined) {
            return {
              success: true,
              credentials,
              steps,
              ...this.resultTail(),
            };
          }
          return {
            success: false,
            error:
              "no_credentials_after_already_signed_in: bot detected an authenticated dashboard " +
              "but post-OAuth navigation did not surface an API key. Sign in manually and generate the token.",
            steps,
            ...this.resultTail(),
          };
        }
        case "submitted":
          break;
      }
      await saveDebugSnapshot(this.browser, "after-submit");

      // Step 6: Extract creds from page.
      steps.push("Extracting credentials from page...");
      let credentials = await this.extractCredentials();

      // Step 7: Email verification + post-verification navigation.
      let verificationFailed: string | undefined;
      if (credentials.api_key === undefined && credentials.username === undefined) {
        // S3: read the post-submit page first. Whether it is actually
        // asking the user to confirm by email decides both the no-inbox
        // bail (M2) and, when an inbox exists, the poll duration.
        const expectsEmail = expectsVerificationEmail(await this.browser.extractText());
        if (task.inbox === undefined) {
          // M2/S3: no inbox to receive a verification email (the SES
          // inbound pipeline is mothballed — TODOS M1). If the page is
          // asking for email confirmation the bot cannot finish this
          // signup, so bail FAST to a manual-signup result rather than
          // a poll that could only ever time out. If the page is NOT
          // asking for email, the credentials simply are not on it —
          // fall through to the generic not-found result below.
          if (expectsEmail) {
            const where = task.signupUrl !== undefined ? ` at ${task.signupUrl}` : "";
            steps.push(
              "Post-submit page asks for email verification, but no inbox is " +
                "configured — stopping for manual signup (no blind poll).",
            );
            verificationFailed =
              `verification_not_sent: ${task.service} requires email verification, ` +
              `which the automated signup cannot complete — finish signing up ` +
              `manually${where}.`;
          }
        } else {
          // S3: don't blind-wait. If the page explicitly tells the user
          // to check their email, poll the full timeout; if not, the
          // service most likely sent nothing — run a short probe.
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
                // PERF: a 1s settle is enough for the verify landing
                // page to commit cookies + render the post-verify
                // dashboard. Previous 3s was over-cautious.
                await this.browser.wait(1);
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
                    ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
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
    providerId: OAuthProviderId,
    steps: string[],
  ): Promise<SignupResult> {
    const provider = OAUTH_PROVIDERS[providerId];
    const loginCmd =
      provider.id === "github"
        ? "npx @trusty-squire/mcp login --provider=github"
        : "npx @trusty-squire/mcp login";
    // rc.22 — OpenRouter (Clerk) renders a visible Cloudflare Turnstile
    // checkbox at the bottom of the same form as the OAuth buttons.
    // Clerk's Google button stops at a loading spinner if Turnstile
    // hasn't been completed — the OAuth click never redirects, the bot
    // sees URL unchanged and times out. clickSubmit handles this for
    // form-submit paths, but OAuth-first bypasses clickSubmit. Run the
    // tier-2 solver here too. Best-effort: a missing widget no-ops, a
    // failed solve still proceeds (the click may still work for some
    // services that don't gate OAuth on Turnstile).
    try {
      const captcha = await this.browser.solveVisibleCaptcha(20_000);
      if (captcha.found) {
        steps.push(
          captcha.solved
            ? `OAuth: ticked the visible ${captcha.kind ?? "captcha"} checkbox before clicking the ${provider.label} affordance`
            : `OAuth: visible ${captcha.kind ?? "captcha"} present but did not solve in 20s — clicking the ${provider.label} affordance anyway`,
        );
      }
    } catch (err) {
      // Solver is best-effort; never block OAuth on its failure.
      steps.push(
        `OAuth: visible-captcha precheck failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    steps.push(`OAuth: clicking the ${provider.label} sign-in affordance`);
    await this.browser.startOAuth(oauthSelector);
    await this.browser.wait(3);
    await saveDebugSnapshot(this.browser, "oauth-after-click");

    // Bounded consent walk — handles account-chooser → consent as two
    // steps without ever spinning. Each iteration re-reads the page.
    const MAX_OAUTH_NAV = 6;
    // True once a clean scope-grant consent has already been
    // auto-approved on this flow. Subsequent unreadable-scope consent
    // pages (post-grant confirmation, account chooser routed through
    // /consent, etc.) get the soft-advance path instead of an abort —
    // because the scope-grant decision was already made and validated.
    let consentAlreadyApproved = false;
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
      steps.push(`OAuth: ${provider.label} auth state = ${authState} (url=${url.slice(0, 120)})`);

      if (authState === "not_provider") break; // flow left the provider — back on the service

      if (authState === "challenge") {
        // rc.26 — always capture forensic state at the moment the
        // challenge is detected. Before this, snapshots fired only at
        // before-fill / oauth-after-click / oauth-post-consent — none
        // covered the challenge page itself. When
        // extractGoogleNumberMatch's patterns don't match the current
        // Google phrasing, this is the only artifact the user can read
        // to find the number to tap.
        await saveDebugSnapshot(this.browser, "google-challenge");

        if (provider.id === "google") {
          const matchNum = extractGoogleNumberMatch(body);
          if (matchNum !== null) {
            // rc.26 — surface in real-time via stderr as well as the
            // step trail. The step trail only renders after the run
            // ends; stderr lands in the harvester output immediately,
            // inside the 2-minute window the user has to react.
            console.error(
              `[universal-bot] GOOGLE NUMBER-MATCH: tap "${matchNum}" on your phone — 2 minute window`,
            );
            steps.push(
              `Google: match the number ${matchNum} on your phone — ` +
                `open the Google app on your phone and tap ${matchNum}`,
            );
            void notifyHeightenedAuth({
              service: task.service,
              digit: String(matchNum),
              windowSeconds: 120,
              machineToken: task.machineToken,
              apiBase: task.apiBase,
            });
            // rc.18 — opt-in Telegram fallback. Bypasses the email
            // path (which collapses to Sent only when GMAIL_USER ==
            // account.email). No-op without TELEGRAM_BOT_TOKEN env.
            void sendTelegramHeightenedAuth({
              service: task.service,
              digit: String(matchNum),
              windowSeconds: 120,
            });
          } else {
            // Extractor missed the number — Google phrasing has
            // drifted again. Surface a banner so the user knows to
            // check the just-saved snapshot before the 2-minute wait
            // expires.
            console.error(
              `[universal-bot] GOOGLE CHALLENGE detected (number-match phrasing not recognized) — ` +
                `read the most recent google-challenge.png in the debug dir to find the number — 2 minute window`,
            );
            steps.push(
              "Google: challenge detected, number-match extractor missed it. " +
                "See the latest google-challenge snapshot in the debug dir to read the number.",
            );
            void notifyHeightenedAuth({
              service: task.service,
              digit: null,
              windowSeconds: 120,
              machineToken: task.machineToken,
              apiBase: task.apiBase,
            });
            void sendTelegramHeightenedAuth({
              service: task.service,
              digit: null,
              windowSeconds: 120,
            });
          }
          // Either way (number found or not), the user can still
          // clear the challenge in the bot's browser window or by
          // tapping on their phone. Wait the full 2 minutes.
          const cleared = await this.waitForGoogleChallenge(provider, steps);
          if (!cleared) {
            return this.oauthAbort(
              "needs_login",
              `Google challenge timed out after 2 minutes. ` +
                `Re-run \`${loginCmd}\`, complete the challenge in the window, then retry.`,
              steps,
            );
          }
          steps.push("Google: challenge cleared — continuing OAuth");
          // Re-classify on the next iteration without burning the
          // OAuth-navigation budget (which assumes continuous
          // browser progress, not a 2-minute human pause).
          i--;
          continue;
        }
        // rc.34 — GitHub 2FA sanity-check page is dismissible. When
        // the user recently (re)configured 2FA, GitHub injects a
        // "Verify your two-factor authentication (2FA) settings"
        // overlay on the OAuth /authorize URL with a literal
        // "skip 2FA verification at this moment" link. That's a
        // non-blocking nag, not a real challenge — clicking skip
        // returns the user to the OAuth handshake. Detect + auto-
        // click before aborting.
        if (provider.id === "github" && isGitHubDismissible2faSetup(body)) {
          steps.push(
            "GitHub: 2FA sanity-check overlay detected (post-setup nag, not a real challenge). " +
              "Clicking 'skip 2FA verification at this moment' to defer.",
          );
          const clicked = await this.browser.clickLinkByText(
            GITHUB_DISMISSIBLE_2FA_SKIP_TEXT,
          );
          if (clicked) {
            // Give GitHub a moment to navigate back to the consent flow.
            await this.browser.wait(2);
            // Re-classify on the next iteration; the URL + body should
            // now be the actual OAuth /authorize consent page.
            i--;
            continue;
          }
          steps.push(
            "GitHub: skip-link click did not register — falling back to needs_login abort.",
          );
        }
        return this.oauthAbort(
          "needs_login",
          `${provider.label} interrupted the sign-in with a security challenge ("verify it's you"). ` +
            `Re-run \`${loginCmd}\`, clear the challenge in the window, then retry.`,
          steps,
        );
      }
      if (authState === "needs_login") {
        // Drop the provider from the logged-in marker so the NEXT
        // signup doesn't optimistically re-take the OAuth path and
        // fail the same way — it'll fall back to form-fill until the
        // user runs `mcp login` to re-establish a usable session.
        clearProviderLoggedIn(provider.id);
        steps.push(
          `OAuth: cleared ${provider.label} from logged-in providers — ` +
            `future signups will form-fill until \`${loginCmd}\` runs`,
        );
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
        clearProviderLoggedIn(provider.id);
        return this.oauthAbort(
          "needs_login",
          `landed on a ${provider.label} sign-in form — the session is missing or expired. ` +
            `Re-run \`${loginCmd}\`, then retry. The bot will not type into ${provider.label}'s login form.`,
          steps,
        );
      }

      // Genuine consent screen / account chooser — scope-gate it (T7).
      const scopes = extractOAuthScopes(url);
      // Always surface the parsed scopes so the user / debug logs see
      // exactly what tripped the gate (or what was allowed through).
      steps.push(
        `OAuth: parsed consent scopes = [${scopes === null ? "<unreadable>" : scopes.join(", ")}]`,
      );
      if (scopes === null) {
        // Defense-in-depth: scrape the page DOM for known scope-grant
        // verb phrases ("See your", "Manage your contacts", "Send email
        // on your behalf", etc.). A real scope-grant consent always
        // lists each scope visually with one of these patterns. An
        // intermediate page (account chooser, post-grant confirmation,
        // safety review) does not.
        const dangerPhrases =
          provider.id === "google" ? scrapeGoogleScopePhrases(body) : [];
        if (dangerPhrases.length > 0) {
          return this.oauthAbort(
            "oauth_consent_needs_review",
            `${provider.label} consent page (URL unparseable) lists scope-grant phrases: ` +
              `[${dangerPhrases.join(" | ")}]. Pausing for manual review.`,
            steps,
          );
        }
        // F16 — order matters here. The post-grant intermediate page
        // (after blind-consent approved on iter 1) is also classified
        // as "consent" with unreadable scopes. If we check the blind-
        // consent branch FIRST, iter 2 fires advanceOAuthConsent
        // again, finds no Authorize button (already clicked), aborts —
        // a false negative even though the real authorization
        // succeeded. So: check consentAlreadyApproved FIRST and
        // soft-advance; only fall to blind-consent on iter 1 when
        // the flag isn't yet set.
        if (consentAlreadyApproved) {
          // We already approved a consent screen earlier in this flow
          // (either basic-scopes match or blind-consent). The second
          // consent-classed page is a post-grant confirmation /
          // safety review / account chooser routed through /consent.
          // Soft advance: try the approve control; if it isn't there
          // the loop will re-classify on the next iteration as the
          // page naturally redirects.
          steps.push(
            "OAuth: post-grant consent page (no parseable scopes, no scope phrases) — advancing",
          );
          const advanced = await this.browser.advanceOAuthConsent(provider.id);
          if (!advanced) {
            steps.push(
              "OAuth: no approve control on the post-grant page — waiting for natural navigation",
            );
          }
          await this.browser.wait(3);
          continue;
        }
        // GitHub App / opaque-OAuth blind-approve: defaults to true at
        // the tool schema (provision-any.ts), since the user signed up
        // to delegate this provisioning. The DOM scraper above is the
        // safety net — Drive/Gmail/contacts-class scope-grant verb
        // phrases still abort here. Set to false explicitly to force a
        // per-service confirmation prompt.
        if (task.allowBlindOAuthConsent === true) {
          steps.push(
            `OAuth: blind consent approved (allow_blind_oauth_consent=true; ` +
              `no scope-grant verb phrases detected in page DOM)`,
          );
          const advanced = await this.browser.advanceOAuthConsent(provider.id);
          if (!advanced) {
            return this.oauthAbort(
              "oauth_consent_needs_review",
              `blind-consent approved but no approve control found on the ` +
                `${provider.label} consent page — sign up manually.`,
              steps,
            );
          }
          consentAlreadyApproved = true;
          await this.browser.wait(3);
          continue;
        }
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `reached a ${provider.label} consent screen but could not read its requested scopes ` +
            `from the URL — pausing for manual review rather than approving blind.`,
          steps,
        );
      }
      const extraAllowed = new Set(task.allowExtraOAuthScopes ?? []);
      const nonBasic = scopes.filter((s) => !provider.scopesAreBasic([s]));
      const unauthorized = nonBasic.filter((s) => !extraAllowed.has(s));
      if (unauthorized.length > 0) {
        // Encode requested scopes into the error so the MCP tool layer
        // can extract them and show the user what to approve.
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `${provider.label} consent requests non-basic scopes: [${unauthorized.join(", ")}]. ` +
            `All requested scopes: [${scopes.join(", ")}]. ` +
            `To proceed, re-run provision_any_service with allow_extra_oauth_scopes set to ` +
            `the scopes the user has explicitly approved.`,
          steps,
        );
      }
      if (nonBasic.length > 0) {
        steps.push(
          `OAuth: user pre-approved extra scopes [${nonBasic.join(", ")}] — auto-approving`,
        );
      } else {
        steps.push(`OAuth: consent scopes all basic (${scopes.join(", ")}) — auto-approving`);
      }
      consentAlreadyApproved = true;
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

    // rc.20 — login-loop detection. Services like Groq complete the
    // Google OAuth handshake server-side but redirect back to a
    // login-looking page (/authenticate) where the user has to click
    // "Continue with Google" ONE MORE TIME to actually finalize the
    // session. The post-verify planner sees the same OAuth buttons it
    // saw on the original signup page, picks `click` on the provider
    // affordance, and the click triggers a popup-based re-OAuth that
    // the planner-driven post-verify loop doesn't follow — so each
    // iteration sees the same page text and the bot burns the round
    // budget.
    //
    // Detect: post-OAuth URL path matches a known login-shaped pattern
    // (/login, /signin, /authenticate, ...) AND the inventory still
    // carries an OAuth affordance for the SAME provider we just used.
    // Recovery: re-invoke runOAuthFlow ONCE with the new selector —
    // the second handshake completes the session and lands on the
    // dashboard. Bounded to one retry so a service that genuinely
    // never finalizes can't trap us in a loop.
    const postOAuthState = await this.browser.getState();
    const postOAuthInv = await this.buildInventory(steps, [provider.id]);
    const loopBtn = isLoginLoopState(postOAuthState.url, postOAuthInv, provider.id);
    if (loopBtn !== null) {
      steps.push(
        `Post-OAuth: landed on a login-like page (${pathOf(postOAuthState.url)}) ` +
          `with a ${provider.label} sign-in button still visible — service requires a ` +
          `second click to finalize the session. Re-triggering OAuth once.`,
      );
      try {
        await this.browser.startOAuth(loopBtn.selector);
        await this.browser.wait(3);
        await saveDebugSnapshot(this.browser, "oauth-loop-retry");
        await this.browser.settleAfterOAuth();
        await this.browser.wait(2);
        steps.push(
          `Post-OAuth: re-OAuth completed (url=${pathOf(this.browser.currentUrl())}).`,
        );
      } catch (err) {
        steps.push(
          `Post-OAuth: re-OAuth retry threw (${err instanceof Error ? err.message : String(err)}) — ` +
            `continuing to post-verify loop anyway.`,
        );
      }
      // After the retry, if we're STILL on a login-like page with the
      // same provider button visible, the service has trapped us. Abort
      // with a specific error rather than re-running the loop.
      const retryState = await this.browser.getState();
      const retryInv = await this.browser.extractInteractiveElements();
      if (isLoginLoopState(retryState.url, retryInv, provider.id) !== null) {
        return {
          success: false,
          error:
            `oauth_loop_detected: signed in via ${provider.label} twice but ${task.service} ` +
            `keeps redirecting to a login page (${pathOf(retryState.url)}). The service may ` +
            `require manual completion of an onboarding step before its OAuth session ` +
            `finalizes — finish the signup manually.`,
          steps,
          ...this.resultTail(),
        };
      }
    }

    // rc.24 — three additional post-OAuth gates surfaced from the
    // registry-snapshot review. Each is a state the bot definitively
    // cannot pass; emit a precise terminal error rather than burn the
    // post-verify budget.
    {
      const gateState = await this.browser.getState();
      const gateText = await this.browser.extractText().catch(() => "");
      const gateInv = postOAuthInv;
      // (a) Manual-login fallback (DigitalOcean, Hyperbolic). Service
      // dropped the OAuth session and rendered a /login form with
      // email + password inputs. Bot can't manually log in.
      if (detectManualLoginFallback(gateState.url, gateInv)) {
        return {
          success: false,
          error:
            `oauth_session_not_persisted: signed in via ${provider.label} but ${task.service} ` +
            `dropped the OAuth callback and rendered a manual /login form (${pathOf(gateState.url)}). ` +
            `Finish the signup manually — this typically indicates anti-bot rejection of the ` +
            `OAuth callback or a service-side session-storage issue.`,
          steps,
          ...this.resultTail(),
        };
      }
      // (b) Email-OTP wall (Porter, Koyeb / WorkOS-backed). Code went
      // to the operator's gmail. rc.27 — instead of immediately
      // aborting, try reading the OTP from the operator's inbox via
      // POST /v1/inbox/poll-operator-otp. If a code arrives, push a
      // step trail hint and continue to the post-verify loop —
      // the planner sees the hint and fills the input.
      if (detectEmailOtpGate(gateState.url, gateState.title, gateText)) {
        const domain = fromDomainFromUrl(gateState.url);
        const machineToken = task.machineToken;
        let otpResult: { code: string | null; reason: string };
        if (
          machineToken === undefined ||
          machineToken.length === 0
        ) {
          otpResult = { code: null, reason: "no_machine_token" };
        } else {
          steps.push(
            `Email-OTP gate detected (${pathOf(gateState.url)}) — polling operator gmail for the code` +
              (domain !== null ? ` (from_domain=${domain})` : ""),
          );
          otpResult = await readOperatorOtp({
            machineToken,
            ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
            ...(domain !== null ? { fromDomain: domain } : {}),
            maxWaitSeconds: 90,
          });
        }
        if (otpResult.code !== null) {
          // rc.27 — log the code's existence + length but never the
          // digits. The planner gets the digits via a system-prompt
          // hint passed through scopeHint-style on the next round.
          steps.push(
            `Email-OTP retrieved (${otpResult.code.length} digits, ending …${otpResult.code.slice(-2)}) — continuing into post-verify so the planner can fill the verification input.`,
          );
          this.pendingOtpCode = otpResult.code;
          // Fall through to extract + postVerifyLoop normally.
        } else {
          return {
            success: false,
            error:
              `email_otp_required: ${task.service} sent a verification code but the bot ` +
              `couldn't fetch it from the operator's gmail (reason=${otpResult.reason}). ` +
              `Finish the signup manually by entering the OTP from the email.`,
            steps,
            ...this.resultTail(),
          };
        }
      }
      // (c) SSO restriction (Fly.io). Org SSO blocks programmatic
      // token creation — the page explicitly says so.
      if (detectSsoRestriction(gateText)) {
        return {
          success: false,
          error:
            `sso_restricted: ${task.service} requires SSO/SAML for token creation. The bot ` +
            `cannot complete an SSO handshake. Finish via your organization's SSO portal.`,
          steps,
          ...this.resultTail(),
        };
      }
      // (d) Stuck on Google OAuth screens (Upstash class). Bot
      // signed in via Google but the OAuth flow didn't redirect off
      // accounts.google.com — usually a Clerk-mediated chooser the
      // post-verify planner can't navigate.
      if (detectStuckOnGoogleOAuth(gateState.url)) {
        return {
          success: false,
          error:
            `oauth_stuck_on_chooser: ${task.service}'s Google OAuth flow did not redirect off ` +
            `accounts.google.com (${pathOf(gateState.url)}) — likely a Clerk/Auth0 account-chooser ` +
            `screen the bot's post-OAuth loop can't navigate. Finish the signup manually.`,
          steps,
          ...this.resultTail(),
        };
      }
    }

    let credentials = await this.extractCredentials();
    if (credentials.api_key === undefined) {
      credentials = await this.postVerifyLoop({
        service: task.service,
        maxRounds: task.postVerifyMaxRounds ?? 12,
        steps,
        ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
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
    const finalText = await this.browser.extractText().catch(() => "");
    if (isAtPaywall(finalText)) {
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

  // Poll the provider page until the challenge clears (the user
  // completed it on their phone) or 2 minutes elapse. Returns true on
  // resolution, false on timeout. The 2-minute cap is enough time to
  // unlock a phone, open the Google app, and tap a number; longer
  // would mask a stuck/abandoned flow.
  private async waitForGoogleChallenge(
    provider: { id: OAuthProviderId; label: string; classifyAuthState: (url: string, body: string) => string },
    steps: string[],
  ): Promise<boolean> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await this.browser.wait(3);
      if (this.browser.oauthPageClosed()) return true;
      const url = this.browser.currentUrl();
      let body: string;
      try {
        body = (await this.browser.extractText()).slice(0, 4000);
      } catch {
        continue;
      }
      const state = provider.classifyAuthState(url, body);
      if (state !== "challenge") return true;
    }
    steps.push("Google: challenge wait timed out after 2 minutes");
    return false;
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
      { kind: "image", media_type: "image/jpeg", data_base64: input.screenshot },
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
    scopeHint?: string | undefined;
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
    // rc.27 — when the email_otp gate handler retrieved a code from
    // the operator's gmail, seed the FIRST round's hint with the
    // code + explicit fill+submit instructions. Cleared after one
    // round so it doesn't echo into unrelated downstream rounds.
    if (this.pendingOtpCode !== null) {
      hint =
        `Operator email-OTP retrieved from gmail: code is "${this.pendingOtpCode}". ` +
        `The current page is an email-verification gate. Find the SINGLE visible OTP/code input ` +
        `on this page (it usually has placeholder text like "Code", "Verification code", or a ` +
        `numeric placeholder; some sites render 6 individual digit inputs — in that case fill the ` +
        `FIRST one and the browser auto-distributes). Issue {"kind":"fill", "selector":"…", ` +
        `"value":"${this.pendingOtpCode}"} on it. NEXT round, click the Verify/Continue/Submit button.`;
      this.pendingOtpCode = null;
    }
    // Failed-extract counter. The stuck-loop detector below exempts
    // `extract` on the theory that "extract is its own progress signal"
    // — true when extract succeeds, FALSE when it returns no key. A
    // planner that keeps quoting the on-screen token in its reasoning
    // but extract keeps returning null means the regex library in
    // extractApiKeyFromText doesn't recognize the shape (Railway: bare
    // UUID token). Without this counter the loop burns all 12 rounds
    // re-extracting the same unrecognized value. Two consecutive
    // failures triggers a re-plan with a hint that steers the planner
    // toward Copy buttons or `done`.
    let consecutiveFailedExtracts = 0;
    // Stuck-loop detector: when the planner returns the SAME action
    // (kind+selector) two rounds in a row AND the inventory size hasn't
    // changed, the page is unaffected by the action and the planner
    // is in a tight loop (Railway: 3x click "Create Token" with no
    // form-name fill; 5x scroll the same modal whose Accept button
    // is gated on something else). Track the prior round's signature
    // and inject a forced "no-progress" hint on the second repeat.
    let prevSignature: string | null = null;
    let prevInventorySize = -1;
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
        // PERF: parallel getState + inventory (independent calls).
        [state, inventory] = await Promise.all([
          this.browser.getState(),
          this.buildInventory(args.steps, undefined, 80),
        ]);
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
          ...(args.scopeHint !== undefined ? { scopeHint: args.scopeHint } : {}),
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
      // rc.22 — redact tokens before pushing to the step trail.
      // The planner's reason field sometimes quotes the actual API
      // value it just observed ("The full API token 'sbp_xxx' is
      // visible…"); the harvester then posts step trails to a public
      // GitHub issue, leaking the credential. Redactor patterns mirror
      // tools/harvester/redact.mjs — defense in depth.
      args.steps.push(`Post-verify ${round + 1}/${args.maxRounds}: ${nextStep.kind} — ${redactCredentials(nextStep.reason)}`);

      // Dump this round's real page state + inventory in the E1
      // eval-corpus format so onboarding adapters can be iterated
      // offline without re-running the rate-limited OAuth handshake.
      // Default-on as of 0.6.14-rc.11 — writes to
      // ~/.trusty-squire/corpus/onboarding/ unless an env override
      // points elsewhere or disables it.
      captureOnboardingRound({
        service: args.service,
        round,
        oauth,
        state,
        inventory,
        observed: nextStep,
      });

      // Per-round telemetry upload (rc.11). Mirrors the disk capture
      // but ships to the registry so debugging works from any host —
      // the bot may be running in Goose or a sibling agent that
      // doesn't share a filesystem with whoever's diagnosing the run.
      // Fire-and-forget; failures must never abort the loop.
      if (this.roundUploader !== undefined) {
        const observedReason = "reason" in nextStep ? nextStep.reason : "";
        void (async () => {
          try {
            await this.roundUploader!({
              service: args.service,
              round,
              kind: nextStep.kind,
              url: state.url,
              title: state.title,
              inventory_count: inventory.length,
              observed_reason: observedReason,
              html: state.html,
              ...(state.screenshot !== undefined && state.screenshot.length > 0
                ? { screenshot_jpeg_base64: state.screenshot }
                : {}),
            });
          } catch {
            // best-effort — telemetry upload is diagnostic, never load-bearing
          }
        })();
      }

      // Stuck-loop detector. Re-planning steps (done/extract/login/
      // wait/navigate) are exempt: extract is its own progress signal,
      // navigate intentionally changes the URL not the current DOM,
      // wait is a deliberate pause, and login/done are terminal-ish.
      // The detector fires when a planner returns the same action with
      // the same selector AND the inventory size matches the prior
      // round's — strong evidence the previous step did nothing.
      const repeatableKinds = new Set(["click", "fill", "select", "check", "scroll"]);
      if (repeatableKinds.has(nextStep.kind)) {
        const sel = "selector" in nextStep ? (nextStep.selector ?? "<none>") : "<none>";
        const signature = `${nextStep.kind}|${sel}`;
        // The selector-level guard fires on exact selector repeats. The
        // kind-level guard fires when the planner just keeps clicking
        // SOMETHING — the Railway pattern was 6 click steps on 2-3
        // different selectors with no inventory change in between
        // (planner cycles through Create, Focus-input, Create again,
        // …). When that happens, force a non-click action.
        const sameSelector =
          signature === prevSignature && inventory.length === prevInventorySize;
        const stuckOnKind =
          nextStep.kind === "click" &&
          prevSignature !== null &&
          prevSignature.startsWith("click|") &&
          inventory.length === prevInventorySize;
        if (sameSelector || stuckOnKind) {
          const emptyInputs = inventory
            .filter(
              (e) =>
                (e.tag === "input" || e.tag === "textarea") &&
                e.value !== null &&
                e.value !== undefined &&
                e.value.length === 0 &&
                e.type !== "hidden" &&
                e.type !== "submit" &&
                e.type !== "button",
            )
            .slice(0, 5)
            .map((e) => {
              const hint =
                e.placeholder ?? e.labelText ?? e.ariaLabel ?? e.name ?? "(no label)";
              return `  - ${JSON.stringify(hint)} → selector=${e.selector}`;
            });
          const emptyInputHint =
            emptyInputs.length > 0
              ? `\n\nVisible empty inputs on this page (any of these is a likely required field):\n${emptyInputs.join("\n")}\n\nIssue {"kind":"fill"} on one of them with a sensible value.`
              : "";
          // Defaulted <select>s — value="" means the first <option>
          // (typically "Select…", "No workspace", "Choose…") is still
          // showing. React Hook Form treats those as untouched and
          // silently rejects submits. The Railway token-create form
          // was the canonical case: the Workspace dropdown's "No
          // workspace" placeholder was visually selected, but its
          // value="" left React state undefined, so Create did
          // nothing. Surface them explicitly so the planner emits a
          // select step before another click.
          const defaultedSelects = inventory
            .filter(
              (e) =>
                e.tag === "select" &&
                e.value !== null &&
                e.value !== undefined &&
                e.value.length === 0 &&
                e.selectOptions !== null &&
                e.selectOptions !== undefined &&
                e.selectOptions.length > 1 &&
                // rc.17 — skip selects we've already touched; their
                // form state is committed even though the visible
                // value="" still trips the DEFAULTED heuristic.
                e.interactedThisRun !== true,
            )
            .slice(0, 5)
            .map((e) => {
              const label =
                e.labelText ?? e.ariaLabel ?? e.name ?? e.placeholder ?? "(no label)";
              // Show the first non-empty-value option as the suggested
              // pick — the obvious target when the planner doesn't
              // have a domain reason to prefer a specific one.
              const realOptions = (e.selectOptions ?? []).filter(
                (o) => o.value.length > 0 && o.text.length > 0,
              );
              const firstReal = realOptions[0]?.text ?? "(none)";
              return `  - ${JSON.stringify(label)} → selector=${e.selector} (first real option: ${JSON.stringify(firstReal)})`;
            });
          const defaultedSelectHint =
            defaultedSelects.length > 0
              ? `\n\nVisible DEFAULTED dropdowns on this page (value="" — React form-state likely treats these as UNTOUCHED, which silently fails submit):\n${defaultedSelects.join("\n")}\n\nIssue {"kind":"select", "option_text":"…"} to commit a choice. Even if the default visible label ("No workspace", "None") is what you want, you MUST emit the select step to register it with the form's state.`
              : "";
          // rc.20 — also enumerate custom combobox triggers (Cohere's
          // role picker, Fireworks's survey, similar). These render as
          // <button role="combobox"> or as <button> with placeholder-
          // shaped text ("Select your role", "Choose a country") and
          // gate a submit-disabled state that the planner can't see.
          // Surface them so the planner emits `select` instead of
          // re-clicking the dead submit. Tightly scoped: must be a
          // button-shaped element with role=combobox OR placeholder-
          // shaped visible text, and NOT touched this run.
          const SELECT_PROMPT_TEXT =
            /^(?:select|choose|pick)\b|^select an?\b|\bselect\.{3}|\bchoose\.{3}/i;
          const customComboboxes = inventory
            .filter(
              (e) =>
                (e.role === "combobox" ||
                  (e.tag === "button" &&
                    SELECT_PROMPT_TEXT.test((e.visibleText ?? "").trim()))) &&
                e.interactedThisRun !== true,
            )
            .slice(0, 5)
            .map((e) => {
              const label =
                e.labelText ?? e.ariaLabel ?? e.name ?? e.visibleText ?? "(no label)";
              return `  - ${JSON.stringify(label)} → selector=${e.selector}`;
            });
          const customComboboxHint =
            customComboboxes.length > 0
              ? `\n\nVisible custom comboboxes / placeholder-state pickers that you haven't touched yet:\n${customComboboxes.join("\n")}\n\nIssue {"kind":"select", "option_text":"…"} with a sensible option_text — these are commonly the gate on a submit-disabled state.`
              : "";
          // rc.20 — and enumerate unchecked agreement checkboxes.
          // Mistral's TOS, GitHub-app sign-up, many onboarding forms
          // gate submit on a checkbox that isn't yet ticked.
          const uncheckedBoxes = inventory
            .filter(
              (e) =>
                e.tag === "input" &&
                e.type === "checkbox" &&
                // We can't read the actual `checked` from the inventory
                // shape, but interactedThisRun is set after a successful
                // `check` step. Show checkboxes the bot hasn't touched.
                e.interactedThisRun !== true,
            )
            .slice(0, 5)
            .map((e) => {
              const label =
                e.labelText ?? e.ariaLabel ?? e.name ?? e.placeholder ?? "(no label)";
              return `  - ${JSON.stringify(label)} → selector=${e.selector}`;
            });
          const uncheckedBoxHint =
            uncheckedBoxes.length > 0
              ? `\n\nVisible checkboxes you haven't ticked yet (often a TOS / agreement gate):\n${uncheckedBoxes.join("\n")}\n\nIssue {"kind":"check"} on any that look like agreements / required confirmations.`
              : "";
          args.steps.push(
            sameSelector
              ? `Post-verify: no-progress detected — same ${nextStep.kind} on same selector, inventory unchanged. Re-planning instead of re-running.`
              : `Post-verify: no-progress detected — successive click steps with no inventory change. Forcing a non-click action.`,
          );
          hint =
            `Your previous ${sameSelector ? `'${nextStep.kind}' on ${JSON.stringify(sel)}` : "click steps"} had NO observable effect — the inventory ` +
            `count is unchanged. The element you targeted is either disabled or gated on ` +
            `a precondition (an empty required input, an unticked agreement checkbox, an ` +
            `unselected dropdown option). Do NOT issue another '${nextStep.kind}' this round — pick a ` +
            `DIFFERENT KIND: {"kind":"fill"} on any empty text input, {"kind":"check"} on ` +
            `any unticked checkbox, {"kind":"select"} on any unselected dropdown, or ` +
            `{"kind":"done"} if there is genuinely nothing to do.` +
            emptyInputHint +
            defaultedSelectHint +
            customComboboxHint +
            uncheckedBoxHint;
          prevSignature = signature;
          prevInventorySize = inventory.length;
          continue;
        }
        prevSignature = signature;
        prevInventorySize = inventory.length;
      } else {
        // Reset the signature on non-repeatable kinds so a `navigate`
        // followed by a `click` doesn't pattern-match the click against
        // a click before the navigate.
        prevSignature = null;
        prevInventorySize = inventory.length;
      }

      if (nextStep.kind === "done") break;
      hint = undefined;
      try {
        if (nextStep.kind === "extract") {
          credentials = await this.extractCredentials();
          if (credentials.api_key === undefined) {
            // rc.28 — planner-quoted-token fallback. The regex
            // library missed (IPInfo's 14-char hex; some other
            // shape) but the planner's reason often literally
            // quotes the value. Accept it IF it's also present
            // verbatim in the visible page text — that's the
            // anti-hallucination guardrail.
            const pageText = await this.browser
              .extractText()
              .catch(() => "");
            const quoted = extractQuotedTokenFromReason(
              nextStep.reason,
              pageText,
            );
            if (quoted !== null) {
              credentials = { ...credentials, api_key: quoted };
              args.steps.push(
                `Post-verify ${round + 1}/${args.maxRounds}: extracted token via ` +
                  `planner-quoted fallback (${quoted.slice(0, 4)}…${quoted.slice(-4)})`,
              );
              consecutiveFailedExtracts = 0;
              continue;
            }
            consecutiveFailedExtracts += 1;
            // Best-effort diagnostic upload: when extract returns
            // null despite the planner asserting a credential is
            // visible, capture the DOM + screenshot so the UI shape
            // can be inspected later. Wrapped tight — any failure
            // here MUST NOT abort the post-verify loop.
            if (this.extractFailureUploader !== undefined) {
              void (async () => {
                try {
                  const snapshot = await this.browser.getState();
                  const candidates = await this.browser.extractCredentialCandidates();
                  await this.extractFailureUploader!({
                    service: this.currentService,
                    url: snapshot.url,
                    title: snapshot.title,
                    step_label: `post-verify round ${round + 1}/${args.maxRounds}: extract`,
                    extract_reason: nextStep.reason,
                    candidates,
                    html: snapshot.html,
                    screenshot_jpeg_base64: snapshot.screenshot,
                  });
                  args.steps.push(
                    `Diagnostic: uploaded extract-failure snapshot (post-verify round ${round + 1}).`,
                  );
                } catch {
                  // Silent — diagnostic uploads are best-effort.
                }
              })();
            }
            // Two consecutive failed extracts on a DOM the planner
            // keeps quoting a token from means the value's shape is
            // not in our regex library (Railway: bare UUID; some
            // smaller services use opaque alphanumeric tokens with no
            // recognisable prefix or nearby label). Steer HARD toward
            // a Copy-button click — the page renders a Copy affordance
            // far more often than it changes the token's text shape,
            // and the Copy path is regex-free. Falling back to `done`
            // is acceptable when the user can copy the token visually.
            if (consecutiveFailedExtracts >= 2) {
              args.steps.push(
                `Post-verify: ${consecutiveFailedExtracts} consecutive failed extracts ` +
                  `on a page the planner says shows a token — the value's shape is not ` +
                  `in this build's regex library. Re-planning off extract.`,
              );
              hint =
                "Your last TWO 'extract' attempts returned NO key, even though you " +
                "said the token is visible. The token's SHAPE is not one this " +
                "extractor recognises (e.g. a bare UUID with no 'API key:' label " +
                "nearby). Do NOT issue another 'extract'. Instead: " +
                "(1) {\"kind\":\"click\"} a 'Copy' / 'Copy token' / 'Copy to clipboard' " +
                "button near the token — the clipboard path bypasses the regex. " +
                "(2) If no Copy button exists, issue {\"kind\":\"done\"} — the user " +
                "will copy the token manually from the screenshot.";
              consecutiveFailedExtracts = 0;
            } else {
              // First failure: keep the existing masked/truncated hint
              // — most services that fail extract once do so because
              // the displayed value is dots/ellipsis, and the existing
              // hint correctly steers to "create a fresh key".
              hint =
                "Your last 'extract' found NO key — the key text on the page is " +
                "masked or truncated (e.g. shows '...' or dots). A masked existing " +
                "key cannot be extracted. Click 'Create API Key' / 'New API Key' to " +
                "generate a fresh one — its full value is shown once, on creation.";
            }
          } else {
            consecutiveFailedExtracts = 0;
          }
        } else if (nextStep.kind === "click") {
          await this.browser.click(nextStep.selector);
          // F7 / 0.6.15-rc.11 — Modal-based credential reveals
          // (OpenRouter, Anthropic, OpenAI Create-Key flows) render
          // the new key into a modal AFTER a server round-trip — the
          // prior blind 2s wait was racing the API response. The
          // implicit-extract that follows this branch then found
          // nothing, the round ended, and by the next round the modal
          // had auto-closed. Poll up to 8s for the key to appear in
          // the post-action DOM. Early-exit as soon as
          // extractCredentials returns one — typical happy path on
          // services without modal-delay returns in <1s. Saves both
          // time (no overshoot wait) and correctness (catches the
          // modal-render race).
          const credentialDeadline = Date.now() + 8000;
          let pollExtract: Record<string, string> = {};
          while (Date.now() < credentialDeadline) {
            await this.browser.wait(0.5);
            try {
              pollExtract = await this.extractCredentials();
              if (pollExtract.api_key !== undefined) break;
            } catch {
              // Page mid-render — keep polling; next tick may settle.
            }
          }
        } else if (nextStep.kind === "fill") {
          await this.browser.type(nextStep.selector, nextStep.value);
        } else if (nextStep.kind === "select") {
          await this.browser.selectOption(nextStep.selector, nextStep.option_text);
          await this.browser.wait(1);
        } else if (nextStep.kind === "check") {
          // browser.check force-ticks + scrolls into view + verifies —
          // a styled TOS checkbox a plain click can't flip.
          await this.browser.check(nextStep.selector);
          await this.browser.wait(1);
        } else if (nextStep.kind === "scroll") {
          // Drive a ToS modal to the bottom so its gated Accept button
          // enables. Railway-class flow: planner sees a disabled
          // "Accept" + a long modal body, asks us to scroll it.
          const result = await this.browser.scrollToEndOfTOS(nextStep.selector);
          if (result.reason === "no_container") {
            args.steps.push(
              `Post-verify: scroll requested but no scrollable container found — re-planning.`,
            );
            hint =
              "Your last 'scroll' found NO scrollable container on the page. " +
              "Do NOT return scroll again — try clicking a different element, " +
              "or return done if the gated button still won't enable.";
          } else if (result.reason === "already_at_bottom") {
            args.steps.push(
              `Post-verify: scroll requested but ${result.container} is already at the bottom — re-planning.`,
            );
            hint =
              "Your last 'scroll' was a no-op — the scrollable container is ALREADY at the " +
              "bottom. Whatever is keeping the Accept button disabled is NOT scroll position. " +
              "Re-read the page: look for an unticked agreement checkbox, an unfilled required " +
              "input (name/email), a sub-tab on the modal that hasn't been visited, or a 'I agree' " +
              "radio button. Do NOT return scroll again.";
          } else {
            args.steps.push(`Post-verify: scrolled ToS container (${result.container}) to bottom.`);
          }
          await this.browser.wait(1);
        } else if (nextStep.kind === "navigate") {
          await this.browser.goto(nextStep.url);
          // PERF: next round opens with waitForFormReady; no blind dwell.
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
      const hadCredentialsBefore =
        credentials.api_key !== undefined || credentials.username !== undefined;
      try {
        credentials = await this.extractCredentials();
      } catch {
        // page mid-navigation — next round's waitForFormReady handles it
      }
      // rc.16 — synthetic extract round capture. When the implicit
      // extractCredentials() above pulls a credential out of the page
      // *without* the planner ever having picked an `extract` step,
      // the for-loop's early-return at the next iteration's top fires
      // before any further capture is written. The chain that
      // auto-promote sees then has no `observed.kind === "extract"`
      // round, so promoteToSkill rejects with no_extract_step. Fix:
      // when an implicit extract just succeeded and the planner's
      // chosen step this round wasn't already `extract`, write a
      // synthetic extract round with fresh state+inventory captured
      // RIGHT NOW (the action just ran, the token row is now visible).
      // Best-effort — a capture failure must never block returning the
      // credential we already have.
      const haveNewCredentials =
        !hadCredentialsBefore &&
        (credentials.api_key !== undefined || credentials.username !== undefined);
      if (haveNewCredentials && nextStep.kind !== "extract") {
        try {
          const [postState, postInventory] = await Promise.all([
            this.browser.getState(),
            this.buildInventory(args.steps, undefined, 80),
          ]);
          const syntheticExtract: PostVerifyStep = {
            kind: "extract",
            reason: `implicit extract after ${nextStep.kind} — credentials surfaced on the page`,
          };
          captureOnboardingRound({
            service: args.service,
            round: round + 1,
            oauth,
            state: postState,
            inventory: postInventory,
            observed: syntheticExtract,
          });
          if (this.roundUploader !== undefined) {
            void (async () => {
              try {
                await this.roundUploader!({
                  service: args.service,
                  round: round + 1,
                  kind: syntheticExtract.kind,
                  url: postState.url,
                  title: postState.title,
                  inventory_count: postInventory.length,
                  observed_reason: syntheticExtract.reason,
                  html: postState.html,
                  ...(postState.screenshot !== undefined && postState.screenshot.length > 0
                    ? { screenshot_jpeg_base64: postState.screenshot }
                    : {}),
                });
              } catch {
                // best-effort
              }
            })();
          }
        } catch {
          // best-effort — synthetic capture is auto-promote plumbing,
          // never load-bearing for the parent signup
        }
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
    // Free-text permission scope hint from the host agent. When
    // present, the planner aligns option_text picks on permission
    // dropdowns with it. When absent, the planner is told to default
    // to MAX permissions (Admin > Write > Read) on token-creation
    // forms.
    scopeHint?: string;
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
  {"kind":"select","selector":"<a selector= from the inventory>","option_text":"<visible label of the option to pick — optional>","reason":"pick an option for a dropdown — region, role, country, or a permission/scope on a token form"}
  {"kind":"check","selector":"<a selector= from the inventory, type=checkbox>","reason":"tick a terms-of-service / agreement checkbox"}
  {"kind":"scroll","reason":"scroll a ToS / agreement modal to the bottom so its gated Accept button enables"}
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
- For ANY dropdown — native (tag=select) OR a custom combobox (role=combobox / aria-haspopup=listbox, common on modern React apps like Sentry / Stripe / Vercel) — use {"kind":"select"}. "click" on a combobox trigger opens it but does not pick an option; do not click it repeatedly.
- When you need a SPECIFIC option from the dropdown — e.g. "Project: Read" on Sentry's permissions picker, or a specific region — include "option_text" with the visible label. The executor matches it case-insensitively as a substring. Omit "option_text" when any option is fine (a placeholder country picker).
- A post-OAuth onboarding form (organization name, region, terms) is normal — fill/select/check its fields and click Continue to advance toward the dashboard; do not return "done" just because it is a form.
- If a "Create"/"Continue" button is disabled, look for a required terms-of-service / agreement checkbox and tick it with {"kind":"check"} — use the checkbox's own inventory selector (an entry with type=checkbox), NOT the adjacent "Terms of Service" link. A "click" on a styled checkbox often fails to flip it; use "check".
- If an Accept / Agree / Continue button is DISABLED and the page shows a ToS / agreement modal (a long scrollable block of legal text, often inside a dialog), AND there is no agreement checkbox in the inventory to tick, return {"kind":"scroll"}. Some services (Railway is the canonical case) only enable the Accept button after the user scrolls the modal body to the bottom. The bot auto-detects the scrollable container — you do NOT need a selector. Do NOT use "click" to try to scroll; "click" does not scroll, it lands a click and returns. After scrolling, the next round should re-read the page and click the now-enabled Accept button (which will appear in the inventory).
- Prefer the simplest credential path: a project- or organization-level API token / auth token usually needs only a name. A "personal token" with a grid of per-scope permission dropdowns is more work — choose it only if no simpler token type is offered.
- **Token names must be unique within the account.** Many services (Railway is the canonical case) silently reject submits whose name collides with an existing token — the click registers, the button takes focus, but no token is created and no error toast is shown. Before filling a token-name input, READ the visible existing-tokens list on the page (names like "mykey", "mytoken123", any others). For the name you fill, prefer a fresh unique name like \`ts-<random>\` or \`agent-<short-suffix>\`; NEVER reuse a name that appears in the existing list — including names with sequential suffixes like \`mykey2\`, \`mykey3\` if the un-suffixed name is also present (assume the user has been iterating). If you cannot see the existing-tokens list (it scrolled off, the page hides it), pick a name with high entropy (8+ random alphanumeric chars).
- On a token-creation form whose permission/scope dropdowns default to "No Access" / "None", you MUST set permissions BEFORE clicking the create button.
- **Defaulted dropdowns (value="") gate submit, even when the visible label looks fine.** An inventory line marked \`(DEFAULTED — pick an explicit option before submitting)\` means a \`<select>\` is showing its first option visually but its underlying value is empty. React-form-state libraries (React Hook Form, Formik) treat those as UNTOUCHED and reject submits silently — the click on the submit button visually focuses it but no submission occurs. Issue \`{"kind":"select", "option_text":"…"}\` to commit a choice BEFORE clicking submit, even if the existing visible label ("No workspace", "None", "Select…") is the option you want. The Railway token-create form was the canonical case: typing the name and clicking Create did nothing for six rounds because the Workspace dropdown was never explicitly selected.
- **PERMISSION SCOPE — default is MAXIMUM.** ${input.scopeHint !== undefined
  ? `The user provided a scope hint: "${input.scopeHint}". Pick option_text values aligned with this on each permission dropdown.`
  : `No scope hint was provided. Default to the HIGHEST available permission level on EVERY permission dropdown (Admin > Write > Read > anything lower). Most agent use-cases need write access; a read-only token will fail downstream when the agent tries to push data. Set "Admin" if offered; "Write" otherwise. Explicitly use option_text to specify — do NOT rely on first-option behavior, which often picks Read.`}
- On a form with MULTIPLE permission rows (Sentry: Project, Team, Member, Issue, Event, Release, Organization), set EACH ONE before clicking Create. One step per turn — return to this turn-by-turn until every row is set.
- Round ${input.round + 1} of ${input.maxRounds}. Prefer "done" if you're not making progress.`;

    const userBlocks: LLMBlock[] = [
      { kind: "image", media_type: "image/jpeg", data_base64: input.state.screenshot },
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
      parse: (raw) => {
        const step = parsePostVerifyStep(raw, allowed);
        // A `check` must land on a real checkbox/radio — the planner
        // otherwise picks the adjacent "Terms of Service" *link*, which
        // page.check() cannot tick. Reject it so the round re-plans.
        if (step.kind === "check") {
          const el = input.inventory.find((e) => e.selector === step.selector);
          const checkable =
            el !== undefined &&
            ((el.tag === "input" &&
              (el.type === "checkbox" || el.type === "radio")) ||
              el.role === "checkbox" ||
              el.role === "radio");
          if (!checkable) {
            throw new Error(
              `post-verify check step: ${JSON.stringify(step.selector)} is not a ` +
                `checkbox — pick the actual agreement checkbox, not its label or link`,
            );
          }
        }
        return step;
      },
    });
  }

  // Pick a signup link out of the current page's HTML. Used as the
  // fallback after a Google-search navigation.
  //
  // The naive version (regex /href="[^"]*signup[^"]*"/) failed badly
  // on Google search results: it matched URLs like
  // accounts.google.com/SignOutOptions?continue=...search?q=Sentry%20signup
  // — Google's own nav, whose ?continue= query param leaks the
  // original search query (with "signup" in it) and gets matched.
  // The bot then navigated to a Google sign-out page and gave up.
  //
  // This version:
  //   - parses each href as a real URL
  //   - rejects google.com / accounts.google.com / support.google.com
  //     and other Google nav infra (we're ON a google search page, so
  //     any google.com href is search-nav, not the service)
  //   - matches against host+path only — never query params
  //   - scores candidates: hosts that contain the service name win
  //     over generic matches. Means "sentry.io/signup" beats
  //     "github.com/sentry/sentry/blob/...signup..." (the github
  //     source-code result that mentions signup in a path).
  //   - returns the highest-scoring candidate, or null.
  private async findSignupLink(serviceName?: string): Promise<string | null> {
    const html = (await this.browser.getState()).html;
    const serviceSlug = serviceName?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    const candidates: Array<{ url: string; score: number }> = [];

    const hrefRe = /href="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null) {
      const raw = m[1];
      if (raw === undefined) continue;

      let url: URL;
      try {
        url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;

      // Reject Google's own navigation infrastructure — that's what
      // tripped the naive regex on the Sentry run.
      if (/(?:^|\.)google\.com$/.test(url.hostname)) continue;
      if (/(?:^|\.)googleusercontent\.com$/.test(url.hostname)) continue;
      if (/(?:^|\.)gstatic\.com$/.test(url.hostname)) continue;

      // Match against host+path ONLY. Query params can carry the
      // original search query text and would re-introduce the
      // junk-link bug.
      const hostPath = (url.hostname + url.pathname).toLowerCase();
      if (!/(?:^|\.|\/)(?:signup|register|sign-up|create-account|join)\b/.test(hostPath)) {
        continue;
      }
      // Negative: signin/login/logout in host+path.
      if (/(?:^|\/)(?:signin|login|logout|sign-in|log-in)\b/.test(hostPath)) continue;

      // BUG-1 GUARD: registered-domain match against the target service.
      // Without this, a Google search for "Railway signup" returned a
      // link to storysite-production.up.railway.app/signup/ — somebody's
      // hobby Django app hosted on Railway — and the bot filled out the
      // form, creating a junk account on the wrong website. PSL-aware
      // eTLD+1 comparison handles platform suffixes like .up.railway.app
      // and .vercel.app (where each customer subdomain is its own
      // "registered" entity) correctly.
      if (!hostMatchesServiceDomain(url.hostname, serviceSlug)) continue;

      // Score: a host containing the service slug is a strong match.
      // Without a slug to compare against, every match scores 1.
      const hostLower = url.hostname.toLowerCase();
      const score = serviceSlug.length > 0 && hostLower.includes(serviceSlug) ? 10 : 1;

      candidates.push({ url: url.toString(), score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url ?? null;
  }

  // Heuristic: does the currently-loaded page LOOK like a real signup
  // page? Used to decide whether the guessed canonical URL
  // (<service>.com/signup) worked or we need to fall back to a Google
  // search.
  //
  // Three signals, in order:
  //   1. URL-path shortcut: if the page's pathname matches
  //      /signup|register|sign-up|create-account|join/, trust it —
  //      we navigated to a signup-shaped URL and the redirect chain
  //      kept us on one. Catches Sentry-style cross-TLD redirects
  //      (sentry.com → sentry.io/signup) where the inventory looks
  //      different from a typical signup page but the URL is correct.
  //   2. 404 guard: drop pages whose title shouts 404 / not found.
  //   3. Content check: inventory has at least one text/email input
  //      OR a button whose text mentions Google/GitHub (broad on
  //      purpose — a "Continue with Google" / "Login with Google" /
  //      icon-only Google button all count when the bot has a
  //      provider session).
  private async looksLikeSignupPage(): Promise<boolean> {
    const state = await this.browser.getState();

    // 1. URL-path shortcut. If we navigated to a signup-shaped path
    //    and the browser kept us on one, that's a strong signal —
    //    redirect chains often preserve the path across TLD changes.
    try {
      const path = new URL(state.url).pathname.toLowerCase();
      if (/(?:^|\/)(?:signup|register|sign-up|create-account|join)\b/.test(path)) {
        return true;
      }
    } catch {
      // Malformed state.url — skip the shortcut, fall through.
    }

    // 2. 404 guard.
    const titleLower = (state.title ?? "").toLowerCase();
    if (
      titleLower.includes("404") ||
      titleLower.includes("not found") ||
      titleLower.includes("page not found")
    ) {
      return false;
    }

    // 3. Inventory check.
    let inventory: InteractiveElement[];
    try {
      inventory = await this.browser.extractInteractiveElements();
    } catch {
      return true;
    }
    const hasInput = inventory.some(
      (e) =>
        e.tag === "input" &&
        (e.type === "email" || e.type === "text" || e.type === null || e.type === undefined),
    );
    if (hasInput) return true;

    // Broad OAuth-button detection: any element whose visible text or
    // aria-label mentions "google" or "github" as a word. Covers
    // "Continue with Google", "Login with Google", "Use Google",
    // "Sign in with GitHub", and icon-only buttons with
    // aria-label="Google" — all common on OAuth-only signup pages.
    // False positives (e.g. a "Google Tag Manager" footer link)
    // are unlikely on a real signup view and harmless: the worst
    // case is we trust this page and the downstream planner gives
    // up cleanly later.
    return inventory.some((e) => {
      const text = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
      return /\b(?:google|github)\b/.test(text);
    });
  }

  private async extractCredentials(): Promise<Record<string, string>> {
    // IMPORTANT: pull credentials from the *visible* page, not the raw
    // HTML. Reading from HTML matches anti-bot challenge JS (Cloudflare
    // Turnstile, hCaptcha) whose challenge tokens look like API keys to
    // a naive regex.
    //
    // Three-pass extraction, in priority order:
    //   1. Visible candidates — input values + each element's direct
    //      text. A key read whole, un-glued from adjacent buttons.
    //   2. F10: when pass 1 hits a TRUNCATED display (modal shows
    //      "sk-or-v1-1687…" with the full secret only on the
    //      clipboard via the Copy button), click the Copy button and
    //      re-extract from `navigator.clipboard.readText()`. This is
    //      the OpenRouter / Anthropic / OpenAI / Stripe modal
    //      pattern — pass 1 would otherwise persist a truncated stub.
    //   3. F10 fallback: walk hidden inputs. Some modals stash the
    //      full secret in a `display:none` <input> the masked display
    //      reads from.
    const credentials: Record<string, string> = {};
    let apiKey: string | null = null;
    let truncatedHit: string | null = null;

    for (const candidate of await this.browser.extractCredentialCandidates()) {
      const hit = extractApiKeyFromText(candidate);
      if (hit === null) continue;
      if (isTruncatedCapture(candidate, hit)) {
        // Remember the truncated value but keep scanning — a later
        // candidate may produce a full one (e.g. a hidden input on
        // the same page).
        truncatedHit = truncatedHit ?? hit;
        continue;
      }
      apiKey = hit;
      break;
    }
    if (apiKey === null) {
      const bodyText = await this.browser.extractText();
      const hit = extractApiKeyFromText(bodyText);
      if (hit !== null) {
        if (isTruncatedCapture(bodyText, hit)) {
          truncatedHit = truncatedHit ?? hit;
        } else {
          apiKey = hit;
        }
      }
    }

    // Pass 2 — Copy-button + clipboard recovery.
    if (apiKey === null && truncatedHit !== null) {
      apiKey = await this.tryCopyButtonExtraction();
    }

    // Pass 3 — hidden-input scan. Cheap to always try as a last
    // resort, whether or not we saw a truncated hit; a service that
    // stashes the key in a hidden input may not display it at all.
    if (apiKey === null) {
      try {
        for (const value of await this.browser.extractAllInputValues()) {
          const hit = extractApiKeyFromText(value);
          if (hit !== null && !isTruncatedCapture(value, hit)) {
            apiKey = hit;
            break;
          }
        }
      } catch {
        // Hidden-input scan failures are non-fatal; we just stay
        // with whatever we had (or null).
      }
    }

    // Pass 4 — Copy-button colocation scan. Railway's "New Token"
    // modal shows the UUID inside a <code> built character-by-span,
    // which Pass 1's direct-text walk can't reassemble. Walk every
    // visible "Copy" affordance's ancestor subtree, tokenize its
    // innerText, and accept the first token that looks like a
    // credential. Strict on shape (length 16-256, isolated token)
    // to avoid false positives on copy-blog-post-link buttons.
    if (apiKey === null) {
      try {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const candidate of await this.browser.extractCredentialsNearCopyButtons()) {
          // The candidate is a bare whitespace-isolated token. If it's
          // a UUID, accept it directly — the Copy-button colocation
          // is the credential signal we'd otherwise demand a textual
          // "api key" label for.
          if (UUID_RE.test(candidate)) {
            apiKey = candidate;
            break;
          }
          // Otherwise route through the normal extractor — accepts
          // gh*_*, sk_*, pk_*, Stripe/AWS-style prefixes, JWTs, etc.
          const hit = extractApiKeyFromText(candidate);
          if (hit !== null && !isTruncatedCapture(candidate, hit)) {
            apiKey = hit;
            break;
          }
        }
      } catch {
        // Non-fatal — leave apiKey as null and fall through.
      }
    }

    // Last resort: if every path returned a truncated value, persist
    // it with a `_truncated` suffix so the host agent can surface the
    // partial result to the user (better than reporting "no key
    // found" when the bot demonstrably reached the modal).
    if (apiKey === null && truncatedHit !== null) {
      credentials.api_key_truncated = truncatedHit;
      return credentials;
    }

    if (apiKey !== null) credentials.api_key = apiKey;
    return credentials;
  }

  // F10: click the page's Copy button (whose label typically reads
  // "Copy", "Copy key", "Copy secret") and extract the secret from
  // `navigator.clipboard.readText()`. Returns null on any failure —
  // the caller has its own fallback paths.
  private async tryCopyButtonExtraction(): Promise<string | null> {
    let copyBtnSelector: string | null = null;
    try {
      const inventory = await this.browser.extractInteractiveElements();
      const copyBtn = inventory.find((e) => {
        const text = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.trim();
        // "Copy" alone, "Copy key", "Copy API key", "Copy secret",
        // "Copy token". Anchored so a "Don't copy this" tooltip
        // doesn't match. Case-insensitive.
        return /^\s*copy(?:\b|\s|$)|copy\s+(?:api\s*key|secret|token|key)\b/i.test(text);
      });
      if (copyBtn === undefined) return null;
      copyBtnSelector = copyBtn.selector;
    } catch {
      return null;
    }

    try {
      await this.browser.click(copyBtnSelector);
      // Brief wait — the Copy button's onclick is usually a sync
      // navigator.clipboard.writeText, but some modals run an async
      // serialize step (e.g. format-the-key into "Bearer <key>"
      // first). 1s covers both with no real cost.
      await this.browser.wait(1);
    } catch {
      return null;
    }

    let clipboardText: string;
    try {
      clipboardText = await this.browser.readClipboard();
    } catch {
      return null;
    }
    if (clipboardText.trim().length === 0) return null;

    const fromClipboard = extractApiKeyFromText(clipboardText);
    if (fromClipboard === null) return null;
    // Sanity: don't accept a clipboard hit that is ITSELF truncated
    // (some Copy buttons copy the masked display rather than the
    // real value — defensive against that surprising case).
    if (isTruncatedCapture(clipboardText, fromClipboard)) return null;
    return fromClipboard;
  }
}
