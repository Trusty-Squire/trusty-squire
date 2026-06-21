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
  isGitHubForced2faVerification,
  GITHUB_DISMISSIBLE_2FA_SKIP_TEXT,
  type OAuthProviderId,
} from "./oauth-providers.js";
import { extractGoogleNumberMatch, scrapeGoogleScopePhrases } from "./google-login.js";
import { decideOAuthStep } from "./oauth-flow.js";
import {
  decideFormFillStep,
  FORM_FILL_BUDGETS as B_FF,
  findSignupLinkOnLoginPage,
  initialFormFillState,
  pickEmailCodeSubmitSelector,
  type FormFillObservation,
  type FormFillOutcome,
  type FormFillState,
} from "./form-fill.js";
import {
  accumulateCandidate,
  hasFullHit,
  initialExtractionState,
  resolveExtraction,
  type CandidateClass,
} from "./extraction.js";
import { notifyHeightenedAuth } from "./notify-api.js";
import { sendTelegramHeightenedAuth } from "./telegram-notify.js";
import { TwoCaptchaSolver } from "./captcha-solver-2captcha.js";
import { redactCredentials } from "./redact.js";
import { readOperatorOtp, fromDomainFromUrl } from "./read-otp.js";
import {
  loggedInProviders,
  clearProviderLoggedIn,
  markProviderLoggedIn,
} from "./login-state.js";
import { SignupOAuthFlow } from "./signup-oauth-flow.js";
import { saveDebugSnapshot } from "./debug.js";
import { captureObservationFrame, type ObservationFrame } from "./observation-frame.js";
import { classifyObservationFrame } from "./state-classifier.js";
import {
  isAtAccountReviewGate,
  isAtPaywall,
  isOnboardingReviewGate,
  isSignupsClosed,
} from "./terminal-gate.js";
export {
  isAtAccountReviewGate,
  isAtPaywall,
  isOnboardingReviewGate,
  isSignupsClosed,
} from "./terminal-gate.js";
import {
  PostSignupCredentialTracker,
  classifyNoCredentialPostSignup,
} from "./post-signup-flow.js";
import {
  PostSignupActionExecutor,
  type PostSignupExecutableAction,
} from "./post-signup-action-executor.js";
import { PostSignupLoginFlow } from "./post-signup-login-flow.js";
import {
  MAX_POST_VERIFY_NAVIGATES,
  MAX_PREMATURE_DONE_FALLBACKS,
  MAX_UPSTREAM_BLIP_RETRIES,
  PostSignupRecoveryFlow,
  PostSignupRecoveryState,
} from "./post-signup-recovery-state.js";
import { PostSignupSyntheticCapture } from "./post-signup-synthetic-capture.js";
import {
  CredentialExtractionFlow,
  DOM_LABEL_TO_KEY,
  NON_CREDENTIAL_KEYS,
  extractAllLabeledTokensFromReason,
  hasAnyExtractedCredential,
  hasUsableCredentialBundle,
} from "./credential-extraction-flow.js";
export {
  extractAllLabeledTokensFromReason,
  hasAnyExtractedCredential,
  isMultiCredBundle,
} from "./credential-extraction-flow.js";
import { captureOnboardingRound } from "./onboarding-capture.js";
import {
  KEYS_DESTINATION_URL,
  runNavSearch,
  type NavSearchBrowserPort,
  type NavSearchDeps,
} from "./nav-search.js";
import type { FailureStage } from "./failure-stage.js";
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
    parsed_codes: ReadonlyArray<string>;
    // The rendered HTML body, when the inbox provides it — used to pick a
    // verification link by ANCHOR TEXT when the URL is a click-tracker that
    // hides the "verify"/"activate" keyword (SendGrid/Mailgun/…). Optional so
    // test/stub inboxes need not supply it.
    body_html?: string | null;
  }>;
}

// Hard cap on LLM calls per signup. Keep it aligned with the real
// post-verify round budget (24) plus a small form-fill/retry allowance.
// Long but legitimate onboarding wizards (Anyscale-style multi-step org
// setup) can consume >15 deterministic planner calls before the credential
// surface exists; the loop itself remains bounded by postVerifyMaxRounds and
// the wall clock timeout. Override via env when debugging.
const MAX_LLM_CALLS_PER_SIGNUP = Number.parseInt(
  process.env.UNIVERSAL_BOT_MAX_LLM_CALLS ?? "30",
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

// A single-use verification link that lands on an "expired / already used /
// invalid" page. MEASURED on portkey (2026-06-17): a FRESH, seconds-old
// Firebase mode=verifyEmail oobCode rendered "Email Verification Failed — This
// link has expired" on the bot's FIRST navigation. A single-use action link is
// routinely burned by an upstream mail link-scanner (anti-phishing prefetch) —
// and following a Firebase verifyEmail link COMPLETES the verification
// server-side. So "expired" almost always means the email is ALREADY verified;
// the right move is to log in with the signup credentials and proceed, not bail.
// Exported for unit tests.
const VERIFY_LINK_FAILED_PATTERNS: readonly string[] = [
  "link has expired",
  "link is invalid",
  "link is no longer valid",
  "invalid or expired",
  "expired or invalid",
  "verification failed",
  "already been used",
  "already verified", // some apps say so outright → also "go log in"
];

export function verificationLinkFailed(pageText: string): boolean {
  const t = pageText.toLowerCase();
  return VERIFY_LINK_FAILED_PATTERNS.some((p) => t.includes(p));
}

// Firebase email-action links carry mode=verifyEmail + oobCode + apiKey as
// query params — even on a custom domain (portkey: app.portkey.ai/auth?…).
// Extract them so we can confirm the verification via Firebase's REST API
// directly: far lower latency than a browser SPA navigation (racing a short
// oobCode TTL) and it issues the single-use code exactly ONCE (no SPA
// double-submit). Returns null when the link isn't a Firebase verifyEmail
// action. Exported for unit tests.
export function parseFirebaseEmailAction(
  url: string,
): { apiKey: string; oobCode: string } | null {
  let u: URL;
  try {
    u = new URL(url.replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
  const oobCode = u.searchParams.get("oobCode");
  const apiKey = u.searchParams.get("apiKey");
  if (u.searchParams.get("mode") !== "verifyEmail" || oobCode === null || apiKey === null) {
    return null;
  }
  if (!/^AIza[\w-]{20,}$/.test(apiKey)) return null; // Firebase web API key shape
  return { apiKey, oobCode };
}

// Apply a Firebase email-verification oobCode via the Identity Toolkit REST API
// — the same call the emailed link's SPA makes, issued directly so it runs the
// instant the mail lands and only once. The apiKey is the Firebase WEB api key
// (public by design). ok=true + the verified email on success; ok=false + the
// Firebase error (EXPIRED_OOB_CODE / INVALID_OOB_CODE) otherwise — which itself
// proves whether the code was alive at receipt. Exported for unit tests.
export async function applyFirebaseEmailVerification(
  apiKey: string,
  oobCode: string,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oobCode }),
      },
    );
    const data = (await resp.json().catch(() => ({}))) as {
      email?: string;
      emailVerified?: boolean;
      error?: { message?: string };
    };
    if (resp.ok && (data.emailVerified === true || data.email !== undefined)) {
      return { ok: true, ...(data.email !== undefined ? { email: data.email } : {}) };
    }
    return { ok: false, error: data.error?.message ?? `http_${resp.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Short probe when, even after a settle, the post-submit page still never
// prompted the user to check their email AND no account-created signal
// appeared. Legitimate verification mail almost always lands inside a
// minute; this catches the fast case without 300s of dead air.
const VERIFICATION_PROBE_SECONDS = 45;

// Give-up ceiling for the "page says check your email" case (mail IS coming).
// These poll timeouts are pure GIVE-UP BOUNDS: the inbox server long-polls and
// early-exits the instant mail arrives, so a real email returns at ~its arrival
// time regardless of the ceiling — the ceiling only costs wall-clock when mail
// NEVER comes (young-domain withhold). Sized to the ARRIVAL TAIL, not the
// average: transactional mail lands <30s typically, with a greylist retry tail
// to ~60s, so 90s covers every real case with margin while failing a withheld
// mail 90s sooner (was 180). Tail-sized, NOT average-sized — abandoning real
// mail loses a signup (OF#2). Env-tunable for an A/B.
const VERIFY_EMAIL_CEILING_SECONDS = Number.parseInt(
  process.env.BOT_VERIFY_EMAIL_CEILING_S ?? "120",
  10,
);

// Settle window before the SECOND post-submit page read. SPA signups
// (Postmark, ElevenLabs, Browserbase, Grafana Cloud, …) swap in their
// "check your email" confirmation screen a beat AFTER submit. Reading the
// DOM the instant extraction fails races that render and mislabels the
// run as "no email expected", collapsing the poll to the 45s probe and
// abandoning mail that was, in fact, on its way.
const SUBMIT_SETTLE_SECONDS = 3;

// Poll floor once the form CLEANLY SUBMITTED but the page text stayed
// inconclusive about an email prompt (no "check your email", but also no
// hard error/rejection). A clean submit means an account was created, so
// real verification mail is plausibly inbound; transactional senders on a
// fresh send (Postmark, SendGrid) routinely take longer than the 45s
// probe. Polling 120s here — rather than bailing at 45s — is the
// difference between catching that mail and a false `verification_not_sent`.
// Still bounded so a genuinely-silent service doesn't hold the run for the full
// ceiling. Tail-sized to ~90s (arrival tail incl. a greylist retry); since the
// long-poll early-exits on arrival, this only costs wall-clock when mail never
// comes — failing an inconclusive no-mail run 30s sooner (was 120). Env-tunable.
const SUBMITTED_PROBE_FLOOR_SECONDS = Number.parseInt(
  process.env.BOT_VERIFY_INCONCLUSIVE_CEILING_S ?? "90",
  10,
);

// Post-submit page text that means the submit was REJECTED, not accepted —
// no account was created, so no verification mail is coming and even the
// 45s probe is wasted. Lets the bot bail immediately instead of polling.
// Kept conservative: only unambiguous rejection phrasings.
const SUBMIT_REJECTED_PATTERNS: readonly RegExp[] = [
  /\balready\s+(?:registered|exists|in\s+use|taken|have\s+an\s+account)\b/i,
  /\b(?:email|account|username)\s+(?:is\s+)?already\s+(?:registered|taken|in\s+use)\b/i,
  /\bthat\s+email\s+is\s+already\b/i,
  /\ban?\s+account\s+(?:with\s+(?:this|that)\s+email\s+)?already\s+exists\b/i,
  /\bplease\s+(?:try\s+again|correct\s+the\s+errors?)\b/i,
  /\bthis\s+field\s+is\s+required\b/i,
  /\b(?:email|password)\s+cannot\s+be\s+empty\b/i,
  /\binvalid\s+(?:email|password)\b/i,
];

// Exported for unit testing. True when the post-submit page reads like a
// rejected submit (account not created), so the bot should not poll for a
// verification email that will never arrive.
export function submitWasRejected(pageText: string): boolean {
  return SUBMIT_REJECTED_PATTERNS.some((p) => p.test(pageText));
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

// A5 — thrown from postVerifyLoop when an OAuth run keeps landing on a
// login page (the planner asks to log in ≥2 times): the OAuth callback
// never established a session, so the post-verify thrash would only end
// in a mislabeled oauth_onboarding_failed. The OAuth call site catches
// this and returns the correct oauth_session_not_persisted classification.
export class OAuthSessionNotPersistedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthSessionNotPersistedError";
  }
}

// 0.8.2-rc.10 — common dashboard paths that vendors host their
// per-account API key UI at. Ordered most-specific first so a
// fallback navigate doesn't land short of the actual page. Returned
// as an array of path-strings; the caller composes them onto the APP
// origin (the signup/app URL the bot navigated to), NOT the auth/IdP
// origin it may be stuck on post-OAuth, and skips any already tried.
//
// Patterns harvested from Anthropic (settings/keys), Sentry
// (settings/account/api/auth-tokens), Neon (settings#api-keys),
// Render (account/api-keys), Postmark (account/api_tokens),
// OpenRouter (keys), and a long tail of vendors converging on the
// same conventions.
const STUCK_LOOP_FALLBACK_PATHS: readonly string[] = [
  "/settings/keys",
  "/settings/api-keys",
  "/settings/api_keys",
  "/settings/tokens",
  "/settings/api-tokens",
  "/settings/account/api/auth-tokens/",
  // 0.8.3-rc.2 — added after the post-OAuth onboarding drain
  // (amplitude/groq/launchdarkly/modal/weaviate/…). These conventions
  // were absent from the generic list and each cost a service its
  // whole post-verify budget: LaunchDarkly hosts keys at
  // /settings/authorization, a cohort of consoles use a bare
  // /settings/access-tokens or /settings/api, and several put the
  // developer surface at /settings/developers. They sit AFTER the
  // historic, more-common paths so we don't regress an existing hit.
  "/settings/authorization",
  "/settings/access-tokens",
  "/settings/developers",
  "/settings/developer",
  "/settings/api",
  "/account/api-keys",
  "/account/api_tokens",
  "/account/api-tokens",
  "/account/keys",
  "/account/tokens",
  "/account/access-tokens",
  "/api-keys",
  "/api_keys",
  "/api-tokens",
  "/keys",
  "/tokens",
  "/access-tokens",
  "/auth-tokens",
  "/developers",
  "/dashboard/api-keys",
  "/dashboard/keys",
];

// 0.8.3-rc.2 — curated per-service API-key paths, consulted BEFORE the
// generic STUCK_LOOP_FALLBACK_PATHS list when the stuck origin belongs
// to one of these vendors. The generic conventions can't reach these:
// the path is either non-obvious (LaunchDarkly's /settings/authorization),
// or the vendor splits the convention differently than the majority
// (groq keys live at a bare /keys but the planner kept guessing
// /settings/api-keys, which 404s). Keyed by service SLUG (lowercased,
// alphanumerics only) so it survives the inbox-alias slug the bot is
// invoked with, and additionally matched against the stuck URL's host so
// a curated path is only ever composed onto the vendor it was harvested
// from. Each entry is ordered most-specific-first.
//
// This is deliberately a SMALL map of paths the generic heuristic
// provably can't derive — not a 12-service URL table. Most services in
// the onboarding-drain cohort are fixed by the widened generic list
// above; only the ones whose real path is genuinely un-guessable land
// here.
const SERVICE_KEYS_PATHS: Readonly<Record<string, readonly string[]>> = {
  // console.groq.com/keys — the planner kept trying /settings/api-keys
  // (404). The bare /keys IS in the generic list but lands deep in the
  // order; pin it first for groq so the first escalation hits.
  groq: ["/keys", "/settings/keys"],
  // app.launchdarkly.com/settings/authorization — LD's access-token UI.
  // /settings/api-keys and /settings/generated-credentials both 404.
  launchdarkly: ["/settings/authorization"],
  // Weaviate keys are issued per-cluster, but the org-level admin page
  // is the closest reachable surface; account-scoped guesses all 404.
  weaviate: ["/account", "/settings/api-keys"],
  // northflank hosts user API keys under the account menu, not a
  // top-level /settings/keys.
  northflank: ["/account/api", "/settings/api"],
  // Sentry's personal auth-token UI lives here. The generic fallback
  // order hits three unrelated 404s before this path and the recovery
  // walker aborts after 3 consecutive 404s, so pin the documented path.
  sentry: ["/settings/account/api/auth-tokens/"],
  // Axiom documents API-token creation under Settings > API tokens in
  // app.axiom.co. Generic /settings/keys guesses hit the wrong surface.
  axiom: ["/settings/api-tokens", "/settings/tokens", "/settings/api"],
  // Anyscale documents API keys under the console account menu ("user icon"
  // → "API keys"). The generic walker tries three /settings/* guesses first
  // and aborts after consecutive 404s, so pin the account-level route first.
  anyscale: ["/api-keys", "/account/api-keys"],
  // Cloudinary's credential docs point users to the Dashboard for visible
  // cloud/API credentials, with key management under Console Settings >
  // API Keys. Generic settings guesses can leave an unfinished welcome wizard
  // in place, so try the dashboard/developer surface first.
  cloudinary: [
    "https://console.cloudinary.com/pm/developer-dashboard",
    "https://console.cloudinary.com/settings/api-keys",
    "https://console.cloudinary.com/app/settings/api-keys",
    "/pm/developer-dashboard",
    "/settings/api-keys",
    "/app/settings/api-keys",
  ],
  // Luma's docs link the API key page on the marketing/apex host, while OAuth
  // can settle inside app.lumalabs.ai or an app NotFound shell. This cannot be
  // discovered by same-origin guesses.
  lumaai: ["https://lumalabs.ai/dream-machine/api/keys", "https://lumalabs.ai/api/keys"],
  // Mistral's current API-key surface is on admin.mistral.ai; generic guesses
  // from console.mistral.ai can miss the organization-scoped key page.
  mistral: [
    "https://admin.mistral.ai/organization/api-keys",
    "https://console.mistral.ai/api-keys",
    "https://console.mistral.ai/home?workspace_dialog=apiKeys",
  ],
  // Baseten documents API keys under app settings. If signup lands in a model
  // catalog/onboarding surface, go straight to the settings route.
  baseten: ["https://app.baseten.co/settings/api-keys"],
  // Val Town's docs link API tokens here; /new opens the token-creation flow
  // directly, avoiding disabled list-page actions.
  valtown: ["https://www.val.town/settings/api/new", "https://www.val.town/settings/api"],
  // Langfuse project ids are dynamic, but the cloud root/settings route is the
  // stable entry to project settings/API keys after signup.
  langfuse: ["https://cloud.langfuse.com/settings/api-keys", "https://us.cloud.langfuse.com/settings/api-keys"],
  // WorkOS documents the dashboard API key page directly; post-OAuth can land
  // on product/onboarding surfaces that do not expose the sidebar path.
  workos: ["https://dashboard.workos.com/api-keys"],
  // Paddle's dashboard exposes API keys under Developer Tools >
  // Authentication. The sidebar route is /authentication-v2; generic
  // /settings/* and /api-keys guesses miss it and the planner can get stuck
  // in Business Account > Team Members.
  paddle: ["/authentication-v2"],
};

// Normalize a service name to the slug used as a SERVICE_KEYS_PATHS key:
// lowercased, alphanumerics only. Mirrors guessSignupUrl's slug rule so
// the inbox-alias-derived service string (e.g. "Groq Cloud") resolves to
// the same key the map is authored under. Exported for unit testing.
export function serviceSlug(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// 0.8.2-rc.10 — heuristic for "this account already exists on the
// service and its API keys are masked, with no path to reveal them."
// The test identity (methoxine@gmail.com) accumulates state across
// batches; subsequent runs land on a dashboard whose API-keys page
// shows only the NAMES of existing keys (the values were revealed
// once at create-time and aren't recoverable). Without this
// classifier those runs fall through to a generic
// oauth_onboarding_failed and the housekeeper treats them like a
// repairable bug.
//
// Conservative rules: must be on a URL that names an API-key page
// (keys / api-keys / api-tokens / auth-tokens / api_keys), AND the
// page text shows BOTH a masking glyph pattern (•••, ***, ─•) AND
// an existing-key word, OR the planner's last reason explicitly
// describes the same shape.
const EXISTING_KEY_URL_HINT =
  /(?:api[-_/]keys?|api[-_/]tokens?|auth[-_/]tokens?|personal[-_/]access[-_/]tokens?|\/keys(?:\b|\/|$)|\/tokens(?:\b|\/|$)|\/settings\/keys\b|\/settings\/tokens\b|#api[-_/]keys\b|#api[-_/]tokens\b)/i;
const MASKED_KEY_GLYPHS =
  /(?:•{3,}|\*{3,}|─•|·{3,}|•{3,}|x{6,}|[A-Za-z0-9]{2,4}[•*]{5,})/;
// 0.8.2-rc.12 — widened to catch Neon's existing-key list shape
// (the per-row layout has a "Key name" header + "Created <date>" +
// "Last used <date|never>" — no glyph, no "existing" word, just the
// columns of an API-key listing table). The conservative AND with
// EXISTING_KEY_URL_HINT keeps this from misfiring on marketing copy
// elsewhere on a non-keys URL.
const EXISTING_KEY_WORDS =
  /\b(?:existing\s+(?:api\s+)?(?:key|token)|previously\s+created|created\s+by\b|api\s+keys?\s*\(\d+\)|tokens?\s*\(\d+\)|reveal|copy\s+key|key\s+name\b|last\s+used\b|created(?:\s+\w+){0,3}\s+(?:\d{1,2},?\s+)?\d{4}\b)/i;
const NO_CREATE_AFFORDANCE_HINT =
  /\b(?:cannot\s+(?:reveal|extract|read)|values?\s+(?:is\s+)?masked|only\s+shown\s+once|cannot\s+(?:see|view|copy)\s+(?:the\s+)?(?:key|secret|value)|key\s+(?:value|secret)\s+(?:is\s+)?(?:not\s+)?(?:available|recoverable|extractable|shown))\b/i;

export function detectExistingAccountNoExtract(input: {
  url: string;
  pageText: string;
  lastPlannerReason: string;
}): boolean {
  if (!EXISTING_KEY_URL_HINT.test(input.url)) return false;
  // Planner reason naming the no-reveal shape is the strongest single
  // signal — the planner has SEEN the page and is describing it.
  if (NO_CREATE_AFFORDANCE_HINT.test(input.lastPlannerReason)) {
    return true;
  }
  // 0.8.2-rc.12 — three independent positive paths, ANY of which is
  // enough since we already gated on the URL matching an API-keys
  // page (which alone weeds out the marketing-tile false-positives
  // the conservative pre-rc.12 path was protecting against):
  //   1. Mask glyphs in the page (•••, asterisks, ··· — the literal
  //      "value is hidden" decoration most vendors use).
  //   2. Two or more existing-key word patterns matched (a key
  //      LISTING shape: "Key name" + "Last used" + "Created <date>"
  //      is unmistakable when found on a /keys-style URL).
  //   3. Mask glyph PLUS any existing-key word (the original
  //      detector — keeps the conservative behavior for vendors
  //      whose listing UI uses different column labels).
  const hasMaskGlyph = MASKED_KEY_GLYPHS.test(input.pageText);
  // Tally up to 5 distinct existing-key signals; 2+ is enough.
  const existingKeyMatches: string[] = [];
  const allWords = input.pageText.match(new RegExp(EXISTING_KEY_WORDS, "gi"));
  if (allWords !== null) {
    const distinct = new Set<string>();
    for (const m of allWords) {
      distinct.add(m.toLowerCase().replace(/\s+/g, " "));
      if (distinct.size >= 5) break;
    }
    existingKeyMatches.push(...distinct);
  }
  if (hasMaskGlyph && existingKeyMatches.length >= 1) return true;
  if (existingKeyMatches.length >= 2) return true;
  if (hasMaskGlyph && /\bAPI\s+keys?\b/i.test(input.pageText)) return true;
  return false;
}

// A "mint a fresh key" affordance — a button/link that creates a new
// API key/token. The label vocabulary is deliberately broad ("create",
// "generate", "new", "add" paired with a key/token noun) but must be
// paired with a credential noun so a bare "New project" / "Add member"
// button on a dashboard isn't mistaken for a key-minting control.
//
// Word-boundary-anchored to avoid matching "recreate" / "regenerate
// password" style false friends — though "regenerate" + a key noun IS
// a valid mint affordance (rotating a key produces a fresh value), so
// it's included explicitly.
const CREATE_KEY_VERB = /\b(?:create|generate|regenerate|new|add|issue|mint)\b/i;
const CREATE_KEY_NOUN =
  /\b(?:api[\s_-]*keys?|secret[\s_-]*keys?|access[\s_-]*tokens?|personal[\s_-]*access[\s_-]*tokens?|api[\s_-]*tokens?|auth[\s_-]*tokens?|tokens?|keys?|credentials?)\b/i;
// A standalone phrase that is unambiguously a key-minting control even
// without the verb+noun co-occurrence test (some buttons read just
// "New API key" with the verb folded into "new"). Kept separate so the
// generic verb/noun pairing can stay strict.
const CREATE_KEY_PHRASE =
  /\b(?:create|generate|new|add|issue|mint)\s+(?:a\s+)?(?:new\s+)?(?:api|secret|access|auth|personal\s+access)?\s*(?:keys?|tokens?|credentials?)\b/i;

// Scan an inventory for the single best "create new key / generate API
// key / new token" affordance. Returns the matching element or null.
// Exported for unit tests. Pure — operates on the inventory shape only,
// no browser access, so it can be unit-tested with synthetic elements.
export function findCreateKeyAffordance(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  const candidates: { el: InteractiveElement; score: number }[] = [];
  for (const el of inventory) {
    // Only buttons / links / role=button are mint controls; an <input>
    // (a text field named "key") is never the create action.
    const isClickable =
      el.tag === "button" ||
      el.tag === "a" ||
      el.role === "button" ||
      el.role === "link";
    if (!isClickable) continue;
    // A non-visible element can't be clicked reliably; skip when the
    // live extractor told us it's hidden (test fixtures that omit
    // `visible` are treated as visible).
    if (el.visible === false) continue;
    const haystack = [
      el.visibleText,
      el.ariaLabel,
      el.title,
      el.labelText,
      el.iconLabel,
    ]
      .filter((s): s is string => s !== null && s !== undefined)
      .join(" ")
      .trim();
    if (haystack.length === 0) continue;
    const phraseHit = CREATE_KEY_PHRASE.test(haystack);
    // Guard against large card/buttons whose aggregate subtree text happens to
    // contain a create verb and a credential noun far apart. Ona's "What's new"
    // card rendered "What's new ... provider keys" in one button; the old
    // verb+noun co-occurrence treated that as "New token" and navigated away
    // from the real PAT panel. Explicit phrases still win regardless of length.
    if (!phraseHit && haystack.length > 96) continue;
    const verbNounHit =
      CREATE_KEY_VERB.test(haystack) && CREATE_KEY_NOUN.test(haystack);
    if (!phraseHit && !verbNounHit) continue;
    // Score: a full phrase match is the strongest signal; an explicit
    // "api key" / "token" noun beats a bare "key"; in-viewport beats
    // off-screen. Highest score wins so a precise "Create API Key" is
    // preferred over a generic "Add key".
    let score = 0;
    if (phraseHit) score += 4;
    if (/\bapi[\s_-]*keys?\b|\bapi[\s_-]*tokens?\b/i.test(haystack)) score += 2;
    if (el.inViewport === true) score += 1;
    candidates.push({ el, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.el;
}

// A "name your key" confirm modal frequently labels its submit button
// generically — "Submit", "Create", "Generate", "Done" — with NO key noun, so
// findCreateKeyAffordance can't see it (groq: the page-level "Create API Key"
// opens a dialog whose only affirmative is a bare "Submit"). Worse, the
// page-level create button is still in the background DOM, so a naive
// findCreateKeyAffordance re-grabs IT and reopens the modal forever. This finds
// the modal's affirmative submit instead. Bounded to the modal shape — a text
// input (the name field) MUST be present — so a page-level Submit on an
// unrelated form can't be tripped. Excludes the just-clicked create button and
// any cancel/close control. Pure; exported for unit testing.
const KEY_MODAL_SUBMIT_AFFIRM =
  /^\s*(?:submit|create(?:\s+(?:api\s+)?key)?|generate(?:\s+key)?|confirm|done|save|add(?:\s+key)?|ok)\s*$/i;
const KEY_MODAL_NEGATIVE = /\b(?:cancel|close|back|dismiss|never\s*mind)\b/i;

export function findKeyModalSubmit(
  inventory: readonly InteractiveElement[],
  excludeSelector: string,
): InteractiveElement | null {
  const hasNameInput = inventory.some(
    (el) =>
      el.tag === "input" &&
      el.visible !== false &&
      (el.type === null || /^(?:text|search|email)$/i.test(el.type)),
  );
  if (!hasNameInput) return null;
  for (const el of inventory) {
    if (el.selector === excludeSelector) continue;
    const clickable =
      el.tag === "button" || el.tag === "a" || el.role === "button" || el.role === "link";
    if (!clickable || el.visible === false) continue;
    const label = [el.visibleText, el.ariaLabel, el.title]
      .filter((s): s is string => s !== null && s !== undefined && s.length > 0)
      .join(" ")
      .trim();
    if (label.length === 0 || label.length > 24) continue;
    if (KEY_MODAL_NEGATIVE.test(label)) continue;
    if (KEY_MODAL_SUBMIT_AFFIRM.test(label)) return el;
  }
  return null;
}

// The name input inside a "name your key" modal — the first visible text-like
// input. Some vendors gate the submit on a non-empty name (groq), so the mint
// flow types one before clicking submit. Pure; exported for unit testing.
export function findKeyNameInput(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  for (const el of inventory) {
    if (el.tag !== "input" || el.visible === false) continue;
    if (el.type !== null && !/^(?:text|search|email)$/i.test(el.type)) continue;
    return el;
  }
  return null;
}

// An in-DOM nav link/affordance that points AT an API-keys / tokens page.
// Distinct from findCreateKeyAffordance (the "create key" button): this finds
// the LINK that navigates TO the keys page, so the bot can click the real
// target — whose href is the correct path — instead of GUESSING a URL from a
// fixed convention list (which 404s whenever a service hosts keys at a
// non-standard path: unify-ai's keys aren't at /keys, /api-keys, or
// /settings/api-keys, all of which 404). A human clicks the sidebar link; so
// should the bot. Exported, pure (operates on the inventory shape only).
const API_KEYS_HREF =
  /\/(?:api[-_]?keys?|api[-_]?tokens?|access[-_]?tokens?|auth[-_]?tokens?|secret[-_]?keys?|personal[-_]?access[-_]?tokens?|developers?|keys?|tokens?)(?:[/?#]|$)/i;
const API_KEYS_TEXT =
  /\b(?:api|access|secret|auth|personal\s+access)\s*(?:keys?|tokens?)\b/i;

export function findApiKeysNavLink(
  inventory: readonly InteractiveElement[],
  alreadyClicked: ReadonlySet<string> = new Set(),
): InteractiveElement | null {
  const candidates: { el: InteractiveElement; score: number }[] = [];
  for (const el of inventory) {
    const isClickable =
      el.tag === "a" ||
      el.tag === "button" ||
      el.role === "link" ||
      el.role === "button";
    if (!isClickable) continue;
    if (el.visible === false) continue;
    if (alreadyClicked.has(el.selector)) continue;
    const href = el.href ?? "";
    const text = [el.visibleText, el.ariaLabel, el.title, el.labelText, el.iconLabel]
      .filter((s): s is string => s !== null && s !== undefined)
      .join(" ")
      .trim();
    // The loose href segments (keys?/tokens?/developers?) are only trusted on
    // an actual anchor href, where they're a structured path, not free text.
    const hrefHit = href.length > 0 && API_KEYS_HREF.test(href);
    const textHit = API_KEYS_TEXT.test(text);
    if (!hrefHit && !textHit) continue;
    // A "create API key" control is a different affordance (it opens a
    // create flow / modal, it doesn't navigate to the listing). Skip it here
    // UNLESS it's a real anchor with a keys href (then it's a nav link that
    // merely happens to read "New API key").
    if (CREATE_KEY_PHRASE.test(text) && !(el.tag === "a" && hrefHit)) continue;
    let score = 0;
    if (hrefHit) score += 4; // a real, navigable target beats a text guess
    if (/\bapi\s*(?:keys?|tokens?)\b/i.test(text)) score += 2;
    else if (textHit) score += 1;
    if (el.tag === "a") score += 1; // prefer anchors over role=button
    if (el.inViewport === true) score += 1;
    candidates.push({ el, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.el;
}

// Pick the next fallback URL to try, keyed against the origin of the
// currently-stuck URL. The curated SERVICE_KEYS_PATHS for the run's
// service (when its host matches the stuck origin) are tried FIRST,
// then the generic STUCK_LOOP_FALLBACK_PATHS. Returns null when every
// path has already been attempted. Exported for unit tests.
export function pickStuckLoopFallbackUrl(
  currentUrl: string,
  alreadyTried: ReadonlySet<string>,
  service?: string,
  appUrl?: string,
): string | null {
  let parsedCurrent: URL;
  try {
    parsedCurrent = new URL(currentUrl);
  } catch {
    return null;
  }

  // Compose key-path guesses onto the APP origin, NOT the origin of the
  // currently-stuck URL. After OAuth the stuck URL is the identity-provider
  // subdomain (auth.lumalabs.ai, accounts.<svc>, login.<svc>, the IdP) — which
  // has no settings/keys pages, so "${authOrigin}/settings/keys" 404s by
  // construction. The keys live on the app host (lumalabs.ai). `appUrl` is the
  // signup/app URL the bot actually navigated to (this.resolvedSignupUrl), so
  // its origin is the right host to guess against. Fall back to the stuck
  // origin only when no usable app URL is known.
  let composeBase: URL = parsedCurrent;
  if (appUrl !== undefined) {
    try {
      const parsedApp = new URL(appUrl);
      if (
        (parsedApp.protocol === "http:" || parsedApp.protocol === "https:") &&
        !isGoogleSearchUrl(appUrl) &&
        shouldComposeFallbackOnAppOrigin(parsedCurrent, parsedApp)
      ) {
        composeBase = parsedApp;
      }
    } catch {
      // keep the stuck origin
    }
  }
  // about:blank / data: / chrome-error pages have an opaque origin that
  // serializes to the literal string "null" — building "${origin}${path}"
  // then yields an unnavigable "null/settings/keys". Only compose
  // fallbacks against a real http(s) origin.
  if (composeBase.protocol !== "http:" && composeBase.protocol !== "https:") {
    return null;
  }
  const origin = composeBase.origin;
  // Skip a candidate when it resolves to the exact URL we're already stuck
  // on (full origin+path, trailing-slash/case tolerant) — re-navigating
  // there won't break the cycle. Compared on the full URL now that the
  // compose origin can differ from the stuck origin.
  const currentFull =
    `${parsedCurrent.origin}${parsedCurrent.pathname}`.replace(/\/+$/, "").toLowerCase();

  // Compose curated per-service paths first, but only when the COMPOSE
  // origin's host actually belongs to the named service. The slug is
  // a substring of the host for the vendors we curate (groq →
  // console.groq.com, launchdarkly → app.launchdarkly.com, …); this
  // host gate stops a curated path from being composed onto an
  // unrelated origin the bot wandered onto (e.g. an OAuth provider or
  // a redirect to a marketing domain).
  const slug = service !== undefined ? serviceSlug(service) : "";
  const servicePaths =
    slug !== "" && SERVICE_KEYS_PATHS[slug] !== undefined
      ? SERVICE_KEYS_PATHS[slug]
      : undefined;
  const hasAbsoluteServicePath =
    servicePaths?.some((path) => /^https?:\/\//i.test(path)) === true;
  const curated =
    servicePaths !== undefined &&
    (hasAbsoluteServicePath || composeBase.hostname.toLowerCase().includes(slug))
      ? servicePaths
      : [];

  // Curated paths lead; the generic list follows. De-dup so a path that
  // appears in both (groq's /keys, /settings/keys) isn't offered twice.
  const seen = new Set<string>();
  for (const path of [...curated, ...STUCK_LOOP_FALLBACK_PATHS]) {
    const candidate =
      /^https?:\/\//i.test(path) ? path : `${origin}${path}`;
    const candidatePath = candidate.replace(/\/+$/, "").toLowerCase();
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    if (alreadyTried.has(candidate)) continue;
    if (candidate.replace(/\/+$/, "").toLowerCase() === currentFull) continue;
    return candidate;
  }
  return null;
}

function shouldComposeFallbackOnAppOrigin(current: URL, app: URL): boolean {
  if (current.origin === app.origin) return true;
  if (isOAuthProviderHost(current.toString())) return true;
  const firstLabel = current.hostname.toLowerCase().split(".")[0] ?? "";
  // Auth/login subdomains are not where settings/key pages live. App consoles
  // commonly are (console.cloudinary.com, app.axiom.co), so do not blindly
  // replace every current origin with the original signup URL's origin.
  return /^(?:auth|authkit|login|accounts?|idp|sso|oauth|signin|signup)$/.test(firstLabel);
}

// Last-resort canonical signup URL when the caller passed none and no
// promoted skill / model resolution applies: <name>.com/signup, which
// catches the common dev-SaaS case (Resend, Postmark, IPInfo, …). Non-.com
// products and non-obvious entry points are handled upstream by
// resolveSignupUrl (promoted-skill signup_url → model); a wrong .com guess
// is recovered by the looksLikeSignupPage → Google-search fallback. The old
// hand-maintained KNOWN_DOMAINS table was retired once the model + the
// verified skill cache covered it. Exported for unit testing.
export function guessSignupUrl(service: string): string {
  const slug = service.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `https://${slug}.com/signup`;
}

const CANONICAL_SIGNUP_URLS: Readonly<Record<string, string>> = {
  // The model repeatedly returns the stale/dead host
  // console.cloud.clickhouse.com, which no longer resolves. ClickHouse's own
  // docs and current console use console.clickhouse.cloud.
  clickhousecloud: "https://console.clickhouse.cloud/signup",
  // The model repeatedly guesses /auth/signup, which Langfuse serves as a
  // Next.js 404. The actual Clerk/Auth.js registration route uses sign-up.
  langfuse: "https://cloud.langfuse.com/auth/sign-up",
  // The model guesses /app/signup, but Fly's current route is /app/sign-up.
  flyio: "https://fly.io/app/sign-up",
  // "Braintrust" is ambiguous in search/model results: usebraintrust.com is a
  // talent marketplace, while the API-key product is the AI observability app.
  braintrust: "https://www.braintrust.dev/signup",
  // Nomic's public Atlas routes now redirect to a marketing/developer page.
  // The self-serve account surface lives behind Auth0's universal login.
  nomic:
    "https://nomicai-production.us.auth0.com/u/login?state=hKFo2SA2XzhiVGRXMUR4X283bFYtUjQ1T2Q1NXBOZ095RmQ5c6Fur3VuaXZlcnNhbC1sb2dpbqN0aWTZIDdzTWlnTTZKVUZ5WnVDMjZldktEMlNMS0pZRmRfYnZOo2NpZNkgVkY0MURxZEV5UzJBYXE2NHExSW9PMUVPemRwanBsbnY",
  // /signup is now a 404; StackBlitz's account creation route is /register.
  stackblitz: "https://stackblitz.com/register",
  // Axiom's public login/register surface is app.axiom.co; login.axiom.co
  // is an auth host and 404s if API-token paths are composed onto it.
  axiom: "https://app.axiom.co/register",
  // Anyscale's marketing /signup is a lead form ("Get Started with $100 Credit")
  // that can submit cleanly without creating an account or sending
  // verification. Current Anyscale docs identify console.anyscale.com as the
  // organization signup flow.
  anyscale: "https://console.anyscale.com",
};

function canonicalSignupUrl(service: string): string | null {
  const slug = service.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CANONICAL_SIGNUP_URLS[slug] ?? null;
}

function serviceDerivedSignupCandidates(serviceSlug: string): string[] {
  const parts = serviceSlug
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];

  const candidates: string[] = [];
  const add = (url: string): void => {
    if (!candidates.includes(url)) candidates.push(url);
  };

  const compact = parts.join("");
  add(`https://${compact}.com/signup`);

  if (parts.length >= 2) {
    const root = parts.slice(0, -1).join("");
    const tld = parts[parts.length - 1];
    add(`https://${root}.${tld}/signup`);
    add(`https://app.${root}.${tld}/signup`);
    add(`https://console.${root}.${tld}/signup`);
  }

  return candidates;
}

// Pull the first well-formed http(s) URL out of arbitrary model text.
// Exported for unit testing.
export function firstHttpsUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>)\]]+/i);
  if (m === null) return null;
  // Trim trailing sentence punctuation the greedy match swallows when the
  // URL ends a sentence ("…/sign-up." → "…/sign-up").
  const raw = m[0].replace(/[.,;:!?]+$/, "");
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Resolve a service's signup URL.
//
// The old path was guessSignupUrl() alone: it templated `<slug>.com/signup`
// + a hand-maintained domain table. Every product whose real domain isn't
// `.com` (xata.io, fly.io, hyperbolic.xyz, …) died at the FIRST navigation —
// before the vision planner, the smartest part of the bot, ever loaded a
// page. The intelligence was in the wrong place: a vision-grade form-filler
// bolted onto a dumb string template for the front door.
//
// Resolution order now: a promoted skill's verified `signup_url` (injected
// lookupSkillUrl) → ASK the model (which knows where products live) → the
// `.com` guess. The model's answer is self-verifying: the navigation that
// follows surfaces a wrong URL as a 404 / cert / DNS failure (recovered by
// the looksLikeSignupPage → Google-search fallback), so a hallucinated URL
// is no worse than the old guess. With no LLM wired it degrades to the guess.
//
// Exported for unit testing.
export async function resolveSignupUrl(
  service: string,
  llm: LLMClient | null | undefined,
  opts: {
    log?: (line: string) => void;
    // Injected by the caller (router / housekeeper) — looks up the entry
    // URL of a promoted skill for this service. Verified-by-construction:
    // a skill only exists because a signup succeeded, so its recorded URL
    // is known-good. Kept as injection so the bot stays registry-decoupled.
    lookupSkillUrl?: () => Promise<string | null>;
  } = {},
): Promise<string> {
  // A promoted skill's entry URL beats the model — it's verified by a real
  // prior signup, not asserted. Consult it before spending an LLM call.
  if (opts.lookupSkillUrl !== undefined) {
    try {
      const fromSkill = await opts.lookupSkillUrl();
      if (fromSkill !== null) {
        opts.log?.(`Resolved signup URL for "${service}" from a promoted skill: ${fromSkill}`);
        return fromSkill;
      }
    } catch (err) {
      opts.log?.(
        `skill-URL lookup failed for "${service}" (${err instanceof Error ? err.message : String(err)}) — trying the model`,
      );
    }
  }
  const canonical = canonicalSignupUrl(service);
  if (canonical !== null) {
    opts.log?.(`Resolved signup URL for "${service}" from canonical map: ${canonical}`);
    return canonical;
  }
  // No model available → preserve the old deterministic behavior exactly.
  if (llm === null || llm === undefined) return guessSignupUrl(service);
  try {
    const resp = await llm.createMessage({
      system:
        "You map a developer-tool / SaaS product name to its canonical " +
        "account SIGN-UP (registration) URL — the page with the email or " +
        "OAuth signup form, not the marketing homepage and not the docs. " +
        "Use the product's REAL domain, which is frequently .io / .dev / " +
        ".ai / .xyz / .co and NOT .com. If signup lives on a dashboard / " +
        "app / console subdomain (dash.*, app.*, console.*), return that " +
        "exact URL. Respond with ONLY the URL on a single line, no prose. " +
        "If you are not confident, respond with exactly UNKNOWN.",
      user: [{ kind: "text", text: `Account sign-up URL for the product "${service}"?` }],
      max_tokens: 80,
    });
    const url = firstHttpsUrl(resp.text);
    if (url !== null) {
      opts.log?.(`Resolved signup URL for "${service}" via ${resp.backend}: ${url}`);
      return url;
    }
    opts.log?.(
      `Model gave no usable signup URL for "${service}" (said ${JSON.stringify(resp.text.trim().slice(0, 40))}) — using guess`,
    );
  } catch (err) {
    opts.log?.(
      `signup-URL model resolve failed for "${service}" (${err instanceof Error ? err.message : String(err)}) — using guess`,
    );
  }
  return guessSignupUrl(service);
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

// Google's NEWER consent screen (URL form
// `accounts.google.com/signin/oauth/id?...&part=<opaque-token>`) hides
// the requested scopes behind the opaque `part=` token — there is no
// `scope=` query param to read, so extractOAuthScopes() returns null.
// The only remaining signal is the visible DOM: the consent page lists
// each requested item as a templated phrase. These pattern sets let us
// classify that DOM as basic-only vs. reaching beyond identity.
//
// BASIC = the openid/email/profile family — the exact thing the
// URL-readable happy path (scopesAreBasic → auto-approve) already
// approves without a human. We require a positive basic signal so an
// empty/ambiguous DOM never counts as basic.
const GOOGLE_BASIC_CONSENT_PHRASES: readonly RegExp[] = [
  // "See your primary Google Account email address"
  /see\s+your\s+primary\s+google\s+account\s+email\s+address/i,
  // generic email-address grant wording
  /\byour\s+(?:primary\s+)?(?:google\s+account\s+)?email\s+address\b/i,
  // "See your personal info, including any personal info you've made
  // publicly available" / "See your public profile"
  /see\s+your\s+personal\s+info/i,
  /your\s+public\s+profile/i,
  // "Associate you with your personal info on Google"
  /associate\s+you\s+with\s+your\s+personal\s+info/i,
];
// Sensitive (non-basic) scope-grant wording. Any hit means the consent
// reaches beyond identity — never auto-approve. Kept broad on purpose:
// a false "non-basic" only costs a manual review, but a missed one
// would auto-approve a sensitive grant.
const GOOGLE_NON_BASIC_CONSENT_PHRASES: readonly RegExp[] = [
  /\bcontacts?\b/i,
  /\bcalendars?\b/i,
  /\b(?:google\s+)?drive\b/i,
  /\byour\s+files?\b/i,
  /\bgmail\b/i,
  /send\s+(?:email|mail|messages)/i,
  /\bspreadsheets?\b/i,
  /\bsheets\b/i,
  /\bphotos\b/i,
  /\byoutube\b/i,
  /\bon\s+your\s+behalf\b/i,
  /\bmanage\s+your\b/i,
  /\bedit\s+your\b/i,
  /\bdelete\s+your\b/i,
  /see\s+and\s+download\s+your/i,
];

// "basic" = the consent DOM lists ONLY openid/email/profile-family
// grants. See the block comment above for WHY this exists (Google hides
// scopes behind `part=` in the new consent URL; the visible phrases are
// the only signal, and a basic-only consent is what the URL-readable
// path auto-approves anyway). Returns false on ambiguous/empty so the
// caller keeps its conservative oauth_consent_needs_review abort —
// this gate only RECOVERS the basic-only case, never widens approval.
// Exported for unit testing.
export function googleConsentIsBasicFromDom(bodyText: string): boolean {
  // Reuse the existing danger scraper as the first backstop — if it
  // flags any sensitive scope-grant phrase, this is not basic-only.
  if (scrapeGoogleScopePhrases(bodyText).length > 0) return false;
  const hasNonBasic = GOOGLE_NON_BASIC_CONSENT_PHRASES.some((p) =>
    p.test(bodyText),
  );
  if (hasNonBasic) return false;
  // Require a positive basic signal: an empty/ambiguous DOM (no
  // recognizable grant wording) returns false so the caller does not
  // approve blind.
  return GOOGLE_BASIC_CONSENT_PHRASES.some((p) => p.test(bodyText));
}

// The MODERN "Sign in with Google" (GIS) consent screen uses different copy
// than the classic OAuth consent: "Allow <App> to access this info about you"
// listing "Name and profile picture" / "Email address" with a Continue button
// (MEASURED 2026-06-13: langfuse OAuth as a fresh robot lands exactly here, and
// the bot mislabeled it oauth_stuck_on_chooser because the URL is still
// accounts.google.com). This recognizes that basic-only GIS screen so the bot
// can auto-approve it — same safety contract as googleConsentIsBasicFromDom:
// any sensitive phrase (Drive/Gmail/contacts/…) hard-fails it. Exported for tests.
export function googleGisConsentIsBasic(bodyText: string): boolean {
  // Safety first — any sensitive scope wording disqualifies, via both the
  // danger scraper and the explicit non-basic phrase set.
  if (scrapeGoogleScopePhrases(bodyText).length > 0) return false;
  if (GOOGLE_NON_BASIC_CONSENT_PHRASES.some((p) => p.test(bodyText))) return false;
  // Positive GIS basic signal: the "access this info about you" framing plus a
  // name/email/profile item and nothing else. Fall back to the classic
  // basic-phrase check for the older consent layout.
  const isGisScreen = /to access this info about you|access your google account/i.test(bodyText);
  const hasBasicItem =
    /name and profile picture/i.test(bodyText) ||
    /\bemail address\b/i.test(bodyText) ||
    /personal info/i.test(bodyText) ||
    /public profile/i.test(bodyText);
  if (isGisScreen && hasBasicItem) return true;
  return googleConsentIsBasicFromDom(bodyText);
}

// Pure: pick which Google account-chooser card to click. Given the intended
// signup email and the emails the chooser shows (its `data-identifier` values),
// return the matching one (case-insensitive, whitespace-trimmed) so a profile
// with more than one account signs up as the RIGHT identity instead of whoever
// renders first. Returns null when there's no hint or no match — the caller
// then falls back to the first card, which is correct for the common single-
// account profile (one card, no ambiguity).
export function pickChooserAccount(
  targetEmail: string | undefined,
  identifiers: readonly string[],
): string | null {
  if (targetEmail === undefined || targetEmail.trim() === "") return null;
  const want = targetEmail.trim().toLowerCase();
  return identifiers.find((id) => id.trim().toLowerCase() === want) ?? null;
}

export interface SignupTask {
  service: string;
  signupUrl?: string | undefined;
  // Looks up the entry URL of a promoted skill for this service (registry-
  // backed). When no curated signupUrl is given, resolveSignupUrl consults
  // this before the LLM. Injected so the bot stays registry-decoupled.
  lookupSkillUrl?: ((service: string) => Promise<string | null>) | undefined;
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
  // The Google account to sign up AS when the profile holds more than one and
  // Google shows its account chooser. The chooser picks the card whose email
  // matches this; without it (or on a single-account profile) the first card is
  // taken. Plumbed so a multi-account profile signs up as the intended identity
  // instead of whichever account happens to render first.
  oauthAccountEmail?: string | undefined;
  // Force the email/password FORM path even when the page (and the bot's
  // profile) would otherwise prefer OAuth. Used to exercise a service's
  // form-side captcha (e.g. Turnstile/reCAPTCHA-v3 on the signup form)
  // that OAuth would bypass — the A/B harness for the CDP-hardening work
  // needs the form path to actually hit the challenge.
  forceForm?: boolean | undefined;
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

// Detect an image block's media type from its base64 payload's magic bytes.
// Live screenshots are JPEG (Playwright `type: "jpeg"`), so that's the
// default — but the eval corpus uses a 1x1 PNG sentinel, and a PNG labeled
// `image/jpeg` makes the Anthropic premium fallback 400 ("the image appears
// to be a image/png image"). Base64 of the PNG magic (\x89PNG) is "iVBOR";
// JPEG (\xFF\xD8\xFF) is "/9j/". Cheap providers tolerate a mislabel; strict
// ones reject it — so always label what the bytes actually are.
export function imageMediaType(base64: string): "image/png" | "image/jpeg" {
  return base64.startsWith("iVBOR") ? "image/png" : "image/jpeg";
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
  // B1 — the terminal failure-stage label (flakiness taxonomy). Set on the
  // finished result so telemetry + the outcome sidecar share one value.
  // "none" on success; see classifyFailureStage in failure-stage.ts.
  failure_stage?: FailureStage;
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

  // Which stealth launcher this run used: "cdp_hardened" when the
  // patchright launcher loaded (BOT_CDP_HARDENED set + patchright
  // present), else "baseline". The CaptchaEvent A/B tag that lets us
  // measure whether isolated-world execution (closing mainWorldExecution
  // + webdriver tells) lowers block rate — see
  // docs/DESIGN-antibot-hardening.md.
  stealth_profile?: "baseline" | "cdp_hardened";

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
    kind: CaptchaKind;
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
  | { kind: "select"; selector: string; reason: string; option_text?: string }
  | { kind: "click"; selector: string; reason: string };

export interface SignupPlan {
  actions: FillAction[];
  submit_selector: string;
  confidence: "high" | "medium" | "low";
  notes?: string;
}

function textOfInteractiveElement(el: InteractiveElement): string {
  return [
    el.visibleText,
    el.ariaLabel,
    el.title,
    el.labelText,
    el.placeholder,
    el.name,
    el.id,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();
}

export function planSimpleEmailOnlySignup(
  inventory: readonly InteractiveElement[],
): SignupPlan | null {
  const visibleInputs = inventory.filter(
    (el) =>
      el.tag === "input" &&
      el.visible !== false &&
      el.type !== "hidden" &&
      el.type !== "checkbox" &&
      el.type !== "radio",
  );
  const emailInputs = visibleInputs.filter((el) => {
    const hay = textOfInteractiveElement(el);
    return el.type === "email" || /\be-?mail\b/i.test(hay);
  });
  if (emailInputs.length !== 1) return null;
  if (visibleInputs.some((el) => el.type === "password")) return null;
  if (visibleInputs.length !== 1) return null;

  const hasSeparateSignupCta = inventory.some((el) => {
    if (el.visible === false) return false;
    if (el.tag === "button" || el.type === "submit") return false;
    return /\b(?:sign up|signup|get started|create (?:an )?account|register)\b/i.test(
      textOfInteractiveElement(el),
    );
  });

  const submit = inventory.find((el) => {
    if (el.visible === false) return false;
    if (el.tag !== "button" && el.tag !== "input" && el.role !== "button") return false;
    const text = textOfInteractiveElement(el);
    const isSubmitControl = el.type === "submit" || el.tag === "button" || el.role === "button";
    if (!isSubmitControl) return false;
    return /\b(?:send (?:me )?(?:a )?(?:magic )?link|magic link|continue|sign up|join|get started)\b/i.test(text);
  });
  if (submit === undefined) return null;
  const submitText = textOfInteractiveElement(submit);
  if (
    hasSeparateSignupCta &&
    !/\b(?:sign up|signup|join|get started|create (?:an )?account|register)\b/i.test(
      submitText,
    )
  ) {
    return null;
  }

  return {
    actions: [
      {
        kind: "fill",
        selector: emailInputs[0]!.selector,
        value_kind: "email",
        reason: "Fill the email address for the magic-link signup form",
      },
    ],
    submit_selector: submit.selector,
    confidence: "high",
    notes: "Deterministic email-only signup form",
  };
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
  "phone",
  "literal",
] as const;
type FillValueKind = (typeof FILL_VALUE_KINDS)[number];

const HUMAN_FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Taylor",
  "Casey",
  "Morgan",
  "Riley",
  "Jamie",
  "Cameron",
  "Avery",
  "Quinn",
] as const;

const HUMAN_LAST_NAMES = [
  "Miller",
  "Parker",
  "Reed",
  "Brooks",
  "Hayes",
  "Bennett",
  "Carter",
  "Foster",
  "Morgan",
  "Spencer",
] as const;

interface SignupIdentity {
  firstName: string;
  lastName: string;
  displayName: string;
  username: string;
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function titleCaseNameToken(token: string): string {
  const lower = token.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function safeNameToken(token: string | undefined): string | null {
  if (token === undefined) return null;
  const cleaned = token.replace(/[^a-z]/gi, "");
  if (cleaned.length < 2) return null;
  if (/^(?:trusty|squire|bot|test|demo|admin|user|verify)$/i.test(cleaned)) return null;
  return titleCaseNameToken(cleaned);
}

function identityFromEmail(email: string): SignupIdentity {
  const local = email.split("@", 1)[0] ?? "";
  const tokens = local.split(/[^a-z]+/i).map(safeNameToken).filter((token): token is string => token !== null);
  const hash = stableHash(email);
  const firstName = tokens[0] ?? HUMAN_FIRST_NAMES[hash % HUMAN_FIRST_NAMES.length]!;
  const lastName = tokens[1] ?? HUMAN_LAST_NAMES[Math.floor(hash / HUMAN_FIRST_NAMES.length) % HUMAN_LAST_NAMES.length]!;
  const suffix = String(hash % 10_000).padStart(4, "0");
  const username = `${firstName}.${lastName}.${suffix}`.toLowerCase();
  return {
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    username,
  };
}

function elementTextForFieldKind(el: InteractiveElement | undefined): string {
  if (el === undefined) return "";
  return [
    el.name,
    el.id,
    el.placeholder,
    el.ariaLabel,
    el.labelText,
    el.visibleText,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

export function resolvePlannedFillValue(
  action: FillAction & { kind: "fill" },
  fillValues: Record<FillValueKind, string>,
  el: InteractiveElement | undefined,
  identity: SignupIdentity,
): string {
  const fieldText = elementTextForFieldKind(el);
  if (
    action.value_kind === "literal" &&
    /\b(?:confirm|confirmation|verify|verification|again|repeat)\b/.test(fieldText) &&
    /password/.test(fieldText)
  ) {
    return fillValues.password;
  }
  if (action.value_kind === "literal") return action.literal ?? "";
  if (action.value_kind !== "name") return fillValues[action.value_kind];

  if (/\b(?:first|given|forename)\b|first[_-]?name|given[_-]?name/.test(fieldText)) {
    return identity.firstName;
  }
  if (/\b(?:last|family|surname)\b|last[_-]?name|family[_-]?name/.test(fieldText)) {
    return identity.lastName;
  }
  return identity.displayName;
}

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
    case "select": {
      const optionText = typeof obj["option_text"] === "string" ? obj["option_text"] : undefined;
      return optionText !== undefined
        ? {
            kind: "select",
            selector: requireString(obj, "selector", `action[${index}] (select)`),
            option_text: optionText,
            reason: typeof obj["reason"] === "string" ? obj["reason"] : "",
          }
        : {
            kind: "select",
            selector: requireString(obj, "selector", `action[${index}] (select)`),
            reason: typeof obj["reason"] === "string" ? obj["reason"] : "",
          };
    }
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

// True when a clickSubmit failure is a Playwright visibility/attach
// timeout rather than a genuine hard error. A timeout means the submit
// selector resolved at plan-time but was gone by click-time — almost
// always because an earlier action in the same plan advanced a
// multi-step SPA (Paddle's "Continue" → next screen), so the right
// recovery is a re-plan against the new page, not a run-ending
// submit_failed. Matches Playwright's `locator.waitFor`/`waitForSelector`
// timeout text; deliberately does NOT match `submit_disabled` (handled
// separately) or other click errors (genuine failures). Exported for
// unit testing.
export function isSubmitTimeout(reason: string): boolean {
  if (reason.startsWith("submit_disabled")) return false;
  return /Timeout \d+ms exceeded/i.test(reason) && /waitfor|waiting for/i.test(reason);
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
      // T38 — card-radio cluster annotation. Tells the planner "this
      // is the Nth of M sibling cards; exactly one needs to be picked
      // to advance past this wizard step."
      if (e.cardRadioGroup !== null && e.cardRadioGroup !== undefined) {
        bits.push(
          `[card-radio ${e.cardRadioGroup.position}/${e.cardRadioGroup.total}]`,
        );
      }
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

// Strip HTML tags + decode the handful of entities that show up in the
// copy we key on, then lowercase. We classify on the VISIBLE COPY because
// that's the only thing that reliably distinguishes a signup form from a
// login form — both have an <input type="password"> and an email field,
// so structure alone is ambiguous (the exact bug looksLikeSignupPage
// can't see past). The decoded entities matter: "Create&nbsp;account" or
// a "Don&apos;t have an account?" link would otherwise hide the
// discriminating phrase behind an entity.
function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// True when a page is a 404 / route-not-found shell. Used to abort the
// hardcoded keys-URL walk early: when guessed keys paths keep 404ing, this
// host's routing convention simply isn't in our list, and continuing the
// ~25-path walk (each a goto + up-to-15s DOM wait) just burns the run budget.
// MEASURED 2026-06-09: axiom/fathom/loops each hit the FULL walk with every
// path a 404 and blew the 600s deadline. Matches the three observed shells:
// title "Not Found" (fathom), body "404 … page you're looking for doesn't
// exist" (loops), body "404 page not found" (axiom).
export function looksLike404(title: string, bodyText: string): boolean {
  const hay = `${title} ${bodyText}`.toLowerCase().slice(0, 600);
  const has404Token = /\b404\b/.test(hay);
  const notFoundPhrase =
    /page not found|not found|could ?n[o'’]?t be found|could not be found|does ?n[o'’]?t exist|does not exist|page you[''’]?re looking for/.test(
      hay,
    );
  // A bare "404" token, or a clear not-found phrase, is enough — guessed
  // keys URLs that hit either are dead ends.
  return has404Token || notFoundPhrase;
}

// Pull the <title> text out of a raw HTML string (lowercased work is left to
// the caller). Empty string when absent. Cheap — no DOM round-trip.
export function titleFromHtml(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1]?.trim() ?? "";
}

// Classify a fetched page as a signup form, a login form, or neither.
//
// WHY this exists: looksLikeSignupPage() answers "does this page have a
// form?" — which a LOGIN page also satisfies (email + password + a
// "Continue with Google" button). The discriminator is the COPY, not the
// structure: a real email-signup form carries create-account CTA text
// ("create account", "sign up", "get started", "register"); a login form
// carries "sign in" / "log in" / "welcome back" and lacks the create CTA.
// This is the heart of the stale-URL fix — a curated /signup that
// silently serves the login SPA classifies as "login" here, which lets
// the resolver reject it and probe for the real signup path.
export function classifySignupHtml(
  html: string,
  title?: string,
): "signup" | "login" | "other" {
  const text = stripHtmlToText(html);
  const titleLower = (title ?? "").toLowerCase();

  // 404 / error shell wins regardless of stray form copy — a "not found"
  // title is the strongest "this isn't the page you wanted" signal.
  if (
    titleLower.includes("404") ||
    titleLower.includes("not found") ||
    titleLower.includes("page not found")
  ) {
    return "other";
  }

  // A password field is the structural prerequisite for an auth form. We
  // regex the RAW html (not the stripped text) because attribute values
  // live inside the tags the stripper removes. Either the input type or a
  // name="password"/id="password" counts — some SPAs render the field
  // without an explicit type=password.
  const hasPassword =
    /type\s*=\s*["']?password["']?/i.test(html) ||
    /(?:name|id)\s*=\s*["']?password["']?/i.test(html);

  // Create-account CTA copy — the signup discriminator. "sign up" is
  // word-bounded so it matches "sign up" but not "designup"; "get
  // started" and "register" round out the common variants.
  const hasSignupCta =
    /\bcreate (?:an )?account\b/.test(text) ||
    /\bcreate your account\b/.test(text) ||
    /\bsign[\s-]?up\b/.test(text) ||
    /\bget started\b/.test(text) ||
    /\bregister\b/.test(text);

  // Generic login copy — present on any sign-IN form.
  const hasLoginCopy =
    /\bsign in\b/.test(text) ||
    /\blog[\s-]?in\b/.test(text) ||
    /\bwelcome back\b/.test(text);

  // LOGIN-DOMINANT headings: even when a "Sign up" link sits in the
  // footer ("Don't have an account? Sign up"), these headings mean the
  // PRIMARY form is login. Used to veto a false "signup" read.
  const loginDominant =
    /\bsign in to your account\b/.test(text) ||
    /\bwelcome back\b/.test(text) ||
    /\blog[\s-]?in to\b/.test(text);

  if (hasPassword && hasSignupCta && !loginDominant) {
    // Has the form AND advertises account creation, and isn't a login
    // page that merely links to signup — this is the page we want.
    return "signup";
  }

  // A login-dominant heading wins even when a stray signup link bumped
  // hasSignupCta (the "Don't have an account? Sign up" footer case).
  if (loginDominant && hasPassword) {
    return "login";
  }

  if (hasLoginCopy && !hasSignupCta) {
    // Login copy with no create-account CTA anywhere — a sign-in form.
    return "login";
  }

  // No password field and no clear CTA → marketing page / empty SPA shell
  // / 404 body. Not a form we can fill.
  return "other";
}

// Pull the email address an email-verification wall names ("check your
// <addr> inbox", "we sent a link to <addr>"). Returns the first email-shaped
// token, or null. Used to poll the RIGHT alias when the wall was reached
// without a fresh submit (a pending account may carry an alias from a prior
// run, not task.email). Exported for unit tests.
export function extractVerifyWallAlias(text: string): string | null {
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const addr = m[0];
    // Reject email-SHAPED asset references — raw HTML carries script/style
    // srcs like "amplitude-analytics-browser@2.42.4-fe68beca4b18.js" that the
    // pattern otherwise matches. A real verification alias never ends in a
    // file extension.
    if (/\.(?:js|mjs|css|map|png|jpe?g|svg|gif|ico|woff2?|ttf|webp)$/i.test(addr)) {
      continue;
    }
    // Reject RFC 2606 reserved-for-documentation domains. A docs/sample email
    // like "check amy@example.com" rendered on a dashboard is never a real
    // verification target — polling it 404s as unknown_alias and yields a
    // false verification_not_sent. (Anthropic's console shows amy@example.com
    // in a sample.) Covers example.{com,net,org} + the .example/.test/
    // .invalid/.localhost reserved suffixes.
    const domain = addr.slice(addr.indexOf("@") + 1).toLowerCase();
    if (
      /^example\.(?:com|net|org)$/.test(domain) ||
      /\.(?:example|test|invalid|localhost)$/.test(domain)
    ) {
      continue;
    }
    return addr;
  }
  return null;
}

// Pure: does this post-submit page look like a CONTINUATION step of the same
// signup rather than a dashboard, a credentials page, or a verify-your-email
// screen? Conservative on purpose: requires a create/continue-style submit
// control and either a visible empty password input (Amplitude) OR explicit
// signup-wizard copy with visible empty business/account fields (Paddle). The
// page must NOT read as a verify-your-email screen or a login form (a "sign in"
// page also has a password field, but re-filling it with the run's generated
// password would just fail). Exported for unit tests.
export function isContinuationFormStep(
  html: string,
  inventory: ReadonlyArray<InteractiveElement>,
): boolean {
  // A verify-your-email page is finished by the inbox poll, not re-filled.
  if (expectsVerificationEmail(html)) return false;
  // A login page must not be mistaken for a signup continuation.
  if (classifySignupHtml(html) === "login") return false;
  const hasSubmitControl = inventory.some((e) => {
    if (e.tag !== "button" && e.type !== "submit") return false;
    const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
    return /\b(?:create|continue|sign[\s-]?up|next|submit|finish|get started|done)\b/.test(
      t,
    );
  });
  if (!hasSubmitControl) return false;

  const hasEmptyPassword = inventory.some(
    (e) =>
      e.tag === "input" &&
      e.type === "password" &&
      e.visible !== false &&
      (e.value ?? "") === "",
  );
  if (hasEmptyPassword) return true;

  const signupWizardCopy =
    /\b(?:account details|business details|part\s+\d+\s+of\s+\d+|business name|business type|annual revenue|company details|workspace details)\b/i.test(
      html,
    );
  if (!signupWizardCopy) return false;

  return inventory.some((e) => {
    if (e.visible === false) return false;
    if (e.tag !== "input" && e.tag !== "textarea" && e.tag !== "select") return false;
    if (e.type === "checkbox" || e.type === "radio" || e.type === "hidden") return false;
    if ((e.value ?? "") !== "") return false;
    const label = `${e.labelText ?? ""} ${e.placeholder ?? ""} ${e.name ?? ""} ${e.id ?? ""} ${e.ariaLabel ?? ""}`;
    return /\b(?:business|company|workspace|website|revenue|name|type|role|team)\b/i.test(label);
  });
}

// Find the in-page "create an account" affordance on a LOGIN page that
// also advertises signup ("Don't have an account? Sign up for free" —
// the amplitude case). After Google OAuth, such a service has signed the
// identity in but has no account/org for it, and expects the in-page
// signup CTA to be clicked to create one. We surface that element so the
// post-OAuth recovery can click it and re-route into the email/password
// signup path, instead of re-triggering OAuth in a loop.
//
// A login page carries BOTH a "Sign in" submit button AND a "Sign up"
// link — we want the latter. Returns null when no signup affordance is
// present (so callers fall through to the existing re-OAuth path).
export function findSignupCtaElement(
  inventory: ReadonlyArray<InteractiveElement>,
): InteractiveElement | null {
  // Signup intent: "sign up" / "sign up for free" / "create (an) account" /
  // "register" / "get started". Word-bounded so "signup" matches but
  // "designup" doesn't.
  const signupIntent =
    /\b(?:sign[\s-]?up(?:\s+for\s+free)?|create\s+(?:an?\s+)?account|register|get\s+started)\b/i;
  // OAuth affordances ("Continue with Google", "Sign in with GitHub") —
  // clicking these re-triggers the OAuth handshake, the exact loop we're
  // trying to escape. EXCLUDE them even though "sign in with" brushes the
  // loginIntent regex below.
  const oauthAffordance = /continue with|sign in with|log ?in with/i;
  // Pure login affordance ("Sign in" / "Log in") WITHOUT a signup word —
  // a login page's primary submit button. EXCLUDE it; we want the signup
  // link sitting next to it, not the sign-in button.
  const loginIntent = /\b(?:sign[\s-]?in|log[\s-]?in)\b/i;

  let best: InteractiveElement | null = null;
  for (const el of inventory) {
    // Only clickable affordances — an <a>, a <button>, or anything with an
    // explicit button role. A signup CTA is one of these; a bare <div>
    // label isn't reliably clickable.
    const isClickable =
      el.tag === "a" ||
      el.tag === "button" ||
      (el.role ?? "").toLowerCase() === "button";
    if (!isClickable) continue;

    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
    if (label === "") continue;

    // EXCLUDE OAuth buttons — clicking re-OAuths (the loop we're escaping).
    if (oauthAffordance.test(label)) continue;
    // Must read as a signup affordance.
    if (!signupIntent.test(label)) continue;
    // EXCLUDE a pure login button — one whose label reads as sign-IN but
    // carries no signup word. (signupIntent already matched this element's
    // own label, so this guard is defensive: it drops anything that is
    // login-only despite a stray match.)
    if (loginIntent.test(label) && !signupIntent.test(label)) continue;

    // Prefer an <a>/<button> over a role=button div — a real link/button is
    // the canonical signup CTA. First clickable match wins; an anchor or
    // button upgrades a prior role-button-div pick.
    if (best === null) {
      best = el;
    } else if (
      best.tag !== "a" &&
      best.tag !== "button" &&
      (el.tag === "a" || el.tag === "button")
    ) {
      best = el;
    }
  }
  return best;
}

// True when a post-OAuth page is a read-only DEMO / sandbox the service drops
// new users into (amplitude: app.amplitude.com/analytics/demo) rather than a
// real account — there is no API key here, and a real org needs the page's
// "Create a free account" CTA. Conservative: a `/demo` URL segment OR explicit
// demo copy ("you are currently in the … demo" / "this is a demo"). Exported
// for unit tests.
export function isSandboxDemoState(url: string, bodyText: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/(?:^|\/)demo(?:\/|$)/.test(path)) return true;
  } catch {
    // fall through to the text check
  }
  return /you are currently in the .{0,30}demo|this is (?:a|the) .{0,20}demo|viewing (?:the )?demo|demo (?:account|environment|workspace)\b/i.test(
    bodyText,
  );
}

// Find the "Create a free account" CTA that escapes a demo/sandbox into the
// real signup. Distinct from findSignupCtaElement because the demo phrasing
// ("Create a free account") has "free" between "a" and "account", which that
// helper's tighter regex doesn't match. Clickable tags only. Exported for
// unit tests.
export function findCreateAccountCta(
  inventory: ReadonlyArray<InteractiveElement>,
): InteractiveElement | null {
  const re =
    /create\s+(?:a\s+)?(?:free\s+)?account|sign\s*up\s+for\s+free|get\s+started\s+for\s+free/i;
  for (const e of inventory) {
    if (e.tag !== "a" && e.tag !== "button" && e.role !== "button") continue;
    const text = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.trim();
    if (re.test(text)) return e;
  }
  return null;
}

// Conventional signup paths to probe, in priority order. Small + ordered
// on purpose — we want the FIRST real signup form, not a fan-out across
// dozens of guesses that each cost a round-trip over a residential
// tunnel. "/auth/signup" sits high because it catches the plunk case
// (app.useplunk.com/auth/signup 308 → next-app.useplunk.com/auth/signup).
const CONVENTIONAL_SIGNUP_PATHS = [
  "/signup",
  "/auth/signup",
  "/sign-up",
  "/register",
  "/users/sign_up",
  "/account/signup",
  "/join",
] as const;

// Host-prefix swaps: dashboards live behind app./console./dashboard./www.,
// but the signup form often lives on auth. or the bare apex. Swapping the
// leading label widens the probe to those hosts without fanning out
// blindly across arbitrary subdomains.
const SIGNUP_HOST_PREFIX_SWAPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^app\./, "auth."],
  [/^www\./, "auth."],
  [/^console\./, "auth."],
  [/^dashboard\./, "auth."],
];

// Build the ordered, de-duped candidate URL set for the probe: every
// conventional path across (the hint host, the prefix-swapped hosts, and
// the bare eTLD+1). The resolver's final domain-safety check guards
// against a candidate that ends up redirecting off-domain.
function buildSignupCandidates(hint: URL): string[] {
  const hosts = new Set<string>([hint.hostname]);
  for (const [from, to] of SIGNUP_HOST_PREFIX_SWAPS) {
    if (from.test(hint.hostname)) {
      hosts.add(hint.hostname.replace(from, to));
    }
  }
  const registered = getDomain(hint.hostname);
  if (registered !== null) hosts.add(registered);

  const candidates: string[] = [];
  const seen = new Set<string>();
  // Path-major so each path is tried across all hosts before the next
  // path — "/signup" everywhere, then "/auth/signup" everywhere, etc.
  for (const path of CONVENTIONAL_SIGNUP_PATHS) {
    for (const host of hosts) {
      const url = `https://${host}${path}`;
      if (!seen.has(url)) {
        seen.add(url);
        candidates.push(url);
      }
    }
  }
  return candidates;
}

// Tier A of the signup-URL resolver — the HTTP fast-path. Given a hint URL
// (curated YAML or a guess) and an injectable redirect-following fetcher,
// return a URL that actually serves a signup FORM, or null if the HTTP
// probe can't resolve one (the caller then escalates to the landing-page
// CTA or the Google-search fallback).
//
// `fetchText` is injected so this is unit-testable with a fake — in
// production it's bound to BrowserController.fetchText, which egresses
// through the same residential proxy + cookie jar as the real navigation,
// so a redirect/HTML read here is representative of what the browser would
// land on. Pure-ish: no browser, no globals beyond the PSL helper.
export async function resolveSignupUrlByProbe(
  hintUrl: string,
  serviceSlug: string,
  fetchText: (
    url: string,
  ) => Promise<{ finalUrl: string; status: number; bodyText: string } | null>,
  log?: (m: string) => void,
): Promise<string | null> {
  const note = (m: string): void => log?.(m);

  let hint: URL;
  try {
    hint = new URL(hintUrl);
  } catch {
    note(`[signup-url] hint ${hintUrl} is not a URL — skipping HTTP probe`);
    return null;
  }

  // Fast path: the hint itself, followed through redirects. A 308 chain
  // (plunk's app. → next-app.) resolves here for free.
  const hintRes = await fetchText(hintUrl);
  if (hintRes !== null && classifySignupHtml(hintRes.bodyText) === "signup") {
    if (hintRes.finalUrl !== hintUrl) {
      note(`[signup-url] hint ${hintUrl} redirected to signup ${hintRes.finalUrl}`);
    } else {
      note(`[signup-url] hint ${hintUrl} is already a signup form`);
    }
    return hintRes.finalUrl;
  }
  note(
    `[signup-url] hint ${hintUrl} did not classify as signup` +
      (hintRes === null
        ? " (fetch failed)"
        : ` (${classifySignupHtml(hintRes.bodyText)})`),
  );

  // The hint's registered domain (eTLD+1) is the trusted anchor — it's the
  // curated/guessed signup_url we were told to start from. A conventional-
  // path candidate is in-bounds when it stays on that SAME registered
  // domain, which is the robust check: the service SLUG frequently isn't
  // the domain label (plunk's site is useplunk.com, railway's is
  // railway.com), so matching the candidate against the slug wrongly
  // rejected legitimate same-site redirects (plunk app.→next-app.). We keep
  // a slug match as a secondary allowance for a curated hint that itself
  // points at a canonical site on a different registered domain.
  const hintDomain = getDomain(hint.hostname.toLowerCase());

  // Probe the conventional paths. The first one that BOTH classifies as a
  // signup form AND stays on the service's own registered domain wins. The
  // domain check guards against a path that redirects to a third party
  // (e.g. a generic SSO portal on a different registered domain).
  for (const candidate of buildSignupCandidates(hint)) {
    if (candidate === hintUrl) continue; // already tried as the hint
    const res = await fetchText(candidate);
    if (res === null) continue;
    if (classifySignupHtml(res.bodyText) !== "signup") continue;

    let finalHost: string;
    try {
      finalHost = new URL(res.finalUrl).hostname;
    } catch {
      continue;
    }
    const finalDomain = getDomain(finalHost.toLowerCase());
    const sameRegisteredDomain =
      hintDomain !== null && finalDomain !== null && finalDomain === hintDomain;
    if (!sameRegisteredDomain && !hostMatchesServiceDomain(finalHost, serviceSlug)) {
      note(
        `[signup-url] candidate ${candidate} → ${res.finalUrl} rejected: ` +
          `off-domain (hint domain ${hintDomain ?? "?"})`,
      );
      continue;
    }
    note(`[signup-url] resolved via probe: ${candidate} → ${res.finalUrl}`);
    return res.finalUrl;
  }

  // If the model/curated hint is not even reachable, widen from "same origin"
  // to service-name-derived origins and validate those with the same HTTP
  // probe. This recovers stale host guesses like
  // console.cloud.clickhouse.com → console.clickhouse.cloud without trusting
  // the LLM blindly. If a candidate is reachable but its static HTML is
  // inconclusive (common Auth0/Clerk shell), return it only as a replacement
  // for an unreachable hint; the browser planner can then inspect the live
  // page instead of dying on DNS.
  let firstReachableServiceCandidate: string | null = null;
  if (hintRes === null) {
    for (const candidate of serviceDerivedSignupCandidates(serviceSlug)) {
      if (candidate === hintUrl) continue;
      const res = await fetchText(candidate);
      if (res === null) continue;

      let finalHost: string;
      let candidateHost: string;
      try {
        finalHost = new URL(res.finalUrl).hostname;
        candidateHost = new URL(candidate).hostname;
      } catch {
        continue;
      }
      const finalDomain = getDomain(finalHost.toLowerCase());
      const candidateDomain = getDomain(candidateHost.toLowerCase());
      const sameCandidateDomain =
        finalDomain !== null && candidateDomain !== null && finalDomain === candidateDomain;
      if (!sameCandidateDomain && !hostMatchesServiceDomain(finalHost, serviceSlug)) {
        note(
          `[signup-url] service candidate ${candidate} → ${res.finalUrl} rejected: off-domain`,
        );
        continue;
      }

      if (classifySignupHtml(res.bodyText) === "signup") {
        note(`[signup-url] recovered via service probe: ${candidate} → ${res.finalUrl}`);
        return res.finalUrl;
      }
      firstReachableServiceCandidate ??= res.finalUrl;
    }
  }

  if (firstReachableServiceCandidate !== null) {
    note(
      `[signup-url] hint ${hintUrl} was unreachable; using reachable service candidate ` +
        `${firstReachableServiceCandidate}`,
    );
    return firstReachableServiceCandidate;
  }

  note(`[signup-url] no conventional signup path resolved for ${hintUrl}`);
  return null;
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

  // Signal 0 — a strong post-login URL path. An onboarding /
  // getting-started / welcome route is only reachable AFTER you're
  // authenticated (you cannot see a "you're all set, next steps" wizard
  // without a session), so the URL alone is conclusive here — unlike the
  // weaker dashboard paths in Signal 3, no paired creation-CTA is needed.
  // last9 lands the bot on /v2/organizations/<slug>/getting-started with
  // its Google session already active; its buttons ("Choose your region",
  // "You're all set! Next steps", "Upgrade Plan") matched none of the CTA
  // vocabularies below, so it used to bail `oauth_required` — claiming
  // "only OAuth/SSO signup, no email/password form" while the bot was in
  // fact fully signed in. The precondition above already ruled out a
  // signup chooser (no credential input).
  // ...UNLESS the page still presents a signup/OAuth chooser (a
  // "Continue with Google" button or a bare "Sign up"/"Log in"). Some
  // services route the login chooser through an /onboarding-style URL; if
  // a provider button is visible, the bot must OAuth via it, not treat the
  // page as already-authenticated. (PostHog TS-1923.)
  const hasSignupAffordance = inventory.some((e) => {
    const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    return (
      /\b(?:continue with|sign ?up with|sign ?in with|log ?in with|with (?:google|github|gitlab|microsoft|apple))\b/.test(
        t,
      ) || /^(?:sign ?up|sign ?in|log ?in|create (?:an )?account)$/.test(t)
    );
  });
  try {
    if (
      !hasSignupAffordance &&
      /\/(?:getting-started|get-started|onboarding|welcome)(?:\/|$)/i.test(
        new URL(url).pathname,
      )
    ) {
      return true;
    }
  } catch {
    // malformed URL — fall through to the other signals
  }

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
  if (
    !hasSignupAffordance &&
    inventory.some((e) => BILLING.test(visibleTextOf(e)))
  ) {
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
    // rc.37 — widened the dashboard-path allowlist after the rc.35
    // sweep showed Upstash's post-OAuth landing was /redis (the
    // product-segment route, not a generic /dashboard). Added
    // /redis, /kafka, /vector, /cluster, /databases?, /instances?,
    // /apps?, /deployments?, /services? — all common product-name
    // routes that almost always indicate authenticated state.
    // An /organizations/<…> or /orgs/<…> prefix is an authenticated-only
    // marker: a logged-OUT visitor never has an organization-scoped route.
    // pinecone's post-OAuth plan-chooser sits at
    // app.pinecone.io/organizations/registration — the trailing
    // "registration" tripped the register-exclusion below and the bot, fully
    // signed in via the operator's existing Google-linked account, bailed
    // no_signup_link instead of routing to key-extraction (MEASURED
    // 2026-06-11: pinecone account was created May 25, so every later run
    // lands here authenticated). An org-prefixed path forces dashboardy and
    // bypasses the auth-route exclusion.
    const hasOrgPrefix = /\/(?:organizations?|orgs?)\//i.test(parsed.pathname);
    dashboardyPath =
      hasOrgPrefix ||
      (/\/(?:new|dashboard|projects?|account|settings|workspace|home|redis|kafka|vector|cluster|databases?|instances?|apps?|deployments?|services?|onboarding|welcome|getting-started|get-started|setup)(?:\/|$)/i.test(
        parsed.pathname,
      ) && !/\/(?:signup|sign-up|register|login|sign-in|signin)/i.test(parsed.pathname));
  } catch {
    // Malformed URL — skip URL signal.
  }
  if (dashboardyPath) {
    // rc.37 — widened the creation-CTA vocabulary to include the
    // dashboard-y "Create <product-noun>" pattern. Upstash's
    // dashboard CTA reads "Create Database"; Convex / Neon /
    // PlanetScale / similar all use this shape ("Create cluster",
    // "Create instance", "Create deployment"). Without this the
    // bot's F17 already-signed-in path fell through to form-fill
    // and the planner clicked the CTA thinking it was a signup
    // submit button.
    const CREATION_CTA =
      /^\s*(?:\+\s*)?(?:new\s+(?:project|workspace|team|app|site|deployment|api\s*key|database|cluster|instance|service)|create(?:\s+(?:new|a|project|workspace|database|cluster|instance|deployment|app|service|index|environment))?)/i;
    if (
      inventory.some((e) => {
        const t = e.visibleText ?? e.ariaLabel ?? "";
        return CREATION_CTA.test(t.trim());
      })
    ) {
      return true;
    }

    // 0.8.2-rc.5 — PostHog-class onboarding wizard. When the URL is
    // dashboard-y (path like /project/<id>/onboarding) and the page
    // shows project-picker / account-menu / onboarding-skip
    // affordances WITHOUT a credential input or OAuth provider button,
    // the user is authenticated and the wizard is interstitial. The
    // rc.3 overnight run for posthog landed exactly here and bailed
    // `oauth_required` because the inventory had only:
    //   - "Default project" (project picker)
    //   - "BBento" (account avatar toggle)
    //   - "Hand off setup" (skip-onboarding affordance)
    //
    // Detect this shape via a second-tier signal set. Conservative —
    // we already gated on "no credential inputs" and "dashboardyPath",
    // so a true signup chooser (which has neither of those AND the
    // path is /signup or /login) cannot reach this branch.
    const POST_AUTH_AFFORDANCE =
      /^\s*(?:hand\s*off\s*setup|skip\s*(?:onboarding|setup|for\s*now)|invite\s*(?:teammates|members|your\s*team)|set\s*up\s*billing|finish\s*setup|get\s*started|continue\s*to\s*(?:dashboard|app|console))\s*$/i;
    // Workspace / project / org picker shape. We pattern-match
    // generously because PostHog's reads "Default project" but other
    // SaaS dashboards read "My workspace" / "Acme org" / similar. The
    // structural cue is "button with one of the workspace-noun words"
    // — see TS-1923 (PostHog rc.3 regression).
    const WORKSPACE_PICKER =
      /\b(?:workspace|workspaces|project(?:s)?|organization|organizations|team(?:s)?)\b/i;
    const hasPostAuthAffordance = inventory.some((e) =>
      POST_AUTH_AFFORDANCE.test((e.visibleText ?? e.ariaLabel ?? "").trim()),
    );
    if (hasPostAuthAffordance) {
      // Single signal — the skip-onboarding / handoff verb is strong
      // enough on its own. No login page ever offers "Hand off setup".
      return true;
    }
    // Weaker pair: a workspace-picker shape AND the page lacks a
    // primary call-to-action that reads as signup ("Continue with
    // Google", "Sign up", etc.). Used as a backstop for SPA dashboards
    // whose only visible buttons are picker toggles.
    const hasWorkspacePicker = inventory.some((e) =>
      WORKSPACE_PICKER.test((e.visibleText ?? e.ariaLabel ?? "").trim()),
    );
    const hasSignupOrOAuthAffordance = inventory.some((e) => {
      const t = (e.visibleText ?? e.ariaLabel ?? "").trim();
      return /\b(?:sign[\s-]*up|signup|continue\s+with|log\s+in\s+with|sign\s+in\s+with)\b/i.test(
        t,
      );
    });
    if (hasWorkspacePicker && !hasSignupOrOAuthAffordance) {
      return true;
    }
    // 0.8.3-rc.1 — onboarding-wizard step shape. When the URL clearly
    // names an onboarding path (/onboarding, /welcome, /getting-started,
    // /setup) AND the page has a Next/Continue/Skip/Submit button AND
    // does NOT have any credential input (caught above) AND does NOT
    // have a Sign-up/Continue-with affordance (i.e. it's not a CHOICE
    // between login and signup), the page is mid-onboarding for an
    // already-authenticated user. Mixpanel hits this when a previous
    // run created the account but didn't finish the multi-step
    // onboarding — the bot returns and lands directly on /onboarding.
    let onboardingPath = false;
    try {
      onboardingPath =
        /\/(?:onboarding|welcome|getting-started|get-started|setup)(?:\/|$)/i.test(
          new URL(url).pathname,
        );
    } catch {
      // Malformed URL — skip
    }
    if (onboardingPath && !hasSignupOrOAuthAffordance) {
      const WIZARD_STEP_BTN =
        /^\s*(?:next|continue|submit|skip(?:\s+for\s+now)?|finish|done)\s*$/i;
      const hasWizardStepButton = inventory.some((e) => {
        const t = (e.visibleText ?? e.ariaLabel ?? "").trim();
        return WIZARD_STEP_BTN.test(t);
      });
      if (hasWizardStepButton) return true;
    }
  }

  return false;
}

// rc.39 — companion to detectAlreadySignedIn for the form-fill stage.
// The URL-based dashboard check above conservatively excludes /sign-up,
// /signup, /register paths — but services like PlanetScale and Turso
// serve a logged-in create-database / billing-wall form at /sign-up
// when the user has an active session. The form-fill planner reliably
// describes what it sees: "create the database on this PS-5 plan",
// "Add credit card", "database name". Match those phrases in the
// planner's notes and action reasons to pivot to post-verify instead
// of fooling the form-fill loop into clicking a "create database"
// button it mistakes for a signup submit.
//
// Patterns are intentionally conservative — they must mention an
// authenticated-state product/billing noun, not just any verb. A
// regular signup form's planner output ("name field", "submit
// button") shouldn't match.
export function detectFormFillIsDashboard(plan: {
  readonly notes?: string;
  readonly actions: readonly { readonly reason: string }[];
}): boolean {
  const haystack = [
    plan.notes ?? "",
    ...plan.actions.map((a) => a.reason ?? ""),
  ]
    .join(" ")
    .toLowerCase();

  // Billing / payment wall — the planner sees a credit-card / billing
  // form, which is never a signup form. (Checked first: a "free trial"
  // page that ALSO demands a card is a wall, not a path to signup.)
  const BILLING_WALL =
    /\b(?:add (?:a )?(?:credit card|payment method)|enter (?:your )?(?:credit card|payment)|billing (?:information|details)|payment information required)\b/;
  if (BILLING_WALL.test(haystack)) return true;

  // Negative guard — a LOGIN / SIGN-IN page (pre-auth), or a plan that
  // proposes navigating TO a signup/trial form, is the OPPOSITE of a
  // logged-in dashboard. MEASURED 2026-06-09: fathom's planner correctly
  // said "this is a login page, NOT a signup page; click 'Start a free
  // trial' to reach the actual signup form" — pivoting to key extraction
  // there is wrong (we're not authenticated; the key page 404s). The
  // bot must EXECUTE the planner's click toward signup. Runs before the
  // ambiguous "not a signup" check below so it can't be swallowed.
  const REACH_SIGNUP =
    /\blog[\s-]?in page|sign[\s-]?in page|free trial|start a (?:free )?trial|create an? account|navigate to the (?:actual )?sign-?up/;
  if (REACH_SIGNUP.test(haystack)) return false;

  // Product-creation form — the planner describes creating a
  // database / cluster / instance / deployment / app / project /
  // workspace / service, which is post-signup territory.
  const PRODUCT_CREATION =
    /\b(?:create(?:s|d)?|creating|provision(?:s|ed|ing)?)\s+(?:(?:the|a|an|new|your|this)\s+){0,3}(?:database|cluster|instance|deployment|app|service|project|workspace|index|environment|tenant)\b/;
  if (PRODUCT_CREATION.test(haystack)) return true;

  // Explicit "logged in" / "dashboard" statements from the planner. NB:
  // bare "not a signup" is deliberately NOT here — it's ambiguous (a
  // LOGIN page is also "not a signup") and false-pivoted fathom into key
  // extraction. A genuine dashboard says "already signed in" / "logged-in
  // dashboard", which the REACH_SIGNUP guard above doesn't touch.
  const EXPLICIT =
    /\b(?:already\s+(?:signed[\s-]?in|logged[\s-]?in|authenticated)|logged[\s-]?in (?:dashboard|user))\b/;
  if (EXPLICIT.test(haystack)) return true;

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
    // 2. Icon-only (logo) button — named only by a descendant img/svg.
    //    Truly-empty visibleText is the clean case. But a logo button whose
    //    <svg> carries a <title>GitHub</title> LEAKS that title into
    //    textContent (northflank renders "GitHubGitHub" — doubled, which
    //    also defeats the \bgithub\b match in path 3), so it isn't strictly
    //    empty. Treat it as icon-only too WHEN its visible text is nothing
    //    but the provider name (any number of times): strip every keyword
    //    occurrence and require no residue. A nav link like "GitHub's
    //    Privacy Policy" leaves residue and is correctly rejected. The
    //    iconLabel must still independently name the provider, so a stray
    //    one-word label can't false-positive.
    const kw = keyword.toLowerCase();
    const residue = visibleText
      .toLowerCase()
      .split(kw)
      .join("")
      .replace(/[\s·|/–-]+/g, "");
    const isLogoOnly = visibleText.length === 0 || residue.length === 0;
    if (isLogoOnly && keywordRe.test((e.iconLabel ?? "").toLowerCase())) {
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
    // "with <provider>" is the OAuth-button idiom and is accepted
    // directly — it survives an SVG accessible name glued to the verb.
    // elevenlabs renders its button text as "GoogleSign up with Google",
    // which fuses "sign" into "googlesign" so the bare \bsign\b check
    // misses, but "with google" still matches. (A blanket camelCase split
    // can't be used to un-glue it — it would mangle the provider name
    // itself, e.g. "GitHub" → "Git Hub".)
    const withProviderRe = new RegExp(`\\bwith ${keyword}\\b`);
    if (
      /\b(sign|signup|signin|continue|log ?in|connect|auth)\b/.test(text) ||
      withProviderRe.test(text)
    ) {
      return e;
    }
    // rc.39 — minimal-label OAuth buttons. Some auth UIs render the
    // provider as a bare keyword button: just "GitHub" or just "Google"
    // (Turso, several Stytch / Clerk / Auth0 templates). When the
    // VISIBLE text is essentially nothing but the provider keyword,
    // accept it — no auth-verb required. The keyword regex already
    // ensured the provider name is present; the length cap MAX_OAUTH_
    // BUTTON_TEXT_CHARS (60) ensures it's still buttonish, not a
    // paragraph that happens to mention the provider.
    //
    // 0.8.3-rc.1 — reject minimal-label matches whose href points at
    // a NON-AUTH path on the provider's domain (most often a project
    // repo URL like github.com/plausible/analytics in a homepage
    // footer). Without this gate, plausible's footer "GitHub" link
    // matched, the bot clicked it, ended up on the analytics repo's
    // page, and misclassified the README content as a security
    // challenge — burning the entire OAuth budget on a false alarm.
    const stripped = visibleText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (stripped === keyword || stripped === `with ${keyword}`) {
      // When the element is an <a> with a provider-domain href, require
      // it to look like an auth route. Repo / docs / marketing links
      // on the provider's site never start an OAuth flow.
      if (href.length > 0) {
        const providerDomain =
          provider === "github" ? "github.com" : "google.com";
        if (href.includes(providerDomain)) {
          // Accept only if href matches the auth pattern OR points
          // at a login/signup/sessions/oauth path.
          const looksLikeAuthPath =
            hrefRe.test(href) ||
            /github\.com\/(?:login|signin|sign-in|sessions|oauth\/authorize|apps\/[^/]+\/installations\/new|users\/sign_in)/i.test(
              href,
            ) ||
            /accounts\.google\.com\/(?:o\/oauth2|signin)/i.test(href);
          if (!looksLikeAuthPath) continue;
        }
      }
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
  // 0.8.3-rc.1 — Clerk-class post-OAuth supplementary-signup form.
  // Some services (Clerk's dashboard, certain Auth0 templates) handle
  // OAuth identity but ALSO require the user to fill an email +
  // password form (plus often a Cloudflare turnstile) before the
  // account is created. Post-OAuth lands on /sign-up with both the
  // OAuth buttons still visible AND credential inputs. The legacy
  // loop-detect path saw the Google button + the login-shaped URL
  // and looped OAuth indefinitely.
  //
  // When a PASSWORD input is visible alongside (2) an OAuth button for
  // the provider we just used, the page is a genuine hybrid
  // credential-creation form (Clerk/Auth0: email + password [+ turnstile]),
  // not a loop. Return null so the caller falls through to the
  // post-verify flow — its planner drives the form-fill, the captcha
  // gate, and the Continue click the same way the form-fill phase does.
  //
  // A BARE EMAIL field does NOT count: it's the near-universal "or
  // continue with email" magic-link/OTP alternative that sits next to
  // the OAuth buttons on an ordinary login page (groq's /authenticate,
  // northflank's /login, …). Treating that as a hybrid form suppressed
  // the login-loop OAuth retry these services REQUIRE — they finalize
  // the Stytch/WorkOS session only on a second OAuth click — and
  // stranded them at oauth_session_not_persisted. The email-OTP case
  // that genuinely needs the planner is caught separately downstream
  // (detectEmailOtpGate), so narrowing to password here is safe.
  const hasPasswordInput = inventory.some(
    (e) => e.tag === "input" && e.type === "password",
  );
  if (hasPasswordInput) return null;
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
  inventory?: readonly InteractiveElement[],
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
  if (inventory !== undefined && !hasOtpInput(inventory)) {
    return false;
  }
  return (
    /we sent[^.]{0,60}\bcode\b[^.]{0,40}to\b/.test(lower) ||
    /enter[^.]{0,40}\bcode\b[^.]{0,40}\b(?:sent|email)/.test(lower)
  );
}

function hasOtpInput(inventory: readonly InteractiveElement[]): boolean {
  return inventory.some((e) => {
    if (e.tag !== "input" && e.tag !== "textarea") return false;
    const text = [
      e.type,
      e.id,
      e.name,
      e.placeholder,
      e.ariaLabel,
      e.labelText,
      e.visibleText,
      e.testId,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ")
      .toLowerCase();
    return /\b(?:otp|code|verification|verify|one[\s-]?time|pin)\b/.test(text);
  });
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

// Google-OAuth-is-LOGIN-ONLY (plunk class). Some services accept Google
// only to log an EXISTING account in; they do NOT auto-provision a new
// account for a first-time Google identity. The OAuth handshake
// completes, then the service bounces back to its login page with an
// explicit "no account" message — e.g. plunk lands on
// `…/auth/login?message=No%20account%20found%20for%20this%20Google%20account`.
//
// WHY a dedicated detector: this state otherwise trips
// detectManualLoginFallback (it IS a /login form) and aborts as
// `oauth_session_not_persisted` — misleading, because nothing dropped
// the session; the account simply was never created. The correct
// recovery is to abandon OAuth and create the account via the
// email/password form. Caller re-routes to form-fill on a true return.
//
// Conservative by design: matches the URL query AND body text against
// CLEAR no-account / must-sign-up phrasing. A normal consent page or a
// post-login dashboard (which never carries these phrases) must NOT
// match, or we'd wrongly abandon a working OAuth session.
export function detectGoogleNoAccount(url: string, bodyText: string): boolean {
  // Inspect the decoded query string (where plunk parks its message) and
  // the URL path (to decide whether a BODY match is trustworthy).
  let query = "";
  let path = "";
  let urlParsed = false;
  try {
    const u = new URL(url);
    query = decodeURIComponent(u.search).toLowerCase();
    path = u.pathname.toLowerCase();
    urlParsed = true;
  } catch {
    query = "";
    path = "";
  }
  // MEASURED 2026-06-04 (clerk): after Google OAuth, clerk bounces to its
  // sign-in showing "The External Account was not found" — Google signed
  // in but no clerk account exists for this identity (same class as plunk's
  // "No account found").
  const noAccountPhrase =
    /no account found|external account was not found|account (?:was )?not found|no (?:such )?account (?:found|exists)|account (?:doesn['’]?t|does not) exist|couldn['’]?t find (?:an|your) account|no account associated|sign up (?:first|to continue)|create an account|[?&]google-auth-error|register first/;
  // The QUERY string is an unambiguous auth-error redirect param (plunk parks
  // its message there; some services use ?google-auth-error) — trust it
  // anywhere.
  if (noAccountPhrase.test(query)) return true;
  // The BODY phrases ("create an account", "register first", "sign up to
  // continue", …) ALSO appear as generic CTAs/links on a LOGGED-IN dashboard.
  // MEASURED 2026-06-09 (together): after a successful Google sign-in the bot
  // landed on the app root "/", whose body carried such a CTA — and the old
  // body match abandoned the working session and dead-ended at oauth_required.
  // A genuine "no account for this identity" message only renders on a
  // login/sign-in/auth ROUTE, so only honor a body match there. On a dashboard
  // or app route we keep the session and let post-OAuth navigation extract.
  // If the URL couldn't be parsed at all, we have no route context to gate on
  // — fall back to trusting the body (rare, and the phrases are strong).
  const onAuthRoute =
    /(?:^|\/)(?:login|signin|sign-in|sign-up|signup|auth|authenticate|sso)(?:\/|$)/.test(
      path,
    );
  if (urlParsed && !onAuthRoute) return false;
  return noAccountPhrase.test(bodyText.toLowerCase());
}

// (d) Stuck-on-Google-OAuth-screens (Upstash class). After
// settleAfterOAuth the URL is STILL on accounts.google.com — the
// handshake didn't redirect through to the service. Most common
// shape: Clerk-mediated OAuth (Upstash's auth.upstash.com → Google
// account chooser) where the chooser uses a clickable card the
// post-verify planner can't reliably target, and the bot loops
// trying. Defining trait: hostname accounts.google.com (or
// accounts.googleusercontent.com) at the post-OAuth gate.
// Is this URL on an OAuth PROVIDER's own domain (github.com, accounts.google.com,
// gitlab.com, …)? Such a URL is mid-handshake — its `/login/oauth/authorize`
// path reads as a "login route", but navigating to the provider's ROOT abandons
// the handshake on the provider's domain instead of returning to the service
// (MEASURED 2026-06-11: typesense's GitHub OAuth landed on
// github.com/login/oauth/authorize and the dead-route escape navigated to
// github.com/, breaking the flow). The dead-route escape must skip these.
export function isOAuthProviderHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "github.com" ||
      h === "gitlab.com" ||
      h === "bitbucket.org" ||
      h === "accounts.google.com" ||
      h === "accounts.googleusercontent.com" ||
      h.endsWith(".accounts.google.com") ||
      h === "login.microsoftonline.com" ||
      h === "appleid.apple.com"
    );
  } catch {
    return false;
  }
}

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

// Is the current URL an OAuth/SSO CALLBACK route — the redirect target
// where the SPA exchanges the provider code for a session? MEASURED
// 2026-06-04: clerk's `/sign-in/sso-callback` does a token exchange that
// renders even slower than its already-slow dashboard (~15s over the
// residential proxy). On a callback route the SPA IS making progress, so
// the post-verify hydration loop grants it a larger budget; on every
// other route the smaller budget holds (a never-hydrating page must not
// burn the run cap). Matches on the pathname only (PSL-safe via URL parse,
// try/catch → false for non-URLs).
export function isOAuthCallbackRoute(url: string): boolean {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return /\/sso-callback|\/oauth\/callback|\/auth\/callback|\/callback(?:\/|$)|\/login\/callback/i.test(
    pathname,
  );
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

// A page can gate the real login UI behind a generic "Sign In to
// Continue" interstitial that renders NO provider affordance yet —
// Qdrant's session-expiry flow redirects to /logout?aerr=expired whose
// only element is a "Sign In to Continue" button; the Google button
// lives one click deeper. The OAuth-first scan finds no provider
// affordance and was bailing `oauth_required` without ever advancing.
// This finds a generic sign-in-ish button to CLICK so the next scan can
// see the provider buttons. Strictly gated on sign-in vocabulary so we
// never click an arbitrary CTA: a bare "Continue" / "Get started" /
// "Go to Dashboard" / 404-recovery / "Join Workspace" button does NOT
// match — only text that explicitly reads as advancing into a login.
// Caller bounds the number of click-throughs. Returns null when no such
// affordance exists (the page is then either genuinely SSO-only, a 404,
// or already authenticated). Exported for unit testing.
const SIGN_IN_ADVANCE_RE =
  /\b(?:sign[\s-]?in|log[\s-]?in|continue with email|continue to (?:sign|log)|get started)\b/i;
export function findSignInAdvanceButton(
  inventory: readonly InteractiveElement[],
  providers: readonly OAuthProviderId[],
): InteractiveElement | null {
  // If a provider affordance is already present, advancing is pointless
  // — the caller would have taken the OAuth path. Guard so a page that
  // has both (e.g. a "Sign in" header link + "Continue with Google")
  // never routes through this click-through path.
  if (findFirstOAuthButton(inventory, providers) !== null) return null;
  for (const e of inventory) {
    const isButtonish =
      e.tag === "button" ||
      e.tag === "a" ||
      e.role === "button" ||
      e.type === "submit" ||
      e.type === "button";
    if (!isButtonish) continue;
    const text = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`
      .replace(/\s+/g, " ")
      .trim();
    // Sanity-cap: a real sign-in button is short. A long string is a
    // paragraph / card that happens to contain "sign in".
    if (text.length === 0 || text.length > MAX_OAUTH_BUTTON_TEXT_CHARS) continue;
    if (SIGN_IN_ADVANCE_RE.test(text)) return e;
  }
  return null;
}

// Order the OAuth providers the bot may use for a signup, given the
// service's yaml pin (if any) and the providers the persistent profile
// actually has a session for. `findFirstOAuthButton` walks this list in
// order and uses the first provider the PAGE offers, so order = preference.
//
// RULE 1 — an explicit pin is an override. The queue uses oauth_provider to
// test or force a known-good route; silently promoting Google over a pinned
// GitHub path makes service-level fixes impossible to reason about.
//
// RULE 2 — with no explicit pin, auto-prefer warm Google, then other warm
// providers. Google usually blocks less hard, but that is only a default, not
// an override of service metadata.
export function orderOAuthCandidates(
  pinned: OAuthProviderId | undefined,
  loggedIn: readonly OAuthProviderId[],
): OAuthProviderId[] {
  if (pinned !== undefined) {
    if (loggedIn.includes(pinned)) return [pinned, ...loggedIn.filter((p) => p !== pinned)];
    return [pinned];
  }
  if (loggedIn.includes("google")) {
    return ["google", ...loggedIn.filter((p) => p !== "google")];
  }
  return [...loggedIn];
}

export function defaultOAuthProviderForService(service: string): OAuthProviderId | undefined {
  void service;
  return undefined;
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
  // `.` is in the class: many tokens are dot-separated (Zerops
  // `LhJbaP.VeODh3ZZ…`, GitLab PATs, JWTs, Slack `xox*`); excluding it
  // dropped every dotted token to null and looped to run_timeout
  // (MEASURED 2026-06-12: zerops). `+/=` are in too: some services mint
  // BASE64-encoded keys (portkey, MEASURED 2026-06-17: `tdCwXd/8kp4…` — the
  // `/` truncated capture to `tdCwXd` (<10) → null → 24-round loop to
  // run_timeout despite the key being on the page). The verbatim
  // pageText.includes guard below keeps a sentence's trailing period — or a
  // stray path/URL fragment — from matching anything not actually on the page.
  const matches = reason.matchAll(/['"`]([A-Za-z0-9_.+/=\-]{10,80})['"`]/g);
  for (const m of matches) {
    const candidate = m[1];
    if (candidate === undefined) continue;
    if (pageText.includes(candidate)) return candidate;
  }
  // rc.36 — unquoted UUID fallback. Upstash's API key dialog shows a
  // bare UUID (`b7dd0ff0-2497-4dc8-a793-8261a38e0339`) and the
  // planner quotes it WITHOUT surrounding quote marks ("The full API
  // key b7dd0ff0-… is visible"). The verbatim-in-page check is the
  // safety net — random UUIDs sprinkled across dashboards (trace IDs,
  // project IDs) only false-positive if the SAME UUID appears in the
  // planner's reason. Keyword guard ('api key' / 'token' / 'secret'
  // / 'credential' within 50 chars of the UUID) keeps unrelated
  // UUIDs (project IDs, member IDs in a sidebar) from matching.
  const uuidRe =
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  const keywordRe =
    /\b(?:api[\s_-]?(?:key|token)|access[\s_-]?token|secret|credential)\b/i;
  for (const m of reason.matchAll(uuidRe)) {
    const candidate = m[1] ?? m[0];
    if (!pageText.includes(candidate)) continue;
    const start = Math.max(0, m.index - 50);
    const end = Math.min(reason.length, m.index + candidate.length + 50);
    const window = reason.slice(start, end);
    if (keywordRe.test(window)) return candidate;
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
    // Plunk is the EXCEPTION: its API key is `pk_<hex>` (e.g.
    // pk_e063df9b5…) and IS the user's credential, shown in plaintext on
    // the dashboard under an "API Key" label. The pure-hex body after the
    // prefix distinguishes it from Stripe publishable keys (pk_live_/
    // pk_test_ — a "live"/"test" segment, not hex), so this can't re-open
    // the embedded-public-key false-positive the note above warns about.
    /\bpk_[a-f0-9]{24,}\b/, // Plunk (hex public/API key — NOT Stripe pk_live_/pk_test_)
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
    // 0.8.3-rc.1 — typeform personal access tokens. Shape
    // `tfp_<alnum-with-underscore>` length 40-80. Surfaced during the
    // 2026-05-29 retest where the planner SAW the token (quoted in
    // reason) but no regex matched, so extractCredentials returned
    // null and the bot bailed `oauth_onboarding_failed`.
    /\btfp_[A-Za-z0-9_]{40,80}\b/, // Typeform
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
    // Baseten: `<6-12 alnum>.<30+ alnum>`. The dot separator + length
    // bounds on both sides distinguish it from version strings (too
    // short on either side). rc.35 — relaxed the prefix to mixed-case
    // after the rc.33 broad sweep showed a Baseten key whose prefix
    // had uppercase letters: `HP9tFTtm.txDl4vv7ayYsTwx9dQea47ylRdN4Brk3`.
    /\b[A-Za-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/, // Baseten
    // Qdrant Cloud: `<UUID>|<55-char opaque>` — a literal pipe between
    // a key id and the secret body. Unique enough that no false-
    // positive guard is needed.
    //
    // rc.34/rc.36 — extended the secret-body character class to
    // include underscore + hyphen. rc.35 broad sweep surfaced
    // another Qdrant shape with mid-body hyphens:
    // `<UUID>|e8L7oyi-5fHa327u7x-IQN6WivtPlpIVjT-giIsrXDZW7P-8i2G9Pw`.
    // [A-Za-z0-9_-] covers both observed shapes; the {30,80} length
    // bound + UUID prefix keep false-positive risk near zero.
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9_\-]{30,80}\b/i, // Qdrant
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

// Password-manager / autofill UI affordances that render as short
// word-tokens on credential pages. A render API-keys page ships a
// "Save to 1Password" / "1Password" autofill button next to the real
// `rnd_…` key; LastPass, Bitwarden, and Dashlane do the same. These
// strings are alphanumeric, often carry a digit ("1Password"), and sit
// EARLIER in DOM order than the credential — so the validator-blind
// candidate-scan tiers (replay-skill.ts) used to return them as the
// "credential" and the downstream length validator then rejected them
// (the 0DTW2V66 render skill: `got="1Password" length 9 below min 32`).
// They are never credentials; reject them at the candidate layer so the
// scan moves on to the real key instead of the right key being shadowed
// by a UI word. Matched case-insensitively as a whole token (the
// candidates the scan tiers feed in are already whitespace-trimmed
// single tokens). Exported for unit testing.
const CREDENTIAL_NOISE_TOKENS: readonly string[] = [
  "1password",
  "lastpass",
  "bitwarden",
  "dashlane",
  "keepass",
  "keeper",
  "nordpass",
  "proton pass",
  "protonpass",
  "autofill",
  "passwords",
  // Cookie-consent widget vocabulary (CookieScript/OneTrust-class banners
  // render these as checkbox values and category labels on EVERY page,
  // earlier in DOM order than any credential — zilliz's banner fed
  // "personalization" to the validator-shaped scan tier as the "key").
  // Whole-token equality with a generic English word is never a real
  // credential, so rejecting these costs nothing.
  "necessary",
  "analytics",
  "personalization",
  "personalisation",
  "advertising",
  "advertisement",
  "marketing",
  "functional",
  "preferences",
  "statistics",
  "performance",
  "targeting",
  "unclassified",
  "security",
];

// Verb-prefixed UI affordances ("Save to 1Password", "Copy to
// clipboard", "Add to vault"). The candidate-scan tiers tokenize on
// whitespace so a multi-word affordance rarely survives as one
// candidate — but extractText()/innerText passes glue it together, so
// guard the leading verbs too.
const CREDENTIAL_NOISE_PREFIXES: readonly string[] = [
  "save to ",
  "copy to ",
  "add to ",
  "store in ",
];

// True when a candidate string is a password-manager / autofill UI
// affordance rather than a real credential value. Used by the replay
// engine's raw-candidate scan tiers to keep "1Password"-class words
// out of the credential slot. Exported for unit testing.
export function isCredentialNoiseCandidate(candidate: string): boolean {
  const lower = candidate.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (CREDENTIAL_NOISE_TOKENS.includes(lower)) return true;
  return CREDENTIAL_NOISE_PREFIXES.some((p) => lower.startsWith(p));
}

// True when a URL is a documentation / help / reference page rather than a
// product surface. Such pages render REALISTIC sample credentials (Anthropic's
// platform.claude.com/docs/.../get-started shows ANTHROPIC_API_KEY='sk-ant-
// api03-...') that match the real key shape but are NOT user credentials. A
// real minted key lives on the console / settings, never under /docs — so the
// extractor refuses to read a credential while on a docs page, which keeps the
// post-verify loop navigating toward the real keys page instead of false-
// succeeding on a sample. Exported for unit testing.
export function isDocumentationUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    /^https?:\/\/docs?\.[^/]+/.test(u) || // docs.x.com / doc.x.com host
    /\/docs?\//.test(u) || // /docs/ or /doc/ path
    /\/(?:help|reference|api-reference|guides?|tutorials?)\//.test(u)
  );
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
    if (isEmailAssetLink(lower)) score -= 50;
    if (lower.includes("verify") || lower.includes("confirm")) score += 10;
    if (lower.includes("activate")) score += 8;
    if (lower.includes("welcome")) score += 3;
    if (lower.includes("unsubscribe") || lower.includes("preferences")) score -= 10;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top !== undefined && top.score > 0
    ? top.url.replace(/&amp;/gi, "&")
    : null;
}

function isEmailAssetLink(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.replace(/&amp;/g, "&"));
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    return (
      /\.(?:png|jpe?g|gif|webp|svg|ico|css|woff2?|ttf|otf)(?:$|[?#])/.test(path) ||
      /^(?:static|cdn|assets|images|img|media)\./.test(host) ||
      /\/(?:static|assets|images|img|media)\//.test(path)
    );
  } catch {
    return false;
  }
}

// Pick a verification link by its ANCHOR TEXT in the email HTML — the fallback
// when pickVerificationLink (which scores the URL) fails because the link is
// wrapped in a click-tracker that hides the keyword behind a redirect. MEASURED
// on amplitude (2026-06-04): its "Activate account" link is a
// u…ct.sendgrid.net/ls/click?upn=… URL (no "activate" in the URL), so the
// URL scorer returned null and the bot fell to a false-positive "code" (the
// year "2025"). The anchor TEXT still reads "Activate account". Pure + exported
// for unit tests.
export function pickVerificationLinkFromHtml(bodyHtml: string): string | null {
  const anchorRe = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let best: { url: string; score: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(bodyHtml)) !== null) {
    const href = (m[2] ?? "").replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(href)) continue;
    const text = (m[3] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    let score = 0;
    if (/\b(?:verify|confirm|activate)\b/.test(text)) score += 10;
    if (
      /verify (?:your )?email|confirm (?:your )?email|activate (?:your )?account|complete (?:your )?sign[\s-]?up/.test(
        text,
      )
    ) {
      score += 5;
    }
    if (
      /confirmation instructions|confirm (?:my |your )?account|confirm (?:my |your )?email address|verify (?:my |your )?account|accept confirmation/.test(
        text,
      )
    ) {
      score += 8;
    }
    if (/get started|finish setting up|continue|open stackblitz/.test(text)) score += 3;
    try {
      const u = new URL(href);
      if ((u.pathname === "/" || u.pathname === "") && u.search === "" && u.hash === "") {
        score -= 8;
      }
    } catch {
      /* already validated as http(s), leave score unchanged */
    }
    if (
      /unsubscribe|preferences|manage|view (?:in|this) (?:browser|email)|privacy|terms/.test(
        text,
      )
    ) {
      score -= 10;
    }
    if (score > (best?.score ?? 0)) best = { url: href, score };
  }
  return best !== null && best.score > 0 ? best.url : null;
}

// Last-resort verification-link pick: a link in the email that points at the
// SERVICE's OWN domain. MEASURED on arize (2026-06-17): the confirm email says
// "Click the link in the email", but its confirm link is a click-tracker the
// keyword scorers miss, and a spurious number in the body got read as a code →
// the bot entered a code on a page with no code field and stalled. A same-
// registrable-domain link in a signup email is almost always the confirmation,
// so follow it when the keyword scorers came up empty. Skips obvious non-confirm
// links (unsubscribe/preferences/privacy/terms/social). Exported for unit tests.
export function pickServiceDomainLink(
  links: readonly string[],
  serviceHost: string | null,
): string | null {
  if (serviceHost === null || serviceHost.length === 0) return null;
  // Compare the last two labels so app.arize.com matches arize.com.
  const base = (h: string): string =>
    h.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
  const target = base(serviceHost);
  const SKIP =
    /unsubscribe|preferences|email[_-]?settings|\bmanage\b|privacy|\bterms\b|twitter|linkedin|facebook|instagram|youtube|status\.|\/help\b|\/support\b|\/docs\b/i;
  for (const raw of links) {
    let u: URL;
    try {
      u = new URL(raw.replace(/&amp;/g, "&"));
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if ((u.pathname === "/" || u.pathname === "") && u.search === "" && u.hash === "") continue;
    if (SKIP.test(raw)) continue;
    if (isEmailAssetLink(raw)) continue;
    if (base(u.hostname) === target) return u.href;
  }
  return null;
}

// Last-resort verification-CODE extraction from an email body, for the
// passwordless "we emailed you a code" flow (axiom: "Axiom sign-in
// verification code") when the inbox parser's parsed_codes came back empty.
// Without this the bot bailed "no usable verification link" on a code-only
// email — treating a routine code flow as a dead end. Conservative: prefers a
// 4-8 digit run next to a code/verify keyword, then a space/dash-grouped code,
// then a standalone 6-digit number (the most common verification length).
// Returns null when nothing code-shaped is found so the caller still bails
// honestly rather than typing garbage. Exported for unit testing.
export function extractCodeFromEmailBody(
  email: {
    subject: string;
    body_text?: string | null;
    body_html?: string | null;
  },
  // The recipient address, when known. Verification emails routinely echo
  // the recipient ("sent to sandra.young487@…"); if its local part carries
  // digits they can be mistaken for the code. Strip the address out before
  // scanning so a human-looking alias never poisons the extraction.
  recipient?: string,
): string | null {
  let text = [
    email.subject ?? "",
    email.body_text ?? "",
    (email.body_html ?? "").replace(/<[^>]+>/g, " "),
  ].join("\n");
  if (recipient !== undefined && recipient.length > 0) {
    text = text.split(recipient).join(" ");
    const local = recipient.split("@")[0];
    if (local !== undefined && local.length > 0) text = text.split(local).join(" ");
  }
  // 1) A code sitting next to a verification keyword — the strongest signal.
  const kw = text.match(
    /(?:verification code|sign[\s-]?in code|one[\s-]?time(?:\s+(?:code|password))?|security code|your code|confirmation code|code is|enter(?:\s+this)?\s+code)\b[^0-9]{0,40}([0-9]{4,8})\b/i,
  );
  if (kw?.[1] !== undefined) return kw[1];
  // 2) A grouped code ("123-456" / "1234 5678").
  const grouped = text.match(/(?<![0-9])([0-9]{3,4}[ -][0-9]{3,4})(?![0-9])/);
  if (grouped?.[1] !== undefined) return grouped[1].replace(/[ -]/g, "");
  // 3) A standalone 6-digit number (most verification codes).
  const six = text.match(/(?<![0-9])([0-9]{6})(?![0-9])/);
  if (six?.[1] !== undefined) return six[1];
  return null;
}

// True when the page is an email verification-CODE entry gate: a single
// code-style input (name/id/placeholder/label ~ code/token/otp/verification),
// NO email/password/tel field still to fill, and verify/code copy in the body.
// axiom-class passwordless ("Send Code to Email" lands here). Distinct from the
// no-fields verification WALL: this page HAS an input, but it's a CODE field,
// so the form-fill planner would otherwise type an empty literal into it and
// loop. The caller returns "submitted" to route to the inbox-poll + code-entry
// path (the code was emailed to our alias). Exported for unit testing.
export function isVerificationCodeGate(
  inventory: readonly InteractiveElement[],
  pageText: string,
): boolean {
  const inputs = inventory.filter((e) => e.tag === "input" && e.visible !== false);
  // Any email/password/tel field still present → still a signup form, not a
  // pure code gate.
  if (
    inputs.some((e) => e.type === "email" || e.type === "password" || e.type === "tel")
  ) {
    return false;
  }
  const codeRe = /\b(?:code|token|otp|verification|verify|one[\s-]?time|2fa|mfa)\b/i;
  const hasCodeInput = inputs.some((e) => {
    const hay = `${e.name ?? ""} ${e.id ?? ""} ${e.placeholder ?? ""} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`;
    return codeRe.test(hay);
  });
  if (!hasCodeInput) return false;
  const t = pageText.toLowerCase();
  return /verification code|enter (?:the |your )?code|code is required|verify and continue|we (?:sent|emailed)|check your email|one[\s-]?time (?:code|password)|sign[\s-]?in code/.test(
    t,
  );
}

// Discriminates LLMPair from LLMClient. LLMPair has `primary` (an
// LLMClient); LLMClient has `createMessage`. They're mutually exclusive
// shapes so a structural check is reliable.
function isLLMPair(x: LLMClient | LLMPair): x is LLMPair {
  return "primary" in x && typeof x.primary === "object" && x.primary !== null;
}

// True when the last `threshold` executed ACTIONS (click/select/check/
// fill — steps meant to mutate the page) each left the page content
// UNCHANGED. That is the signature of a broken onboarding wizard that
// re-presents itself no matter what the bot clicks (the axiom case,
// measured 2026-06-03): the planner keeps correctly reacting to a
// visibly-unfilled form, but the click never registers, so without this
// the run burns all 24 rounds + LLM budget re-clicking the same card.
// Navigates / waits / extracts are excluded — they legitimately don't
// change the current DOM (navigate changes URL, wait pauses). Pure +
// exported for unit tests.
// Pick the onboarding field to overwrite with a unique value when a "name
// taken" collision stalls the wizard. Prefer a business/org/workspace NAME
// field (which commonly drives a derived subdomain — editing the domain
// directly gets re-derived away), falling back to a bare subdomain/slug field.
// Returns null when no such field is present (then the stall is a genuine
// click-not-registering case, not a name collision). Exported for tests.
export function pickUniqueNameField(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  const textInputs = inventory.filter(
    (e) => e.tag === "input" && (e.type === null || e.type === "text"),
  );
  const hay = (e: InteractiveElement): string =>
    `${e.name ?? ""} ${e.id ?? ""} ${e.placeholder ?? ""} ${e.labelText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
  const NAME_RE =
    /business[_ -]?name|company[_ -]?name|organi[sz]ation|\borg\b|workspace[_ -]?name|team[_ -]?name|account[_ -]?name|site[_ -]?name|project[_ -]?name|tenant/;
  const byName = textInputs.find((e) => NAME_RE.test(hay(e)));
  if (byName !== undefined) return byName;
  const DOMAIN_RE = /subdomain|\bdomain\b|\bslug\b|workspace[_ ]?url|handle/;
  const byDomain = textInputs.find((e) => DOMAIN_RE.test(hay(e)));
  return byDomain ?? null;
}

// Pick the submit/advance control for an onboarding form. Matches a
// type=submit button or the conventional advance verbs. Returns null when no
// obvious submit affordance is present.
export function pickOnboardingSubmit(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  const buttons = inventory.filter((e) => e.tag === "button" || e.role === "button");
  const ADVANCE_RE = /^(?:next|continue|submit|create|register|get started|finish|done|save)\b/i;
  const byText = buttons.find((e) => ADVANCE_RE.test((e.visibleText ?? e.ariaLabel ?? "").trim()));
  if (byText !== undefined) return byText;
  const bySubmit = buttons.find((e) => e.type === "submit");
  return bySubmit ?? buttons[0] ?? null;
}

export function pickOnboardingLeafChoice(
  inventory: readonly InteractiveElement[],
  alreadyTried: ReadonlySet<string> = new Set(),
): InteractiveElement | null {
  const buttons = inventory.filter(
    (e) => (e.tag === "button" || e.role === "button") && e.visible === true,
  );
  const labels = buttons.map((e) => (e.visibleText ?? e.ariaLabel ?? "").trim());
  const hasParentRole = labels.some((t) => /^(?:developer|engineer|personal\s*&\s*freelance|designer|marketing)$/i.test(t));
  const hasFinalSubmit = labels.some((t) => /^(?:let'?s get started|get started|finish|done|continue|next)$/i.test(t));
  if (!hasFinalSubmit) return null;

  const LEAF_ROLE_RE =
    /^(?:full stack|front end|back end|backend|frontend|mobile|web|software|data|ml|ai|devops|platform|cloud)\s+(?:developer|engineer)\b/i;
  const leafRole = hasParentRole ? buttons.find((e) => {
    if (alreadyTried.has(e.selector)) return false;
    const text = (e.visibleText ?? e.ariaLabel ?? "").trim();
    return LEAF_ROLE_RE.test(text);
  }) : undefined;
  if (leafRole !== undefined) return leafRole;

  const DEV_STACK_RE = /^(?:javascript|typescript|python|node(?:\.js)?|react|next(?:\.js)?|vue|angular|ruby|php|java|go|golang|swift|kotlin|android|ios)\b/i;
  const devStackOptions = buttons.filter((e) =>
    DEV_STACK_RE.test((e.visibleText ?? e.ariaLabel ?? "").trim()),
  );
  if (devStackOptions.length < 2) return null;
  return devStackOptions.find((e) => !alreadyTried.has(e.selector)) ?? null;
}

export function isStalledOnActions(
  effects: ReadonlyArray<{ kind: string; pageUnchanged: boolean; selector?: string | null }>,
  threshold = 3,
): boolean {
  if (effects.length < threshold) return false;
  const ACTION_KINDS = new Set(["click", "select", "check", "fill"]);
  const recent = effects.slice(-threshold);
  if (!recent.every((e) => ACTION_KINDS.has(e.kind) && e.pageUnchanged)) {
    return false;
  }
  // A genuine stall RE-acts on the SAME element (the planner keeps clicking
  // one card whose click never registers). Acting on DISTINCT selectors is
  // PROGRESS through a multi-field wizard — selecting role, then company
  // size, then a plan doesn't change the inventory, but each is a different
  // choice (axiom). Only call it stalled when a selector REPEATS (fewer
  // distinct selectors than actions). All-distinct → let the wizard finish.
  const selectors = recent.map((e) => e.selector ?? "");
  const distinct = new Set(selectors).size;
  // If selectors weren't recorded (older callers pass none), fall back to the
  // original kind+unchanged behavior so existing tests/paths don't regress.
  const anyRecorded = recent.some((e) => e.selector !== undefined);
  if (!anyRecorded) return true;
  return distinct < threshold;
}

// True when a URL reads as a login / authentication screen. Service-
// agnostic (path-based, no per-service hosts) — used to detect a
// non-persisting OAuth session: after a successful OAuth, an
// authenticated bot lands on a dashboard, not a login page. Pure +
// exported for tests.
export function isLoginPageUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (
      /(?:^|\/)(?:login|signin|sign-in|authenticate|sso)(?:\/|$)/.test(path)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  // Some providers keep the path stable but flag the failed auth in the
  // query (amplitude: /login?google-auth-error=…).
  return /[?&]google-auth-error\b/i.test(url);
}

export function isLoginPageInventory(
  inventory: readonly InteractiveElement[],
): boolean {
  const visible = inventory.filter((element) => element.visible !== false);
  const hasPassword = visible.some(
    (element) => element.tag === "input" && element.type === "password",
  );
  const hasIdentity = visible.some((element) => {
    if (element.tag !== "input") return false;
    const text = [
      element.name,
      element.id,
      element.placeholder,
      element.ariaLabel,
      element.labelText,
    ]
      .filter(Boolean)
      .join(" ");
    return element.type === "email" || /email|username|login/i.test(text);
  });
  if (!hasPassword || !hasIdentity) return false;
  return visible.some((element) => {
    if (element.tag !== "button" && element.type !== "submit" && element.role !== "button") {
      return false;
    }
    const text = [element.visibleText, element.ariaLabel, element.labelText]
      .filter(Boolean)
      .join(" ");
    return /\b(log ?in|sign ?in|continue|submit)\b/i.test(text);
  });
}

// A pre-account route (signup OR login OR register) — the set of paths an
// AUTHENTICATED user has no business sitting on. Broader than
// isLoginPageUrl (which is tuned for the OAuth-callback-loop detector and
// deliberately excludes /signup). Used for the post-OAuth dead-route
// escape. Exported for unit tests.
export function isSignupOrLoginRoute(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /(?:^|\/)(?:login|signin|sign-in|sign[_-]?up|signup|register|authenticate|sso)(?:\/|$)/.test(
      path,
    );
  } catch {
    return false;
  }
}

// The scheme://host root of a URL (no path/query) — the place a service
// redirects an authenticated user to their dashboard. Null on a malformed
// URL. Exported for unit tests.
export function originRoot(url: string): string | null {
  try {
    return new URL(url).origin + "/";
  } catch {
    return null;
  }
}

// A modern SPA dashboard often paints a "Connecting…" / "Loading…" shell
// (plus the static <noscript> "enable JavaScript" fallback) for a beat
// while its JS bundle and websocket finish — especially over a
// high-latency residential tunnel. During that window the page has ZERO
// interactive elements. northflank's /settings/access-tokens lands on
// exactly this shell post-OAuth; the post-verify planner reads the empty
// inventory and concludes {"kind":"done","no elements"} ~2s in, abandoning
// a page that was about to render the token UI. Detect the shell so the
// caller can wait for hydration instead of giving up. Matched ONLY
// alongside an empty inventory, so the narrow phrasing here won't swallow
// a real dashboard that merely contains the word "loading". Exported for
// unit tests.
export function isLoadingShellText(text: string): boolean {
  // The Google account chooser ("Choose an account to continue to <App>")
  // carries a stray "Loading" label but is an ACTIONABLE page, not a
  // hydration shell — the clerk post-verify loop must click the account
  // card, not idle through the hydration-wait ticks. Veto the shell read
  // before the generic "loading" match below can fire on it.
  if (/choose an account/i.test(text)) return false;
  // ONLY transient "still rendering" copy. The <noscript> fallback
  // ("This application cannot function without JavaScript…") is PERMANENT
  // in the DOM and was matched here by mistake — it made northflank (whose
  // noscript text never leaves the body) read as a perpetual loading shell,
  // so the hydration waits never exited. JS-enabled pages keep that text
  // forever, so it is not a signal.
  return /\bconnecting\b|\bloading\b|please wait|getting things ready|initiali[sz]ing/i.test(
    text,
  );
}

// The interactive-element count at/above which a page is "hydrated by
// definition" — a rendered dashboard/form a user can act on — so a stray
// "loading"/"please wait" word in its (visible) text is NOT a hydration
// shell. WHY 5: a genuine loading shell paints zero or a handful of chrome
// affordances (a logo link, maybe a skip-link); a real authenticated surface
// (nav + content + an "API Keys"/"Create" affordance) clears 5 trivially.
// Field evidence: luma-ai/unify-ai/sambanova/fireworks-ai/defang carried
// 10–95 visible interactive elements yet were flagged a shell EVERY round —
// any threshold from ~5 up vetoes all of them while still catching the true
// 0-to-few-element shell (northflank). Reuses the same minElements default as
// waitForInteractiveDom (5) so the negative gate and the positive readiness
// wait agree on what "hydrated" means.
export const SHELL_MAX_ELEMENTS = 5;

// The authoritative loading-shell decision: a page is a hydration shell only
// when loading-text is present in its VISIBLE text AND it has fewer than
// SHELL_MAX_ELEMENTS interactive elements. Splitting the two conditions kills
// the dominant false positive two ways at once:
//   1. visibleText (innerText) drops hidden skeleton/RSC "loading" strings a
//      raw textContent read picked up;
//   2. the inventory veto makes the gate un-fireable on a hydrated page
//      regardless of any residual stray "loading" word.
// Pure + exported for unit tests. The text predicate stays isLoadingShellText
// (still used where only text is on hand); this is the call-site gate where
// both signals are available.
export function isLoadingShell(
  visibleText: string,
  inventoryCount: number,
): boolean {
  if (inventoryCount >= SHELL_MAX_ELEMENTS) return false;
  return isLoadingShellText(visibleText);
}

// Thrown from postVerifyLoop when a post-OAuth/post-verify SPA presents a
// genuine loading shell that never hydrates within the bounded budget (and a
// navigate-to-root retry didn't unstick it). Surfaced as the terminal status
// `spa_never_hydrated`. classifyFailure() (skill-schema failure-taxonomy)
// has no entry for this kind, so it falls to the deliberate transient default
// — a non-demoting outcome (a never-hydrating route is environmental/transient,
// not skill rot), and no new exported skill-schema symbol is needed (avoids
// the published-dep-skew trap). The leading token before ':' is what
// classifyFailure keys on, so the message MUST start with the bare kind.
export class SpaNeverHydratedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaNeverHydratedError";
  }
}

// Transient "the session is being established RIGHT NOW" copy. MEASURED on
// groq (Stytch B2B): after the OAuth callback, /authenticate shows
// "Logging in…" then "Creating your organization…" for ~5-7s of async
// discovery+org-creation+session calls before redirecting to the dashboard.
// Interrupting that window (navigating away, or — worse — re-clicking the
// OAuth button) ABORTS the org creation and the session never finalizes,
// which is exactly how the bot was failing groq. When this text is present
// the bot must WAIT, never act. Generalizes to any async-session auth
// (Stytch / WorkOS / Auth0 org provisioning). Exported for unit tests.
export function isAuthProcessingText(text: string): boolean {
  return /logging in|signing in|creating your organization|creating your account|setting up your account|authenticating|finishing (?:sign|log)|redirecting you|one moment/i.test(
    text,
  );
}

// Sentinel returned by runOAuthFlow when the OAuth path is a dead end
// that the email/password form-fill path can still recover (Google
// login-only services that never created an account — see
// detectGoogleNoAccount). runSignup catches it and re-runs the form-fill
// path with OAuth-first suppressed. A unique const so it can't collide
// with any SignupResult.error string.
const OAUTH_FALL_BACK_TO_FORM_FILL = "__fall_back_to_form_fill__" as const;

// Returned by runOAuthFlow when the chosen provider is a dead end for the
// BOT specifically (Google GSI/FedCM: the dialog never renders for an
// automated browser — measured) but the page offers ANOTHER provider that
// uses a classic redirect (GitHub), which the bot can drive. runSignup
// re-dispatches the oauth outcome with this provider/selector. Has a `kind`
// discriminant so it's distinguishable from a SignupResult (which has none).
interface OAuthTryNextProvider {
  kind: "try_next_provider";
  selector: string;
  provider: OAuthProviderId;
}

function isOAuthTryNextProvider(
  r: SignupResult | typeof OAUTH_FALL_BACK_TO_FORM_FILL | OAuthTryNextProvider,
): r is OAuthTryNextProvider {
  return typeof r !== "string" && "kind" in r && r.kind === "try_next_provider";
}

export class SignupAgent {
  // Per-run counter so a single SignupAgent (which lives one run) can't
  // burn through more than MAX_LLM_CALLS_PER_SIGNUP. Reset isn't needed
  // because each signup gets a fresh SignupAgent in index.ts.
  private llmCallCount = 0;
  // Capture-chain round counter shared across the signup-form-fill phase
  // (captureSignupFormRounds) and the post-verify loop so they form ONE
  // contiguous chain. Stays 0 on the OAuth path (no form-fill capture), so
  // post-verify starts at 0 exactly as before. Per-run instance → no reset.
  private captureChainRound = 0;
  // The stable signup-form entry URL the bot navigated to (e.g.
  // cloud.zilliz.com/signup). captureSignupFormRounds stamps it as the
  // preamble rounds' URL instead of the transient SPA URL getState() reads
  // mid-fill (zilliz settles to /login/loading) — so the synthesized
  // signup_url points a fresh replay at the real form, not a loading shell.
  private resolvedSignupUrl: string | undefined;
  // Tracks which backend handled each call, for debugging cost/quality.
  // backends_used[i] is the .name string of the LLMClient that produced
  // the i-th reply this run.
  private readonly backendsUsed: string[] = [];
  // Fix C4 — the model/provider the backend actually served on the most
  // recent LLM call, captured per round. callLLM stamps these after every
  // call; the capture sites read them when dumping a round. Undefined
  // until the first call (or when the backend doesn't report a model).
  private lastResolvedModel: string | undefined;
  private lastResolvedProvider: string | undefined;
  private readonly llmPair: LLMPair;

  // Captcha encounter state for the current run. Updated by the
  // pre/post-submit/re-plan captcha gates in signup(); read by the
  // result builder. We track the *last* encounter (overwrites win)
  // because a "blocked" outcome is more diagnostic than an earlier
  // "solved" one and we always want the failure mode in the result.
  private captchaEncounter: SignupResult["captcha"] = undefined;

  // Sticky "this run is on the email path" flag. Set when OAuth turns out to be
  // login-only (a new identity has no account — Clerk's form_identifier_not_found)
  // and we fall back to email signup. Without it, the dispatch loop re-runs the
  // OAuth-first scan after the re-route and re-clicks Google → loops forever
  // (the cartesia oauth_session_not_persisted bug). Honored by
  // resolveOAuthCandidates; reset at the start of each signup().
  private committedToEmailPath = false;

  // One-shot guard for the post-OAuth-callback email fallback. When a Clerk-class
  // app completes the Google handshake but never persists a session (its callback
  // silently fails for a brand-new identity driven through sign-IN — the cartesia
  // root cause WITHOUT the explicit "no account" text), the bot recovers by
  // creating the account via email instead. This flag keeps that to one attempt so
  // a service that's genuinely OAuth-only (no email form to fall back to) fails
  // honestly rather than re-trying forever. Reset at the start of each signup().
  private oauthEmailFallbackTried = false;

  // Invisible-captcha presence for the current run. Cloudflare Turnstile
  // and reCAPTCHA-v3 are score-based: a HIGH score passes silently with no
  // visible widget to "solve", so the visible-gate path above records
  // nothing — leaving the telemetry blind to exactly the challenge class
  // the CDP-hardening targets. We detect the widget's PRESENCE (its iframe/
  // badge is in the DOM even when invisible) and, at result-build time,
  // synthesize a `challenge_rendered:false` encounter so silent passes
  // show up in the CaptchaEvent A/B alongside the visible blocks. A low
  // score escalates to a VISIBLE widget, which the gate above records with
  // blocked=true and which wins over this (captchaEncounter takes
  // precedence in resultTail).
  private invisibleCaptcha:
    | { kind: "turnstile" | "recaptcha" | "hcaptcha"; variant: CaptchaVariant }
    | undefined = undefined;

  // Helper: build the common trailing fields every SignupResult needs.
  // This used to be inlined at each return site (6 of them); a one-line
  // helper keeps the captcha field from being forgotten on a future
  // refactor that adds a 7th return path.
  private resultTail(): Pick<
    SignupResult,
    | "llm_calls"
    | "llm_backends"
    | "browser_channel"
    | "proxied"
    | "captcha"
    | "stealth_profile"
  > {
    const captcha = this.resolveCaptchaEncounter();
    return {
      llm_calls: this.llmCallCount,
      llm_backends: [...this.backendsUsed],
      browser_channel: this.browser.channel,
      proxied: this.browser.proxied !== null,
      stealth_profile: this.browser.stealthProfile,
      ...(captcha !== undefined ? { captcha } : {}),
    };
  }

  // The captcha encounter to report: a recorded VISIBLE encounter wins
  // (it carries the real solved/blocked outcome); otherwise, if an
  // invisible Turnstile/v3 was detected, synthesize a silent-pass
  // encounter (challenge_rendered=false, blocked=false). null when no
  // captcha of any kind was seen.
  private resolveCaptchaEncounter(): SignupResult["captcha"] {
    if (this.captchaEncounter !== undefined) return this.captchaEncounter;
    if (this.invisibleCaptcha !== undefined) {
      return {
        kind: this.invisibleCaptcha.kind,
        variant: this.invisibleCaptcha.variant,
        challenge_rendered: false,
        blocked: false,
      };
    }
    return undefined;
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
    // Best-effort: captcha DETECTION must never abort a signup. A bounded
    // boundingBox / detect race inside solveVisibleCaptcha that throws is
    // treated as "no widget here, proceed" — the OAuth-first path already
    // wraps this call (browser.ts ~6351); the form-fill path didn't, so an
    // invisible-mode Turnstile (which patchright + residential pass) crashed
    // the run instead of falling through to submit.
    let result: Awaited<ReturnType<typeof this.browser.solveVisibleCaptcha>>;
    try {
      result = await this.browser.solveVisibleCaptcha();
    } catch (err) {
      steps.push(
        `${label} captcha gate: detection error (${err instanceof Error ? err.message : String(err)}) — treating as no widget, continuing`,
      );
      return { found: false, solved: false, blocked: false, kind: "turnstile" };
    }
    if (!result.found) {
      // No VISIBLE widget — but an invisible Turnstile / reCAPTCHA-v3 may
      // be present and scoring silently. Record its presence once (a
      // visible escalation later would overwrite via captchaEncounter) so
      // the A/B sees silent passes, not just blocks. Cheap DOM read.
      if (this.invisibleCaptcha === undefined && this.captchaEncounter === undefined) {
        const detected = await this.browser.detectCaptchaVariant();
        if (detected.variant === "turnstile" && !detected.challengeRendered) {
          this.invisibleCaptcha = { kind: "turnstile", variant: "turnstile" };
          steps.push(`${label} captcha: invisible Turnstile present, no visible challenge — recording silent encounter`);
        } else if (detected.variant === "recaptcha_v3") {
          this.invisibleCaptcha = { kind: "recaptcha", variant: "recaptcha_v3" };
          // Invisible reCAPTCHA scores in the background, but its token is only
          // minted when grecaptcha.execute() runs — and a form like amplitude's
          // REQUIRES that token to submit. Mint it now (passes on our ~1.0
          // score) so the imminent submit carries a valid g-recaptcha-response,
          // instead of submitting with an empty token and silently no-op'ing.
          const minted = await this.browser.triggerInvisibleRecaptcha();
          steps.push(
            `${label} captcha: invisible reCAPTCHA v3 — ${minted ? "minted score token via grecaptcha.execute()" : "badge present, token not minted (form may submit it itself)"}`,
          );
        } else if (this.captchaSolver?.isAvailable() === true) {
          // INVISIBLE hCaptcha (huggingface, 2026-06-17): sitekey in the page's
          // JS config, NO visible widget, but the form REQUIRES an
          // h-captcha-response token to submit (the wired Tier 3 hCaptcha path
          // only fires for VISIBLE widgets). Solve via 2Captcha now and inject,
          // so the imminent submit carries a token instead of a silent reject.
          // HONEST CAVEAT: a sophisticated host (HF may run Enterprise hCaptcha)
          // can bind the token to the browser session and reject a solver token
          // regardless — in which case this surfaces the real wall instead of a
          // misleading "validation error".
          const hSitekey = await this.browser.extractHcaptchaSitekey();
          if (hSitekey !== null) {
            this.invisibleCaptcha = { kind: "hcaptcha", variant: "hcaptcha" };
            const pageUrl = (await this.browser.getState().catch(() => null))?.url;
            if (pageUrl !== undefined && this.captchaSolver !== undefined) {
              steps.push(
                `${label} captcha: invisible hCaptcha (sitekey ${hSitekey.slice(0, 10)}…) — solving via 2Captcha before submit`,
              );
              const solveRes = await this.captchaSolver.solveHcaptcha({
                sitekey: hSitekey,
                pageUrl,
              });
              if (solveRes.kind === "ok") {
                const injected = await this.browser.injectHcaptchaToken(solveRes.token);
                steps.push(
                  injected
                    ? `${label} captcha: invisible hCaptcha solved in ${Math.round(solveRes.durationMs / 1000)}s + token injected`
                    : `${label} captcha: hCaptcha token arrived but injection failed`,
                );
                if (injected) {
                  return { found: true, solved: true, blocked: false, kind: "hcaptcha" };
                }
              } else {
                steps.push(
                  `${label} captcha: invisible hCaptcha 2Captcha ${solveRes.kind}` +
                    ("reason" in solveRes ? `: ${solveRes.reason}` : ""),
                );
              }
            }
          }
        }
      }
      return { found: false, solved: false, blocked: false, kind: "turnstile" };
    }
    steps.push(
      `${label} captcha (${result.kind}): ${result.solved ? "solved" : "NOT solved (timeout)"}`,
    );
    // Tier 3 — when Tier 2 click-and-wait times out on a reCAPTCHA v2
    // image challenge AND TWOCAPTCHA_API_KEY is configured, fall
    // through to the third-party solver. Reads sitekey from the
    // page, submits to 2Captcha, polls for the token (~30-90s),
    // injects into the hidden g-recaptcha-response textarea + fires
    // the widget's onSuccess callback. Turnstile is intentionally
    // skipped — Cloudflare's challenge scores at the IP layer; a
    // solver-issued token gets rejected anyway.
    if (
      !result.solved &&
      result.kind === "recaptcha" &&
      this.captchaSolver?.isAvailable() === true
    ) {
      const sitekey = await this.browser.extractRecaptchaSitekey();
      if (sitekey === null) {
        // result.kind said "recaptcha" but no key with the reCAPTCHA `6L`
        // format is on the page — almost always an hCaptcha/Turnstile
        // widget misbucketed by the host-input heuristic. 2Captcha's
        // reCAPTCHA endpoint would reject the wrong-provider key
        // (ERROR_WRONG_GOOGLEKEY); skip it and surface the real shape.
        steps.push(
          `${label} captcha: no genuine reCAPTCHA sitekey on page (widget is likely hCaptcha/Turnstile) — skipping 2Captcha`,
        );
      } else {
        const pageUrl = (await this.browser.getState().catch(() => null))?.url;
        if (pageUrl !== undefined) {
          steps.push(`${label} captcha: Tier 3 — submitting sitekey to 2Captcha (${sitekey.slice(0, 10)}…)`);
          const solveRes = await this.captchaSolver.solveRecaptchaV2({
            sitekey,
            pageUrl,
          });
          if (solveRes.kind === "ok") {
            const injected = await this.browser.injectRecaptchaToken(solveRes.token);
            if (injected) {
              steps.push(
                `${label} captcha: Tier 3 solved in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha`,
              );
              result = { ...result, solved: true };
            } else {
              steps.push(
                `${label} captcha: Tier 3 token arrived but page injection failed — captcha stays blocked`,
              );
            }
          } else {
            steps.push(`${label} captcha: Tier 3 ${solveRes.kind}` +
              ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
              ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : ""));
          }
        }
      }
    }
    // Tier 3 for hCaptcha (plausible). Distinct provider, distinct
    // 2Captcha method (method=hcaptcha) + a UUID sitekey the reCAPTCHA
    // `6L` guard rejects — so it needs its own extractor, solver call,
    // and h-captcha-response injector. Same structure as reCAPTCHA Tier 3.
    if (
      !result.solved &&
      result.kind === "hcaptcha" &&
      this.captchaSolver?.isAvailable() === true
    ) {
      const sitekey = await this.browser.extractHcaptchaSitekey();
      const pageUrl = (await this.browser.getState().catch(() => null))?.url;
      if (sitekey !== null && pageUrl !== undefined) {
        steps.push(`${label} captcha: Tier 3 — submitting hCaptcha sitekey to 2Captcha (${sitekey.slice(0, 10)}…)`);
        const solveRes = await this.captchaSolver.solveHcaptcha({ sitekey, pageUrl });
        if (solveRes.kind === "ok") {
          const injected = await this.browser.injectHcaptchaToken(solveRes.token);
          if (injected) {
            steps.push(
              `${label} captcha: Tier 3 hCaptcha solved in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha`,
            );
            result = { ...result, solved: true };
          } else {
            steps.push(
              `${label} captcha: Tier 3 hCaptcha token arrived but page injection failed — captcha stays blocked`,
            );
          }
        } else {
          steps.push(`${label} captcha: Tier 3 hCaptcha ${solveRes.kind}` +
            ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
            ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : ""));
        }
      } else if (sitekey === null) {
        steps.push(`${label} captcha: hCaptcha widget detected but no sitekey found — cannot Tier-3 solve`);
      }
    }
    // Turnstile Tier 3 (2026-06-12). Mirrors the hCaptcha path; the "Cloudflare
    // IP-scores Turnstile so a solver token is rejected" belief that kept this
    // off is FALSIFIED (exa fails on a fresh direct residential IP + real GPU
    // — not IP-bound; STATE.md). The 2Captcha key is configured. Covers the
    // post-SUBMIT form Turnstile (cartesia-class), complementing the
    // OAuth-precheck branch in runOAuthFlow.
    if (
      !result.solved &&
      result.kind === "turnstile" &&
      this.captchaSolver?.isAvailable() === true
    ) {
      const sitekey = await this.browser.extractTurnstileSitekey();
      const pageUrl = (await this.browser.getState().catch(() => null))?.url;
      if (sitekey !== null && pageUrl !== undefined) {
        steps.push(`${label} captcha: Tier 3 — submitting Turnstile sitekey to 2Captcha (${sitekey.slice(0, 12)}…)`);
        const solveRes = await this.captchaSolver.solveTurnstile({ sitekey, pageUrl });
        if (solveRes.kind === "ok") {
          const injected = await this.browser.injectTurnstileToken(solveRes.token);
          if (injected) {
            steps.push(
              `${label} captcha: Tier 3 Turnstile solved in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha`,
            );
            result = { ...result, solved: true };
          } else {
            steps.push(
              `${label} captcha: Tier 3 Turnstile token arrived but page injection failed — captcha stays blocked`,
            );
          }
        } else {
          steps.push(`${label} captcha: Tier 3 Turnstile ${solveRes.kind}` +
            ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
            ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : ""));
        }
      } else if (sitekey === null) {
        steps.push(`${label} captcha: Turnstile widget detected but no sitekey found — cannot Tier-3 solve`);
      }
    }
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
    identity: SignupIdentity,
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
          const value = resolvePlannedFillValue(action, fillValues, el, identity);
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
        } else if (action.kind === "select") {
          steps.push(
            action.option_text !== undefined
              ? `Select ${action.selector} → ${action.option_text}`
              : `Select ${action.selector}`,
          );
          await this.browser.selectOption(action.selector, action.option_text);
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
    // When true, suppress the OAuth-first scan entirely and go straight
    // to form-fill. Set by the re-route after the OAuth path discovered
    // the Google identity has no account (detectGoogleNoAccount) — the
    // page still carries a "Continue with Google" button, so without
    // this the scan would re-pick OAuth and loop right back into the
    // same no-account bounce. One-shot equivalent of committedToEmailPath.
    forceFormFill = false,
  ): Promise<PlanExecOutcome> {
    // FORM_FILL_ENGINE (default-ON since 2026-06-15, strangler slice 3): route the
    // whole round through the pure decideFormFillStep reducer. Flipped default-on
    // after live validation showed the engine reaches the correct terminal on
    // every fillable form (ipinfo full success; cohere/deepinfra/postmark each
    // reached submit — their failures were downstream verification/extraction or
    // already-registered, NOT the form-fill phase). The inline loop below is kept
    // one cycle as the explicit opt-out fallback (FORM_FILL_ENGINE=0/off) and is
    // deleted next, once a heal pass confirms no per-service regression
    // (DESIGN-form-fill-engine.md migration step 4).
    if (!/^(0|false|off|no)$/i.test(process.env.FORM_FILL_ENGINE ?? "")) {
      return this.planExecuteViaEngine(task, fillValues, steps, forceFormFill);
    }
    const MAX_ERROR_REPLANS = 2;
    // 0.8.3-rc.1 — widened from 4 to 6 so submit_disabled re-plans
    // get more attempts to identify the gating control. Mailgun's
    // signup form has a non-standard required field whose label the
    // planner missed on the first 5 plans; the 6th attempt typically
    // surfaces the unchecked checkbox. Bounded by the 15-call LLM
    // budget so genuinely-stuck signups still terminate.
    const MAX_PROGRESS_REPLANS = 6;
    let errorReplans = 0;
    let progressReplans = 0;
    let emptyPlans = 0;
    let oauthScanRetries = 0;
    // A signup SPA that's STILL a loading shell after all OAuth-scan
    // retries (getstream's accounts/signup SPA wedged this way → the bot
    // wrongly bailed oauth_required "no form"). A single reload usually
    // kicks the stuck hydration loose; bounded so a genuinely empty page
    // still terminates.
    let oauthShellReloads = 0;
    const MAX_OAUTH_SHELL_RELOADS = 1;
    // Bound upstream-proxy blips. The blip carve-out below deliberately
    // does NOT tick errorReplans (a transient 502 isn't a logic failure),
    // but with no cap a SUSTAINED LLM-proxy outage spins this loop until
    // the 600s run deadline — meilisearch burned 177 planner calls this
    // way on a degraded `trusty-squire-proxy:cheap` upstream. The
    // post-verify loop already caps blips at 8; mirror that here so a
    // sustained outage fails fast as planning_failed instead of timing out.
    let upstreamBlipRetries = 0;
    const MAX_UPSTREAM_BLIP_RETRIES = 8;
    // Bounded click-throughs of a generic "Sign In to Continue"
    // interstitial that gates the provider buttons (Qdrant). Capped so
    // an SSO-only page that keeps re-showing a sign-in button (or a
    // redirect loop) still terminates at oauth_required.
    let signInAdvanceClicks = 0;
    const MAX_SIGN_IN_ADVANCE_CLICKS = 2;
    let hint: string | undefined;
    // F14 — selectors the planner clicked WITHOUT advancing the page.
    // Each no-progress plan records its click selectors here; the next
    // plan that picks ONLY selectors in this set is failed as stuck
    // instead of looping. Cleared on ANY real progress between two
    // clicks of the same selector — a fill/select/check action OR a
    // page change (inventory/url moved). The Railway run that motivated
    // F14 spun the same footer "Email" link 5 times before timing out;
    // this loop now bails after 2.
    let lastNoProgressClickSelectors: Set<string> = new Set();
    // Page-state fingerprint from the END of the previous round, used to
    // decide whether the page actually moved between rounds. A
    // "fill field → submit → (validation error) → fix field → submit
    // again" cycle is legitimate progress, NOT a loop: kinde's post-OAuth
    // register form has a globally-unique "domain" field, so the first
    // guess collides ("taken") and the bot must edit the field and
    // re-click the SAME "Next" button. Without this, re-clicking the same
    // selector after a genuine field edit (or any inventory/url change)
    // false-bailed as planner_loop even though the intervening fill was
    // real progress. (MEASURED 2026-06-13, kinde, terminal_round 3.)
    let lastRoundPageSig: string | null = null;
    // rc.31 — once the bot has explicitly clicked an email-flow
    // button (e.g. Railway's "Log in using email" two-stage chooser),
    // stay on the email path. Without this, the auto-OAuth-first
    // detection on the *next* iteration sees the now-revealed
    // "Continue with Google" button and reroutes — exactly the
    // regression that produced the Security Code challenge on
    // methoxine's account during the rc.30 Railway run.
    let committedToEmailPath = forceFormFill;

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

      if (/^https:\/\/github\.com\/login\/oauth\/authorize\b/i.test(state.url)) {
        const advanced = await this.browser.advanceOAuthConsent("github");
        steps.push(
          `OAuth: GitHub authorize page appeared during form-fill — ${advanced ? "approved consent" : "no approve control found"}`,
        );
        if (advanced) {
          await this.browser.wait(3);
          continue;
        }
      }

      {
        const prePlanCredentials = await this.harvestVisibleCredentials();
        if (hasAnyExtractedCredential(prePlanCredentials)) {
          steps.push(
            "Form-fill: credentials are already visible before planning — skipping form actions and extracting in place.",
          );
          return { kind: "submitted" };
        }
      }

      // Email-verification WALL reached without a fresh submit — e.g. OAuth
      // landed on a pending account's "Verify your email — check <addr>" page.
      // A real signup form still has fields to fill; a wall has only
      // Open-Gmail / Resend / Return buttons, on which the form-fill planner
      // stalls. Route to the post-submit inbox-poll + verification-link flow
      // instead, polling the alias the wall names (which may differ from
      // task.email when a prior run created the pending account).
      {
        // Use the already-fetched state.html (don't call extractText() again —
        // an extra read would shift queue-backed test mocks and isn't needed:
        // the verification copy is in the rendered HTML).
        const wallText = state.html;
        const hasFillableInput = inventory.some(
          (e) =>
            e.tag === "input" &&
            (e.type === "email" ||
              e.type === "text" ||
              e.type === "password" ||
              e.type === null) &&
            e.visible !== false,
        );
        // Only enter the inbox-poll flow when the named alias is one we can
        // actually POLL — on our own inbox domain (task.email's domain, which
        // also covers a prior run's alias). A logged-in dashboard often shows
        // the operator's real email (e.g. a personal gmail) or a docs sample
        // next to "check your email" copy; polling those 404s as
        // unknown_alias and yields a false verification_not_sent. A wall that
        // names NO address (generic "check your email") still fires and polls
        // task.email — that's the common legitimate case. (Already-
        // authenticated dashboards are routed straight to key extraction
        // before the form-fill loop, so they never reach this detector.)
        const wallAlias = extractVerifyWallAlias(wallText);
        const ourInboxDomain = task.email
          .slice(task.email.indexOf("@") + 1)
          .toLowerCase();
        const aliasPollable =
          wallAlias === null ||
          wallAlias.slice(wallAlias.indexOf("@") + 1).toLowerCase() ===
            ourInboxDomain;
        // A no-input page that offers an OAuth signup affordance
        // ("SIGN UP WITH GOOGLE/GITHUB") is a signup-METHOD chooser, not
        // a post-submit verification wall — nothing has been submitted
        // yet, so there's no mail to poll. Cloudinary's register page is
        // exactly this: no fields, three "SIGN UP WITH …" links, and
        // marketing copy that trips expectsVerificationEmail. Skipping the
        // wall here lets control fall through to the OAuth-first scan
        // below, which clicks Google.
        const offersOAuthSignup =
          oauthCandidates.length > 0 &&
          findFirstOAuthButton(inventory, oauthCandidates) !== null;
        if (
          !hasFillableInput &&
          expectsVerificationEmail(wallText) &&
          aliasPollable &&
          !offersOAuthSignup
        ) {
          const alias = wallAlias;
          this.pendingVerificationAlias = alias;
          steps.push(
            `Form: email-verification wall (no fields to fill${alias !== null ? `, check ${alias}` : ""}) — ` +
              `routing to the inbox-poll + verification-link flow.`,
          );
          // The named link may be stale (a pending account from a prior run);
          // click "Resend verification email" if present to refresh it.
          const resend = inventory.find((e) => {
            if (e.tag !== "button" && e.tag !== "a") return false;
            const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
            return /resend (?:verification )?(?:email|link)|send (?:it )?again/.test(t);
          });
          if (resend !== undefined) {
            try {
              await this.browser.click(resend.selector);
              steps.push(`Form: clicked "Resend verification email" to refresh the link.`);
              await this.browser.wait(2);
            } catch {
              // non-fatal — poll for whatever's already in the inbox
            }
          }
          return { kind: "submitted" };
        }
      }

      // Email verification-CODE gate (axiom-class passwordless). The no-fields
      // wall above misses it because this page HAS an input — but it's a CODE
      // field, not email/password, and the code was emailed to our alias.
      // Return "submitted" so the post-submit inbox-poll + code-entry path
      // (extractCodeFromEmailBody → enterEmailVerificationCode) handles it,
      // instead of the planner typing an empty literal into the code field and
      // looping. Gated on committedToEmailPath — a code gate only appears after
      // the email was submitted.
      if (committedToEmailPath && isVerificationCodeGate(inventory, state.html)) {
        this.pendingVerificationAlias = this.pendingVerificationAlias ?? task.email;
        steps.push(
          "Form: email verification-CODE gate detected — routing to the inbox-poll + code-entry flow.",
        );
        return { kind: "submitted" };
      }

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
        // a couple of times before giving up on the OAuth path. On a
        // websocket-gated SPA (northflank) the WHOLE page — provider
        // buttons included — renders only after a ~15s hydration, so a
        // "Connecting"/loading shell warrants far more patience than the
        // default 2 retries (otherwise the bot gives up at ~6s and wrongly
        // falls back to the email-signup path before the GitHub button
        // even exists).
        // An almost-empty inventory is itself a strong unhydrated-SPA signal,
        // even when the page TEXT doesn't match the loading-shell phrases
        // (lancedb's accounts.lancedb.com/sign-up renders its Google button
        // late and shows 0 interactive candidates meanwhile — MEASURED
        // 2026-06-11: it bailed oauth_required after only 2 retries because
        // the text heuristic missed it). Treat ≤1 interactive elements as a
        // loading shell so the late-rendering provider button gets the patient
        // 8-retry budget instead of a premature email-fallback bail.
        //
        // Also patient when the page has NO provider button (we're in this
        // branch because the scan found none) AND no email/password form yet:
        // the auth surface simply hasn't hydrated. An OAuth-ONLY signup
        // (replit: "Continue with Google/GitHub", no credential input) renders
        // its provider buttons a beat late, and with >1 element it otherwise
        // got only 2 retries and bailed oauth_required. If a form IS present,
        // it's a genuine form-signup → fall back to form-fill without waiting.
        const hasCredentialInput = inventory.some(
          (e) =>
            e.tag === "input" &&
            (e.type === "email" || e.type === "password" || e.type === "tel"),
        );
        const oauthScanShell =
          inventory.length <= 1 ||
          !hasCredentialInput ||
          isLoadingShellText(await this.browser.extractText().catch(() => ""));
        const maxOauthScanRetries = oauthScanShell ? 8 : 2;
        if (oauthScanRetries < maxOauthScanRetries) {
          oauthScanRetries += 1;
          steps.push(
            `OAuth-first: no provider affordance yet — waiting for an ` +
              `async render (retry ${oauthScanRetries}/${maxOauthScanRetries}` +
              `${oauthScanShell ? ", page still a loading shell" : ""})`,
          );
          await this.browser.wait(3);
          continue;
        }
        // Still a loading shell after every retry — reload once to unstick
        // a wedged SPA (getstream's signup SPA) before falling through to
        // the misleading oauth_required "no form" bail.
        if (oauthScanShell && oauthShellReloads < MAX_OAUTH_SHELL_RELOADS) {
          oauthShellReloads += 1;
          steps.push(
            `OAuth-first: page stuck as a loading shell after ${oauthScanRetries} retries — ` +
              `reloading once to unstick the SPA (${oauthShellReloads}/${MAX_OAUTH_SHELL_RELOADS})`,
          );
          try {
            await this.browser.goto(this.browser.currentUrl());
            await this.browser.waitForFormReady();
          } catch {
            // reload failed — fall through to the normal terminal handling
          }
          oauthScanRetries = 0;
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
        // The provider buttons can sit one click behind a generic
        // "Sign In to Continue" interstitial (Qdrant's session-expiry
        // /logout?aerr=expired redirect renders only that button). The
        // OAuth scan above found nothing because the real login UI
        // hasn't been reached yet. Click the sign-in-ish affordance to
        // advance, reset the async-render retries, and re-scan — bounded
        // so a page that just keeps showing a sign-in button (genuine
        // SSO-only / a redirect loop) still terminates at oauth_required
        // rather than clicking forever.
        if (signInAdvanceClicks < MAX_SIGN_IN_ADVANCE_CLICKS) {
          const advance = findSignInAdvanceButton(inventory, oauthCandidates);
          if (advance !== null) {
            signInAdvanceClicks += 1;
            steps.push(
              `OAuth-first: no provider affordance, but found a generic ` +
                `sign-in affordance (${JSON.stringify(advance.visibleText ?? advance.ariaLabel ?? "")}) ` +
                `— clicking it to advance to the real login page ` +
                `(${signInAdvanceClicks}/${MAX_SIGN_IN_ADVANCE_CLICKS})`,
            );
            try {
              await this.browser.click(advance.selector);
            } catch (err) {
              steps.push(
                `OAuth-first: sign-in advance click failed (${err instanceof Error ? err.message : String(err)}) ` +
                  `— falling through to form-fill`,
              );
            }
            // Reset the async-render budget for the now-advanced page so
            // its provider buttons get the same couple of render retries.
            oauthScanRetries = 0;
            continue;
          }
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
        const haveSessions = await this.effectiveLoggedInProviders();
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

      let plan = planSimpleEmailOnlySignup(inventory);
      if (plan !== null) {
        steps.push("Plan: deterministic email-only signup form (no LLM call).");
      } else {
        steps.push("Asking planner to plan the signup form fill...");
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
        // 0.8.2-rc.6 — mirror the post-verify upstream-blip carve-out.
        // The form-fill planner is also vulnerable to sustained
        // upstream-proxy degradation: the rc.3 + rc.5 batch runs
        // showed openrouter / resend / sentry losing 4+ consecutive
        // proxy calls in a row when the free-tier upstream was
        // throttling. Don't punt to planning_failed for upstream
        // weather — keep re-planning until the budget runs out at the
        // top-level F2 deadline, OR a true logic failure shows up.
        const isUpstreamBlip =
          /\b50[234]\b/.test(reason) ||
          /\bupstream_(?:error|unreachable)\b/i.test(reason) ||
          /\bnetwork error\b/i.test(reason);
        if (!isUpstreamBlip && ++errorReplans > MAX_ERROR_REPLANS) {
          return { kind: "planning_failed", reason: `planner output never validated: ${reason}` };
        }
        if (isUpstreamBlip && ++upstreamBlipRetries > MAX_UPSTREAM_BLIP_RETRIES) {
          return {
            kind: "planning_failed",
            reason: `llm_proxy_unavailable: planner request failed ${upstreamBlipRetries}x on upstream proxy errors (${reason}) — sustained LLM-proxy/upstream outage, not a page problem`,
          };
        }
        steps.push(
          isUpstreamBlip
            ? `⚠ planner request hit a transient upstream blip (${reason}) — retrying (${upstreamBlipRetries}/${MAX_UPSTREAM_BLIP_RETRIES})`
            : `⚠ plan rejected (${reason}) — re-planning`,
        );
        if (!isUpstreamBlip) {
          hint =
            "Your previous plan used a selector not in the inventory. Use ONLY selectors copied verbatim from a `selector=` field.";
        } else {
          // Brief backoff so a genuinely transient blip can recover
          // before the next attempt, instead of hammering a degraded
          // upstream as fast as the proxy can 502.
          await this.browser.wait(2);
        }
        continue;
      }
      }
      steps.push(
        `Plan: ${plan.actions.length} action(s), confidence=${plan.confidence}` +
          (plan.notes !== undefined ? ` — ${plan.notes}` : ""),
      );

      // rc.39 — PlanetScale-class detection. The form-fill planner
      // sometimes lands on a logged-in product page (PlanetScale's
      // /sign-up redirects authenticated users to a create-database
      // form; similar for Turso, Cockroach, etc.). detectAlreadySignedIn
      // missed the URL signal because the path is /sign-up. But the
      // planner's notes / action reasons describe the page accurately:
      // "create the database on this PS-5 plan", "Add credit card",
      // "database name field". Pivot to post-verify navigation rather
      // than blindly filling the create-product form.
      if (detectFormFillIsDashboard(plan)) {
        steps.push(
          "Form-fill planner described a logged-in product/billing page (not a signup form) — pivoting to post-verify navigation",
        );
        return { kind: "already_oauth" };
      }

      // The page moved since the previous round if the URL changed or the
      // set of interactive selectors changed (a field gained/lost, a
      // validation message toggled an element, a wizard step advanced).
      // ANY such change means whatever the planner did last round was real
      // progress — clear the no-progress memory so a re-click of a
      // previously-"dead" selector on the now-changed page isn't judged a
      // loop. This is the unique-value-retry case (kinde domain field):
      // edit field → page re-renders → re-click "Next" is legitimate.
      const pageSig =
        state.url +
        "§" +
        inventory
          .map((e) => e.selector)
          .sort()
          .join("|");
      if (lastRoundPageSig !== null && pageSig !== lastRoundPageSig) {
        lastNoProgressClickSelectors = new Set();
      }
      lastRoundPageSig = pageSig;

      // F14 — stuck-detection: if the plan picks ONLY click selectors
      // we already tried in the previous round without page progress,
      // it's a planner loop. Fail planning_failed with the offending
      // selector(s) so the operator sees what stalled. Doesn't fire
      // when the plan adds at least one new selector (legitimate
      // exploration). Doesn't fire on fill plans (forward progress),
      // nor on a plan that ALSO edits a field this round (a fill/check
      // alongside the re-click is real progress — kinde's "tick the
      // required box + re-click Next" advances the form even though the
      // Next selector repeats).
      const planClickSelectors = plan.actions
        .filter((a) => a.kind === "click")
        .map((a) => a.selector);
      const planEditsAField = plan.actions.some(
        (a) => a.kind === "fill" || a.kind === "check",
      );
      if (
        !planEditsAField &&
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

      await this.executePlan(plan, fillValues, identityFromEmail(task.email), steps, bySelector);

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

      // A plan that should not submit either revealed/advanced the page
      // (a cookie banner, a two-stage "sign up with email" chooser) —
      // worth a re-plan — or found nothing actionable at all. A
      // 0-action plan revealed *nothing*: re-extracting the same
      // static page won't help, so a second consecutive empty plan is
      // a dead end. (The 0.1.12 loop spun this 4x on Axiom.)
      const hadFill = plan.actions.some((a) => a.kind === "fill");
      // A check/select is ALSO a field edit = real progress, even though
      // (unlike a fill) it doesn't always promote the plan to the submit
      // path below. Treat these as progress for
      // the no-progress tracker only: a plan that ticked a box advanced
      // the form, so its click selectors must NOT be recorded as "dead"
      // (and any prior dead record is cleared). Without this, a "click
      // Next (no advance) → tick a required box + re-click Next" cycle
      // false-bailed as a loop even though the check was progress.
      const hadFieldEdit = plan.actions.some(
        (a) => a.kind === "fill" || a.kind === "check" || a.kind === "select",
      );
      const shouldSubmit = hadFill || (hadFieldEdit && planClickSelectors.length === 0);
      if (!shouldSubmit) {
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
        // planner which selectors NOT to re-pick. A plan that ALSO made
        // a field edit (select/check) made real progress, so clear the
        // tracker instead of recording its clicks as dead.
        lastNoProgressClickSelectors = hadFieldEdit
          ? new Set()
          : new Set(planClickSelectors);
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

      // Deterministic agreement-checkbox guard — runs BEFORE the captcha
      // gate + submit so the form is fully satisfied at submit time. The
      // LLM planner sometimes skips a required TOS box (amplitude: it
      // read the box as one of the adjacent card-radios), and when the
      // service doesn't disable submit for an unchecked box, the click
      // silently no-ops. This ticks terms/privacy/consent boxes while
      // never touching marketing opt-ins. Best-effort: never throws.
      const choiceBoxes = await this.browser.checkRequiredSignupChoiceBoxes();
      if (choiceBoxes.length > 0) {
        steps.push(
          `Form: checked required signup choice box(es): [${choiceBoxes.join(", ")}]`,
        );
      }
      const agreementBoxes = await this.browser.checkRequiredAgreementBoxes();
      if (agreementBoxes.length > 0) {
        steps.push(
          `Form: checked required agreement box(es): [${agreementBoxes.join(", ")}]`,
        );
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
          // 0.8.3-rc.1 — surface concrete unchecked-checkbox candidates
          // from the current inventory so the planner picks one
          // immediately rather than re-guessing. Best-effort: a snapshot
          // failure falls back to the generic prompt that used to be
          // here.
          let uncheckedHint = "";
          let emptyInputHint = "";
          try {
            const snapshotInv = await this.buildInventory(steps, undefined, 60);
            const unchecked = snapshotInv.filter(
              (e) =>
                e.tag === "input" &&
                (e.type === "checkbox" || e.role === "checkbox") &&
                e.checked === false &&
                e.visible === true,
            );
            if (unchecked.length > 0) {
              const lines = unchecked
                .slice(0, 6)
                .map((e) => {
                  const label =
                    (e.labelText ?? e.ariaLabel ?? e.placeholder ?? e.name ?? "(no label)")
                      .toString()
                      .slice(0, 60);
                  return `  - selector ${JSON.stringify(e.selector)} label=${JSON.stringify(label)}`;
                });
              uncheckedHint = `\nUnchecked checkboxes visible on the page:\n${lines.join("\n")}`;
            }
            const emptyInputs = snapshotInv.filter(
              (e) =>
                e.tag === "input" &&
                e.type !== "checkbox" &&
                e.type !== "radio" &&
                e.type !== "hidden" &&
                (e.value === null || e.value === "") &&
                e.visible === true,
            );
            if (emptyInputs.length > 0) {
              const lines = emptyInputs
                .slice(0, 6)
                .map((e) => {
                  const label =
                    (e.labelText ?? e.placeholder ?? e.ariaLabel ?? e.name ?? "(no label)")
                      .toString()
                      .slice(0, 60);
                  return `  - selector ${JSON.stringify(e.selector)} label=${JSON.stringify(label)}`;
                });
              emptyInputHint = `\nEmpty visible inputs (any could be the unmet required field):\n${lines.join("\n")}`;
            }
          } catch {
            // best-effort
          }
          hint =
            "The submit button is disabled — a required field or an agreement " +
            "was not satisfied. Issue {\"kind\":\"check\"} on an unchecked " +
            "agreement/terms checkbox, OR {\"kind\":\"fill\"} on an empty " +
            "required input. Do NOT click a link." +
            uncheckedHint +
            emptyInputHint;
          continue;
        }
        // A submit-selector visibility timeout means the element the
        // planner picked is no longer on the page — typically because an
        // earlier action in THIS plan advanced a multi-step SPA (Paddle's
        // signup: a "Continue" click navigates to a new screen, so the
        // submit selector that resolved at plan-time has vanished by the
        // time clickSubmit polls for it). The page DID move forward, so
        // re-plan against the new state rather than failing the whole run
        // on a stale selector. Bounded by the same progressReplans
        // headroom as the disabled-submit / post-validation re-plans.
        if (isSubmitTimeout(reason)) {
          if (++progressReplans > MAX_PROGRESS_REPLANS) {
            return { kind: "submit_failed", reason };
          }
          steps.push(
            `⚠ submit selector went stale (${reason.split("\n")[0]}) — the page likely advanced; re-planning`,
          );
          hint =
            "The submit button selected last round was no longer present when " +
            "we tried to click it — an earlier action probably advanced the page. " +
            "Re-read the now-visible form and plan the next step (pick the submit " +
            "button that is actually on the current screen).";
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
      if (postGate.blocked) {
        // A managed/invisible Turnstile (Clerk's Smart CAPTCHA) resolves
        // SERVER-SIDE: the submit can succeed — account created, verification
        // email sent — even though our client-side token poll timed out.
        // cartesia PROVED this: it emailed a verification code AFTER the bot had
        // bailed captcha_blocked. The ground truth of "did the submit go
        // through" is the INBOX, not the client token. So for a POST-submit
        // Turnstile with an inbox available, don't hard-bail: proceed to the
        // verification step and let the inbox poll arbitrate — a code arriving
        // proves the managed Turnstile passed (→ completes); no code surfaces
        // an honest verification_not_sent rather than a false captcha_blocked.
        // A genuine pre-submit gate (no inbox, or a non-Turnstile challenge)
        // still bails captcha_blocked.
        if (postGate.kind === "turnstile" && task.inbox !== undefined) {
          steps.push(
            "Post-submit Turnstile token didn't populate — but a managed Turnstile resolves " +
              "server-side, so the submit may have gone through. Proceeding to verification; " +
              "the inbox poll arbitrates (a code = submit succeeded).",
          );
          // Don't let the recorded block short-circuit later gates / the result.
          this.captchaEncounter = undefined;
          await this.captureSignupFormRounds(task.service, plan, inventory, fillValues);
          return { kind: "submitted" };
        }
        return { kind: "captcha_blocked", captchaKind: postGate.kind };
      }
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
      // Capture the signup-form preamble (email + password fills + the
      // submit click) as the FIRST rounds of the chain, so a synthesized
      // email-OTP skill's graph DISPATCHES the verification email before
      // its await_email_code step. Without it the capture begins post-
      // verify and the skill can never replay (zilliz). Only the email-form
      // path reaches here (OAuth returns `already_oauth` earlier), so OAuth
      // skills keep starting their chain at round 0.
      await this.captureSignupFormRounds(task.service, plan, inventory, fillValues);
      return { kind: "submitted" };
    }
  }

  private async captureFormObservationFrame(
    steps: string[],
    oauthCandidates: readonly OAuthProviderId[],
  ): Promise<ObservationFrame> {
    return captureObservationFrame(this.browser, () => this.buildInventory(steps, oauthCandidates));
  }

  private async captureTextObservationFrame(): Promise<ObservationFrame> {
    return captureObservationFrame(this.browser, async () => []);
  }

  private async capturePostVerifyObservationFrame(
    steps: string[],
  ): Promise<ObservationFrame> {
    return captureObservationFrame(this.browser, () => this.buildInventory(steps, undefined, 80));
  }

  // FORM_FILL_ENGINE path (strangler slice 3) — the same round as
  // planExecuteWithRetry, but every DECISION goes through the pure
  // decideFormFillStep reducer (form-fill.ts); this method owns only the I/O and
  // the replan-hint CONTENT. Faithful to the inline loop; reuses its helpers.
  private async planExecuteViaEngine(
    task: SignupTask,
    fillValues: Record<FillValueKind, string>,
    steps: string[],
    forceFormFill: boolean,
  ): Promise<PlanExecOutcome> {
    let state: FormFillState = initialFormFillState(forceFormFill);
    let hint: string | undefined;
    // Map a reducer terminal outcome to PlanExecOutcome. needs_oauth_provider_session
    // + oauth carry provider IDs the executor holds in typed form — pass those in.
    const toPlanExec = (
      outcome: FormFillOutcome,
      typed?: {
        oauth?: { selector: string; provider: OAuthProviderId } | undefined;
        missingProviders?: readonly OAuthProviderId[] | undefined;
        haveSessions?: readonly OAuthProviderId[] | undefined;
      },
    ): PlanExecOutcome => {
      switch (outcome.kind) {
        case "oauth":
          return { kind: "oauth", selector: typed!.oauth!.selector, provider: typed!.oauth!.provider };
        case "needs_oauth_provider_session":
          return {
            kind: "needs_oauth_provider_session",
            missingProviders: typed!.missingProviders!,
            haveSessions: typed!.haveSessions!,
          };
        default:
          return outcome;
      }
    };

    const oauthCandidates = await this.resolveOAuthCandidates(task, steps);
    for (;;) {
      await this.browser.waitForFormReady();
      const dismissed = await this.browser.dismissConsentBanner();
      if (dismissed !== null) steps.push(`Dismissed cookie consent: "${dismissed}"`);
      await saveDebugSnapshot(this.browser, "before-fill");
      const frame = await this.captureFormObservationFrame(steps, oauthCandidates);
      const frameVerdict = classifyObservationFrame(frame);
      if (process.env.TRUSTY_SQUIRE_OBSERVATION_DEBUG === "1") {
        steps.push(`Observation :  ()`);
      }
      const browserState = frame.state;
      const inventory = frame.inventory;

      if (/^https:\/\/github\.com\/login\/oauth\/authorize\b/i.test(browserState.url)) {
        const advanced = await this.browser.advanceOAuthConsent("github");
        steps.push(
          `OAuth: GitHub authorize page appeared during form-fill — ${advanced ? "approved consent" : "no approve control found"}`,
        );
        if (advanced) {
          await this.browser.wait(3);
          continue;
        }
      }

      {
        const prePlanCredentials = await this.harvestVisibleCredentials();
        if (hasAnyExtractedCredential(prePlanCredentials)) {
          steps.push(
            "Form-fill: credentials are already visible before planning — skipping form actions and extracting in place.",
          );
          return { kind: "submitted" };
        }
      }

      // ── C1 pre_plan: gather the observation, then decide ──
      const hasFillableInput = inventory.some(
        (e) =>
          e.tag === "input" &&
          (e.type === "email" || e.type === "text" || e.type === "password" || e.type === null) &&
          e.visible !== false,
      );
      const visiblePrePlanText = !hasFillableInput
        ? await this.browser.extractText().catch(() => "")
        : "";
      const wallText = `${browserState.html} ${visiblePrePlanText}`;
      const wallAlias = extractVerifyWallAlias(wallText);
      const ourInboxDomain = task.email.slice(task.email.indexOf("@") + 1).toLowerCase();
      const aliasPollable =
        wallAlias === null ||
        wallAlias.slice(wallAlias.indexOf("@") + 1).toLowerCase() === ourInboxDomain;
      const oauthButtonHitRaw = findFirstOAuthButton(inventory, oauthCandidates);
      const offersOAuthSignup = oauthCandidates.length > 0 && oauthButtonHitRaw !== null;
      const verifyWall =
        !hasFillableInput &&
        expectsVerificationEmail(wallText) &&
        aliasPollable &&
        !offersOAuthSignup;
      const hasCredentialInput = inventory.some(
        (e) => e.tag === "input" && (e.type === "email" || e.type === "password" || e.type === "tel"),
      );
      // LAZY (parity with inline agent.ts:4823): the loading-shell check calls
      // extractText() — an I/O read — so only compute it when the OAuth-scan
      // branch will actually consult it (candidates present, NOT committed, and
      // no provider button hit yet). Computing it unconditionally would fire a
      // spurious extractText() every round and diverge from the inline path.
      const needScanShell =
        oauthCandidates.length > 0 && !state.committedToEmailPath && oauthButtonHitRaw === null;
      const oauthScanShell =
        needScanShell &&
        (inventory.length <= 1 ||
          !hasCredentialInput ||
          isLoadingShellText(await this.browser.extractText().catch(() => "")));
      const signInAdvance = findSignInAdvanceButton(inventory, oauthCandidates);
      const signupLinkOnLoginPage = findSignupLinkOnLoginPage({
        inventory,
        url: browserState.url,
        title: browserState.title,
        htmlOrText: browserState.html,
      });
      const antiBotVendor = inventory.length < 10 ? detectAntiBotBlock(browserState.html) : null;
      const oauthOnly = isOauthOnlyChooser(inventory);
      let missingProviders: readonly OAuthProviderId[] = [];
      let haveSessions: readonly OAuthProviderId[] = [];
      if (oauthOnly) {
        const visibleProviders = detectOAuthProvidersInInventory(inventory);
        haveSessions = await this.effectiveLoggedInProviders();
        missingProviders = visibleProviders.filter((p) => !haveSessions.includes(p));
      }
      const preObs: FormFillObservation = {
        checkpoint: "pre_plan",
        hasFillableInput,
        verifyWall,
        codeGate: isVerificationCodeGate(inventory, browserState.html),
        oauthCandidatesPresent: oauthCandidates.length > 0,
        oauthButtonHit:
          oauthButtonHitRaw !== null
            ? { selector: oauthButtonHitRaw.button.selector, provider: oauthButtonHitRaw.provider }
            : null,
        oauthScanShell,
        alreadySignedIn: detectAlreadySignedIn({ inventory, url: browserState.url }),
        signInAdvancePresent: signInAdvance !== null,
        signupLinkOnLoginPage: signupLinkOnLoginPage !== null,
        antiBotVendor,
        oauthOnly,
        oauthOnlyMissingProviders: missingProviders,
        oauthOnlyHaveSessions: haveSessions,
      };
      const pre = decideFormFillStep(state, preObs);
      state = pre.nextState;
      const preAct = pre.action;
      if (preAct.kind === "route_to_verification") {
        this.pendingVerificationAlias = wallAlias;
        steps.push(
          `Form: email-verification wall (no fields to fill${wallAlias !== null ? `, check ${wallAlias}` : ""}) — ` +
            `routing to the inbox-poll + verification-link flow.`,
        );
        const resend = inventory.find((e) => {
          if (e.tag !== "button" && e.tag !== "a") return false;
          const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
          return /resend (?:verification )?(?:email|link)|send (?:it )?again/.test(t);
        });
        if (resend !== undefined) {
          try {
            await this.browser.click(resend.selector);
            steps.push(`Form: clicked "Resend verification email" to refresh the link.`);
            await this.browser.wait(2);
          } catch {
            // non-fatal
          }
        }
        return { kind: "submitted" };
      }
      if (preAct.kind === "terminal") {
        if (preAct.outcome.kind === "oauth" && oauthButtonHitRaw !== null) {
          const label = OAUTH_PROVIDERS[oauthButtonHitRaw.provider].label;
          steps.push(
            `OAuth-first: found a ${label} sign-in affordance ` +
              `(${JSON.stringify(oauthButtonHitRaw.button.visibleText ?? oauthButtonHitRaw.button.ariaLabel ?? label)}) ` +
              `— taking the OAuth path`,
          );
        }
        return toPlanExec(preAct.outcome, {
          oauth:
            oauthButtonHitRaw !== null
              ? { selector: oauthButtonHitRaw.button.selector, provider: oauthButtonHitRaw.provider }
              : undefined,
          missingProviders,
          haveSessions,
        });
      }
      if (preAct.kind === "oauth_scan_wait") {
        steps.push(
          `OAuth-first[engine]: no provider affordance yet — waiting for async render ` +
            `(retry ${state.oauthScanRetries}${oauthScanShell ? ", loading shell" : ""})`,
        );
        await this.browser.wait(3);
        continue;
      }
      if (preAct.kind === "oauth_shell_reload") {
        steps.push(`OAuth-first[engine]: page stuck as a loading shell — reloading once to unstick the SPA`);
        try {
          await this.browser.goto(this.browser.currentUrl());
          await this.browser.waitForFormReady();
        } catch {
          // reload failed — re-loop and let the terminal handling take over
        }
        continue;
      }
      if (preAct.kind === "sign_in_advance" && signInAdvance !== null) {
        steps.push(
          `OAuth-first: no provider affordance, but found a generic ` +
            `sign-in affordance (${JSON.stringify(signInAdvance.visibleText ?? signInAdvance.ariaLabel ?? "")}) ` +
            `— clicking it to advance to the real login page ` +
            `(${state.signInAdvanceClicks}/${B_FF.MAX_SIGN_IN_ADVANCE_CLICKS})`,
        );
        try {
          await this.browser.click(signInAdvance.selector);
        } catch (err) {
          steps.push(
            `OAuth-first[engine]: sign-in advance click failed (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        continue;
      }
      if (preAct.kind === "signup_link_advance" && signupLinkOnLoginPage !== null) {
        steps.push(
          `Form: login page exposes a signup affordance ` +
            `(${JSON.stringify(signupLinkOnLoginPage.visibleText ?? signupLinkOnLoginPage.ariaLabel ?? signupLinkOnLoginPage.href ?? "")}) ` +
            `— clicking it before filling credentials ` +
            `(${state.signupLinkAdvanceClicks}/${B_FF.MAX_SIGNUP_LINK_ADVANCE_CLICKS})`,
        );
        try {
          await this.browser.click(signupLinkOnLoginPage.selector);
          await this.browser.waitForFormReady();
        } catch (err) {
          steps.push(
            `Form[engine]: signup-link advance click failed (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        continue;
      }
      // preAct.kind === "run_planner" → fall through to the planner.

      let plan = planSimpleEmailOnlySignup(inventory);
      if (plan !== null) {
        steps.push("Plan: deterministic email-only signup form (no LLM call).");
      } else {
        steps.push("Asking planner to plan the signup form fill...");
        try {
          plan = await this.planSignupForm({
            service: task.service,
            url: browserState.url,
            inventory,
            screenshot: browserState.screenshot,
            ...(hint !== undefined ? { hint } : {}),
          });
        } catch (err) {
        // ── C2 plan_error ──
        const reason = err instanceof Error ? err.message : String(err);
        const isUpstreamBlip =
          /\b50[234]\b/.test(reason) ||
          /\bupstream_(?:error|unreachable)\b/i.test(reason) ||
          /\bnetwork error\b/i.test(reason);
        const pe = decideFormFillStep(state, { checkpoint: "plan_error", isUpstreamBlip, reason });
        state = pe.nextState;
        if (pe.action.kind === "terminal") return toPlanExec(pe.action.outcome);
        if (pe.action.kind === "blip_retry") {
          steps.push(`⚠ planner request hit a transient upstream blip (${reason}) — retrying`);
          await this.browser.wait(2);
          continue;
        }
        // replan (selector_not_in_inventory)
        steps.push(`⚠ plan rejected (${reason}) — re-planning`);
        hint =
          "Your previous plan used a selector not in the inventory. Use ONLY selectors copied verbatim from a `selector=` field.";
        continue;
      }
      }
      steps.push(
        `Plan: ${plan.actions.length} action(s), confidence=${plan.confidence}` +
          (plan.notes !== undefined ? ` — ${plan.notes}` : ""),
      );

      // ── C3 post_plan ──
      const planClickSelectors = plan.actions
        .filter((a) => a.kind === "click")
        .map((a) => a.selector);
      const planEditsAField = plan.actions.some(
        (a) => a.kind === "fill" || a.kind === "check" || a.kind === "select",
      );
      const pageSig =
        browserState.url + "§" + inventory.map((e) => e.selector).sort().join("|");
      const bySelector = new Map(inventory.map((e) => [e.selector, e]));
      const miss = await this.verifyPlan(plan, bySelector);
      const post = decideFormFillStep(state, {
        checkpoint: "post_plan",
        isDashboard: detectFormFillIsDashboard(plan),
        pageSig,
        planClickSelectors,
        planEditsAField,
        verifyMiss: miss,
        verifyMissNotCheckbox: miss !== null && miss.includes("not a checkbox"),
      });
      state = post.nextState;
      if (post.action.kind === "terminal") {
        if (post.action.outcome.kind === "planning_failed") {
          steps.push(`Form[engine]: post-plan → planning_failed (${post.action.outcome.reason})`);
        }
        return toPlanExec(post.action.outcome);
      }
      if (post.action.kind === "replan") {
        if (post.action.hintKind === "drop_the_check") {
          steps.push(`⚠ planned selectors did not verify (${miss}) — re-planning`);
          hint =
            `These selectors did not resolve correctly: ${miss}. Pick different inventory entries.` +
            " If the inventory has NO input of type=checkbox, OMIT the check" +
            " action entirely — do not substitute a link or a button. The" +
            " agreement may be implicit or pre-accepted.";
        } else {
          steps.push(`⚠ planned selectors did not verify (${miss}) — re-planning`);
          hint = `These selectors did not resolve correctly: ${miss}. Pick different inventory entries.`;
        }
        continue;
      }
      // post.action.kind === "execute_plan"
      await this.executePlan(plan, fillValues, identityFromEmail(task.email), steps, bySelector);

      // ── C4 post_execute ──
      const hadFill = plan.actions.some((a) => a.kind === "fill");
      const hadFieldEdit = plan.actions.some(
        (a) => a.kind === "fill" || a.kind === "check" || a.kind === "select",
      );
      const clickedEmailAffordance = plan.actions.some(
        (a) => a.kind === "click" && /\bemail\b/i.test(a.reason),
      );
      const wasCommitted = state.committedToEmailPath;
      const px = decideFormFillStep(state, {
        checkpoint: "post_execute",
        clickedEmailAffordance,
        planClickSelectors,
        hadFill,
        hadFieldEdit,
        planActionCount: plan.actions.length,
      });
      state = px.nextState;
      if (!wasCommitted && state.committedToEmailPath) {
        steps.push("Committed to email-fill path — auto-OAuth-first scan suppressed for the rest of this signup");
      }
      if (px.action.kind === "terminal") {
        steps.push(`Form[engine]: post-execute → planning_failed`);
        return toPlanExec(px.action.outcome);
      }
      if (px.action.kind === "replan") {
        const avoidHint =
          planClickSelectors.length > 0
            ? ` AVOID these selectors — they were clicked but the page did NOT advance: ${planClickSelectors.map((s) => JSON.stringify(s)).join(", ")}.`
            : "";
        steps.push(
          plan.actions.length === 0
            ? "Plan found nothing to act on — re-checking once for a late render"
            : "Plan only revealed the page — re-planning the now-visible form",
        );
        hint =
          "The previous step revealed or advanced the page. Plan the signup form that should now be visible." +
          avoidHint;
        continue;
      }
      // px.action.kind === "submit"
      const choiceBoxes = await this.browser.checkRequiredSignupChoiceBoxes();
      if (choiceBoxes.length > 0) {
        steps.push(`Form: checked required signup choice box(es): [${choiceBoxes.join(", ")}]`);
      }
      const agreementBoxes = await this.browser.checkRequiredAgreementBoxes();
      if (agreementBoxes.length > 0) {
        steps.push(`Form: checked required agreement box(es): [${agreementBoxes.join(", ")}]`);
      }

      // ── C4 post_submit: gather facts incrementally (the reducer's priority-order
      // checks make an early-blocking pre-gate correct even with default tails). ──
      const preGate = await this.runCaptchaGate("Pre-submit", steps);
      let submitError: string | null = null;
      let submitDisabled = false;
      let submitTimeout = false;
      let postGateBlocked = false;
      let postGateKind = "";
      let validationFailure = false;
      if (!preGate.blocked) {
        const submitSelector =
          pickEmailCodeSubmitSelector({
            inventory,
            htmlOrText: browserState.html,
            currentSubmitSelector: plan.submit_selector,
          }) ?? plan.submit_selector;
        if (submitSelector !== plan.submit_selector) {
          steps.push(`Form: corrected email-code submit selector ${plan.submit_selector} → ${submitSelector}`);
        }
        steps.push(`Submit → ${submitSelector}`);
        try {
          await this.browser.clickSubmit(submitSelector);
        } catch (err) {
          submitError = err instanceof Error ? err.message : String(err);
          submitDisabled = submitError.startsWith("submit_disabled");
          submitTimeout = !submitDisabled && isSubmitTimeout(submitError);
        }
        if (submitError === null) {
          await this.browser.wait(2);
          const postGate = await this.runCaptchaGate("Post-submit", steps);
          postGateBlocked = postGate.blocked;
          postGateKind = postGate.kind;
          if (!postGate.blocked && postGate.found && postGate.solved) {
            try {
              await this.browser.click(submitSelector);
              await this.browser.wait(3);
            } catch (err) {
              steps.push(
                `⚠ post-captcha submit retry failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (!postGate.blocked) {
            const afterText = (await this.browser.extractText()).slice(0, 4000);
            validationFailure =
              !expectsVerificationEmail(afterText) &&
              this.looksLikeValidationFailure(afterText);
            if (validationFailure) hint = `The previous submit produced validation errors. Visible page text: ${afterText.slice(0, 600)}`;
          }
        }
      }
      const ps = decideFormFillStep(state, {
        checkpoint: "post_submit",
        preGateBlocked: preGate.blocked,
        preGateKind: preGate.kind,
        submitError,
        submitDisabled,
        submitTimeout,
        postGateBlocked,
        postGateKind,
        hasInbox: task.inbox !== undefined,
        validationFailure,
      });
      state = ps.nextState;
      if (ps.action.kind === "replan") {
        if (ps.action.hintKind === "submit_disabled") {
          steps.push(`⚠ ${submitError} — re-planning to satisfy it`);
          hint = await this.buildSubmitDisabledHint(steps);
        } else if (ps.action.hintKind === "submit_went_stale") {
          steps.push(`⚠ submit selector went stale — the page likely advanced; re-planning`);
          hint =
            "The submit button selected last round was no longer present when " +
            "we tried to click it — an earlier action probably advanced the page. " +
            "Re-read the now-visible form and plan the next step (pick the submit " +
            "button that is actually on the current screen).";
        } else {
          steps.push("Post-submit validation errors — re-planning");
          // hint already set above from afterText
        }
        continue;
      }
      if (ps.action.kind === "terminal") {
        // Match the inline step trail: a genuine (non-disabled, non-timeout)
        // submit error logs "submit click failed" before failing.
        if (
          ps.action.outcome.kind === "submit_failed" &&
          submitError !== null &&
          !submitDisabled &&
          !submitTimeout
        ) {
          steps.push(`⚠ submit click failed: ${submitError}`);
        }
        if (ps.action.outcome.kind === "submitted" && postGateBlocked && postGateKind === "turnstile") {
          // managed-Turnstile + inbox flip: clear the recorded block so it can't
          // short-circuit a later gate, and capture the form rounds.
          steps.push(
            "Post-submit Turnstile token didn't populate — managed Turnstile resolves server-side; " +
              "proceeding to verification (the inbox poll arbitrates).",
          );
          this.captchaEncounter = undefined;
        }
        if (ps.action.outcome.kind === "submitted") {
          await this.captureSignupFormRounds(task.service, plan, inventory, fillValues);
        }
        return toPlanExec(ps.action.outcome);
      }
    }
  }

  // The submit_disabled replan hint CONTENT (review Q2 — the executor owns this;
  // the reducer only emits the intent). A fresh inventory snapshot lists concrete
  // unchecked-checkbox + empty-input candidates so the planner picks one
  // immediately. Best-effort: a snapshot failure falls back to the generic prose.
  private async buildSubmitDisabledHint(steps: string[]): Promise<string> {
    let uncheckedHint = "";
    let emptyInputHint = "";
    try {
      const snapshotInv = await this.buildInventory(steps, undefined, 60);
      const unchecked = snapshotInv.filter(
        (e) =>
          e.tag === "input" &&
          (e.type === "checkbox" || e.role === "checkbox") &&
          e.checked === false &&
          e.visible === true,
      );
      if (unchecked.length > 0) {
        const lines = unchecked.slice(0, 6).map((e) => {
          const label = (e.labelText ?? e.ariaLabel ?? e.placeholder ?? e.name ?? "(no label)").toString().slice(0, 60);
          return `  - selector ${JSON.stringify(e.selector)} label=${JSON.stringify(label)}`;
        });
        uncheckedHint = `\nUnchecked checkboxes visible on the page:\n${lines.join("\n")}`;
      }
      const emptyInputs = snapshotInv.filter(
        (e) =>
          e.tag === "input" &&
          e.type !== "checkbox" &&
          e.type !== "radio" &&
          e.type !== "hidden" &&
          (e.value === null || e.value === "") &&
          e.visible === true,
      );
      if (emptyInputs.length > 0) {
        const lines = emptyInputs.slice(0, 6).map((e) => {
          const label = (e.labelText ?? e.placeholder ?? e.ariaLabel ?? e.name ?? "(no label)").toString().slice(0, 60);
          return `  - selector ${JSON.stringify(e.selector)} label=${JSON.stringify(label)}`;
        });
        emptyInputHint = `\nEmpty visible inputs (any could be the unmet required field):\n${lines.join("\n")}`;
      }
    } catch {
      // best-effort
    }
    return (
      "The submit button is disabled — a required field or an agreement " +
      "was not satisfied. Issue {\"kind\":\"check\"} on an unchecked " +
      "agreement/terms checkbox, OR {\"kind\":\"fill\"} on an empty " +
      "required input. Do NOT click a link." +
      uncheckedHint +
      emptyInputHint
    );
  }

  // Emit the signup-form-fill rounds (email + password + submit) into the
  // capture chain. Shares this.captureChainRound with the post-verify loop
  // so the two phases form one contiguous 0..N chain. The captured email
  // value is templatized to ${EMAIL_ALIAS} by the synthesizer; the
  // generated throwaway password is baked literally (a fresh account each
  // replay, so reuse is harmless). Best-effort — capture must never fail a
  // signup.
  private async captureSignupFormRounds(
    service: string,
    plan: SignupPlan,
    inventory: InteractiveElement[],
    fillValues: Record<FillValueKind, string>,
  ): Promise<void> {
    try {
      const live = await this.browser.getState();
      // Stamp the STABLE signup-form URL (not the transient SPA URL the SPA
      // may have settled to mid-fill); the synthesizer derives signup_url
      // from round 0's url, and a fresh replay must land on the real form.
      const state = {
        ...live,
        url: this.resolvedSignupUrl ?? live.url,
      };
      const emit = (observed: PostVerifyStep): void => {
        captureOnboardingRound({
          service,
          round: this.captureChainRound,
          oauth: false,
          state,
          inventory,
          observed,
          // Fix C4 — the form-plan's backend (planSignupForm ran before
          // this synthetic preamble capture, so lastResolved* still reflect
          // it). These preamble rounds replay the one plan; one backend.
          ...(this.lastResolvedModel !== undefined ? { resolved_model: this.lastResolvedModel } : {}),
          ...(this.lastResolvedProvider !== undefined ? { resolved_provider: this.lastResolvedProvider } : {}),
        });
        this.captureChainRound += 1;
      };
      for (const action of plan.actions) {
        if (action.kind === "fill") {
          if (
            action.value_kind !== "email" &&
            action.value_kind !== "password" &&
            action.value_kind !== "phone"
          ) {
            continue;
          }
          emit({
            kind: "fill",
            selector: action.selector,
            value: fillValues[action.value_kind],
            reason: `Fill the signup ${action.value_kind}`,
          });
          continue;
        }
        if (action.kind === "select") {
          emit({
            kind: "select",
            selector: action.selector,
            ...(action.option_text !== undefined ? { option_text: action.option_text } : {}),
            reason: `Select the signup dropdown option`,
          });
        }
      }
      emit({
        kind: "click",
        selector: plan.submit_selector,
        reason: "Submit the signup form to dispatch the verification email",
      });
    } catch {
      // Capture is a synthesis input + forensic aid; never fatal.
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
  // rc.28 — click the first plausible account card on a Google
  // account-chooser page. Returns true on a successful click, false
  // when no card was identified. Used by the rc.25 stuck-on-chooser
  // post-OAuth gate to forward the flow off accounts.google.com
  // instead of immediately aborting.
  //
  // Google's chooser markup is consistent across surfaces: each
  // account renders as a clickable container with a data-identifier
  // attribute equal to the account's email, plus role="link" or
  // jsaction. The fallback is any element whose visible text
  // contains an @ — accounts always show their email.
  // Approve a basic "Sign in with Google" consent screen ("Allow <App> to
  // access this info about you" → Continue). Returns:
  //   "approved"    — basic consent, clicked Continue/Allow
  //   "non_basic"   — consent reaches beyond identity; caller must NOT auto-grant
  //   "not_consent" — not a consent screen (no Continue/Allow + access wording)
  //   "error"       — page unavailable
  // Mirrors tryClickGoogleChooserCard's direct-page approach. The safety gate
  // (googleGisConsentIsBasic) is the same conservative one the popup-flow
  // consent uses — only the basic identity grant is auto-approved.
  private async tryApproveGoogleConsentScreen(): Promise<
    "approved" | "non_basic" | "not_consent" | "error"
  > {
    try {
      const page = (
        this.browser as unknown as { page: import("playwright").Page | null }
      ).page;
      if (page === null || page === undefined) return "error";
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const looksLikeConsent =
        /to access this info about you|access your google account|wants (?:to )?access|allow .{1,40} to access/i.test(
          bodyText,
        ) && /\b(continue|allow)\b/i.test(bodyText);
      if (!looksLikeConsent) return "not_consent";
      if (!googleGisConsentIsBasic(bodyText)) return "non_basic";
      for (const name of [/^continue$/i, /^allow$/i]) {
        const btn = page.getByRole("button", { name }).first();
        try {
          await btn.waitFor({ state: "visible", timeout: 2_500 });
          await btn.click({ timeout: 3_000 });
          return "approved";
        } catch {
          continue;
        }
      }
      return "not_consent"; // basic scopes but no clickable Continue/Allow found
    } catch {
      return "error";
    }
  }

  private async tryClickGoogleChooserCard(targetEmail?: string): Promise<boolean> {
    try {
      const page = (
        this.browser as unknown as { page: import("playwright").Page | null }
      ).page;
      if (page === null || page === undefined) return false;
      const urlBefore = page.url();
      // Multi-account profile: if we know which account to sign up as AND the
      // chooser is showing it, click THAT card — not the first one blindly.
      // (Single-account profiles fall straight through to the generic path.)
      if (targetEmail !== undefined) {
        const identifiers = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll("[data-identifier]"))
              .map((e) => e.getAttribute("data-identifier") ?? "")
              .filter((s) => s.length > 0),
          )
          .catch(() => [] as string[]);
        const pick = pickChooserAccount(targetEmail, identifiers);
        if (pick !== null) {
          // Email values are safe inside a quoted attribute selector (no quotes
          // in an address). Match the exact account the caller asked for.
          const loc = page.locator(`[data-identifier="${pick}"]`).first();
          try {
            await loc.waitFor({ state: "visible", timeout: 2_000 });
            await loc.click({ timeout: 3_000 });
            if (process.env.BOT_DEBUG_CHOOSER) {
              await page.waitForTimeout(1500).catch(() => undefined);
              console.error(
                `[chooser-debug] matched account=${JSON.stringify(pick)} urlBefore=${urlBefore} urlAfter=${page.url()}`,
              );
            }
            return true;
          } catch {
            // Matched account but the click didn't take — fall through to the
            // generic first-card path rather than failing outright.
          }
        }
      }
      // First-choice selector: data-identifier on an interactive element.
      const candidates = [
        '[data-identifier]:visible',
        '[role="link"]:has-text("@")',
        'div[jsaction]:has-text("@")',
      ];
      for (const sel of candidates) {
        const loc = page.locator(sel).first();
        try {
          await loc.waitFor({ state: "visible", timeout: 2_000 });
          await loc.click({ timeout: 3_000 });
          if (process.env.BOT_DEBUG_CHOOSER) {
            await page.waitForTimeout(1500).catch(() => undefined);
            console.error(
              `[chooser-debug] matched sel=${JSON.stringify(sel)} urlBefore=${urlBefore} urlAfter=${page.url()}`,
            );
          }
          return true;
        } catch {
          continue;
        }
      }
      if (process.env.BOT_DEBUG_CHOOSER) {
        const dump = await page
          .evaluate(() => ({
            url: location.href,
            buttons: Array.from(document.querySelectorAll('[data-identifier],[role="link"],div[jsaction]'))
              .slice(0, 12)
              .map((e) => `${e.tagName}|${(e.getAttribute("data-identifier") ?? "").slice(0, 40)}|${(e.textContent ?? "").trim().slice(0, 50)}`),
          }))
          .catch(() => null);
        console.error(`[chooser-debug] NO selector matched. dump=${JSON.stringify(dump)}`);
      }
      return false;
    } catch {
      return false;
    }
  }

  // Which OAuth providers can the bot actually use right now. The LIVE browser
  // cookie jar is ground truth; logged-in-providers.json is only a memo used
  // when the live probe itself fails. A stale marker must not make the bot
  // prefer OAuth after the provider session expired.
  private async effectiveLoggedInProviders(): Promise<OAuthProviderId[]> {
    return new SignupOAuthFlow(this.browser, {
      loggedInProviders,
      markProviderLoggedIn,
      clearProviderLoggedIn,
    }).effectiveLoggedInProviders();
  }

  private async resolveOAuthCandidates(
    task: SignupTask,
    steps: string[],
  ): Promise<OAuthProviderId[]> {
    if (task.forceForm === true || this.committedToEmailPath) {
      steps.push(
        this.committedToEmailPath
          ? "Committed to email path (OAuth was login-only) — OAuth-first scan suppressed"
          : "Force-form: OAuth-first scan suppressed — taking the email/password path",
      );
      return [];
    }
    const provider = task.oauthProvider;
    const ordered = orderOAuthCandidates(
      provider,
      await this.effectiveLoggedInProviders(),
    );
    if (ordered.length === 0) return [];
    const pinNote = provider !== undefined ? ` (pinned ${provider})` : "";
    steps.push(
      `Auto-OAuth: candidates [${ordered.join(", ")}]${pinNote} — using whichever the page offers`,
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
  // loop uploads the current DOM + screenshot to the registry
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
  // Set when planExecuteWithRetry routes an email-verification WALL (reached
  // without a fresh submit — e.g. OAuth landed on a pending account's "Verify
  // your email — check <addr>" page) into the post-submit email flow. The poll
  // targets this alias (the one the wall names) instead of task.email.
  private pendingVerificationAlias: string | null = null;
  // rc.39 — when postVerifyLoop exits because the planner returned
  // `done`, capture the planner's stated reason so the caller can
  // factor it into paywall classification. Koyeb (and similar)
  // shows a billing wall whose page text doesn't match the
  // ONBOARDING_PAYWALL_PATTERNS regex set, but the planner accurately
  // reasons about it in the done reason ("requires credit card payment
  // to access the platform"). Mixing that into the paywall check
  // upgrades these from oauth_onboarding_failed → onboarding_blocked.
  private lastPostVerifyDoneReason: string | null = null;
  // Stashed at signup() entry so deep postVerifyLoop code (the
  // heightened-auth detector below) can fire notifyHeightenedAuth
  // without threading task through every method. Mirrors the
  // currentService pattern.
  private currentMachineToken: string | undefined = undefined;
  private currentApiBase: string | undefined = undefined;
  // Once per signup — fire the heightened-auth notifier at most one
  // time even if the planner returns done with a challenge phrasing
  // multiple times before the loop fully exits.
  private heightenedAuthFired = false;
  // Tier 3 captcha solver (2Captcha). Constructed eagerly so the
  // isAvailable() check in runCaptchaGate is cheap; opt-in via the
  // TWOCAPTCHA_API_KEY env var read at construction.
  private readonly captchaSolver?: TwoCaptchaSolver;

  constructor(
    private browser: BrowserController,
    llm?: LLMClient | LLMPair,
    opts: {
      extractFailureUploader?: ExtractFailureUploader;
      roundUploader?: RoundUploader;
      // Inject a pre-constructed solver — tests pass a stub that
      // returns canned tokens without hitting 2captcha.com.
      captchaSolver?: TwoCaptchaSolver;
      // Override Google's 2-step-verification wait timeout. Default
      // 120s (matches the human "unlock phone, open Google app, tap"
      // window). Tests pass a tiny value (e.g. 10ms) so they don't
      // wall-clock-burn through the full deadline waiting for a
      // FakeBrowser that's never going to advance its state.
      googleChallengeTimeoutMs?: number;
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
    this.captchaSolver = opts.captchaSolver ?? new TwoCaptchaSolver();
    if (opts.googleChallengeTimeoutMs !== undefined) {
      this.googleChallengeTimeoutMs = opts.googleChallengeTimeoutMs;
    }
  }

  // 0.8.3-rc.1 — widened from 2 → 4 minutes. The 2-min window forced
  // the operator to drop everything immediately on a Telegram alert.
  // For batch-harvest runs the operator is rarely staring at the
  // phone; 4 minutes gives realistic time to switch devices, unlock,
  // open the Google app, and tap. Matches the same wait window the
  // GitHub challenge path now uses.
  private googleChallengeTimeoutMs = 240_000;

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
    // Sampling temperature. The navigation/form planners pass 0 for
    // deterministic decisions (see docs/DESIGN-planner-navigation-eval.md);
    // omitted → provider default.
    temperature?: number;
    // Fix C — mark a NAVIGATION-PLANNER call. Forwarded to the proxy so it
    // pins a single model + backend provider + seed (temperature 0 alone
    // doesn't kill the model/provider-swap byte-flips). Set true by the
    // form + post-verify planners; left unset by every other call.
    deterministic?: boolean;
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
    temperature?: number;
    deterministic?: boolean;
  }): Promise<T | string> {
    const callOne = async (client: LLMClient): Promise<string> => {
      if (this.llmCallCount >= MAX_LLM_CALLS_PER_SIGNUP) {
        throw new LLMCallBudgetExceeded(MAX_LLM_CALLS_PER_SIGNUP);
      }
      // 0.8.2-rc.8 — count the call only AFTER the upstream actually
      // replied. The old code incremented before the proxy fetch which
      // means a proxy 502 (caught & surfaced after the 4-attempt retry
      // budget exhausts) cost the same budget unit as a real planner
      // reply. The rc.7 sentry batch run hit this: 2 upstream-blip
      // retries consumed 2 of the 15 calls on top of the 9 successful
      // post-verify rounds — the planner ran out of budget on the 8th
      // permission scope, 5 short of the API key. Failed calls produce
      // no progress; charging them against the budget is wrong. Behave
      // like a meter: only count consumption that actually delivered.
      // Text-only planner experiment (BOT_PLANNER_TEXT_ONLY, default-off).
      // The DOM inventory is the authoritative action space — the planner
      // may only pick a selector the bot supplied, so the screenshot can
      // never expand the move set. This strips the screenshot from
      // NAVIGATION-PLANNER calls (deterministic=true) ONLY, leaving genuine
      // vision calls (2SV number-read, on-screen key extraction) untouched,
      // to measure whether the image earns its latency + token cost.
      const plannerTextOnly =
        args.deterministic === true &&
        /^(1|true|on)$/i.test(process.env.BOT_PLANNER_TEXT_ONLY ?? "");
      const userBlocks = plannerTextOnly
        ? args.userBlocks.filter((b) => b.kind !== "image")
        : args.userBlocks;
      const resp = await client.createMessage({
        system: args.system,
        user: userBlocks,
        max_tokens: args.maxTokens,
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.deterministic === true ? { deterministic: true } : {}),
      });
      this.llmCallCount += 1;
      this.backendsUsed.push(resp.backend);
      // Fix C4 — remember the served model/provider so the capture sites
      // can stamp this round with what actually produced the plan.
      this.lastResolvedModel = resp.resolved_model;
      this.lastResolvedProvider = resp.resolved_provider;
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
    // Fresh per-run: don't let a prior run's email-path commitment leak.
    this.committedToEmailPath = false;
    this.oauthEmailFallbackTried = false;
    // Stash the service name so the diagnostic uploader (called from
    // deep inside postVerifyLoop after a failed extract) can label
    // the snapshot without us threading task through every method.
    this.currentService = task.service;
    this.lastPostVerifyDoneReason = null;
    // Stash for the post-verify heightened-auth notifier — the
    // detection point is deep inside postVerifyLoop where it sees
    // the planner's `done` reason naming a Google challenge. Same
    // path runOAuthFlow uses for the in-handshake case.
    this.currentMachineToken = task.machineToken;
    this.currentApiBase = task.apiBase;
    this.heightenedAuthFired = false;
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
    const identity = identityFromEmail(task.email);

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
      // A curated signupUrl (from the YAML queue) always wins. Otherwise
      // resolve via the model (promoted-skill signup_url → LLM → .com guess)
      // so non-.com products (xata.io, fly.io, …) don't die at navigation.
      const guessed =
        task.signupUrl ??
        (await resolveSignupUrl(task.service, this.llmPair.primary, {
          log: (m) => steps.push(m),
          ...(task.lookupSkillUrl !== undefined
            ? { lookupSkillUrl: () => task.lookupSkillUrl!(task.service) }
            : {}),
        }));
      let signupUrl = guessed;

      // Tier A — HTTP fast-path signup-URL resolver. Before committing to
      // the (~6-minute) navigation, probe the candidate over the SAME
      // proxy via the context request API and confirm it actually serves a
      // signup FORM (not a login SPA / 404). Curated signup_urls go stale
      // (plunk's app.useplunk.com/signup now 404s and silently serves the
      // login page; the real form moved to next-app.useplunk.com/auth/
      // signup). The probe follows redirects + tries conventional paths
      // and adopts a better URL when it finds one. Non-Google URLs only —
      // a Google-search URL is the explicit fallback path, not a hint.
      if (!isGoogleSearchUrl(signupUrl)) {
        const serviceSlug = task.service.toLowerCase().replace(/[^a-z0-9]/g, "");
        const resolved = await resolveSignupUrlByProbe(
          signupUrl,
          serviceSlug,
          (u) => this.browser.fetchText(u),
          (m) => steps.push(m),
        );
        if (resolved !== null && resolved !== signupUrl) {
          steps.push(`[signup-url] resolved ${signupUrl} → ${resolved}`);
          // A curated URL that the resolver had to move is a stale-YAML
          // signal worth surfacing in telemetry (curated URLs are
          // supposed to be the trusted, hand-verified path).
          if (task.signupUrl !== undefined) {
            steps.push(
              `⚠ curated signup_url for ${task.service} looks stale ` +
                `(${signupUrl}); using ${resolved}`,
            );
          }
          signupUrl = resolved;
        }
      }

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
      this.resolvedSignupUrl = signupUrl;
      await this.browser.goto(signupUrl);
      // Clear any anti-bot interstitial BEFORE the landing read below.
      // goto() only awaits domcontentloaded, so a Cloudflare "Verifying you
      // are human" / "Just a moment…" page is often still up — and the
      // already-signed-in / classify / OAuth-affordance decisions a few lines
      // down would then run against the interstitial's 2-element DOM and
      // misjudge the page. MEASURED 2026-06-09: perplexity's /settings/api
      // landed on a CF interstitial (inventory = just [Cloudflare, Privacy]),
      // so the bot saw no OAuth button, classified "other", and bailed
      // no_signup_link instead of reaching the real login/dashboard. The
      // later waitForFormReady in planExecuteWithRetry was too late. Best-
      // effort: a page with no interstitial returns fast.
      await this.browser.waitForFormReady().catch(() => undefined);

      // After load: does the rendered page look like a signup form?
      // looksLikeSignupPage() can't tell signup from login (both have
      // email+password), so we ALSO classify the rendered HTML's copy via
      // classifySignupHtml — that's what distinguishes the two.
      //
      // A curated task.signupUrl is no longer trusted blindly: it can land
      // on a login page (a stale path the SPA reroutes to /login). We
      // trigger recovery for BOTH guessed and curated URLs — but
      // conservatively for curated ones, to avoid regressing a good
      // curated URL: recover ONLY when the copy classifies as "login" or
      // "other" AND looksLikeSignupPage also disagrees. The structural
      // check is the backstop for an OAuth-only signup page ("Continue
      // with Google", no email/password copy) that classifySignupHtml
      // would otherwise read as "other". (A promoted-skill URL is replay-
      // verified and a guessed URL that's wrong is recovered here too.)
      let needsRecovery = false;
      // Set when the landing page is an already-authenticated dashboard — we
      // then route STRAIGHT to key extraction (the already_oauth dispatch
      // case) and skip the form-fill loop entirely. The loop's own
      // already-signed-in check runs on a ranked+capped inventory that drops
      // the low-ranked nav markers detectAlreadySignedIn keys on, so it
      // unreliably misses dashboards (anthropic) and the verification-wall
      // detector false-fires first. The full-inventory check below is the
      // reliable signal; act on it here, not in the loop.
      let alreadyAuthenticated = false;
      // Before any recovery: are we ALREADY authenticated for this service?
      // The operator's own session can be bound to the service (e.g.
      // Anthropic, where the bot rides the operator's account), so the
      // landing page is a dashboard with no signup CTA. Recovery would then
      // chase a non-existent signup page — Tier B finds no CTA, the Google
      // fallback finds no on-domain match — and bail `no_signup_link`
      // ("the service likely doesn't have a public self-serve signup"),
      // which is flatly wrong: we're simply logged in. Skip recovery and let
      // planExecuteWithRetry's OAuth-first scan detect the authenticated
      // state (already_oauth) and jump straight to key extraction — the same
      // post-verify path runOAuthFlow uses after a successful handshake.
      // detectAlreadySignedIn's precondition (no email/password/tel input
      // visible) makes this safe: a real signup/login page short-circuits to
      // false before any dashboard marker is considered.
      let landed = await this.browser.getState();
      let landedInventory = await this.browser.extractInteractiveElements();
      let signedIn = detectAlreadySignedIn({
        inventory: landedInventory,
        url: landed.url,
      });
      // SPA-settle re-check (returning-user cluster). An authenticated SPA
      // redirects the session AFTER the first read — pinecone's
      // `/?sessionType=signup` routes to `/organizations/registration` once
      // React hydrates — so a returning-user landing is initially captured as
      // an un-hydrated shell (no dashboard markers, no credential input yet)
      // and missed → no_signup_link. When the first detect is false, the page
      // is shell-like (few elements), AND there's no credential form rendered,
      // dwell once and re-read before classifying. Safe: a real login/signup
      // page renders its credential input or signup affordance, so
      // detectAlreadySignedIn stays false on the re-check (no false positive).
      if (!signedIn && landedInventory.length <= 4) {
        const hasCredInput = landedInventory.some(
          (e) =>
            e.tag === "input" &&
            (e.type === "email" || e.type === "password" || e.type === "tel"),
        );
        // Only a BARE shell (no credential form AND no OAuth/signup button)
        // is a returning-user-redirect candidate. A page that already shows a
        // provider button is a usable signup entry — take it as-is (and don't
        // perturb the OAuth-first flow with an extra settle).
        const hasOAuthHere =
          findFirstOAuthButton(landedInventory, ["google", "github"]) !== null;
        if (!hasCredInput && !hasOAuthHere) {
          await this.browser.wait(3);
          await this.browser.waitForInteractiveDom(5, 12_000).catch(() => undefined);
          const reLanded = await this.browser.getState();
          const reInv = await this.browser.extractInteractiveElements();
          if (detectAlreadySignedIn({ inventory: reInv, url: reLanded.url })) {
            landed = reLanded;
            landedInventory = reInv;
            signedIn = true;
            steps.push(
              `${task.service}: returning-user dashboard surfaced after SPA settle (${pathOf(reLanded.url)})`,
            );
          }
        }
      }
      if (signedIn) {
        steps.push(
          `${task.service}: already authenticated (dashboard markers, no signup CTA) — ` +
            `skipping signup, routing straight to key extraction`,
        );
        alreadyAuthenticated = true;
      } else if (task.signupUrl === undefined) {
        needsRecovery = !(await this.looksLikeSignupPage());
      } else {
        const klass = classifySignupHtml(landed.html);
        if (klass !== "signup" && !(await this.looksLikeSignupPage())) {
          // A "login"-classified page is still a valid signup ENTRY when it
          // offers OAuth: clicking "Continue with GitHub/Google" auto-
          // provisions the account on first use, and plenty of modern SPAs
          // (qdrant: cloud.qdrant.io/login) ship ONE unified page for both
          // login and signup. Only chase a separate signup page when there's
          // no OAuth affordance to ride — otherwise recovery falls through to
          // the Google-search fallback, which Google ERR_ABORTs through the
          // residential proxy, and the run dies on a page that would have
          // worked via OAuth.
          const oauthHere = findFirstOAuthButton(landedInventory, ["google", "github"]);
          if (process.env.BOT_DEBUG_CHOOSER) {
            console.error(
              `[login-entry-debug] ${task.service} klass=${klass} oauthHere=${oauthHere?.provider ?? "none"} ` +
                `inv(${landedInventory.length})=` +
                JSON.stringify(
                  landedInventory
                    .slice(0, 20)
                    .map((e) => `${e.tag}|${(e.visibleText ?? e.ariaLabel ?? "").slice(0, 36)}`),
                ),
            );
          }
          if (oauthHere !== null) {
            steps.push(
              `curated signup_url for ${task.service} rendered as "${klass}", but it offers ` +
                `${oauthHere.provider} OAuth — treating the login page as the signup entry`,
            );
          } else if (klass === "login" && task.oauthProvider !== undefined) {
            let loginEntry: InteractiveElement | null = null;
            for (const el of landedInventory) {
              const label = (el.visibleText ?? el.ariaLabel ?? el.labelText ?? "").trim().toLowerCase();
              if (
                label === "log in" ||
                label === "login" ||
                label === "sign in" ||
                label === "signin"
              ) {
                loginEntry = el;
                break;
              }
            }
            if (loginEntry !== null) {
              const dismissed = await this.browser.dismissConsentBanner();
              if (dismissed !== null) {
                steps.push(`[signup-url] dismissed cookie consent on curated login gate: "${dismissed}"`);
              }
              const label = loginEntry.visibleText ?? loginEntry.ariaLabel ?? "login";
              steps.push(
                `[signup-url] curated credential URL is login-gated — following "${label.slice(0, 40)}" to OAuth entry`,
              );
              try {
                await this.browser.click(loginEntry.selector);
                const loginState = await this.browser.getState();
                const loginInventory = await this.browser.extractInteractiveElements();
                const loginOAuth = findFirstOAuthButton(loginInventory, ["google", "github"]);
                if (loginOAuth !== null) {
                  signupUrl = this.browser.currentUrl();
                  landed = loginState;
                  landedInventory = loginInventory;
                  steps.push(
                    `[signup-url] recovered OAuth entry from curated login gate: ${signupUrl} (${loginOAuth.provider})`,
                  );
                } else {
                  needsRecovery = true;
                  steps.push(
                    `[signup-url] curated login gate did not expose OAuth after click — url=${loginState.url}`,
                  );
                }
              } catch (err) {
                needsRecovery = true;
                steps.push(
                  `[signup-url] curated login gate click failed (${err instanceof Error ? err.message : String(err)}) — attempting recovery`,
                );
              }
            } else {
              needsRecovery = true;
              steps.push(
                `curated signup_url for ${task.service} rendered as "${klass}", not a signup form — attempting recovery`,
              );
            }
          } else {
            needsRecovery = true;
            steps.push(
              `curated signup_url for ${task.service} rendered as "${klass}", not a signup form — attempting recovery`,
            );
          }
        }
      }

      if (needsRecovery) {
        if (task.signupUrl === undefined) {
          steps.push(
            `${signupUrl} didn't look like a signup page — attempting recovery`,
          );
        }

        // Tier B — landing-page CTA self-heal. Before the heavyweight
        // Google-search path, navigate to the site root and click the
        // highest-scored signup CTA (same scorer the planner uses). This
        // catches static-host SPAs that serve a 200 empty shell for every
        // path (so the HTTP probe can't tell signup from login) but DO
        // render a real "Sign up" CTA once the JS hydrates on the root.
        const root = originRoot(signupUrl);
        let recovered = false;
        if (root !== null) {
          steps.push(`[signup-url] Tier B: landing-page CTA at ${root}`);
          try {
            await this.runPrewarm(root, steps);
            await this.browser.goto(root);
            const dismissed = await this.browser.dismissConsentBanner();
            if (dismissed !== null) {
              steps.push(`[signup-url] Tier B dismissed cookie consent: "${dismissed}"`);
            }
            const inventory = await this.browser.extractInteractiveElements();
            // Score every interactive element's text; pick the best
            // signup CTA. Providers are driven negative by scoreSignupButton
            // (we want the email-signup affordance, not an OAuth button).
            let best: { el: InteractiveElement; score: number } | null = null;
            for (const el of inventory) {
              const label =
                el.visibleText ?? el.ariaLabel ?? el.iconLabel ?? el.title ?? "";
              if (label.trim().length === 0) continue;
              const score = scoreSignupButton(label, ["google", "github"]);
              if (best === null || score > best.score) best = { el, score };
            }
            if (best !== null && best.score > 0) {
              steps.push(
                `[signup-url] Tier B clicking CTA "${(best.el.visibleText ?? best.el.ariaLabel ?? "").slice(0, 40)}" (score ${best.score})`,
              );
              await this.browser.click(best.el.selector);
              const landedState = await this.browser.getState();
              const landed = landedState.html;
              const clickedInventory = await this.browser.extractInteractiveElements();
              const clickedOAuth = findFirstOAuthButton(clickedInventory, ["google", "github"]);
              const landedClass = classifySignupHtml(landed);
              if (landedClass === "signup" || clickedOAuth !== null) {
                const url = this.browser.currentUrl();
                steps.push(
                  clickedOAuth !== null
                    ? `[signup-url] Tier B recovered OAuth signup entry: ${url} (${clickedOAuth.provider})`
                    : `[signup-url] Tier B recovered signup page: ${url}`,
                );
                signupUrl = url;
                recovered = true;
              } else if (
                detectAlreadySignedIn({
                  inventory: clickedInventory,
                  url: landedState.url,
                })
              ) {
                const url = this.browser.currentUrl();
                steps.push(
                  `[signup-url] Tier B landed on an authenticated page after CTA click: ${url}`,
                );
                signupUrl = url;
                alreadyAuthenticated = true;
                recovered = true;
              } else {
                let loginCandidate: InteractiveElement | null = null;
                for (const el of clickedInventory) {
                  const label = (el.visibleText ?? el.ariaLabel ?? el.labelText ?? "").trim().toLowerCase();
                  if (
                    label === "log in" ||
                    label === "login" ||
                    label === "sign in" ||
                    label === "signin"
                  ) {
                    loginCandidate = el;
                    break;
                  }
                }
                if (landedClass === "login" && loginCandidate !== null) {
                  const label = loginCandidate.visibleText ?? loginCandidate.ariaLabel ?? "login";
                  steps.push(
                    `[signup-url] Tier B following login entry "${label.slice(0, 40)}" after CTA landed on login page`,
                  );
                  await this.browser.click(loginCandidate.selector);
                  const loginState = await this.browser.getState();
                  const loginInventory = await this.browser.extractInteractiveElements();
                  const loginOAuth = findFirstOAuthButton(loginInventory, ["google", "github"]);
                  if (
                    loginOAuth !== null ||
                    classifySignupHtml(loginState.html) === "signup" ||
                    detectAlreadySignedIn({ inventory: loginInventory, url: loginState.url })
                  ) {
                    const url = this.browser.currentUrl();
                    steps.push(
                      loginOAuth !== null
                        ? `[signup-url] Tier B recovered OAuth entry after login click: ${url} (${loginOAuth.provider})`
                        : `[signup-url] Tier B recovered login/signup entry after login click: ${url}`,
                    );
                    signupUrl = url;
                    alreadyAuthenticated = loginOAuth === null && detectAlreadySignedIn({ inventory: loginInventory, url: loginState.url });
                    recovered = true;
                  }
                }
                const labelPreview = clickedInventory
                  .map((el) =>
                    (el.visibleText ||
                      el.ariaLabel ||
                      el.labelText ||
                      el.placeholder ||
                      el.name ||
                      el.selector ||
                      "")
                      .replace(/\s+/g, " ")
                      .trim(),
                  )
                  .filter((label) => label.length > 0)
                  .slice(0, 8)
                  .join(" | ");
                if (!recovered) {
                  steps.push(
                    `[signup-url] Tier B click did not reach a signup form — url=${landedState.url} class=${landedClass} oauth=none buttons=${labelPreview || "none"} — falling through to search`,
                  );
                }
              }
            } else {
              steps.push(
                `[signup-url] Tier B found no scoring signup CTA on ${root}`,
              );
            }
          } catch (err) {
            steps.push(
              `[signup-url] Tier B failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Final fallback — the existing Google-search + findSignupLink
        // path, unchanged. Only when Tier B didn't recover.
        if (!recovered) {
          const fallbackSearch = `https://www.google.com/search?q=${encodeURIComponent(`${task.service} signup`)}`;
          await this.browser.goto(fallbackSearch);
          // PERF: domcontentloaded from goto() + findSignupLink reads
          // the DOM itself — no blind dwell needed.
          signupUrl = fallbackSearch;
        }
      }

      if (isGoogleSearchUrl(signupUrl)) {
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
          return {
            success: false,
            error:
              `no_signup_link: searched for ${task.service}'s signup page and ` +
              `found no on-domain candidates. Likely causes: you already have an ` +
              `account and the bot landed on a logged-in dashboard with no signup ` +
              `CTA (the already-authenticated detector didn't recognize this ` +
              `dashboard's markers); the service has no public self-serve signup; ` +
              `or the bot's domain guard rejected every match. Sign up manually, ` +
              `or extract the key from the existing session.`,
            steps,
            ...this.resultTail(),
          };
        }
      }

      // Steps 2-5: plan the form, fill it, submit — via the
      // verify-and-replan loop (F3). The planner picks selectors from
      // a DOM-grounded element inventory; a bad pick re-plans instead
      // of cascading through 10s timeouts to total failure.
      const fillValues: Record<FillValueKind, string> = {
        email: task.email,
        password,
        name: identity.displayName,
        username: identity.username,
        company: `${identity.lastName} Labs`,
        phone: "6502530000",
        // `literal` has no fixed value — resolved per-action.
        literal: "",
      };
      // `outcome` is re-computed when the OAuth path signals a form-fill
      // fall-back (Google login-only / no-account, e.g. plunk): the
      // `case "oauth"` handler re-runs planExecuteWithRetry with OAuth-
      // first suppressed and loops back through this same switch, so
      // every terminal case (submitted, planning_failed, …) stays in one
      // place. Bounded to a single re-route so a service that keeps
      // bouncing can't spin here.
      // Already authenticated (full-inventory check above): skip the form-fill
      // loop and hand straight to the already_oauth case, which extracts /
      // mints the key from the existing session. Going through the loop would
      // re-detect on a capped inventory (missing the nav markers), false-fire
      // the verification-wall detector, and never reach key extraction.
      let outcome: PlanExecOutcome = alreadyAuthenticated
        ? { kind: "already_oauth" }
        : await this.planExecuteWithRetry(task, fillValues, steps);
      let oauthFallbackUsed = false;
      // Guards the Google-GSI-dead-end → next-provider (GitHub) retry so a
      // page offering both providers can't ping-pong between them.
      let oauthProviderFallbackUsed = false;
      // Multi-step signup guard (amplitude: email/name step → a dedicated
      // "Create your password" step). Bounds how many continuation form steps
      // we'll fill after the first submit before treating the signup as done.
      let multiStepRounds = 0;
      const MAX_MULTI_STEP_ROUNDS = 3;
      dispatch: for (;;) {
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
        case "oauth": {
          // T6/T7 — OAuth-first path. runOAuthFlow drives the consent
          // handshake and post-OAuth onboarding to its own terminal
          // SignupResult; there is no form submit / email verification.
          const oauthResult = await this.runOAuthFlow(
            task,
            outcome.selector,
            outcome.provider,
            steps,
          );
          // Google GSI/FedCM dead end → retry via the alternate provider
          // (GitHub redirect flow) the page also offers. Once only.
          if (isOAuthTryNextProvider(oauthResult)) {
            if (oauthProviderFallbackUsed) {
              return {
                success: false,
                error:
                  `oauth_required: ${task.service}'s Google sign-in is FedCM-only (the dialog never ` +
                  `renders for the bot) and the ${oauthResult.provider} fall-back also did not complete.`,
                steps,
                ...this.resultTail(),
              };
            }
            oauthProviderFallbackUsed = true;
            steps.push(
              `OAuth: retrying via ${oauthResult.provider} after Google GSI/FedCM dead-end.`,
            );
            outcome = {
              kind: "oauth",
              selector: oauthResult.selector,
              provider: oauthResult.provider,
            };
            continue dispatch;
          }
          // Google login-only / no-account (plunk): OAuth is a dead end
          // but the email/password form can still create the account.
          // Re-run the form-fill path ONCE with OAuth-first suppressed
          // (forceFormFill) — re-navigate to the signup form first since
          // the OAuth flow left us on the service's /login page — then
          // loop back through this switch to dispatch the new outcome.
          if (oauthResult === OAUTH_FALL_BACK_TO_FORM_FILL) {
            if (oauthFallbackUsed) {
              // Already fell back once and OAuth came up again — refuse
              // to ping-pong. Surface the dead end honestly.
              return {
                success: false,
                error:
                  `oauth_required: ${task.service}'s OAuth is login-only (no account for this ` +
                  `identity) and the email/password fall-back did not complete a signup.`,
                steps,
                ...this.resultTail(),
              };
            }
            oauthFallbackUsed = true;
            // If the OAuth recovery already left us ON a signup form (the
            // amplitude demo-escape clicked "Create a free account" → the real
            // /signup form), fill it IN PLACE — re-navigating to task.signupUrl
            // could bounce back to the demo. Otherwise re-navigate (the
            // login-only / no-account case left us on a /login page).
            // OAuth was login-only (no account for this identity). Commit to the
            // email path for the rest of the run so the dispatch loop's
            // OAuth-first scan doesn't re-click Google and loop.
            this.committedToEmailPath = true;
            const onSignupFormHtml =
              (await this.browser.getState().catch(() => null))?.html ?? "";
            if (classifySignupHtml(onSignupFormHtml) === "signup") {
              steps.push(
                `OAuth recovery already on a signup form ` +
                  `(${pathOf(this.browser.currentUrl())}) — filling in place.`,
              );
            } else {
              const formUrl = task.signupUrl ?? this.browser.currentUrl();
              steps.push(
                `Re-routing to email/password signup at ${formUrl} after OAuth no-account.`,
              );
              await this.browser.goto(formUrl);
            }
            outcome = await this.planExecuteWithRetry(
              task,
              fillValues,
              steps,
              /* forceFormFill */ true,
            );
            continue dispatch;
          }
          return oauthResult;
        }
        case "already_oauth": {
          // F17 — page rendered an authenticated dashboard (a
          // previous OAuth bind already linked the account). Skip
          // consent + form-fill, navigate straight to the API key.
          // Uses the same post-OAuth loop runOAuthFlow uses after a
          // successful handshake.
          let credentials = await this.extractCredentials();
          const skippedPostVerify = hasUsableCredentialBundle(credentials);
          if (!hasUsableCredentialBundle(credentials)) {
            credentials = await this.postVerifyLoop({
              service: task.service,
              maxRounds: task.postVerifyMaxRounds ?? 24,
              steps,
              ...(task.oauthAccountEmail !== undefined ? { oauthAccountEmail: task.oauthAccountEmail } : {}),
              ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
              ...(task.machineToken !== undefined ? { machineToken: task.machineToken } : {}),
              ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
            });
          }
          if (hasUsableCredentialBundle(credentials)) {
            // 0.8.3-rc.1 — when extractCredentials short-circuited
            // before postVerifyLoop ran, no captures were written.
            // Emit a synthetic extract round so auto-promote can
            // build a "navigate + extract" skill from this run.
            if (skippedPostVerify) {
              await this.writeFastPathSyntheticCapture(
                task.service,
                0,
                true,
              );
            }
            return {
              success: true,
              credentials,
              steps,
              ...this.resultTail(),
            };
          }
          // 0.8.2-rc.10 — same sentinel-pattern routing the runOAuthFlow
          // path uses. The post-verify loop sets lastPostVerifyDoneReason
          // with [stuck_loop] or [existing_account_no_extract] markers
          // when it bails on a planner-loop or pre-existing-key state;
          // surface those distinctly rather than as the generic
          // no_credentials_after_already_signed_in.
          if (
            this.lastPostVerifyDoneReason !== null &&
            this.lastPostVerifyDoneReason.startsWith("[stuck_loop]")
          ) {
            return {
              success: false,
              error:
                `planner_stuck: ${task.service}'s dashboard re-picked the same step repeatedly ` +
                `with no inventory change and the bot's hardcoded API-key URL fallbacks did not ` +
                `advance the page — finish the signup manually.`,
              steps,
              ...this.resultTail(),
            };
          }
          if (
            this.lastPostVerifyDoneReason !== null &&
            this.lastPostVerifyDoneReason.startsWith("[existing_account_no_extract]")
          ) {
            return {
              success: false,
              error:
                `existing_account_no_extract: ${task.service}'s dashboard shows pre-existing API ` +
                `keys for this identity but the values are masked and unrecoverable — wipe the ` +
                `test identity's account on ${task.service} or sign in manually and reveal the key.`,
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
          case "submitted": {
            // Multi-step signup: a clean submit can land on ANOTHER form step
            // (amplitude: a dedicated "Create your password" page) rather than
            // the dashboard or a verify-email screen. Detect a continuation
            // form step and run the fill-submit phase again on it, bounded,
            // before treating the submit as done — otherwise the post-submit
            // logic below polls the inbox for a verification email the
            // half-finished signup never triggers. Conservative (a visible
            // empty password input + a submit control, NOT a login or
            // check-your-email page), so a genuine email-verification flow
            // isn't mistaken for a form step.
            if (multiStepRounds < MAX_MULTI_STEP_ROUNDS) {
              const stepLabel = await this.detectContinuationFormStep();
              if (stepLabel !== null) {
                multiStepRounds += 1;
                steps.push(
                  `Post-submit: continuation form step detected (${stepLabel}) — ` +
                    `filling + submitting (step ${multiStepRounds + 1}).`,
                );
                this.committedToEmailPath = true;
                outcome = await this.planExecuteWithRetry(
                  task,
                  fillValues,
                  steps,
                  /* forceFormFill */ true,
                );
                continue dispatch;
              }
            }
            break dispatch;
          }
        }
      }
      await saveDebugSnapshot(this.browser, "after-submit");

      // Step 6: Extract creds from page.
      steps.push("Extracting credentials from page...");
      let credentials = await this.extractCredentials();

      // Step 7: Email verification + post-verification navigation.
      let verificationFailed: string | undefined;
      if (credentials.api_key === undefined && credentials.username === undefined) {
        // S3: read the post-submit page to decide both the no-inbox bail
        // (M2) and, when an inbox exists, the poll duration. The page is
        // read up to TWICE: once immediately, then — only if the first
        // read was inconclusive — again after a short settle, because SPA
        // signups render the "check your email" screen a beat after submit
        // and sampling once races that render (the bug behind the
        // Postmark/ElevenLabs/Browserbase/Grafana false `verification_not_sent`).
        let postSubmitText = await this.browser.extractText();
        let expectsEmail = expectsVerificationEmail(postSubmitText);
        if (!expectsEmail && !submitWasRejected(postSubmitText)) {
          await this.browser.wait(SUBMIT_SETTLE_SECONDS);
          postSubmitText = await this.browser.extractText();
          expectsEmail = expectsVerificationEmail(postSubmitText);
        }
        // A clean submit that did NOT visibly reject created an account —
        // verification mail is plausibly inbound even without a "check
        // your email" screen. Distinguish that from a rejected submit
        // (already-registered, validation error) where no mail is coming.
        const submitRejected = submitWasRejected(postSubmitText);
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
          // S3: don't blind-wait, but don't under-poll a clean submit
          // either. Three cases:
          //   - page says "check your email"  → full timeout (mail is
          //     definitely coming).
          //   - submit visibly rejected       → 45s probe (no account was
          //     created; no mail is coming).
          //   - inconclusive but submit clean → 120s floor (an account was
          //     created, so transactional mail is plausibly inbound and
          //     can outlast the 45s probe; bounded below the full timeout).
          const verificationTimeoutSeconds = expectsEmail
            ? (task.verificationTimeoutSeconds ?? VERIFY_EMAIL_CEILING_SECONDS)
            : submitRejected
              ? VERIFICATION_PROBE_SECONDS
              : SUBMITTED_PROBE_FLOOR_SECONDS;
          steps.push(
            expectsEmail
              ? `Post-submit page asks to check email — polling inbox (up to ${verificationTimeoutSeconds}s)...`
              : submitRejected
                ? `Post-submit page shows a rejected submit — short ${verificationTimeoutSeconds}s probe (S3: no account created, no verification email expected)...`
                : `Post-submit page is inconclusive but submit was clean — polling inbox up to ${verificationTimeoutSeconds}s (S3: an account may have been created and mail can lag)...`,
          );
          try {
            const email = await this.waitForVerificationEmail(
              task.inbox,
              this.pendingVerificationAlias ?? task.email,
              verificationTimeoutSeconds,
            );
            steps.push(`Received: "${email.subject}" from ${email.from_address}`);

            if (email.parsed_links.length > 0 || (email.body_html ?? "") !== "") {
              // URL-keyword scorer first; if it can't see past a click-tracker
              // wrapper, fall back to matching the link's ANCHOR TEXT in the
              // HTML body (amplitude's SendGrid-wrapped "Activate account").
              // The service's own host — for the same-domain link fallback
              // below. The current page IS the service (its confirm-email
              // wall), so its URL is the most reliable source; task.signupUrl
              // backs it up.
              let serviceHost: string | null = null;
              try {
                serviceHost = new URL((await this.browser.getState()).url).hostname;
              } catch {
                /* fall through to signupUrl */
              }
              if (serviceHost === null && task.signupUrl !== undefined) {
                try {
                  serviceHost = new URL(task.signupUrl).hostname;
                } catch {
                  /* leave null */
                }
              }
              const verifyLink =
                this.pickVerificationLink(Array.from(email.parsed_links)) ??
                pickVerificationLinkFromHtml(email.body_html ?? "") ??
                pickServiceDomainLink(Array.from(email.parsed_links), serviceHost);
              if (verifyLink !== null) {
                // Firebase email-action link → verify via the REST API
                // IMMEDIATELY (clean ms-latency POST) instead of the browser
                // SPA, which (portkey, 2026-06-17) landed on "link expired".
                // This races a short oobCode TTL, issues the single-use code
                // once, AND diagnoses: an EXPIRED error here proves the code is
                // dead at receipt (mail-pipeline latency), not a browser bug.
                const fbAction = parseFirebaseEmailAction(verifyLink);
                let firebaseVerified = false;
                if (fbAction !== null) {
                  const r = await applyFirebaseEmailVerification(
                    fbAction.apiKey,
                    fbAction.oobCode,
                  );
                  firebaseVerified = r.ok;
                  steps.push(
                    r.ok
                      ? `Verified the email directly via Firebase REST (${r.email ?? "account"} now verified) — bypassing the browser link.`
                      : `Firebase REST verify did not succeed (${r.error ?? "unknown"}) — oobCode appears dead at receipt; falling back to the browser link.`,
                  );
                }
                if (firebaseVerified) {
                  // Email verified server-side → go to the app and log in
                  // (two-stage aware); extraction below then reaches the key.
                  try {
                    await this.browser.goto(new URL(verifyLink).origin);
                    await this.browser.wait(2);
                    await this.loginWithCredentials(task.email, password, steps);
                    await this.browser.wait(2);
                  } catch (err) {
                    steps.push(
                      `Post-Firebase-verify login errored (non-fatal): ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                } else {
                steps.push(`Following verification link: ${verifyLink}`);
                await this.browser.goto(verifyLink);
                // PERF: a 1s settle is enough for the verify landing
                // page to commit cookies + render the post-verify
                // dashboard. Previous 3s was over-cautious.
                await this.browser.wait(1);
                await saveDebugSnapshot(this.browser, "after-verify");

                // Verify-link SPA bounce (MEASURED 2026-06-09: amplitude). The
                // emailed link is a click-tracker that redirects to
                // app.amplitude.com/signup?token=… — the token IS consumed
                // server-side, but the single-page app still renders the
                // "check your email" wall until the client re-fetches session
                // state. The post-verify loop then can't get past it. A single
                // reload makes the SPA re-read the now-verified session.
                // Bounded + guarded on the wall still showing, so a service
                // that verified cleanly pays nothing.
                try {
                  const afterText = await this.browser.extractText();
                  if (expectsVerificationEmail(afterText)) {
                    steps.push(
                      "Verification link landed but the page still shows the email-verify wall — reloading so the SPA re-reads the verified session.",
                    );
                    await this.browser.reload();
                    await this.browser.wait(2);
                  }
                } catch {
                  // best-effort — fall through to extraction regardless
                }

                // Expired/used single-use verification link (portkey,
                // 2026-06-17). A fresh Firebase oobCode that reads "expired" on
                // first touch was consumed upstream by a mail link-scanner —
                // which ALSO ran the verification server-side, so the email is
                // already verified. Don't fail: log in with the signup
                // credentials (the account is ready) and let the extraction +
                // post-verify loop below reach the key. Generalizes to every
                // single-use verify-link flow (Firebase et al.).
                try {
                  const linkText = await this.browser.extractText();
                  if (verificationLinkFailed(linkText)) {
                    steps.push(
                      "Verification link reported expired/used — a single-use link is typically burned by an upstream mail scanner, which also completes verification server-side. Treating the email as verified and logging in with the signup credentials.",
                    );
                    const origin = new URL(verifyLink).origin;
                    await this.browser.goto(origin);
                    await this.browser.wait(2);
                    await this.loginWithCredentials(task.email, password, steps);
                    await this.browser.wait(2);
                  }
                } catch (err) {
                  steps.push(
                    `Post-expiry login attempt errored (non-fatal): ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
                } // end browser-link fallback (non-Firebase path)

                // Try extracting first — many services drop the API key
                // straight onto the landing page after verification.
                credentials = await this.extractCredentials();

                // If no creds yet, run the Claude-planned navigation loop.
                if (credentials.api_key === undefined && credentials.username === undefined) {
                  // 24 (not 6) — same multi-step onboarding wizard the OAuth
                  // path budgets for; see the enterEmailVerificationCode note.
                  const maxRounds = task.postVerifyMaxRounds ?? 24;
                  credentials = await this.postVerifyLoop({
                    service: task.service,
                    credentials: { email: task.email, password },
                    maxRounds,
                    steps,
                    ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
                    ...(task.machineToken !== undefined ? { machineToken: task.machineToken } : {}),
                    ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
                  });
                }
              } else if (email.parsed_codes.length > 0) {
                credentials = await this.enterEmailVerificationCode(
                  email.parsed_codes[0] ?? "",
                  task,
                  password,
                  steps,
                );
              } else {
                // No link and the inbox parser found no code — last-resort
                // scan the email body ourselves for a verification code
                // (passwordless "we emailed you a code" flow, e.g. axiom).
                const bodyCode = extractCodeFromEmailBody(email, task.email);
                if (bodyCode !== null) {
                  steps.push(
                    `Email had no link but carried a verification code (…${bodyCode.slice(-2)}) — entering it.`,
                  );
                  credentials = await this.enterEmailVerificationCode(
                    bodyCode,
                    task,
                    password,
                    steps,
                  );
                } else {
                  // Diagnostic (arize, 2026-06-17): the email arrived but
                  // neither scorer found a usable link and no code parsed —
                  // dump the candidate hrefs so the next run shows WHY (e.g. an
                  // image-only button, or anchor text the scorer doesn't weight).
                  const hrefs = email.parsed_links.slice(0, 8).join(" | ");
                  steps.push(
                    `Email had no usable verification link or code. parsed_links(${email.parsed_links.length}): ${hrefs || "(none)"}`,
                  );
                }
              }
            } else if (email.parsed_codes.length > 0) {
              // No links at all, but the email carries a numeric code
              // (plausible: "Enter 4011 to verify your email address").
              // The signup page transitioned to a code-input step after
              // submit — type the code in rather than waiting for a link.
              credentials = await this.enterEmailVerificationCode(
                email.parsed_codes[0] ?? "",
                task,
                password,
                steps,
              );
            } else {
              steps.push("Email had no parsed links or codes — skipping verification.");
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            steps.push(`Inbox poll failed: ${detail}`);
            verificationFailed = expectsEmail
              ? `verification_not_sent: form submitted and the page asked to check email, but none arrived in ${verificationTimeoutSeconds}s — the service likely withheld it (anti-abuse) or requires manual signup`
              : submitRejected
                ? `verification_not_sent: form submitted but the page reported a rejected submit (already-registered / validation error) and no mail arrived in the ${verificationTimeoutSeconds}s probe — no account was created`
                : `verification_not_sent: form submitted cleanly but no "check your email" prompt appeared and none arrived in ${verificationTimeoutSeconds}s — the service likely withheld it (fresh-domain anti-abuse) or verifies by another channel (SMS / authenticator)`;
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

      // Before the generic no-credentials miss: a service that completed the
      // signup form and then dropped the account into a manual-approval gate
      // (waiting room / waitlist / pending review). Same terminal, non-demoting
      // onboarding_blocked status the OAuth path uses — there's no key to reach
      // until a human approves the account, so don't surface it as a generic
      // failure (which can wrongly chase a code bug) or punish a skill for it.
      //
      // ONLY when verification did NOT time out. A pending email-verification
      // page ("check your email", "we sent a code") can read as a review gate
      // to the classifier, but the authoritative cause there is the missing
      // mail (verification_not_sent) — anthropic mislabeled as onboarding_blocked
      // exactly this way. If we were waiting on an email that never came, that
      // is the failure; don't reinterpret it as a manual-review gate.
      const reviewGateText =
        verificationFailed === undefined ? await this.browser.extractText().catch(() => "") : "";
      // Closed / invite-only registration takes precedence over the review-gate
      // and the generic miss — no account can be created, so it's terminally
      // unservable (dequeue), not a fixable nav bug. Checked only when
      // verification didn't time out (same reasoning as the review gate).
      if (verificationFailed === undefined && isSignupsClosed(reviewGateText)) {
        return {
          success: false,
          error:
            `signups_closed: ${task.service} is not accepting new self-serve sign-ups ` +
            `(closed / invite-only registration) — no account can be created. Dequeue or sign up manually once open.`,
          steps,
          ...this.resultTail(),
        };
      }
      if (isOnboardingReviewGate(verificationFailed, reviewGateText)) {
        return {
          success: false,
          error:
            `onboarding_blocked: ${task.service} put the account into a manual review / ` +
            `waitlist gate after signup — no API key is obtainable until a human approves ` +
            `the account. Finish the signup manually once access is granted.`,
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
    // Sentinel: when the post-OAuth page reveals the Google identity has
    // no account (login-only OAuth, e.g. plunk), the flow returns
    // OAUTH_FALL_BACK_TO_FORM_FILL instead of a terminal SignupResult so
    // the caller re-runs the email/password form-fill path. Returning a
    // sentinel (vs. driving form-fill from in here) keeps the single
    // outcome-dispatch switch in runSignup as the one place that owns it.
  ): Promise<SignupResult | typeof OAUTH_FALL_BACK_TO_FORM_FILL | OAuthTryNextProvider> {
    const provider = OAUTH_PROVIDERS[providerId];
    // `loginCmd` is only ever surfaced from a CHALLENGE / needs_login
    // abort — i.e. the bot HAS a session cookie but the provider is
    // gating it (GitHub "verify it's you" / forced-2FA, Google device
    // drift). In exactly that state a bare `login` short-circuits with
    // "Already signed in" and never opens the browser, so the operator
    // can't clear the challenge. `--force-relogin` forces the browser
    // (noVNC) open regardless of the cached session — so every message
    // that points at loginCmd must include it.
    const loginCmd =
      provider.id === "github"
        ? "npx @trusty-squire/mcp login --provider=github --force-relogin"
        : "npx @trusty-squire/mcp login --force-relogin";
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
      if (captcha.found && captcha.solved) {
        steps.push(
          `OAuth: ticked the visible ${captcha.kind} checkbox before clicking the ${provider.label} affordance`,
        );
      } else if (captcha.found && !captcha.solved) {
        // Tier-2 click-and-wait timed out. For reCAPTCHA v2 this is the
        // SAME state the form-submit gate (runCaptchaGate) recovers from
        // by escalating to the third-party solver — mirror that path here
        // so OAuth-first flows aren't left clicking a Google button that
        // the service keeps gated behind an unsolved checkbox (replit,
        // uploadcare). Turnstile is deliberately NOT escalated: Cloudflare
        // scores at the IP layer, so a solver-issued token is rejected
        // anyway and only burns the 2Captcha balance.
        let solvedViaTier3 = false;
        if (captcha.kind === "recaptcha" && this.captchaSolver?.isAvailable() === true) {
          const sitekey = await this.browser.extractRecaptchaSitekey();
          const pageUrl = (await this.browser.getState().catch(() => null))?.url;
          if (sitekey !== null && pageUrl !== undefined) {
            steps.push(
              `OAuth: Tier 3 — submitting reCAPTCHA sitekey to 2Captcha (${sitekey.slice(0, 10)}…)`,
            );
            const solveRes = await this.captchaSolver.solveRecaptchaV2({ sitekey, pageUrl });
            if (solveRes.kind === "ok") {
              const injected = await this.browser.injectRecaptchaToken(solveRes.token);
              if (injected) {
                solvedViaTier3 = true;
                steps.push(
                  `OAuth: Tier 3 solved the reCAPTCHA in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha — clicking the ${provider.label} affordance`,
                );
              } else {
                steps.push(
                  `OAuth: Tier 3 token arrived but page injection failed — clicking the ${provider.label} affordance anyway`,
                );
              }
            } else {
              steps.push(
                `OAuth: Tier 3 ${solveRes.kind}` +
                  ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
                  ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : "") +
                  ` — clicking the ${provider.label} affordance anyway`,
              );
            }
          }
        }
        // hCaptcha Tier-3 — the OAuth-first path historically only escalated
        // reCAPTCHA, so an hCaptcha-gated OAuth button (MEASURED 2026-06-09:
        // supabase) timed out at Tier-2 and the bot then clicked a button
        // still hidden behind the unsolved widget → 20s waitFor crash. The
        // form-fill gate (runCaptchaGate) already solves hCaptcha via 2Captcha;
        // mirror it here. Unlike Turnstile, hCaptcha is a real image challenge
        // 2Captcha can solve, and its token is NOT IP-scored.
        if (
          !solvedViaTier3 &&
          captcha.kind === "hcaptcha" &&
          this.captchaSolver?.isAvailable() === true
        ) {
          const sitekey = await this.browser.extractHcaptchaSitekey();
          const pageUrl = (await this.browser.getState().catch(() => null))?.url;
          if (sitekey !== null && pageUrl !== undefined) {
            steps.push(
              `OAuth: Tier 3 — submitting hCaptcha sitekey to 2Captcha (${sitekey.slice(0, 10)}…)`,
            );
            const solveRes = await this.captchaSolver.solveHcaptcha({ sitekey, pageUrl });
            if (solveRes.kind === "ok") {
              const injected = await this.browser.injectHcaptchaToken(solveRes.token);
              if (injected) {
                solvedViaTier3 = true;
                steps.push(
                  `OAuth: Tier 3 solved the hCaptcha in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha — clicking the ${provider.label} affordance`,
                );
              } else {
                steps.push(
                  `OAuth: Tier 3 hCaptcha token arrived but page injection failed — clicking the ${provider.label} affordance anyway`,
                );
              }
            } else {
              steps.push(
                `OAuth: Tier 3 hCaptcha ${solveRes.kind}` +
                  ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
                  ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : "") +
                  ` — clicking the ${provider.label} affordance anyway`,
              );
            }
          }
        }
        // Turnstile Tier-3 (2026-06-12). The "Cloudflare IP-scores Turnstile
        // so a solver token is rejected" belief that kept this OFF was
        // FALSIFIED — exa fails on a fresh direct residential IP + real GPU, so
        // its Turnstile is NOT IP-bound (STATE.md). The 2Captcha key is
        // configured (harvester.env). Try the solver token; if Cloudflare still
        // rejects it the step trail says so and we fall through to the
        // inert-click path (which now bails captcha_blocked truthfully).
        if (
          !solvedViaTier3 &&
          captcha.kind === "turnstile" &&
          this.captchaSolver?.isAvailable() === true
        ) {
          const sitekey = await this.browser.extractTurnstileSitekey();
          const pageUrl = (await this.browser.getState().catch(() => null))?.url;
          if (sitekey !== null && pageUrl !== undefined) {
            steps.push(
              `OAuth: Tier 3 — submitting Turnstile sitekey to 2Captcha (${sitekey.slice(0, 12)}…)`,
            );
            const solveRes = await this.captchaSolver.solveTurnstile({ sitekey, pageUrl });
            if (solveRes.kind === "ok") {
              const injected = await this.browser.injectTurnstileToken(solveRes.token);
              if (injected) {
                solvedViaTier3 = true;
                steps.push(
                  `OAuth: Tier 3 solved the Turnstile in ${Math.round(solveRes.durationMs / 1000)}s via 2Captcha — clicking the ${provider.label} affordance`,
                );
              } else {
                steps.push(
                  `OAuth: Tier 3 Turnstile token arrived but page injection failed — clicking the ${provider.label} affordance anyway`,
                );
              }
            } else {
              steps.push(
                `OAuth: Tier 3 Turnstile ${solveRes.kind}` +
                  ("reason" in solveRes ? `: ${solveRes.reason}` : "") +
                  ("durationMs" in solveRes ? ` (${Math.round(solveRes.durationMs / 1000)}s)` : "") +
                  ` — clicking the ${provider.label} affordance anyway`,
              );
            }
          } else {
            steps.push(`OAuth: Tier 3 Turnstile — no sitekey found on page, skipping solver`);
          }
        }
        if (!solvedViaTier3) {
          steps.push(
            `OAuth: visible ${captcha.kind} present but did not solve in 20s — clicking the ${provider.label} affordance anyway`,
          );
        }
      }
    } catch (err) {
      // Solver is best-effort; never block OAuth on its failure.
      steps.push(
        `OAuth: visible-captcha precheck failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const oauthConsentDismissed = await this.browser.dismissConsentBanner();
    if (oauthConsentDismissed !== null) {
      steps.push(`OAuth: dismissed cookie consent before provider click: "${oauthConsentDismissed}"`);
    }
    steps.push(`OAuth: clicking the ${provider.label} sign-in affordance`);
    // Google Identity Services (GSI) / FedCM does NOT redirect — clicking the
    // widget raises a browser-native FedCM dialog or a popup and returns a
    // JWT to a JS callback. The classic startOAuth waits for a provider
    // redirect that never comes, so it falsely concludes "signed in" and the
    // session never persists (northflank). Detect GSI and drive it over CDP.
    let gsiHandled = false;
    let gsiAttempted = false;
    if (provider.id === "google" && (await this.browser.hasGoogleGsiAffordance())) {
      gsiAttempted = true;
      const gsi = await this.browser.tryGoogleGsiLogin(oauthSelector);
      // Only count GSI as handled when it ACTUALLY resolved. On via:"none"
      // (FedCM dialog never fired AND no popup) we must fall through to the
      // classic startOAuth redirect flow rather than skip it and then
      // falsely conclude "signed in" — the bug that left meilisearch
      // bouncing to a "create an account" form post-FedCM-miss.
      gsiHandled = gsi.ok && gsi.via !== "none";
      steps.push(
        `OAuth: Google Identity Services / FedCM widget — resolved via ${gsi.via}` +
          (gsiHandled
            ? ""
            : " (FedCM dialog/popup did not complete — looking for another provider)"),
      );
      // Classic-redirect-misrouted-as-GSI recovery (MEASURED 2026-06-08:
      // netlify). hasGoogleGsiAffordance() returns true whenever the GSI
      // client *script* is loaded — but many pages load that script next to a
      // CLASSIC redirect "Sign up with Google" button (netlify renders
      // button[name="google"]). Routing that button through tryGoogleGsiLogin
      // clicks it, which fires a normal same-tab redirect to
      // accounts.google.com; GSI then reports via:"none" (no FedCM dialog, no
      // popup) even though the OAuth redirect IS now in flight. Without this
      // check the code below would (a) scan the GOOGLE page for a github
      // fallback (finds none) and then (b) re-run startOAuth on
      // button[name="google"] — a button that no longer exists on
      // accounts.google.com → 20s waitFor timeout → the whole signup dies.
      // If the page has actually navigated onto a Google auth host, the
      // redirect already fired: treat it as handled and let the consent loop
      // below drive it, exactly as it would for any classic redirect OAuth.
      if (!gsiHandled && detectStuckOnGoogleOAuth(this.browser.currentUrl())) {
        gsiHandled = true;
        steps.push(
          "OAuth: the GSI dialog never fired, but the click started a classic Google redirect — continuing the consent flow.",
        );
      }
    }
    // GSI/FedCM dead end. Google won't render the FedCM dialog for an
    // automated browser (measured: FedCm.enable ok, dialogShown never fires),
    // and re-clicking a GSI button only re-triggers FedCM — never a redirect.
    // If the page ALSO offers a redirect-based provider (GitHub), hand the
    // caller a TRY_NEXT_PROVIDER signal so it re-dispatches via that provider
    // instead of dead-ending on Google. meilisearch offers both.
    if (gsiAttempted && !gsiHandled) {
      // The GSI click commonly leaves the page mid-SPA-transition (netlify:
      // the button[name="google"] goes invisible, the page hasn't navigated
      // anywhere useful), so a single inventory read here can THROW or return
      // empty — and the old code then fell through to startOAuth(google),
      // which re-clicked the now-hidden button and hung 20s before dying.
      // Settle + retry the read a few times so the redirect-provider fallback
      // (github) actually fires — github is the redirect provider whose
      // session we keep warm.
      let alt: { provider: OAuthProviderId; button: InteractiveElement } | null = null;
      for (let attempt = 0; attempt < 3 && alt === null; attempt++) {
        if (attempt > 0) await this.browser.wait(2);
        try {
          const inv = await this.browser.extractInteractiveElements();
          alt = findFirstOAuthButton(inv, ["github"]);
        } catch {
          // page still navigating — retry after the settle
        }
      }
      if (alt !== null) {
        steps.push(
          `OAuth: Google GSI/FedCM is a dead end for the bot — falling back to ${alt.provider}.`,
        );
        return { kind: "try_next_provider", selector: alt.button.selector, provider: alt.provider };
      }
      // No redirect provider to hand off to. Re-clicking the Google affordance
      // (startOAuth below) is pointless — it only re-raises the same dead GSI
      // dialog, and on netlify-class pages crashes on the hidden button. Skip
      // it: fall into the consent loop on the current page, which aborts
      // cleanly (needs_login) instead of a misleading 20s waitFor timeout.
      gsiHandled = true;
      steps.push(
        "OAuth: Google GSI/FedCM dead-ended with no redirect provider to fall back to.",
      );
    }
    // OmniAuth POST-only recovery prep. Capture the affordance's href + the
    // page's CSRF token NOW, while we're still on the signin page — the
    // "Authentication passthru" page a GET-click lands on is bare (no token).
    // See the typesense root-cause (2026-06-07): Rails/OmniAuth 2.0 is
    // POST-only; the GitHub button is a GET <a href="/users/auth/github">
    // upgraded to POST by page JS, and the bot's GET-click hit the passthru.
    const omniauthHref =
      typeof this.browser.getElementAttribute === "function"
        ? await this.browser
            .getElementAttribute(oauthSelector, "href")
            .catch(() => null)
        : null;
    const omniauthToken =
      typeof this.browser.getMetaCsrfToken === "function"
        ? await this.browser.getMetaCsrfToken().catch(() => null)
        : null;
    let omniauthPostTried = false;
    if (!gsiHandled) {
      await this.browser.startOAuth(oauthSelector);
    }
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
    // Bounded soft-waits for a consent page whose approve control hasn't
    // rendered yet. Google's gaia consent SPA paints "Loading" then
    // hydrates the Allow/Continue button a few seconds later (and for an
    // already-authorized app it may auto-redirect with no button at all).
    // Rather than aborting the instant advanceOAuthConsent finds nothing,
    // wait + re-loop a few times so a slow hydrate / auto-redirect can
    // complete first.
    let consentAdvanceWaits = 0;
    const MAX_CONSENT_ADVANCE_WAITS = 3;
    // OAUTH_ENGINE (default-ON since 2026-06-15): route the CONSENT decision
    // through the pure reducer (oauth-flow.ts, eng-reviewed) instead of the inline
    // scope-gate branches below. Flipped after live validation drove a real Google
    // consent screen both ways — advance_consent (opaque-scope→blind approve, full
    // ipinfo OAuth signup succeeded) AND the abort-on-login-form safety invariant.
    // The inline scope-gate block is kept one cycle as the explicit opt-out
    // (OAUTH_ENGINE=0) and deleted next (DESIGN-oauth-consent-engine.md step 2).
    const oauthEngineOn = !/^(0|false|off|no)$/i.test(process.env.OAUTH_ENGINE ?? "");
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
      // Google "Choose an account" chooser. Its "…to continue to <app>" copy
      // matches the consent classifier, but it is an account PICKER — it needs
      // a card CLICK, not a scope approve. Google shows it before the real
      // consent right after a fresh relogin (the first OAuth re-confirms the
      // account). Without handling it here the bot tries to approve, stalls,
      // and the page flips to needs_login → abort (every Google service fails
      // until an OAuth is done once). Click the account card and re-read; the
      // next pass lands on the real consent screen (or back at the service).
      if (
        provider.id === "google" &&
        /\/(?:accountchooser|chooseaccount|oauthchooseaccount)/i.test(url)
      ) {
        const clicked = await this.tryClickGoogleChooserCard(task.oauthAccountEmail);
        steps.push(
          `OAuth: Google account chooser — ${clicked ? "clicked the account card" : "no clickable account card found"}`,
        );
        await this.browser.wait(2);
        continue;
      }

      const authState = provider.classifyAuthState(url, body);
      steps.push(`OAuth: ${provider.label} auth state = ${authState} (url=${url.slice(0, 120)})`);

      if (authState === "not_provider") {
        // OmniAuth 2.0 POST-only recovery. The provider button can be a GET
        // <a href="/.../auth/<provider>"> that page-JS upgrades to a POST; if
        // the bot's click hit the default GET, Rails/OmniAuth answers
        // "Not found. Authentication passthru." and OAuth never started — the
        // bot then misreads it as "signed in" and bails. Detect that bare
        // passthru page and re-initiate via POST with the signin page's CSRF
        // token (proven to 302 to the provider). MEASURED 2026-06-07: typesense.
        const onOmniAuthPassthru =
          /authentication passthru|not found/i.test(body) &&
          /\/auth\/[a-z0-9_-]+\/?$/i.test(url);
        if (
          onOmniAuthPassthru &&
          !omniauthPostTried &&
          omniauthToken !== null &&
          omniauthHref !== null
        ) {
          omniauthPostTried = true;
          const action = new URL(omniauthHref, url).toString();
          steps.push(
            `OAuth: ${provider.label} endpoint is POST-only (OmniAuth GET passthru) — ` +
              `re-initiating via POST with the page CSRF token`,
          );
          try {
            await this.browser.submitPostForm(action, {
              authenticity_token: omniauthToken,
            });
            await this.browser.wait(3);
            continue; // re-read state — should now be on the provider's page
          } catch (err) {
            steps.push(
              `OAuth: OmniAuth POST recovery failed (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
        break; // flow left the provider — back on the service
      }

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
          // Try text-based extractor first (zero LLM cost), then fall
          // back to vision when phrasing drifts. The vision path uses
          // the screenshot we just saved — if a human can read the
          // number on screen, Claude vision can too.
          let matchNum: string | number | null = extractGoogleNumberMatch(body);
          if (matchNum === null) {
            try {
              matchNum = await this.extractGoogleNumberViaVision();
              if (matchNum !== null) {
                steps.push(
                  `Google: number-match extractor missed phrasing but vision LLM read "${matchNum}" from the challenge screenshot.`,
                );
              }
            } catch (err) {
              steps.push(
                `Google: vision-fallback for number extraction threw (${err instanceof Error ? err.message : String(err)})`,
              );
            }
          }
          if (matchNum !== null) {
            // rc.26 — surface in real-time via stderr as well as the
            // step trail. The step trail only renders after the run
            // ends; stderr lands in the housekeeper output immediately,
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
              windowSeconds: 240,
              machineToken: task.machineToken,
              apiBase: task.apiBase,
            });
            // rc.18 — opt-in Telegram fallback. Bypasses the email
            // path (which collapses to Sent only when GMAIL_USER ==
            // account.email). No-op without TELEGRAM_BOT_TOKEN env.
            void sendTelegramHeightenedAuth({
              service: task.service,
              digit: String(matchNum),
              windowSeconds: 240,
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
              windowSeconds: 240,
              machineToken: task.machineToken,
              apiBase: task.apiBase,
            });
            void sendTelegramHeightenedAuth({
              service: task.service,
              digit: null,
              windowSeconds: 240,
            });
          }
          // Either way (number found or not), the user can still
          // clear the challenge in the bot's browser window or by
          // tapping on their phone. Wait the full 2 minutes.
          const cleared = await this.waitForGoogleChallenge(provider, steps);
          if (!cleared) {
            return this.oauthAbort(
              "needs_login",
              `Google challenge timed out after 4 minutes. ` +
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
        // The NON-skippable escalation: GitHub dropped the skip link and
        // now shows "Verify 2FA now" / "you can no longer delay". No
        // clear-path the bot has (skip link, device email, phone-tap)
        // works — only the operator clicking "Verify 2FA now" in a browser
        // does. Abort immediately with that instruction instead of burning
        // the 60s gmail poll + 4-min phone-tap wait below.
        if (provider.id === "github" && isGitHubForced2faVerification(body)) {
          steps.push(
            "GitHub: forced 2FA re-verification wall ('Verify 2FA now', no skip link) — " +
              "neither the device email nor a phone-tap can clear this; aborting fast.",
          );
          return this.oauthAbort(
            "needs_login",
            `GitHub is forcing a one-time two-factor (2FA) re-verification on the account, ` +
              `which the bot cannot clear. Run \`${loginCmd}\`, click "Verify 2FA now" in the ` +
              `browser window and complete the 2FA flow, then retry.`,
            steps,
          );
        }
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
        // 0.8.3-rc.1 — GitHub email-link challenge auto-clear. When
        // GitHub fires "verify it's you" on a new device, the
        // canonical clear path is to click a link in an email Github
        // dispatches to lunchboxfortwo@gmail.com. If GMAIL_USER /
        // GMAIL_APP_PASSWORD are wired on the API, we can poll for
        // that email, extract the URL, navigate the bot's browser to
        // it, and re-enter the OAuth flow. Best-effort: failure
        // degrades to the phone-tap path below.
        if (
          provider.id === "github" &&
          task.machineToken !== undefined &&
          task.machineToken.length > 0
        ) {
          steps.push(
            "GitHub: verify-it's-you challenge — polling operator inbox for a device-confirmation link (up to 60s)",
          );
          try {
            const { readGitHubChallengeLink } = await import("./read-otp.js");
            const linkResult = await readGitHubChallengeLink({
              machineToken: task.machineToken,
              ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
              maxWaitSeconds: 60,
            });
            if (linkResult.code !== null) {
              steps.push(
                `GitHub: device-confirmation link found in gmail (reason=${linkResult.reason}) — navigating to it`,
              );
              try {
                await this.browser.goto(linkResult.code);
                await this.browser.wait(3);
                steps.push(
                  "GitHub: device confirmation submitted — re-classifying for the consent flow",
                );
                i--;
                continue;
              } catch (err) {
                steps.push(
                  `GitHub: navigating to confirmation link failed (${err instanceof Error ? err.message : String(err)})`,
                );
              }
            } else {
              steps.push(
                `GitHub: no confirmation email arrived within 60s (reason=${linkResult.reason}) — falling back to phone-tap wait`,
              );
            }
          } catch (err) {
            steps.push(
              `GitHub: challenge-clearing import/call threw (${err instanceof Error ? err.message : String(err)})`,
            );
          }
          // 0.8.3-rc.1 — fall back to the phone-tap path: fire
          // Telegram + heightened-auth notifications and wait 4
          // minutes for the operator to tap their phone. This is the
          // same shape Google's challenge path already uses; without
          // it the bot just times out silently with no operator
          // surface.
          console.error(
            `[universal-bot] GITHUB CHALLENGE: tap your phone for ${task.service} — 4 minute window`,
          );
          steps.push(
            `GitHub: phone-tap challenge for ${task.service} — operator has 4 minutes to approve on a registered device`,
          );
          void notifyHeightenedAuth({
            service: task.service,
            digit: null,
            windowSeconds: 240,
            machineToken: task.machineToken,
            apiBase: task.apiBase,
          });
          void sendTelegramHeightenedAuth({
            service: task.service,
            digit: null,
            windowSeconds: 240,
          });
          const cleared = await this.waitForGitHubChallenge(steps);
          if (cleared) {
            steps.push("GitHub: challenge cleared — re-classifying for the consent flow");
            i--;
            continue;
          }
          steps.push("GitHub: phone-tap window elapsed without clear — aborting with needs_login");
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

      // authState === "consent" — route through the reducer when OAUTH_ENGINE is
      // on (every path here continues or returns, so the inline block below is
      // the default-off path). Faithful to the inline ordering; the executor owns
      // the advance-success flag flip + the consentAdvanceWaits budget.
      if (oauthEngineOn) {
        const hasLoginForm = await this.oauthLoginFormPresent();
        const scopes = extractOAuthScopes(url);
        const dangerPhrases = provider.id === "google" ? scrapeGoogleScopePhrases(body) : [];
        const consentDom = scopes === null ? await this.browser.extractText().catch(() => "") : "";
        const { action } = decideOAuthStep(
          {
            providerId: provider.id,
            consentAlreadyApproved,
            omniauthPostTried,
            allowBlindOAuthConsent: task.allowBlindOAuthConsent === true,
            allowExtraOAuthScopes: task.allowExtraOAuthScopes ?? [],
          },
          {
            isChooser: false,
            authState: "consent",
            hasLoginForm,
            omniAuthPassthru: false,
            scopes,
            dangerPhrases,
            domBasicFromDom: provider.id === "google" && googleConsentIsBasicFromDom(body),
            domBasicGis: provider.id === "google" && googleGisConsentIsBasic(consentDom),
          },
          { scopesAreBasic: (s) => provider.scopesAreBasic(s) },
        );
        steps.push(
          `OAuth[engine]: scopes=[${scopes === null ? "<unreadable>" : scopes.join(", ")}] → ` +
            `${action.kind}${action.kind === "advance_consent" ? `:${action.mode}` : ""}`,
        );
        // Faithful inline step trail: a readable all-basic approve logs the same
        // "scopes all basic … auto-approving" line the inline scope-gate emits.
        if (action.kind === "advance_consent" && action.mode === "approve" && scopes !== null) {
          steps.push(`OAuth: consent scopes all basic (${scopes.join(", ")}) — auto-approving`);
        }
        if (action.kind === "abort") {
          if (action.clearProviderLoggedIn) clearProviderLoggedIn(provider.id);
          const detail =
            action.reason === "needs_login"
              ? `landed on a ${provider.label} sign-in form / no session — re-run \`${loginCmd}\`, then retry. ` +
                `The bot will not type into ${provider.label}'s login form.`
              : action.unauthorizedScopes !== undefined
                ? `${provider.label} consent requests non-basic scopes: [${action.unauthorizedScopes.join(", ")}]. ` +
                  `All requested: [${(scopes ?? []).join(", ")}]. Re-run provision with allow_extra_oauth_scopes set to proceed.`
                : `reached a ${provider.label} consent screen but could not safely auto-approve its scopes — approve it manually.`;
          return this.oauthAbort(action.reason, detail, steps);
        }
        // A consent observation only ever yields abort | advance_consent; this
        // narrows the union for TS (and is a defensive no-op if it ever doesn't).
        if (action.kind !== "advance_consent") break;
        // advance_consent — perform the advance; flip the flag only on success.
        const advanced = await this.browser.advanceOAuthConsent(provider.id);
        if (advanced) {
          consentAlreadyApproved = true;
          await this.browser.wait(3);
          continue;
        }
        if (action.onAdvanceFail === "bounded_wait") {
          if (consentAdvanceWaits < MAX_CONSENT_ADVANCE_WAITS) {
            consentAdvanceWaits += 1;
            steps.push(
              `OAuth[engine]: approve control not present yet — waiting for hydrate/redirect ` +
                `(${consentAdvanceWaits}/${MAX_CONSENT_ADVANCE_WAITS})`,
            );
            await this.browser.wait(4);
            continue;
          }
          return this.oauthAbort(
            "oauth_consent_needs_review",
            `blind-consent approved but no approve control on the ${provider.label} consent page ` +
              `after ${consentAdvanceWaits} waits — sign up manually.`,
            steps,
          );
        }
        if (action.onAdvanceFail === "wait_nav") {
          steps.push("OAuth[engine]: post-grant page, no approve control — waiting for natural navigation");
          await this.browser.wait(3);
          continue;
        }
        // onAdvanceFail === "abort"
        return this.oauthAbort(
          "oauth_consent_needs_review",
          `reached a ${provider.label} consent screen but found no approve control to click — approve it manually.`,
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
        // Google's newer consent URL hides the scope= param behind an
        // opaque `part=` token, so extractOAuthScopes() returned null
        // even on an entirely-basic email/profile consent (measured on
        // uploadcare). The visible DOM is the only remaining signal: if
        // it lists ONLY openid/email/profile-family grants (and the
        // danger scraper above already cleared it), this is exactly the
        // consent the URL-readable happy path auto-approves — so recover
        // it here instead of blocking. Anything ambiguous falls through
        // to the conservative abort below. Mirror the basic-scopes happy
        // path: set consentAlreadyApproved, advance, handle !advanced.
        if (
          provider.id === "google" &&
          !consentAlreadyApproved &&
          googleConsentIsBasicFromDom(body)
        ) {
          steps.push(
            "OAuth: consent scopes unreadable from URL but DOM lists only " +
              "basic email/profile scopes — auto-approving",
          );
          consentAlreadyApproved = true;
          const advanced = await this.browser.advanceOAuthConsent(provider.id);
          if (!advanced) {
            return this.oauthAbort(
              "oauth_consent_needs_review",
              `basic-only consent read from the ${provider.label} DOM but no ` +
                `approve control found on the consent page — approve it manually.`,
              steps,
            );
          }
          await this.browser.wait(3);
          continue;
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
            // The approve button may not have hydrated yet, or Google is
            // auto-redirecting an already-authorized app. Wait + re-loop a
            // bounded number of times before giving up.
            if (consentAdvanceWaits < MAX_CONSENT_ADVANCE_WAITS) {
              consentAdvanceWaits += 1;
              steps.push(
                `OAuth: consent approve control not present yet — waiting for hydrate/redirect ` +
                  `(${consentAdvanceWaits}/${MAX_CONSENT_ADVANCE_WAITS})`,
              );
              await this.browser.wait(4);
              continue;
            }
            return this.oauthAbort(
              "oauth_consent_needs_review",
              `blind-consent approved but no approve control found on the ` +
                `${provider.label} consent page after ${consentAdvanceWaits} waits — sign up manually.`,
              steps,
            );
          }
          consentAlreadyApproved = true;
          await this.browser.wait(3);
          continue;
        }
        // Defense-in-depth (MEASURED 2026-06-13: clarifai/daytona/gladia hit
        // this on the OAuth-popup path even after the post-verify consent fix).
        // Even without blind-consent, auto-approve a provably BASIC GIS consent
        // (name/email/profile only). googleGisConsentIsBasic hard-fails on ANY
        // sensitive scope phrase, so this only recovers the identity-only case
        // Google now hides behind an opaque part= token (no URL-readable scopes).
        const consentDom = await this.browser.extractText().catch(() => "");
        if (googleGisConsentIsBasic(consentDom)) {
          steps.push(
            "OAuth: consent DOM is basic identity-only (GIS; scopes not URL-readable) — auto-approving",
          );
          const advanced = await this.browser.advanceOAuthConsent(provider.id);
          if (advanced) {
            consentAlreadyApproved = true;
            await this.browser.wait(3);
            continue;
          }
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
            `To proceed, re-run provision with allow_extra_oauth_scopes set to ` +
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
    // Token-exchange settle. Stytch/WorkOS-style services (groq) bounce the
    // OAuth back to a callback page (/authenticate?token=…) and complete an
    // ASYNC token→session exchange there, THEN redirect to the dashboard.
    // With a warm Google session the round-trip is near-instant, so the bot
    // arrives at the callback while the exchange is still in flight — and
    // acting now (the rc.20 second-click retry, or post-verify navigation)
    // interrupts it, stranding the run on the login page. Give a callback-
    // shaped URL a chance to redirect itself away before we touch anything.
    {
      // Wait while EITHER the URL is still callback/login-shaped OR the page
      // shows async-session processing copy ("Creating your organization…").
      // Budget 24s — MEASURED: Stytch B2B's discovery+org-creation+session
      // chain takes ~5-7s but varies, and the bot's own page reads add jitter;
      // a short URL-only wait exits mid-provisioning and the rc.20 retry then
      // re-clicks OAuth and aborts it. Re-read text each tick.
      let settled = false;
      for (let i = 0; i < 12; i++) {
        const url = this.browser.currentUrl();
        const text = await this.browser.extractText().catch(() => "");
        if (!isLoginPageUrl(url) && !isAuthProcessingText(text)) {
          settled = true;
          break;
        }
        if (i === 0 && isAuthProcessingText(text)) {
          steps.push("OAuth: session is provisioning (auth-processing screen) — holding, not touching the page.");
        }
        await this.browser.wait(2);
      }
      const settledUrl = this.browser.currentUrl();
      steps.push(
        `OAuth: waited for the callback to settle — now at ${pathOf(settledUrl)}` +
          (settled ? " (redirected to the app)" : " (still login/processing-shaped)"),
      );
    }
    // Dead-route escape. The OAuth often returns to the SIGNUP url it
    // started from (northflank: app.northflank.com/signup). For an account
    // that now EXISTS, /signup (and /login, /register…) is a dead route the
    // SPA can't render — it hangs on a "Connecting" shell forever and the
    // post-verify planner reads it as "signed out." Navigating to the app
    // ORIGIN ROOT lets the service redirect an authenticated user to its
    // real dashboard. Generalizes: a service already on its dashboard has a
    // non-auth path here and is left alone.
    if (
      isSignupOrLoginRoute(this.browser.currentUrl()) &&
      !isOAuthProviderHost(this.browser.currentUrl())
    ) {
      // Clerk callback: don't immediately navigate away. On a Clerk combined
      // sign-in/sign-up flow a new-user OAuth completes the account via a
      // client-side sign-up transfer that takes a beat AFTER the callback lands;
      // navigating to root unmounts Clerk's JS and interrupts it (the bug behind
      // the cartesia/braintrust "oauth_session_not_persisted" cluster — proven
      // not IP). We can't drive the transfer via window.Clerk (patchright's
      // isolated world hides it), so instead give Clerk's own JS time and detect
      // success via cookies (world-agnostic). If a session appears, we're signed
      // in — skip the navigate-away.
      const onClerkCallback = /sso-callback|\/sso\b/i.test(this.browser.currentUrl());
      let clerkSignedIn = false;
      if (onClerkCallback) {
        clerkSignedIn = await this.browser.waitForClerkSession(12000).catch(() => false);
        steps.push(
          `OAuth: Clerk callback — waited for session establish → ${clerkSignedIn ? "signed in" : "no session (likely login-only OAuth / needs email signup)"}`,
        );
      }
      if (clerkSignedIn) {
        await this.browser.wait(2);
      } else {
        const root = originRoot(this.browser.currentUrl());
        if (root !== null) {
          steps.push(
            `OAuth: post-auth landing is a signup/login route (${pathOf(this.browser.currentUrl())}) — ` +
              `navigating to the app root (${root}) so the service routes us to the dashboard.`,
          );
          try {
            await this.browser.goto(root);
            await this.browser.wait(2);
          } catch {
            // navigation hiccup — the post-verify loop re-reads regardless.
          }
        }
      }
    }
    await saveDebugSnapshot(this.browser, "oauth-post-consent");

    // Captcha-gated OAuth detection (truthful failure, not a false "signed in").
    // exa's login lives at auth.exa.ai/?callbackUrl=… (path "/"), which
    // isLoginPageUrl doesn't recognise, so the settle loop above declares
    // "redirected to the app" even when we never left the gated login page.
    // If we're STILL showing a provider OAuth button AND a Turnstile/verify
    // challenge, the sign-in click was INERT — the unsolved captcha gated the
    // button, the URL never reached the provider, and we are NOT signed in.
    // MEASURED 2026-06-12: exa fails identically on a real laptop + fresh
    // direct residential IP (so it is the Turnstile/automation layer, NOT
    // IP/fingerprint — see STATE.md). Bail captcha_blocked instead of burning
    // the whole post-verify budget flailing on the login page.
    {
      const postText = (await this.browser.extractText().catch(() => "")).toLowerCase();
      const captchaChallenge =
        /complete the verification challenge|verify you are human|are you human|please complete the (?:captcha|challenge|verification)/i.test(
          postText,
        );
      if (captchaChallenge) {
        const postInv = await this.browser
          .extractInteractiveElements()
          .catch(() => [] as InteractiveElement[]);
        const stillGatedByProviderButton =
          findFirstOAuthButton(postInv, [provider.id]) !== null;
        if (stillGatedByProviderButton) {
          return this.oauthAbort(
            "captcha_blocked",
            `${task.service}'s ${provider.label} sign-in is gated by an unsolved ` +
              `Turnstile/verification challenge — the OAuth click was inert (still on the ` +
              `pre-auth login page). Not IP/fingerprint (a real browser + fresh direct IP ` +
              `fails identically); this service runs a strict Turnstile our automated solve ` +
              `can't clear.`,
            steps,
          );
        }
      }
    }

    steps.push(
      `OAuth: signed in via ${provider.label} — driving post-OAuth onboarding to the API key`,
    );

    // Sentry's Google OAuth returns to /extensions/google/setup/ with a
    // "New Identity" bridge: "Account Settings" links to a login/recovery
    // dead-end, while the submit button "New Account" is the actual signup
    // continuation. Generic nav-search used to prefer the settings link and
    // burn the run. Prefer the continuation button when that exact bridge is
    // visible, then let the normal post-verify loop handle the org form.
    {
      const bridgeState = await this.browser.getState().catch(() => null);
      const bridgeText = await this.browser.extractVisibleText().catch(() => "");
      if (
        bridgeState !== null &&
        /sentry\.io$/i.test(new URL(bridgeState.url).hostname) &&
        /\/extensions\/google\/setup\/?/i.test(new URL(bridgeState.url).pathname) &&
        /new identity/i.test(`${bridgeState.title}\n${bridgeText}`)
      ) {
        const inv = await this.browser.extractInteractiveElements().catch(() => [] as InteractiveElement[]);
        const newAccount = inv.find((e) => {
          const label = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.trim();
          return (e.tag === "button" || e.role === "button") && /^new account$/i.test(label);
        });
        if (newAccount !== undefined) {
          steps.push('OAuth: Sentry New Identity bridge — clicking "New Account" instead of Account Settings.');
          await this.browser.click(newAccount.selector);
          await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
        }
      }
    }

    // amplitude class — OAuth drops the bot into the service's READ-ONLY DEMO
    // sandbox (app.amplitude.com/analytics/demo) instead of a real account: it
    // has NO API key, and the only route to a real org is the prominent
    // "Create a free account" CTA, which opens the real /signup form. Detect
    // the demo state and click that CTA, then re-route to form-fill (the
    // email/name/password form the bot now completes, multi-step password
    // included). MEASURED 2026-06-04: without this the post-verify loop hunts
    // the demo for a key that isn't there → oauth_onboarding_failed.
    {
      await this.browser.wait(2); // let the post-OAuth redirect settle onto the demo
      const demoState = await this.browser.getState();
      const demoText = await this.browser.extractText().catch(() => "");
      if (isSandboxDemoState(demoState.url, demoText)) {
        const cta = findCreateAccountCta(
          await this.browser.extractInteractiveElements(),
        );
        if (cta !== null) {
          steps.push(
            `OAuth: landed in ${task.service}'s read-only demo sandbox ` +
              `(${pathOf(demoState.url)}) — clicking ` +
              `"${(cta.visibleText ?? "Create a free account").trim()}" to escape into ` +
              `the real signup form.`,
          );
          try {
            await this.browser.click(cta.selector);
            await this.browser.wait(2);
          } catch (err) {
            steps.push(
              `OAuth: demo-escape click threw (${err instanceof Error ? err.message : String(err)}) — ` +
                `falling back to form-fill anyway.`,
            );
          }
          return OAUTH_FALL_BACK_TO_FORM_FILL;
        }
      }
    }

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

    // amplitude class — post-OAuth we're STUCK on a login page (the provider
    // button is still present, or the URL is a login route) that carries an
    // in-page SIGNUP CTA. Google signed in fine, but the service has no
    // account/org for this identity and expects us to CREATE one via the
    // page's "Don't have an account? Sign up for free" link. The naive
    // loopBtn path below would re-trigger OAuth and loop until
    // oauth_loop_detected. Instead: click the signup CTA and re-route into
    // the email/password signup path (same sentinel the detectGoogleNoAccount
    // gate uses ~40 lines below). CONSERVATIVE: only fires in the STUCK state
    // (loopBtn or a login URL) and only when the page is NOT already a signup
    // form, so a dashboard that successfully landed but carries a stray
    // signup link is untouched, and a service that legitimately needs a
    // second OAuth click (no signup CTA) falls through. NOTE: gate on
    // classify !== "signup", NOT === "login": amplitude's Org-Login SSO page
    // has no password field, so classifySignupHtml returns "other".
    if (
      (loopBtn !== null || isLoginPageUrl(postOAuthState.url)) &&
      classifySignupHtml(postOAuthState.html) !== "signup"
    ) {
      const signupCta = findSignupCtaElement(postOAuthInv);
      if (signupCta !== null) {
        const ctaText = (
          signupCta.visibleText ??
          signupCta.ariaLabel ??
          "sign up"
        ).trim();
        steps.push(
          `Post-OAuth: ${task.service} shows a login page with a signup CTA ("${ctaText}") — ` +
            `${provider.label} identity has no account; clicking signup to create one.`,
        );
        try {
          await this.browser.click(signupCta.selector);
          await this.browser.wait(2);
        } catch (err) {
          steps.push(
            `Post-OAuth: clicking the signup CTA threw (${err instanceof Error ? err.message : String(err)}) — ` +
              `falling back to form-fill anyway.`,
          );
        }
        // Re-route into the email/password signup path: runSignup catches
        // this sentinel and re-runs form-fill on the now-signup page.
        return OAUTH_FALL_BACK_TO_FORM_FILL;
      }
    }

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
      // (a0) Google-login-only / no-account (plunk class). OAuth
      // completed but the service bounced back saying this Google
      // identity has no account (e.g. plunk's
      // /auth/login?message=No%20account%20found…). MUST run before the
      // manual-login-fallback gate below — this page IS a /login form, so
      // detectManualLoginFallback would otherwise swallow it as
      // oauth_session_not_persisted and abort. The account simply needs
      // creating via email, so re-route to form-fill instead of bailing.
      if (detectGoogleNoAccount(gateState.url, gateText)) {
        // Commit to email for the rest of the run — OAuth is login-only here, so
        // the OAuth-first scan must not re-fire after the form-fill re-route.
        this.committedToEmailPath = true;
        steps.push(
          `OAuth: ${provider.label} sign-in succeeded but ${task.service} has no account for ` +
            `this identity (login-only OAuth, ${pathOf(gateState.url)}) — abandoning OAuth and ` +
            `falling back to email/password signup to create the account.`,
        );
        return OAUTH_FALL_BACK_TO_FORM_FILL;
      }
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
      if (detectEmailOtpGate(gateState.url, gateState.title, gateText, gateInv)) {
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
            `Email-OTP gate detected (${pathOf(gateState.url)}) — polling operator inbox for the code` +
              (domain !== null ? ` (from_domain=${domain})` : ""),
          );
          otpResult = await readOperatorOtp({
            machineToken,
            ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
            ...(domain !== null ? { fromDomain: domain } : {}),
            ...(task.oauthAccountEmail !== undefined
              ? { toAddress: task.oauthAccountEmail }
              : {}),
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
      // Service-side manual approval can appear as an application form BEFORE
      // the final "pending approval" page (Baseten: company + LinkedIn + use
      // case form headed "We need more information to approve your account").
      // Do not hand this to the post-OAuth planner: there is no key to reach
      // until a human/service process approves the account, and filling the form
      // burns a robot into an async waiting room.
      if (isAtAccountReviewGate(gateText)) {
        return {
          success: false,
          error:
            `onboarding_blocked: ${task.service} put the account into a manual review / ` +
            `approval flow after signup. The bot cannot obtain an API key until the service approves the account.`,
          steps,
          ...this.resultTail(),
        };
      }
      // (d) Stuck on Google OAuth screens (Upstash class). Bot
      // signed in via Google but the OAuth flow didn't redirect off
      // accounts.google.com — usually a Clerk-mediated chooser the
      // post-verify planner can't navigate.
      //
      // rc.27 → rc.28 — instead of aborting immediately, try to
      // click an account card on the chooser. Google's chooser
      // renders each account as `<div data-identifier="email@…"
      // role="link" jsaction="…">` (or similar accountchooser shape).
      // Picking the first visible card forwards the flow off the
      // chooser. If the click doesn't move us off accounts.google.com
      // within a few seconds, abort with oauth_stuck_on_chooser.
      if (detectStuckOnGoogleOAuth(gateState.url)) {
        steps.push(
          `Post-OAuth: on Google OAuth screen (${pathOf(gateState.url)}). ` +
            `Trying chooser card + consent.`,
        );
        // (1) Multi-account chooser: pick the account card (no-op if it's
        //     already the consent screen). Prefer the intended account on a
        //     multi-account profile.
        const clicked = await this.tryClickGoogleChooserCard(task.oauthAccountEmail);
        if (clicked) {
          await this.browser.wait(3);
          await saveDebugSnapshot(this.browser, "oauth-chooser-click");
          steps.push(`Post-OAuth: chooser card clicked — now at ${pathOf(this.browser.currentUrl())}`);
        }
        // (2) Consent screen: "Allow <App> to access this info about you" →
        //     Continue. This is ALSO on accounts.google.com, so the old code
        //     mislabeled it oauth_stuck_on_chooser and bailed (MEASURED
        //     2026-06-13: langfuse). Auto-approve the BASIC identity grant
        //     (googleGisConsentIsBasic gates out anything sensitive).
        if (detectStuckOnGoogleOAuth(this.browser.currentUrl())) {
          const consent = await this.tryApproveGoogleConsentScreen();
          steps.push(`Post-OAuth: consent screen → ${consent}`);
          if (consent === "approved") {
            await this.browser.wait(4);
            await saveDebugSnapshot(this.browser, "oauth-consent-approved");
          } else if (consent === "non_basic") {
            return {
              success: false,
              error:
                `oauth_consent_needs_review: ${task.service}'s Google consent requests scopes ` +
                `beyond basic identity — not auto-approving. Finish the signup manually.`,
              steps,
              ...this.resultTail(),
            };
          }
        }
        const afterUrl = this.browser.currentUrl();
        // Moved off accounts.google.com → OAuth completed; fall through to
        // extract + postVerifyLoop. Still stuck → genuine wall.
        if (detectStuckOnGoogleOAuth(afterUrl)) {
          return {
            success: false,
            error:
              `oauth_stuck_on_chooser: ${task.service}'s Google OAuth flow did not redirect off ` +
              `accounts.google.com (${pathOf(afterUrl)}) after chooser + consent handling. ` +
              `Finish the signup manually.`,
            steps,
            ...this.resultTail(),
          };
        }
        steps.push(`Post-OAuth: cleared Google screens — now at ${pathOf(afterUrl)}`);
      }
    }

    let credentials = await this.extractCredentials();
    // 0.8.2-rc.15 — always enter postVerifyLoop. The legacy short-
    // circuit ("only call postVerifyLoop if api_key wasn't already
    // visible") returned early on multi-cred services that happen to
    // land with api_key plain-visible — cloud_name + api_secret on
    // Cloudinary, application_id + admin_api_key on Algolia — and the
    // siblings were never extracted. postVerifyLoop's top-of-iter
    // early-exit is itself multi-cred-aware (rc.13), so when there's
    // nothing more to do, it returns on the first iteration.
    try {
      credentials = await this.postVerifyLoop({
        service: task.service,
        maxRounds: task.postVerifyMaxRounds ?? 24,
        steps,
        ...(task.oauthAccountEmail !== undefined ? { oauthAccountEmail: task.oauthAccountEmail } : {}),
        ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
        ...(task.machineToken !== undefined ? { machineToken: task.machineToken } : {}),
        ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
      });
    } catch (err) {
      // A5 — OAuth bounced back to a login page; classify correctly
      // (oauth_session_not_persisted) instead of thrashing into
      // oauth_onboarding_failed.
      if (err instanceof OAuthSessionNotPersistedError) {
        // The handshake completed but the service never created a session — the
        // Clerk new-user-via-sign-in bounce, surfacing here as a stuck login page
        // (no explicit "no account" text, so detectGoogleNoAccount missed it
        // upstream). If the service also offers email signup, creating the account
        // that way is the recovery — the SAME OAUTH_FALL_BACK_TO_FORM_FILL path the
        // explicit-text case uses (runSignup re-navigates to the form and runs the
        // email path with forceFormFill, which suppresses OAuth so it can't bounce
        // back here). One-shot: an OAuth-only service with no email form then fails
        // honestly on the re-run instead of looping. Generalizes the cartesia crack
        // to the whole silent-callback Clerk cluster (openrouter/groq/northflank/…).
        if (!this.oauthEmailFallbackTried) {
          this.oauthEmailFallbackTried = true;
          steps.push(
            `OAuth callback never persisted a session (Clerk new-user sign-in bounce) — ` +
              `falling back to email/password signup to create the account.`,
          );
          return OAUTH_FALL_BACK_TO_FORM_FILL;
        }
        return { success: false, error: err.message, steps, ...this.resultTail() };
      }
      throw err;
    }
    // Success on a legacy api_key OR a real multi-cred bundle. Some services
    // issue NO field literally named api_key — Pusher's keys are
    // application_id + app_key + app_secret — so an api_key-only gate
    // wrongly bailed oauth_onboarding_failed while the bot was holding a
    // complete, usable bundle. Require >=2 named (non-metadata) credentials
    // so a lone ID (e.g. just application_id) still fails honestly: an ID
    // without a secret isn't a usable credential.
    if (hasUsableCredentialBundle(credentials)) {
      return {
        success: true,
        credentials: { ...credentials },
        steps,
        ...this.resultTail(),
      };
    }

    // No API key. Distinguish a billing/card wall (onboarding_blocked)
    // from a generic navigation miss — never grep-loop a paid wall.
    // rc.39 — fold the planner's `done` reason into the text we
    // grep. Some services (Koyeb) gate API issuance on a billing
    // confirmation whose visible text doesn't match the regex set
    // but whose planner reason clearly describes the wall.
    const finalFrame = await this.captureTextObservationFrame().catch(() => null);
    const finalText =
      finalFrame !== null ? finalFrame.visibleText : await this.browser.extractText().catch(() => "");
    const postSignupGate = classifyNoCredentialPostSignup({
      service: task.service,
      frame: finalFrame,
      fallbackText: finalText,
      lastDoneReason: this.lastPostVerifyDoneReason,
    });
    // Closed / invite-only registration — no account can be created at all
    // (turbopuffer: "Sign-ups are closed"). Terminally unservable; label it
    // honestly so the operator dequeues rather than seeing a misleading
    // oauth_onboarding_failed that implies a fixable nav bug.
    if (postSignupGate.failure?.kind === "signups_closed") {
      return {
        success: false,
        error: postSignupGate.failure.error,
        steps,
        ...this.resultTail(),
      };
    }
    if (
      postSignupGate.failure?.kind === "payment" ||
      postSignupGate.failure?.kind === "phone"
    ) {
      return {
        success: false,
        error: postSignupGate.failure.error,
        steps,
        ...this.resultTail(),
      };
    }
    // Service-side manual-approval gate (waiting room / waitlist / account
    // pending review). The OAuth handshake succeeded but the service won't
    // grant a key until a human approves the account — there is no key to
    // reach autonomously. Same terminal onboarding_blocked status as the
    // billing wall so it's a non-demoting human-pile outcome, not a
    // mislabeled oauth_onboarding_failed that wrongly implies a code bug.
    if (
      postSignupGate.failure?.kind === "account_review"
    ) {
      return {
        success: false,
        error: postSignupGate.failure.error,
        steps,
        ...this.resultTail(),
      };
    }
    // rc.39 — anti-bot interstitial that survived the post-OAuth
    // landing. Turso's GitHub SSO callback runs a Cloudflare check
    // that never clears for our Chromium fingerprint; the planner's
    // done reason / wait reasons name the vendor explicitly. Classify
    // as anti_bot_blocked so the operator sees an accurate status
    // (and the housekeeper routes it the same way as the form-fill-
    // phase anti-bot detector does).
    const ANTI_BOT_REASON =
      /\b(?:cloudflare\b.*?(?:verification|challenge|check)|just\s+a\s+moment|verifying\s+you\s+are\s+human|0\s+interactive\s+elements)/i;
    if (
      this.lastPostVerifyDoneReason !== null &&
      ANTI_BOT_REASON.test(this.lastPostVerifyDoneReason)
    ) {
      return {
        success: false,
        error:
          `anti_bot_blocked: ${task.service}'s post-OAuth landing is gated by an anti-bot ` +
          `interstitial (Cloudflare or similar) the bot cannot clear — finish the signup manually.`,
        steps,
        ...this.resultTail(),
      };
    }
    // 0.8.2-rc.10 — planner stuck-loop, fallback URLs exhausted. The
    // postVerifyLoop marks this with the [stuck_loop] sentinel so the
    // operator sees a distinct status (it's not an "OAuth onboarding"
    // failure — OAuth succeeded; the planner got stuck on the
    // post-OAuth navigation).
    if (
      this.lastPostVerifyDoneReason !== null &&
      this.lastPostVerifyDoneReason.startsWith("[stuck_loop]")
    ) {
      return {
        success: false,
        error:
          `planner_stuck: ${task.service}'s post-OAuth dashboard re-picked the same step ` +
          `repeatedly with no inventory change and the bot's hardcoded API-key URL fallbacks ` +
          `did not advance the page — finish the signup manually.`,
        steps,
        ...this.resultTail(),
      };
    }
    // 0.8.2-rc.10 — existing-account state with no extractable
    // credential. The postVerifyLoop's existing-key detector
    // (detectExistingAccountNoExtract) classifies a run that lands on
    // an authenticated dashboard whose API-keys page surfaces only
    // masked existing keys + no path to a fresh value. Surfacing this
    // distinctly so the housekeeper can flag it (e.g. periodically wipe
    // the chrome profile for the test identity) rather than treat it
    // as a real bot failure.
    if (
      this.lastPostVerifyDoneReason !== null &&
      this.lastPostVerifyDoneReason.startsWith("[existing_account_no_extract]")
    ) {
      return {
        success: false,
        error:
          `existing_account_no_extract: ${task.service}'s dashboard shows pre-existing API ` +
          `keys for this identity but the values are masked and unrecoverable — wipe the ` +
          `test identity's account on ${task.service} or sign in manually and reveal the key.`,
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
    const deadline = Date.now() + this.googleChallengeTimeoutMs;
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
    steps.push("Google: challenge wait timed out after 4 minutes");
    return false;
  }

  // 0.8.3-rc.1 — Claude-vision fallback for Google number-match
  // challenge extraction. Fires only when extractGoogleNumberMatch's
  // text patterns miss the current Google phrasing. Sends the most
  // recent page screenshot to the bot's LLM with a one-line prompt:
  // "what is the 2-3 digit number to tap." If a human can read the
  // screen, the vision model can too — the user's correction made
  // this obvious. Returns null on any failure (no LLM client, parse
  // error, no digits in reply).
  private async extractGoogleNumberViaVision(): Promise<string | null> {
    try {
      const state = await this.browser.getState();
      const screenshot = state.screenshot;
      if (screenshot === undefined || screenshot.length === 0) return null;
      const reply = await this.callLLM<string>({
        // Reading a fixed number off a screen has one right answer — no
        // sampling.
        temperature: 0,
        system:
          "You read numbers from Google authentication challenge screens. " +
          "The screen shows a 2-3 digit number the user must tap on their phone " +
          "to verify identity. Reply with ONLY that number. No words, no " +
          "punctuation, no leading zero unless the number genuinely starts " +
          "with 0. If the screen does not show a tap-this-number challenge, " +
          'reply "NONE".',
        userBlocks: [
          {
            kind: "image",
            media_type: imageMediaType(screenshot),
            data_base64: screenshot,
          },
          {
            kind: "text",
            text: "What number must the user tap on their phone?",
          },
        ],
        maxTokens: 8,
      });
      const trimmed = reply.trim();
      if (trimmed.length === 0 || /^none$/i.test(trimmed)) return null;
      const digits = trimmed.match(/\d{1,4}/);
      if (digits === null) return null;
      const n = digits[0];
      if (n.length < 1 || n.length > 4) return null;
      return n;
    } catch {
      return null;
    }
  }

  // 0.8.3-rc.1 — GitHub challenge clear-poll. Mirrors
  // waitForGoogleChallenge: poll every 3s for the page to transition
  // off the verify-it's-you state. When the URL leaves the GitHub
  // session/device-verification routes AND the page text no longer
  // matches the challenge phrasing, the operator's phone-tap has
  // cleared the gate and we return true.
  private async waitForGitHubChallenge(steps: string[]): Promise<boolean> {
    // Match the broader CHALLENGE_PHRASING_RE the auth-state classifier
    // uses, plus GitHub-specific URL paths. Keeping these regexes
    // aligned with the outer classifier prevents the wait from
    // returning "cleared" while the classifier still calls the state
    // "challenge" (which would cause re-entry into this branch).
    const CHALLENGE_PATH =
      /\/(?:sessions\/(?:two-factor|verify-?device|device)|account_verifications|users\/verify_device)/i;
    const CHALLENGE_BODY =
      /\b(?:device verification|security challenge|2[- ]?step|2fa|number(?: match)?(?: on (?:your |the )?(?:phone|screen|device))?|tap \d+|tap the number|confirm.{0,15}sign[- ]?in|verify it'?s you)\b/i;
    const deadlineMs = 4 * 60 * 1000;
    const deadline = Date.now() + deadlineMs;
    // Require N consecutive "not on challenge" samples before
    // declaring cleared. Brief mid-redirect blanks aren't enough —
    // the OAuth /authorize page transition is usually one second.
    const CONSECUTIVE_CLEAR_TARGET = 3;
    let consecutiveClear = 0;
    while (Date.now() < deadline) {
      await this.browser.wait(3);
      if (this.browser.oauthPageClosed()) return true;
      const url = this.browser.currentUrl();
      let body: string;
      try {
        body = (await this.browser.extractText()).slice(0, 4000);
      } catch {
        consecutiveClear = 0;
        continue;
      }
      const stillChallenged =
        CHALLENGE_PATH.test(url) || CHALLENGE_BODY.test(body);
      if (stillChallenged) {
        consecutiveClear = 0;
      } else {
        consecutiveClear += 1;
        if (consecutiveClear >= CONSECUTIVE_CLEAR_TARGET) {
          return true;
        }
      }
    }
    steps.push("GitHub: phone-tap challenge wait timed out after 4 minutes");
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
      {"kind":"fill","selector":"<a selector= copied verbatim from the inventory>","value_kind":"email|password|name|username|company|phone|literal","literal":"only when value_kind=literal","reason":"why"},
      {"kind":"check","selector":"<from inventory>","reason":"TOS checkbox etc."},
      {"kind":"select","selector":"<from inventory>","option_text":"<visible option label to pick — optional>","reason":"required dropdown/combobox choice"},
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
- For ANY required dropdown — native select, Ant/MUI/Radix custom combobox, or input role=combobox — use {"kind":"select"}. Do NOT use {"kind":"click"} on a dropdown label/trigger unless the goal is only to reveal fields; clicking a dropdown without selecting an option leaves required form state empty.
- For business/profile dropdowns, choose harmless low-risk defaults: business type "Software" / "SaaS" / "Individual" / "Other" if available; annual revenue choose the lowest non-empty bracket; company size choose the smallest non-empty team size.
- Email verification-CODE buttons: if the inventory has a button like
  "Send code", "Send verification code", "Get code", or "Email me a
  code" beside an OTP / verification-code field, you MUST include a
  click action on it, ORDERED AFTER the email fill. The bot operates a
  live email inbox: clicking it dispatches the code to the filled
  email, and the bot fetches the emailed code and fills the code field
  itself in a later step. NEVER skip this button or treat the code as
  un-automatable / manual — if you omit it, the service never sends the
  email and the signup stalls. Do NOT fill the code field yourself (you
  don't have the code yet); just click the send-code button.
- Skip elements marked [cookie-consent — avoid], and skip optional
  marketing-opt-in checkboxes.
- Do NOT add a separate password-confirmation fill unless the
  inventory shows a second password field. If there is a password
  confirmation / repeat password / password again field, fill it with
  value_kind "password", never "literal".
- Fill required phone/contact-number fields with value_kind "phone".
  Do not treat a signup contact-number field as an SMS verification
  wall; only post-submit OTP/SMS challenges are walls.
- Two-stage pages: if the inventory has only buttons (e.g. "Sign up
  with email" / "Continue with Google") and no input fields, emit a
  single click action on the EMAIL-signup button, and set
  submit_selector to that same button.
- For "name" use a realistic full name; for "username" a plausible
  7-15 char handle.`;

    const hintLine = input.hint !== undefined ? `\nHint: ${input.hint}` : "";
    const userBlocks: LLMBlock[] = [
      { kind: "image", media_type: imageMediaType(input.screenshot), data_base64: input.screenshot },
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
      // Deterministic form-fill picks (same rationale as the post-verify
      // planner — D2). Removes a run-to-run flakiness source.
      temperature: 0,
      // Fix C — pin a single model + provider + seed on the proxy path.
      // temperature 0 alone leaves the model/provider lottery in play.
      deterministic: true,
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
    parsed_codes: ReadonlyArray<string>;
    body_html?: string | null;
  }> {
    const deadline = Date.now() + totalSeconds * 1000;
    // `verif` (not `verify`) so the matcher also catches "verification" —
    // "verification" does NOT contain the substring "verify" (…ifi… vs
    // …ify), which silently dropped plausible's "4011 is your Plausible
    // email verification code" and timed the whole signup out. `code` /
    // `one[- ]?time` / `otp` catch code-based verification subjects too.
    const pattern =
      /verif|confirm|welcome|activate|complete|finish|set\s*up|\bcode\b|one[\s-]?time|\botp\b|sign[\s-]?up/i;
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

  // Code-based email verification (plausible: "Enter 4011 to verify your
  // email address"). The signup email carried a numeric code and no
  // clickable link, and the page transitioned to a code-input step after
  // submit. Seed the post-verify planner with the code so it fills the
  // input + clicks Verify, then drives on to the API key. Generalizes to
  // every service that verifies by emailed code rather than link.
  private async enterEmailVerificationCode(
    code: string,
    task: SignupTask,
    password: string,
    steps: string[],
  ): Promise<Record<string, string>> {
    if (code.length === 0) {
      steps.push("Verification email exposed a code field but it was empty — skipping.");
      return {};
    }
    steps.push(`Email carries a verification CODE (${code}) and no link — entering it on the page.`);
    // The post-submit "enter code" view may still be hydrating.
    await this.browser.waitForFormReady();
    const hint =
      `Email verification code retrieved: "${code}". The current page has a ` +
      `verification-code / OTP input (placeholder like "Code" / "Verification code", ` +
      `or several single-digit boxes — fill the FIRST and the browser auto-distributes). ` +
      `Issue {"kind":"fill","selector":"…","value":"${code}"} on it, then NEXT round click ` +
      `the Verify / Confirm / Continue / Submit button.`;
    return this.postVerifyLoop({
      service: task.service,
      credentials: { email: task.email, password },
      // Match the OAuth post-verify budget (24). The onboarding form
      // reached after EMAIL verification is the same multi-step wizard the
      // OAuth path hits — a profile form (name, country, company, role) +
      // a "create your first project" step can need 8-10 rounds alone.
      // The old 6 starved zilliz's "Set up your account" form: the planner
      // had filled only name+jobTitle when the budget ran out.
      maxRounds: task.postVerifyMaxRounds ?? 24,
      steps,
      initialHint: hint,
      ...(task.scopeHint !== undefined ? { scopeHint: task.scopeHint } : {}),
      ...(task.machineToken !== undefined ? { machineToken: task.machineToken } : {}),
      ...(task.apiBase !== undefined ? { apiBase: task.apiBase } : {}),
    });
  }

  // Drive the browser toward the API key after the account exists —
  // used by BOTH the email-verification path and the OAuth path (T9).
  // Each round asks Claude what to do next given the current page; we
  // Heightened-auth detector for the POST-VERIFY path. runOAuthFlow
  // catches Google's device-verification challenge during the OAuth
  // handshake itself; this catches the case where the planner
  // bumped into the same challenge mid-post-verify (Algolia, etc.).
  // Patterns match the planner's natural-language done-reason; the
  // number-match is extracted with the same shape the bot's
  // existing extractGoogleNumberMatch expects ("tap 71", "number 42").
  // Fire-and-forget; idempotent per-signup via heightenedAuthFired.
  private maybeFirePostVerifyHeightenedAuth(
    reason: string,
    service: string,
    steps: string[],
  ): boolean {
    if (this.heightenedAuthFired) return false;
    const CHALLENGE_PATTERNS =
      /\b(?:device verification|security challenge|2[- ]?step|2fa|number(?: match)?(?: on (?:your |the )?(?:phone|screen|device))?|tap \d+|tap the number|confirm.{0,15}sign[- ]?in|verify it'?s you)\b/i;
    if (!CHALLENGE_PATTERNS.test(reason)) return false;
    const digitMatch = reason.match(/\btap (\d{1,3})\b|\bnumber (\d{1,3})\b/i);
    const digit =
      digitMatch !== null ? (digitMatch[1] ?? digitMatch[2] ?? null) : null;
    this.heightenedAuthFired = true;
    const msg = digit !== null
      ? `Google challenge detected mid-post-verify: tap ${digit} on your phone — 2 minute window`
      : `Google challenge detected mid-post-verify (number extractor missed it — vision LLM will read the screen): ${reason.slice(0, 200)}`;
    console.error(`[universal-bot] ${msg}`);
    steps.push(`Post-verify: ${msg}`);
    void notifyHeightenedAuth({
      service,
      digit,
      windowSeconds: 240,
      machineToken: this.currentMachineToken,
      apiBase: this.currentApiBase,
    });
    void sendTelegramHeightenedAuth({
      service,
      digit,
      windowSeconds: 240,
    });
    // 0.8.3-rc.1 — vision-LLM fallback for the mid-post-verify path.
    // When the planner's reason names a challenge but no digit, take
    // a screenshot, ask Claude vision what number is on screen, and
    // fire a SECOND Telegram with the extracted number. The first
    // notification went out immediately (so the operator knows to
    // grab their phone); this follows up with the number as soon as
    // vision returns (~2-5s).
    if (digit === null) {
      void (async () => {
        try {
          const visionDigit = await this.extractGoogleNumberViaVision();
          if (visionDigit !== null) {
            const followUp = `Google challenge mid-post-verify: vision LLM read "${visionDigit}" from the screen — tap that on your phone.`;
            console.error(`[universal-bot] ${followUp}`);
            steps.push(`Post-verify: ${followUp}`);
            void sendTelegramHeightenedAuth({
              service,
              digit: visionDigit,
              windowSeconds: 240,
            });
            void notifyHeightenedAuth({
              service,
              digit: visionDigit,
              windowSeconds: 240,
              machineToken: this.currentMachineToken,
              apiBase: this.currentApiBase,
            });
          }
        } catch {
          // best-effort — the original alert already fired with no
          // digit; vision is a nice-to-have follow-up.
        }
      })();
    }
    return true;
  }

  // stop when Claude says "done" or when we extract a credential.
  // Bounded by maxRounds so a confused agent can't burn the context.
  //
  // T9 — decoupled from email+password. `credentials` is present only
  // on the email-verification path, where the loop may need to sign in
  // with the just-created account (SendPulse). On the OAuth path it is
  // absent: there is no password, and the Google session already
  // authenticated the user — a `login` step is then a no-op.
  // Tier 4 — DOM-proximity labeled extraction. Walks the page's
  // visible DOM via the BrowserController helper, pairs each
  // credential-shape string with the nearest credential-label text,
  // returns the canonical-key → value map. Used as a fallback after
  // the Phase E planner-quoted path when the planner mentioned only
  // one of several visible credentials.
  private async extractFromDomProximity(): Promise<Record<string, string>> {
    // Vocabulary matches the LABEL_ALIASES used by Phase E so the
    // canonical keys stay consistent across paths.
    const LABEL_TO_KEY = DOM_LABEL_TO_KEY;
    let labeled: Awaited<
      ReturnType<BrowserController["extractLabeledCredentialCandidates"]>
    > = [];
    try {
      labeled = await this.browser.extractLabeledCredentialCandidates();
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const c of labeled) {
      // Skip masked values — even if we have a label, the on-DOM
      // string is bullets, not the real credential. The reveal pass
      // ran before this so anything still masked is genuinely
      // unreachable.
      if (c.isMasked) continue;
      if (c.label === null) continue;
      const canonical = LABEL_TO_KEY[c.label];
      if (canonical === undefined) continue;
      if (out[canonical] !== undefined) continue; // first-wins
      out[canonical] = c.value;
    }
    return out;
  }

  // Count the DISTINCT credentials the current page PRESENTS — masked
  // ones included. This detects a multi-cred page BEFORE every value is
  // captured, so the post-verify loop can stay open to harvest the 2nd/
  // 3rd key instead of exiting the moment the first surfaces ("stops at
  // one"). Uses the DOM-proximity harvester's labels (which fire even on
  // masked/bullet'd values) mapped to canonical keys; values are NOT read
  // here, only the label set. Best-effort → 0 on any browser error.
  private async countPresentedCredentialLabels(): Promise<number> {
    try {
      const cands = await this.browser.extractLabeledCredentialCandidates();
      const canon = new Set<string>();
      for (const c of cands) {
        if (c.label === null) continue;
        const key = DOM_LABEL_TO_KEY[c.label];
        if (key !== undefined) canon.add(key);
      }
      return canon.size;
    } catch {
      return 0;
    }
  }

  // Run every visible-credential extraction tier the post-verify loop
  // uses (legacy regex/clipboard/hidden-input + DOM-proximity labeled),
  // merging first-wins into a single bundle. Used by attemptMintNewKey
  // so the freshly-minted key — which may render as a modal value, a
  // copy-button-only token, or a labeled table row — is caught by
  // whichever tier fits the vendor's reveal UI.
  private async harvestVisibleCredentials(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      const legacy = await this.extractCredentials();
      for (const [k, v] of Object.entries(legacy)) {
        if (out[k] === undefined) out[k] = v;
      }
    } catch {
      // best-effort — fall through to DOM-proximity
    }
    try {
      const labeled = await this.extractFromDomProximity();
      for (const [k, v] of Object.entries(labeled)) {
        if (out[k] === undefined) out[k] = v;
      }
    } catch {
      // best-effort
    }
    return out;
  }

  // SUCCEED on an already-signed-in / existing-account dashboard.
  //
  // When the bot lands on an authenticated dashboard whose API-keys
  // page shows only NAMES of pre-existing keys (values are shown once
  // at create-time and are unrecoverable), the historic behavior was to
  // bail with existing_account_no_extract / no_credentials_after_already
  // _signed_in. That's a usable outcome the bot threw away: a new key is
  // a perfectly valid credential.
  //
  // This routine, given the current (existing-account) state:
  //   1. Tries to extract a READABLE key right where we are — some
  //      dashboards do show a usable value (a default key on a freshly
  //      reused account, or a reveal affordance the loop hadn't fired).
  //   2. If the current page isn't a keys page, walks the same
  //      hardcoded keys-path fallbacks the stuck-loop escalation uses,
  //      re-trying the readable-key extract at each.
  //   3. On a keys page with no readable key, finds a "Create new key /
  //      Generate API key / New token" affordance and CLICKS it, then
  //      harvests the freshly-minted value (modal reveal + copy-button +
  //      clipboard + labeled-row, via harvestVisibleCredentials, after a
  //      short poll for the server round-trip that mints the key).
  //
  // Returns the minted/extracted credentials on success, or null when
  // there is genuinely no way to produce a key for this identity (no
  // create affordance anywhere — e.g. key creation is paywalled). The
  // caller then falls through to the honest existing_account bail.
  //
  // Best-effort throughout: any browser error degrades to "couldn't
  // mint" (null) rather than throwing — the existing classifier remains
  // the safety net.
  private async attemptMintNewKey(
    steps: string[],
    service?: string,
  ): Promise<Record<string, string> | null> {
    // The set of keys-page URLs we've navigated, so the fallback walk
    // doesn't revisit one and the create-affordance search doesn't
    // re-click on a page already shown to lack one.
    const visitedKeysUrls = new Set<string>();

    // Attempt readable-extract → create-and-extract on whatever page is
    // currently loaded. Returns credentials on success, null otherwise.
    const tryHere = async (): Promise<Record<string, string> | null> => {
      // (a) A readable key already on the page (or behind a reveal
      //     affordance the post-verify loop hadn't clicked yet).
      let creds = await this.harvestVisibleCredentials();
      if (hasAnyExtractedCredential(creds)) {
        steps.push(
          "Existing-account recovery: a readable key was already present on the keys page — extracted it.",
        );
        return creds;
      }
      // (b) Reveal pass — a masked-but-revealable existing key.
      try {
        const revealRes = await this.browser.revealMaskedCredentials();
        if (revealRes.clicked > 0) {
          await this.browser.wait(1);
          creds = await this.harvestVisibleCredentials();
          if (hasAnyExtractedCredential(creds)) {
            steps.push(
              `Existing-account recovery: revealed a masked existing key (clicked ${revealRes.clicked}) and extracted it.`,
            );
            return creds;
          }
        }
      } catch {
        // best-effort reveal
      }
      // (c) Mint a fresh key. Find + click a create affordance, then
      //     harvest the newly-shown value.
      const inventory = await this.buildInventory(steps, undefined, 80);
      const createBtn = findCreateKeyAffordance(inventory);
      if (createBtn === null) return null;
      const label = (
        createBtn.visibleText ??
        createBtn.ariaLabel ??
        createBtn.title ??
        "create key"
      ).trim();
      steps.push(
        `Existing-account recovery: no readable key — clicking a key-minting affordance ${JSON.stringify(label.slice(0, 40))}.`,
      );
      try {
        await this.browser.click(createBtn.selector);
      } catch (err) {
        steps.push(
          `Existing-account recovery: create-key click failed (${err instanceof Error ? err.message : String(err)}).`,
        );
        return null;
      }
      // Forensic: capture the post-click state so a "modal never minted a key"
      // failure is diagnosable — what does the create-key dialog render (name
      // field? an in-modal captcha? a disabled submit?), and is it in our
      // inventory? Off by default; production runs don't pay the snapshot.
      if (process.env.BOT_DEBUG_MINT_MODAL === "1") {
        await this.browser.wait(1.2);
        await saveDebugSnapshot(this.browser, "mint-after-create-click");
      }
      // Drive the "name your key" dialog the create-click opened, then poll for
      // the freshly-minted value (minting is a server round-trip; Render/Mistral
      // render the value into the modal after the POST returns).
      //
      // Two gates commonly hold the dialog's submit DISABLED until satisfied:
      //   (1) a non-empty NAME (groq's keyName field), and
      //   (2) a CAPTCHA token — groq embeds a Cloudflare Turnstile INSIDE the
      //       create-key modal (cf-turnstile-response), and the submit stays
      //       disabled until the widget issues a token. The captcha gate never
      //       ran here (it fires during form-fill, not post-verify mint), so the
      //       modal sat unsolved and every re-click just reopened it. Satisfy
      //       both up front: type the name, then run the captcha gate (Tier 1
      //       behavior / Tier 2 click-and-wait, polling for the token), and only
      //       then start clicking submit.
      try {
        const openInv = await this.browser.extractInteractiveElements();
        const nameInput = findKeyNameInput(openInv);
        if (nameInput !== null) {
          await this.browser.type(nameInput.selector, "trusty-squire").catch(() => {});
          steps.push("Existing-account recovery: named the new key.");
        }
      } catch {
        // best-effort name fill
      }
      // Solve any captcha gating the modal's submit (groq's in-modal Turnstile).
      // Best-effort: a no-widget result or a solver miss just falls through to
      // the submit poll below, which still works for modals with no captcha.
      const mintGate = await this.runCaptchaGate("Mint-modal", steps);
      if (mintGate.blocked) {
        steps.push(
          "Existing-account recovery: the create-key modal's captcha is blocking — cannot mint.",
        );
      }

      // Poll: click the modal's affirmative submit (re-clicking is harmless —
      // it's a no-op while still disabled, and once name+token clear the gate
      // the click lands), harvesting the minted value each round. No
      // single-click guard: the gate may enable a beat after we first try.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await this.browser.wait(0.5);
        const minted = await this.harvestVisibleCredentials();
        if (hasAnyExtractedCredential(minted)) {
          steps.push(
            "Existing-account recovery: extracted the freshly-minted key.",
          );
          return minted;
        }
        try {
          const modalInv = await this.browser.extractInteractiveElements();
          // Prefer the modal's generic submit ("Submit"/"Create"/…) over
          // findCreateKeyAffordance: the page-level "Create API Key" button is
          // still in the background DOM, and re-clicking IT just reopens the
          // modal (the pre-fix groq failure loop). Fall back to the affordance
          // matcher for modals whose confirm DOES carry a key noun.
          let confirmBtn = findKeyModalSubmit(modalInv, createBtn.selector);
          if (confirmBtn === null) {
            const aff = findCreateKeyAffordance(modalInv);
            if (aff !== null && aff.selector !== createBtn.selector) confirmBtn = aff;
          }
          if (confirmBtn !== null) {
            await this.browser.click(confirmBtn.selector).catch(() => {});
          }
        } catch {
          // best-effort confirm
        }
      }
      // Minted but the value didn't surface — try one last reveal +
      // harvest (some vendors render the new key masked with a Show
      // toggle even on first display).
      try {
        const revealRes = await this.browser.revealMaskedCredentials();
        if (revealRes.clicked > 0) {
          await this.browser.wait(1);
          const afterReveal = await this.harvestVisibleCredentials();
          if (hasAnyExtractedCredential(afterReveal)) {
            steps.push(
              "Existing-account recovery: revealed and extracted the freshly-minted key.",
            );
            return afterReveal;
          }
        }
      } catch {
        // best-effort
      }
      return null;
    };

    // Step 1 — try on the current page first.
    try {
      const state = await this.browser.getState();
      visitedKeysUrls.add(state.url);
      if (EXISTING_KEY_URL_HINT.test(state.url)) {
        const here = await tryHere();
        if (here !== null) return here;
      }
    } catch {
      // best-effort — fall through to the fallback walk
    }

    // Step 2 — walk the hardcoded keys-path fallbacks. Even if Step 1
    // ran (current page WAS a keys page but had no affordance), a
    // different keys URL on the same origin may carry the create
    // control (org-scoped vs account-scoped keys pages).
    let consecutive404 = 0;
    const MAX_CONSECUTIVE_404 = 3;
    const classifyCurrent404 = async (): Promise<"not_404" | "continue" | "break"> => {
      try {
        const after = await this.browser.getState();
        const bodyText = await this.browser.extractText().catch(() => "");
        if (!looksLike404(titleFromHtml(after.html), bodyText)) return "not_404";
        consecutive404 += 1;
        if (consecutive404 >= MAX_CONSECUTIVE_404) {
          steps.push(
            `Existing-account recovery: ${consecutive404} consecutive 404s on guessed keys URLs — ` +
              `this host's keys path isn't in our list; aborting the walk.`,
          );
          return "break";
        }
        return "continue";
      } catch {
        return "not_404";
      }
    };
    for (let i = 0; i < STUCK_LOOP_FALLBACK_PATHS.length; i++) {
      let currentUrl: string;
      try {
        currentUrl = (await this.browser.getState()).url;
      } catch {
        break;
      }
      const fallback = pickStuckLoopFallbackUrl(
        currentUrl,
        visitedKeysUrls,
        service,
        this.resolvedSignupUrl,
      );
      if (fallback === null) break;
      visitedKeysUrls.add(fallback);
      try {
        await this.browser.goto(fallback);
        // Some SPA 404 shells (Temporal observed 2026-06-20) never satisfy
        // the interactive-DOM readiness probe. Detect route-not-found copy
        // before waiting, otherwise the 404 abort below never gets a chance to
        // fire and the run appears to hang on the guessed key URL.
        const early404 = await classifyCurrent404();
        if (early404 === "break") break;
        if (early404 === "continue") continue;
        await Promise.race([
          this.browser.waitForInteractiveDom(5, 15_000),
          new Promise<void>((resolve) => setTimeout(resolve, 16_000)),
        ]);
      } catch {
        continue;
      }
      // Abort the walk once guessed keys paths keep 404ing — this host's
      // convention isn't in our list, so the remaining ~20 paths would all
      // 404 too and burn the run's 600s budget (axiom/fathom/loops). A real
      // (non-404) page resets the counter so a host that mixes 404s with a
      // live keys page is still fully walked.
      const after404 = await classifyCurrent404();
      if (after404 === "break") break;
      if (after404 === "continue") continue;
      consecutive404 = 0;
      const here = await tryHere();
      if (here !== null) return here;
    }
    return null;
  }

  // NAV_SEARCH phase (slice 1): drive the post-verify phase with the goal-directed
  // nav-search engine (nav-search.ts) instead of the greedy planner. Adapts the
  // BrowserController to the engine's narrow port and wires the extractor, the
  // capture-chain (sequential rounds → OF#1/auto-promote parity, A2), and the
  // log. Returns the extracted credentials, or {} (+ a no_self_serve_key done
  // reason) when the dashboard's navigation has no reachable key surface.
  private async runNavSearchPhase(
    args: { service: string; maxRounds: number; steps: string[] },
    oauth: boolean,
  ): Promise<Record<string, string>> {
    const hasRealKey = (c: Record<string, string>): boolean =>
      Object.keys(c).some((k) => !NON_CREDENTIAL_KEYS.has(k));

    // Already on a key surface at entry (bot landed there directly).
    const entry = await this.extractCredentials();
    if (hasRealKey(entry)) return entry;

    // If the curated signup URL is actually a credential/PAT/settings deep link,
    // revisit it after OAuth/session establishment before searching. OAuth
    // callbacks often settle on a dashboard/profile page even though the
    // operator supplied the exact credential route (Ona/Gitpod:
    // /settings/personal-access-tokens). Starting nav-search from the callback
    // landing page makes it wander among neighboring settings tabs instead of
    // preserving the known target surface.
    const curatedCredentialUrl =
      this.resolvedSignupUrl !== undefined &&
      KEYS_DESTINATION_URL.test(this.resolvedSignupUrl)
        ? this.resolvedSignupUrl
        : null;
    if (
      curatedCredentialUrl !== null &&
      this.browser.currentUrl() !== curatedCredentialUrl
    ) {
      args.steps.push(
        `nav-search: returning to curated credential URL ${curatedCredentialUrl} after auth`,
      );
      await this.browser.goto(curatedCredentialUrl).catch(() => undefined);
      await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
      const afterCuratedNav = await this.extractCredentials().catch(() => ({}));
      if (hasRealKey(afterCuratedNav)) return afterCuratedNav;
    }

    const port: NavSearchBrowserPort = {
      currentUrl: () => this.browser.currentUrl(),
      // Visibility-respecting text (innerText) for goal assessment — extractText()
      // reads textContent, which fuses inline <script> source + display:none nodes
      // into the page text and poisons every text-based goal/onboarding signal
      // (the false-shell class). Key extraction still reads RAW text via
      // extractCredentials() downstream; this is the nav-decision surface only.
      extractText: () => this.browser.extractVisibleText(),
      extractInventory: () => this.browser.extractInteractiveElements(),
      clickSelector: (s) => this.browser.click(s),
      navigate: (u) => this.browser.goto(u),
      pressEscape: () => this.browser.pressKey("Escape"),
      settle: async () => {
        await this.browser.waitForInteractiveDom(5, 15_000).catch(() => {});
      },
      expandLatentNav: () => this.browser.expandLatentNav(),
    };

    // Cap nav-search's LLM tiebreak calls so the navigation phase can't starve
    // the greedy planner's budget when we hand off (DEFAULT-ON hybrid): the
    // per-signup circuit breaker is shared, so an unbounded tiebreak could leave
    // the form-fill handoff with no budget. Deterministic ranking is unbounded
    // (free); only the LLM tiebreak is capped. Past the cap, tiebreak returns
    // null (deterministic-only), which leads to honest exhaustion → handoff.
    let tiebreakCalls = 0;
    const MAX_NAV_TIEBREAKS = Number(process.env.NAV_SEARCH_MAX_TIEBREAKS) || 6;

    const deps: NavSearchDeps = {
      extractKey: async () => {
        const c = await this.extractCredentials();
        return hasRealKey(c) ? c : null;
      },
      // Mint on a create-gated key surface: reuse the proven existing-account
      // recovery (readable → reveal → click create → drive the name+confirm
      // modal → poll the create POST → reveal masked-on-first-show). Without
      // this, nav-search only bare-clicks "Create API Key" and never submits
      // the resulting modal (groq's virgin /keys flow).
      mintKey: async () => {
        const c = await this.attemptMintNewKey(args.steps, args.service);
        return c !== null && hasRealKey(c) ? c : null;
      },
      // Capture-chain parity (A2 / OF#1): one sequential round per step, full
      // state + the real selector, so the synthesizer's chain check (no gaps)
      // still passes and auto-promote keeps minting skills.
      captureRound: async (ctx) => {
        const state = await this.browser.getState().catch(() => null);
        if (state === null) return;
        const observed: PostVerifyStep =
          ctx.action === "extract"
            ? { kind: "extract", reason: "nav-search: extract on key surface" }
            : ctx.selector !== undefined
              ? { kind: "click", selector: ctx.selector, reason: `nav-search: ${ctx.action}` }
              : { kind: "done", reason: `nav-search: ${ctx.action}` };
        captureOnboardingRound({
          service: args.service,
          round: this.captureChainRound,
          oauth,
          state,
          inventory: ctx.inventory,
          observed,
          ...(this.lastResolvedModel !== undefined ? { resolved_model: this.lastResolvedModel } : {}),
          ...(this.lastResolvedProvider !== undefined
            ? { resolved_provider: this.lastResolvedProvider }
            : {}),
        });
        this.captureChainRound += 1;
      },
      // LLM tiebreak: the deterministic ranker only fires on keys-keyword text /
      // href. When keys live behind a generically-named affordance (a settings
      // tab like "Advanced"/"Security", an icon nav), nothing scores and the
      // ranker can't decide. This is the ONE place the LLM touches the loop —
      // it picks the single candidate most likely to lead to a key surface, or
      // null. Cheap (text-only, ≤80 tokens, deterministic) and bounded by the
      // per-signup LLM budget; a budget/parse failure falls through to null
      // (honest exhaustion), never throws into the loop.
      tiebreak: async (candidates) => {
        if (candidates.length === 0) return null;
        if (tiebreakCalls >= MAX_NAV_TIEBREAKS) return null; // reserve budget for the handoff
        tiebreakCalls += 1;
        const here = this.browser.currentUrl();
        const list = candidates
          .map(
            (c, i) =>
              `${i}. "${c.text.slice(0, 60)}"${c.href !== null ? ` (href=${c.href})` : ""}`,
          )
          .join("\n");
        const system = `You navigate a SaaS dashboard after signup. Goal: reach the page that SHOWS or CREATES an API key (or any credential — token, secret, access key).
You are given a numbered list of the clickable affordances on the current page. Pick the ONE most likely to lead toward an API-keys / tokens / developer-credentials surface.
Reply with a single JSON object and nothing else: {"index": N} (N = the list number) or {"index": null} if NONE plausibly leads to API keys.
Prefer items naming keys / tokens / API / developer / secrets; then credentials / advanced / settings / account / security. On a B2B product an API key is frequently scoped to an ORGANIZATION / WORKSPACE / PROJECT / TEAM rather than the personal account — so if no personal "API keys" surface exists, an "Organization", "Workspace", "Project", or "Team" link is a strong candidate (its settings usually hold the keys). NEVER pick log out, billing, invoices, usage, docs, pricing, a link back to the current page, or any destructive action (delete, remove, revoke, deactivate, cancel).`;
        const userBlocks: LLMBlock[] = [
          { kind: "text", text: `Current URL: ${here}\n\nAffordances:\n${list}` },
        ];
        try {
          return await this.callLLM<string | null>({
            system,
            userBlocks,
            maxTokens: 80,
            temperature: 0,
            deterministic: true,
            parse: (raw) => {
              const m = raw.match(/\{[\s\S]*\}/);
              if (m === null) return null;
              const obj: unknown = JSON.parse(m[0]);
              const idx =
                typeof obj === "object" && obj !== null && "index" in obj
                  ? (obj as { index: unknown }).index
                  : null;
              if (typeof idx !== "number") return null;
              return candidates[idx]?.selector ?? null;
            },
          });
        } catch {
          return null;
        }
      },
      log: (line) => args.steps.push(line),
      maxSteps: args.maxRounds,
    };

    const result = await runNavSearch(port, deps);
    if (result.kind === "found") return result.credentials;
    this.lastPostVerifyDoneReason =
      "no_self_serve_key: nav-search exhausted the dashboard's navigation without " +
      "reaching an API-key surface";
    return {};
  }

  private async postVerifyLoop(args: {
    service: string;
    credentials?: { email: string; password: string } | undefined;
    maxRounds: number;
    steps: string[];
    scopeHint?: string | undefined;
    // For an email-OTP gate that appears AFTER OAuth (e.g. Convex's
    // radar-challenge → 6-digit code to the operator's Google address).
    // Lets the loop poll the operator's gmail the same way the pre-OAuth
    // signup gate does.
    machineToken?: string | undefined;
    apiBase?: string | undefined;
    // Seed the planner's first round with a hint — e.g. a verification
    // CODE pulled from the signup email (plausible) that the bot must type
    // into the on-page code input rather than click a link.
    initialHint?: string | undefined;
    // Intended Google account on a multi-account profile, for any account
    // chooser the post-OAuth onboarding surfaces mid-loop.
    oauthAccountEmail?: string | undefined;
  }): Promise<Record<string, string>> {
    let credentials = await this.extractCredentials();
    // 0.8.2-rc.15 — also seed DOM-proximity at loop entry. If the
    // bot lands directly on the api-keys page (Cloudinary navigates
    // through onboarding to the dashboard automatically, sometimes
    // landing on /settings/api-keys), labeled siblings are visible
    // immediately and the loop's top-of-iter check (which respects
    // isMultiCredBundle) can hold the loop open for the planner to
    // emit an explicit extract. Without this seed, only api_key
    // would be set on entry and isMultiCredBundle would return
    // false → loop exits with a partial bundle.
    try {
      const labeledSeed = await this.extractFromDomProximity();
      for (const [k, v] of Object.entries(labeledSeed)) {
        if (credentials[k] === undefined) credentials[k] = v;
      }
    } catch {
      // Non-fatal — the planner's explicit extract round will run
      // DOM-proximity again, this is just an opportunistic seed.
    }
    const recovery = new PostSignupRecoveryState();
    const oauth = args.credentials === undefined;
    // NAV_SEARCH (DEFAULT-ON): drive navigation first, then hand off to the
    // greedy planner from the reached surface if navigation alone finds no key.
    if (!/^(0|false|off|no)$/i.test(process.env.NAV_SEARCH ?? "")) {
      try {
        const navResult = await this.runNavSearchPhase(args, oauth);
        if (Object.keys(navResult).some((k) => !NON_CREDENTIAL_KEYS.has(k))) {
          return navResult;
        }
        if (
          this.resolvedSignupUrl !== undefined &&
          KEYS_DESTINATION_URL.test(this.resolvedSignupUrl)
        ) {
          args.steps.push(
            "nav-search: curated signup_url is a credential surface and no key was found — " +
              "not handing off to the greedy planner, which would leave the target route",
          );
          return navResult;
        }
        args.steps.push(
          "nav-search: no key via navigation alone — handing off to the planner from the current surface",
        );
      } catch (err) {
        args.steps.push(
          `nav-search: errored (${err instanceof Error ? err.message : String(err)}) — falling back to the planner`,
        );
      }
    }
    let hint: string | undefined = args.initialHint;
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
    // 0.8.1 — capture chain index is independent of the planner loop
    // round. The loop has two early-`continue` paths (page mid-navigation
    // throw, planner-rejection re-plan) that increment `round` WITHOUT
    // writing a capture file. The old code wrote captures using `round`
    // as the index, so a service that hit either path produced a chain
    // with gaps (neon: missing r4 + r6) — verifyCaptureChain then
    // rejected the run as `missing_round`, and auto-promote silently
    // dropped it. By tracking `capturedRound` separately we get a
    // contiguous 0..N-1 chain regardless of how many planner re-plans
    // happen mid-run. Continues from any signup-form preamble rounds the
    // form-fill phase already captured (captureSignupFormRounds); 0 on the
    // OAuth path, so this is unchanged for OAuth skills.
    let capturedRound = this.captureChainRound;
    const credentialTracker = new PostSignupCredentialTracker(credentials);
    // Gate URLs we've already polled the operator's gmail for, so a
    // multi-round wait on the same email-OTP page doesn't re-poll.
    const otpPolledUrls = new Set<string>();
    // Running summary of the steps the planner has taken, fed back into
    // each planPostVerifyStep call so the (stateless) planner stops
    // re-doing completed onboarding steps and re-navigating dead URLs.
    const priorActions: string[] = [];
    const credentialExtractionFlow = new CredentialExtractionFlow();
    const syntheticCapture = new PostSignupSyntheticCapture();
    const loginFlow = new PostSignupLoginFlow();
    const recoveryFlow = new PostSignupRecoveryFlow(recovery);
    const actionExecutor = new PostSignupActionExecutor(
      this.browser,
      {
        extractCredentials: () => this.extractCredentials(),
        extractFromDomProximity: () => this.extractFromDomProximity(),
      },
    );
    for (let round = 0; round < args.maxRounds; round++) {
      // Top-of-round credential sweep (MEASURED 2026-06-13: langfuse). The
      // credential can become visible on the page BETWEEN planner actions —
      // the keys render in the dashboard after onboarding while the planner
      // gets distracted re-clicking a promo banner it mis-reads as an error
      // toast. Re-reading the page every round makes extraction independent of
      // the planner choosing the right click, so an on-screen key is never
      // missed into a maxRounds bail. Merge-only (never overwrites a prior
      // capture); both extractors are best-effort.
      try {
        const sweep = await this.extractCredentials();
        for (const [k, v] of Object.entries(sweep)) {
          if (credentials[k] === undefined) credentials[k] = v;
        }
      } catch {
        // page mid-render — the early-exit below just won't fire this round
      }
      try {
        const sweepLabeled = await this.extractFromDomProximity();
        for (const [k, v] of Object.entries(sweepLabeled)) {
          if (credentials[k] === undefined) credentials[k] = v;
        }
      } catch {
        // DOM-proximity miss is non-fatal
      }
      const credentialProgress = credentialTracker.observe(credentials);
      const credentialExit = credentialTracker.decideEarlyCredentialExit(
        credentials,
        credentialProgress,
        round,
      );
      if (credentialExit !== null) {
        args.steps.push(credentialExit.message);
        await this.writeFastPathSyntheticCapture(
          args.service,
          capturedRound,
          oauth,
        );
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
      // Dismiss any cookie/consent banner BEFORE reading the page or
      // planning a click. A consent overlay (Google "Accept all", GDPR
      // banners) intercepts pointer events, so the planner's clicks land
      // on the banner instead of the dashboard and the loop stalls / loops /
      // times out. MEASURED 2026-06-07: meilisearch reached /settings/keys
      // but sat behind an Accept-All overlay and ran out the 600s clock.
      // The form-fill loop already dismisses banners every round; the
      // post-verify loop never did. Best-effort — a dismiss failure must
      // not burn the round.
      try {
        const dismissed = await this.browser.dismissConsentBanner();
        if (dismissed !== null) {
          args.steps.push(
            `Post-verify round ${round}: dismissed consent banner ("${dismissed}")`,
          );
        }
      } catch {
        // best-effort
      }
      let state: BrowserState;
      let inventory: InteractiveElement[];
      try {
        // PERF: parallel getState + inventory (independent calls).
        {
          const frame = await this.capturePostVerifyObservationFrame(args.steps);
          state = frame.state;
          inventory = frame.inventory;
        }
      } catch (err) {
        args.steps.push(
          `Post-verify round ${round}: page was mid-navigation ` +
            `(${err instanceof Error ? err.message : String(err)}) — retrying`,
        );
        await this.browser.wait(2);
        continue;
      }
      // clerk class — Google account chooser inside the post-verify loop.
      // The planner re-clicked "Sign in with Google", which opened
      // accounts.google.com's chooser (.../accountchooser?...). That page
      // carries a stray "Loading" label (so the hydration guard below would
      // burn all its ticks idling) and tryClickGoogleChooserCard is only
      // wired into runOAuthFlow — so nothing here clicks the account card.
      // Detect the chooser by URL or its "Choose an account" copy, click
      // the card to continue OAuth, then skip the rest of this round's
      // planning (the next round re-reads the post-chooser page).
      const chooserText = await this.browser.extractText().catch(() => "");
      if (
        /accounts\.google\.com\/.*(accountchooser|chooseaccount|oauthchooseaccount)/i.test(
          state.url,
        ) ||
        /choose an account/i.test(chooserText)
      ) {
        await this.tryClickGoogleChooserCard(args.oauthAccountEmail);
        args.steps.push(
          `Post-verify round ${round}: Google account chooser — clicked the account card to continue OAuth`,
        );
        await this.browser.wait(2);
        try {
          {
          const frame = await this.capturePostVerifyObservationFrame(args.steps);
          state = frame.state;
          inventory = frame.inventory;
        }
        } catch {
          // mid-navigation read after the card click — the next round
          // re-reads, so just fall through to it.
        }
        continue;
      }
      if (/sentry/i.test(args.service)) {
        const skipSetup = inventory.find((e) => {
          return [e.visibleText, e.ariaLabel, e.title, e.labelText]
            .some((label) => /^skip setup$/i.test((label ?? "").trim()));
        });
        if (skipSetup !== undefined) {
          args.steps.push(
            `Post-verify round ${round}: Sentry onboarding — clicking "Skip setup" to reach the dashboard/API-token surface.`,
          );
          try {
            await this.browser.click(skipSetup.selector);
            await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
          } catch (err) {
            args.steps.push(
              `Post-verify round ${round}: Sentry Skip setup click failed (${err instanceof Error ? err.message : String(err)}) — continuing.`,
            );
          }
          continue;
        }
      }
      // SPA hydration guard. A post-OAuth dashboard (northflank's
      // /settings/access-tokens, PostHog) can render a "Connecting"/loading
      // shell while its JS bundle + websocket finish — slow over a
      // residential tunnel. We gate on POSITIVE readiness — the instant the
      // page has SHELL_MAX_ELEMENTS visible interactive elements it is
      // hydrated by definition and we proceed — rather than looping on the
      // negative "text still says loading" signal. waitForInteractiveDom
      // returns the moment that count is met (or after the budget), so a fast
      // page costs ~0 and a slow one waits exactly as long as needed. This is
      // the fix for the dominant false positive: a fully-rendered dashboard
      // whose DOM merely CONTAINS a hidden "loading…"/"please wait 30
      // seconds…" string no longer spins the wait every round to run_timeout.
      //
      // Budget = 6x3s = 18s. MEASURED: a dashboard SPA gated on a websocket
      // (northflank's wss://platform.northflank.com/websocket) hydrates in
      // ~12-15s over the tunnel.
      //
      // ADAPTIVE exception (MEASURED 2026-06-04, clerk): an OAuth/SSO
      // CALLBACK route does a token exchange that renders even slower than a
      // plain dashboard — clerk's `/sign-in/sso-callback` outlasts 18s and
      // the bot bailed at the edge with `oauth_session_not_persisted`. On a
      // callback route the SPA IS making progress, so 36s of patience is
      // warranted; everywhere else the 18s budget holds so a genuinely-stuck
      // route reaches the navigate-to-root escape fast. Read the URL fresh
      // each round (it may redirect off the callback).
      const onOAuthCallback = isOAuthCallbackRoute(state.url);
      const HYDRATION_BUDGET_MS = onOAuthCallback ? 36_000 : 18_000;
      await this.browser
        .waitForInteractiveDom(SHELL_MAX_ELEMENTS, HYDRATION_BUDGET_MS)
        .catch(() => undefined);
      // Re-read after the wait — the page may have hydrated (or redirected).
      try {
        {
          const frame = await this.capturePostVerifyObservationFrame(args.steps);
          state = frame.state;
          inventory = frame.inventory;
        }
      } catch {
        // mid-navigation read — keep the prior state/inventory; the shell
        // decision below uses whatever count we have.
      }
      if (/sentry/i.test(args.service)) {
        const skipSetup = inventory.find((e) => {
          return [e.visibleText, e.ariaLabel, e.title, e.labelText]
            .some((label) => /^skip setup$/i.test((label ?? "").trim()));
        });
        if (skipSetup !== undefined) {
          args.steps.push(
            `Post-verify round ${round}: Sentry onboarding — clicking "Skip setup" after hydration to reach the dashboard/API-token surface.`,
          );
          try {
            await this.browser.click(skipSetup.selector);
            await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
          } catch (err) {
            args.steps.push(
              `Post-verify round ${round}: Sentry Skip setup click failed (${err instanceof Error ? err.message : String(err)}) — continuing.`,
            );
          }
          continue;
        }
      }
      // Negative-side decision, now visibility- AND inventory-aware: a shell
      // requires loading-text in the VISIBLE text AND a sub-threshold
      // inventory. The OAuth-callback exclusion keeps the navigate-to-root
      // escape from firing mid-token-exchange (the callback IS making
      // progress and a navigate-away would abort the session).
      const stillShell =
        !onOAuthCallback &&
        isLoadingShell(
          await this.browser.extractVisibleText().catch(() => ""),
          inventory.length,
        );
      if (stillShell) {
        const shellDecision = recoveryFlow.decideShell({
          round,
          path: pathOf(state.url),
          rootUrl: originRoot(state.url) ?? state.url,
          currentUrl: state.url,
        });
        if (shellDecision.kind === "navigate_root") {
          args.steps.push(shellDecision.message);
          try {
            await this.browser.goto(shellDecision.url);
            await this.browser
              .waitForInteractiveDom(SHELL_MAX_ELEMENTS, 15_000)
              .catch(() => undefined);
            {
          const frame = await this.capturePostVerifyObservationFrame(args.steps);
          state = frame.state;
          inventory = frame.inventory;
        }
          } catch {
            // navigate/read failed — the streak check below bails on the
            // next shell read.
          }
          // Re-evaluate after the root nav. If it hydrated, fall through to
          // planning; if it's STILL a shell, bail truthfully now rather than
          // burning the rest of the round budget to run_timeout.
          const recovered = !isLoadingShell(
            await this.browser.extractVisibleText().catch(() => ""),
            inventory.length,
          );
          if (recovered) {
            recoveryFlow.recordShellRecovered();
          } else {
            throw new SpaNeverHydratedError(
              `spa_never_hydrated: ${args.service}'s post-verify page (${pathOf(state.url)}) ` +
                `stayed a loading shell across ${recovery.shellStreak} rounds and an origin-root reload — ` +
                `the SPA never rendered an actionable surface (blocked websocket / wedged hydration). ` +
              `Not a navigation bug; retry or finish the signup manually.`,
            );
          }
        } else {
          args.steps.push(shellDecision.message);
        }
      } else {
        recoveryFlow.recordNoShell();
      }
      // Stalled-wizard breaker. Build a content signature (URL + each
      // inventory element's selector + label) and judge whether the
      // PREVIOUS executed action changed the page. If the last few
      // page-mutating actions all left the page identical, a wizard is
      // re-presenting itself and clicking it does nothing — stop here so
      // we don't waste the remaining rounds + LLM budget. (axiom: 4×
      // role-card re-clicks that never advanced.)
      const contentSig = (
        state.url +
        "§" +
        inventory
          .map((e) => `${e.selector}·${(e.visibleText ?? e.ariaLabel ?? "").slice(0, 24)}`)
          .join("|")
      ).slice(0, 4000);
      const pageUnchanged = recovery.prevContentSig !== null && contentSig === recovery.prevContentSig;
      if (recovery.lastActionKind !== null) {
        recovery.actionEffects.push({ kind: recovery.lastActionKind, pageUnchanged, selector: recovery.lastActionSelector });
      }
      recovery.prevContentSig = contentSig;
      if (isStalledOnActions(recovery.actionEffects)) {
        // Unique-name-collision recovery (fires ONCE, before giving up). The
        // stall is often NOT "clicks not registering" but a server-side
        // validation: an org/business/workspace NAME the operator's prior
        // account already took, which on many forms drives a derived subdomain
        // — so editing the domain directly doesn't stick; the NAME field must
        // change. MEASURED 2026-06-09 (kinde): the pre-filled "tsagent" was
        // taken, the domain went aria-invalid, and Next re-presented the step.
        // Detect a taken/unavailable signal, overwrite the name field with a
        // unique value (which re-derives a unique subdomain), resubmit, re-loop.
        const bodyLow = (await this.browser.extractText().catch(() => "")).toLowerCase();
        // NB: leading \b only, NO trailing \b — extractText() glues adjacent
        // elements without whitespace ("…already taken" + "region" →
        // "takenregion"), so a trailing boundary made this miss (MEASURED:
        // kinde, takenSignal=false while the body clearly contained "taken").
        // The leading \b still rejects mid-word hits like "mistaken"/"overtaken".
        const takenSignal =
          /\b(?:taken|already (?:in use|exists|registered|taken)|not available|unavailable|already exists|choose another|try another)/.test(
            bodyLow,
          );
        const nameField = takenSignal ? pickUniqueNameField(inventory) : null;
        if (process.env.BOT_DEBUG_CHOOSER) {
          console.error(
            `[uniquename-debug] takenSignal=${takenSignal} nameField=${nameField?.name ?? nameField?.id ?? "null"} ` +
              `textInputs=${JSON.stringify(
                inventory
                  .filter((e) => e.tag === "input")
                  .map((e) => `${e.type}|${e.name ?? e.id ?? "?"}`),
              )} bodyHas_taken=${bodyLow.includes("taken")}`,
          );
        }
        if (!recovery.uniqueNameRetried && nameField !== null) {
          recovery.uniqueNameRetried = true;
          const unique = `tsq${Math.floor(100000 + Math.random() * 900000)}`;
          args.steps.push(
            `Post-verify: stall is a name-taken collision — overwriting ${JSON.stringify(
              nameField.name ?? nameField.id ?? "name field",
            )} with a unique value and resubmitting.`,
          );
          try {
            await this.browser.type(nameField.selector, unique);
            await this.browser.wait(1);
            const submit = pickOnboardingSubmit(inventory);
            if (submit !== null) {
              await this.browser.click(submit.selector);
              await this.browser.wait(2);
            }
            // Reset the stall window so the resubmit gets a fair shot.
            recovery.actionEffects.length = 0;
            recovery.prevContentSig = null;
            hint = undefined;
            continue;
          } catch (err) {
            args.steps.push(
              `Post-verify: unique-name retry failed (${err instanceof Error ? err.message : String(err)}) — falling through.`,
            );
          }
        }
        // Force-advance recovery (fires ONCE). The planner sometimes stalls
        // re-selecting an option on a wizard step whose Next/submit is ALREADY
        // enabled — the selection registered in the wizard's JS state (not the
        // HTML `checked` attr) but the planner kept clicking the option instead
        // of advancing. MEASURED 2026-06-09 (kinde tech-stack: no checked attr,
        // Next not disabled, planner clicked "React" 3×). If a submit/Next that
        // is NOT the just-tried element exists, click it and re-loop.
        if (!recovery.forcedAdvanceTried) {
          // Read a FULL (uncapped) inventory: a step with many options (kinde's
          // ~29 SDK radios) crowds the Next button out of the ranked/capped
          // post-verify inventory, so pickOnboardingSubmit(inventory) misses it.
          const fullInv = await this.browser
            .extractInteractiveElements()
            .catch(() => inventory);
          const submit = pickOnboardingSubmit(fullInv);
          if (process.env.BOT_DEBUG_CHOOSER) {
            console.error(
              `[force-advance-debug] capped=${inventory.length} full=${fullInv.length} ` +
                `submit=${submit?.visibleText ?? submit?.ariaLabel ?? submit?.id ?? "null"} ` +
                `lastSel=${recovery.lastActionSelector ?? "?"}`,
            );
          }
          if (submit !== null && submit.selector !== recovery.lastActionSelector) {
            recovery.forcedAdvanceTried = true;
            args.steps.push(
              `Post-verify: stalled re-selecting an option while a submit/Next is available — clicking ` +
                `${JSON.stringify((submit.visibleText ?? submit.ariaLabel ?? "Next").slice(0, 24))} to advance.`,
            );
            try {
              await this.browser.click(submit.selector);
              await this.browser.wait(2);
              recovery.actionEffects.length = 0;
              recovery.prevContentSig = null;
              hint = undefined;
              continue;
            } catch (err) {
              args.steps.push(
                `Post-verify: force-advance click failed (${err instanceof Error ? err.message : String(err)}) — falling through.`,
              );
            }
          }
        }
        // Capture the exact page that defeated the wizard so the N1
        // onboarding-wizard class is debuggable post-hoc (post-verify pages
        // weren't being snapshotted — imagekit's step-1/3 role-select stall
        // had no rendered capture to diagnose). Best-effort.
        await saveDebugSnapshot(this.browser, "post-verify-stalled").catch(() => undefined);
        args.steps.push(
          `Post-verify: STALLED — the last 3 page-mutating actions left the page ` +
            `identical (${state.url}). An onboarding wizard is re-presenting itself ` +
            `(clicks not registering); giving up instead of burning the round budget.`,
        );
        break;
      }
      // Non-persisting-OAuth detector (A5, broadened). On an OAuth run the
      // bot has ALREADY authenticated before this loop, so landing on a
      // login page means the callback was rejected. The planner usually
      // keeps clicking "Sign in with Google" rather than returning a
      // {"kind":"login"} step, so the explicit login-flow counter misses
      // it — track the structural fact (consecutive login-page rounds)
      // instead. Generalizes across services (groq/northflank/amplitude)
      // without per-service URLs; reclassifies these off the misleading
      // oauth_onboarding_failed label into the truthful (and unwinnable-
      // without-residential-egress) oauth_session_not_persisted wall.
      const oauthLoginPageDecision = recoveryFlow.decideOAuthLoginPage({
        isOAuthRun: args.credentials === undefined,
        isLoginPage: isLoginPageUrl(state.url) || isLoginPageInventory(inventory),
        path: pathOf(state.url),
        rootUrl: originRoot(state.url) ?? state.url,
        currentUrl: state.url,
      });
      if (oauthLoginPageDecision.kind === "reload") {
        args.steps.push(oauthLoginPageDecision.message);
        try {
          await this.browser.goto(oauthLoginPageDecision.url);
          await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
        } catch {
          // reload failed — next login-page round bails below
        }
        continue;
      }
      if (oauthLoginPageDecision.kind === "fail") {
        args.steps.push(oauthLoginPageDecision.message);
        await this.browser.dumpOAuthDebug(args.service, "callback-not-persisted").catch(() => {});
        throw new OAuthSessionNotPersistedError(
          `oauth_session_not_persisted: signed in to ${args.service} via OAuth but the page ` +
            `still presents a login screen (${pathOf(state.url)}) after ` +
            `${oauthLoginPageDecision.rounds} rounds — the OAuth callback was rejected at the ` +
            `automation/fingerprint layer. NOT an IP issue (FALSIFIED 2026-06-14: a clean ` +
            `residential IP fails this callback identically — see STATE.md), so residential ` +
            `egress does NOT fix it. Needs a fingerprint/automation fix or manual signup.`,
        );
      }
      // Email-OTP gate that surfaced AFTER OAuth (the pre-OAuth signup
      // gate never saw it, so pendingOtpCode is unset). Convex's
      // radar-challenge sends a 6-digit code to the operator's Google
      // address; without this the planner emits a value-less `fill` and
      // then gives up ("on a code challenge wall" → oauth_onboarding_failed).
      // Detect it in-loop, poll the operator's gmail once via the same
      // reader the signup gate uses, and hand the code to the planner as
      // the next-round fill hint. Polled at most once per gate URL.
      if (
        hint === undefined &&
        args.machineToken !== undefined &&
        args.machineToken.length > 0 &&
        !otpPolledUrls.has(state.url) &&
        detectEmailOtpGate(
          state.url,
          state.title,
          await this.browser.extractText().catch(() => ""),
          inventory,
        )
      ) {
        otpPolledUrls.add(state.url);
        const domain = fromDomainFromUrl(state.url);
        args.steps.push(
          `Post-verify round ${round}: post-OAuth email-OTP gate (${pathOf(state.url)}) — polling operator inbox for the code` +
            (domain !== null ? ` (from_domain=${domain})` : ""),
        );
        const otp = await readOperatorOtp({
          machineToken: args.machineToken,
          ...(args.apiBase !== undefined ? { apiBase: args.apiBase } : {}),
          ...(domain !== null ? { fromDomain: domain } : {}),
          ...(args.oauthAccountEmail !== undefined ? { toAddress: args.oauthAccountEmail } : {}),
          maxWaitSeconds: 90,
        });
        if (otp.code !== null) {
          args.steps.push(
            `Post-verify round ${round}: email-OTP retrieved (${otp.code.length} digits, ending …${otp.code.slice(-2)}) — handing it to the planner to fill.`,
          );
          hint =
            `Operator email-OTP retrieved from gmail: code is "${otp.code}". The current page is an ` +
            `email-verification gate. Find the SINGLE visible OTP/code input (placeholder like "Code" / ` +
            `"Verification code", or 6 individual digit inputs — fill the FIRST and the browser ` +
            `auto-distributes). Issue {"kind":"fill","selector":"…","value":"${otp.code}"} on it. ` +
            `NEXT round, click the Verify / Continue / Submit button.`;
        } else {
          args.steps.push(
            `Post-verify round ${round}: email-OTP poll found no code (reason=${otp.reason}) — letting the planner proceed.`,
          );
        }
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
          ...(priorActions.length > 0 ? { priorActions: priorActions.slice(-10) } : {}),
        });
      } catch (err) {
        // The planner's output did not validate — most often a
        // selector not in the inventory (the model copied the whole
        // line, not just the `selector=` value). Re-plan with a hint
        // rather than abandon the run, the same resilience the
        // form-fill planner has. Bounded so a persistently broken
        // planner still terminates.
        const reason = err instanceof Error ? err.message : String(err);
        // 0.8.2-rc.6 — distinguish upstream-blip from planner-logic
        // failure. The proxy retry-with-backoff (rc.5) handles most
        // transient 502s within a single call, but during a sustained
        // upstream degradation the retry budget exhausts and surfaces
        // here as a planFailure. Counting those toward the 4x stop
        // threshold is wrong — they're not the planner's fault, the
        // upstream is just temporarily unavailable. We allow these to
        // burn a round (forward progress is impossible without a
        // planner reply) but don't tick recovery.planFailures, so a transient
        // blip can't push us into the terminal stop branch.
        const isUpstreamBlip =
          /\b50[234]\b/.test(reason) ||
          /\bupstream_(?:error|unreachable)\b/i.test(reason) ||
          /\bnetwork error\b/i.test(reason);
        if (isUpstreamBlip) {
          recovery.upstreamBlipRetries += 1;
          if (recovery.upstreamBlipRetries > MAX_UPSTREAM_BLIP_RETRIES) {
            args.steps.push(
              `Post-verify round ${round}: upstream proxy degraded for ${recovery.upstreamBlipRetries} rounds — stopping (likely sustained outage).`,
            );
            break;
          }
        } else {
          recovery.planFailures += 1;
        }
        if (recovery.planFailures > 3) {
          args.steps.push(
            `Post-verify round ${round}: planner failed ${recovery.planFailures}x (${reason}) — stopping.`,
          );
          break;
        }
        const label = isUpstreamBlip ? "transient upstream blip" : "planner output rejected";
        args.steps.push(
          `Post-verify round ${round}: ${label} (${reason})` +
            (isUpstreamBlip
              ? ` — retrying (${recovery.upstreamBlipRetries}/${MAX_UPSTREAM_BLIP_RETRIES}).`
              : " — re-planning."),
        );
        // No re-plan hint on an upstream blip — the planner's previous
        // output (if any) was fine; only the request itself failed.
        if (!isUpstreamBlip) {
          hint =
            "Your previous step was REJECTED. A click/fill/select `selector` must be " +
            "EXACTLY the value after `selector=` on one inventory line — copy only that " +
            "value (it runs to the end of the line), never the leading `[n] tag …` part " +
            "and never the whole line.";
        }
        continue;
      }
      // rc.22 — redact tokens before pushing to the step trail.
      // The planner's reason field sometimes quotes the actual API
      // value it just observed ("The full API token 'sbp_xxx' is
      // visible…"); the housekeeper then posts step trails to a public
      // GitHub issue, leaking the credential. Redactor patterns mirror
      // tools/archived-harvester/redact.mjs — defense in depth.
      args.steps.push(`Post-verify ${round + 1}/${args.maxRounds}: ${nextStep.kind} — ${redactCredentials(nextStep.reason)}`);
      // Feed this action back into the next round's planner context so it
      // doesn't loop. Concise: where we were, what we did, why.
      {
        const where = state.url.replace(/^https?:\/\//, "").slice(0, 40);
        const target =
          "selector" in nextStep && nextStep.selector !== undefined
            ? ` ${nextStep.selector.slice(0, 24)}`
            : "url" in nextStep && nextStep.url !== undefined
              ? ` →${nextStep.url.replace(/^https?:\/\//, "").slice(0, 36)}`
              : "";
        priorActions.push(
          `@${where} ${nextStep.kind}${target}: ${redactCredentials(nextStep.reason).slice(0, 60)}`,
        );
      }

      // Dump this round's real page state + inventory in the E1
      // eval-corpus format so onboarding adapters can be iterated
      // offline without re-running the rate-limited OAuth handshake.
      // Default-on as of 0.6.14-rc.11 — writes to
      // ~/.trusty-squire/corpus/onboarding/ unless an env override
      // points elsewhere or disables it.
      captureOnboardingRound({
        service: args.service,
        round: capturedRound,
        oauth,
        state,
        inventory,
        observed: nextStep,
        // Fix C4 — stamp the backend that produced THIS round's plan
        // (planPostVerifyStep set these via callLLM just above).
        ...(this.lastResolvedModel !== undefined ? { resolved_model: this.lastResolvedModel } : {}),
        ...(this.lastResolvedProvider !== undefined ? { resolved_provider: this.lastResolvedProvider } : {}),
      });
      capturedRound += 1;

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

      // Dead-URL memory. If the previous step navigated somewhere and we
      // landed on a 404, remember the target so we never go back.
      if (recovery.lastNavigatedTo !== null) {
        const t404 = (state.title ?? "").toLowerCase();
        if (t404.includes("404") || t404.includes("not found")) {
          recovery.deadUrls.add(recovery.lastNavigatedTo);
          args.steps.push(
            `Post-verify: navigate to ${recovery.lastNavigatedTo} hit a 404 — added to the do-not-revisit list (${recovery.deadUrls.size} dead URL(s)).`,
          );
        }
        recovery.lastNavigatedTo = null;
      }
      // Credential-domain grounding. The OAuth provider (GitHub/GitLab) is
      // the LOGIN method, never the API-key source — but the planner, told to
      // "find an API token", sometimes navigates to the provider's own
      // token-minting settings and tries to create a GitHub PAT as if it were
      // the service's key (MEASURED 2026-06-11: typesense — the bot went
      // straight to github.com/settings/tokens and walked into GitHub's
      // sudo-2FA gate, then mislabeled it the typesense wall). A PAT for
      // GitHub has nothing to do with the service. Block it and point the
      // planner back to the service's own dashboard.
      if (
        nextStep.kind === "navigate" &&
        /^https?:\/\/(?:github\.com\/settings\/(?:tokens|personal-access-tokens|apps)|gitlab\.com\/-\/(?:profile\/personal_access_tokens|user_settings))/i.test(
          nextStep.url,
        ) &&
        args.service.toLowerCase() !== "github" &&
        args.service.toLowerCase() !== "gitlab"
      ) {
        args.steps.push(
          `Post-verify: planner tried to mint a third-party token at ${nextStep.url} — blocked (provider is the login method, not the key source).`,
        );
        hint =
          `STOP — ${nextStep.url} is the OAuth PROVIDER's own token page. You signed in ` +
          `THROUGH that provider, but the ${args.service} API key lives on ${args.service}'s ` +
          `OWN dashboard, NOT in a GitHub/GitLab personal access token. Do NOT create a ` +
          `provider PAT. Navigate back to the ${args.service} dashboard and find its API-keys / ` +
          `tokens / credentials page there (it is often per-project or per-cluster — create the ` +
          `project/cluster first if none exists).`;
        continue;
      }

      // Refuse to re-navigate to a URL already known to 404 — force a
      // click-based re-plan instead of letting the planner re-guess it.
      if (nextStep.kind === "navigate" && recovery.deadUrls.has(nextStep.url)) {
        args.steps.push(
          `Post-verify: planner re-picked a known-dead URL (${nextStep.url}) — re-planning.`,
        );
        hint =
          `The URL ${nextStep.url} returns a 404 — do NOT navigate there again. ` +
          `Dead URLs (404, avoid all): ${[...recovery.deadUrls].join(", ")}. ` +
          `Reach the credentials/API-keys page by CLICKING a link in the current ` +
          `inventory (e.g. "API Keys", "Tokens", "Settings"), not by guessing a URL.`;
        continue;
      }

      if (nextStep.kind === "navigate") {
        const navigateDecision = recoveryFlow.decideNavigate({
          url: state.url,
          targetUrl: nextStep.url,
          inventory,
        });
        if (navigateDecision.kind === "replan") {
          args.steps.push(navigateDecision.message);
          hint = navigateDecision.hint;
          continue;
        }
        if (navigateDecision.kind === "break") {
          this.lastPostVerifyDoneReason = navigateDecision.doneReason;
          args.steps.push(navigateDecision.message);
          break;
        }
        recoveryFlow.recordNavigateExecution(state.url, nextStep.url);
      } else {
        recoveryFlow.recordNonNavigate();
      }

      // Stuck-loop detector. Re-planning steps (done/extract/login/
      // wait/navigate) are exempt: extract is its own progress signal,
      // navigate intentionally changes the URL not the current DOM,
      // wait is a deliberate pause, and login/done are terminal-ish.
      // The detector fires when a planner returns the same action with
      // the same selector AND the inventory size matches the prior
      // round's — strong evidence the previous step did nothing.
      const repeatableKinds = new Set(["click", "fill", "select", "check", "scroll"]);
      // An inventory-count change means the page genuinely mutated — a fresh
      // wizard step or a new page. Reset the per-stable-run click-selector
      // memory so distinct clicks on the NEW state aren't judged against the
      // old one.
      if (inventory.length !== recovery.prevInventorySize) {
        recovery.clickSelectorsSinceInventoryChange = new Set<string>();
      }
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
          signature === recovery.prevSignature && inventory.length === recovery.prevInventorySize;
        // A brand-new click selector (never clicked since the inventory last
        // changed) is wizard PROGRESS, not a cycle — selecting role, then
        // company-size, then a plan flips aria-checked without moving the
        // element count (axiom). Only treat repeated clicks as stuck: the
        // selector has already been clicked in this stable-inventory run.
        const clickSelectorIsRepeat =
          nextStep.kind === "click" &&
          recovery.clickSelectorsSinceInventoryChange.has(sel);
        const stuckOnKind =
          nextStep.kind === "click" &&
          recovery.prevSignature !== null &&
          recovery.prevSignature.startsWith("click|") &&
          inventory.length === recovery.prevInventorySize &&
          clickSelectorIsRepeat;
        if (nextStep.kind === "click") {
          recovery.clickSelectorsSinceInventoryChange.add(sel);
        }
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
                // Native <input type=checkbox> OR a custom ARIA checkbox
                // (<button role="checkbox">, <div role="checkbox">). The
                // input-only filter missed meilisearch's required agreement,
                // which renders as <button role="checkbox"> — so the planner
                // was never told to tick it and "Next" stayed disabled. The
                // check() executor already handles role=checkbox (it clicks +
                // verifies aria-checked).
                ((e.tag === "input" && e.type === "checkbox") ||
                  e.role === "checkbox") &&
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
          // 0.8.2-rc.10 — escalation. Track stuck-fires per URL so we
          // can switch tactics once the gentle re-plan hint has clearly
          // failed (the planner refuses to break the cycle on its own,
          // see the Anthropic six-round pattern in rc.8).
          if (recovery.lastStuckFireUrl === state.url) {
            recovery.stuckFiresAtUrl += 1;
          } else {
            recovery.stuckFiresAtUrl = 1;
            recovery.lastStuckFireUrl = state.url;
          }
          // After two stuck fires at the same URL, escalate to a
          // hardcoded /settings/keys-style navigation. Vendors almost
          // always have ONE canonical path; the dashboard often gates
          // it behind a sidebar link the planner can't reliably resolve
          // (Anthropic, Neon, Sentry, Mistral, …). The fallback list is
          // ordered most-specific first so a service whose dashboard
          // root happens to share /settings with the API-keys page
          // doesn't land short of the actual page.
          if (recovery.stuckFiresAtUrl >= 2) {
            // 0.8.2-rc.12 — when the bot is ALREADY on a URL that names
            // an API-keys page (path contains /keys, /tokens, /api-keys,
            // etc.) AND the page text shows masked-credential markers,
            // the dashboard is genuinely showing a pre-existing key
            // we can't unmask (Neon's `ts-7229` is the canonical case —
            // the value was revealed once at create-time and is gone).
            // Skip the fallback-URL navigate entirely (it would land
            // on a 404 for vendors whose api-keys page lives at an
            // org-scoped URL like `/app/<org>/settings#api-keys`) and
            // classify as existing_account_no_extract directly.
            try {
              const stuckPageText = await this.browser
                .extractText()
                .catch(() => "");
              if (
                detectExistingAccountNoExtract({
                  url: state.url,
                  pageText: stuckPageText,
                  lastPlannerReason: nextStep.reason,
                })
              ) {
                this.lastPostVerifyDoneReason =
                  `[existing_account_no_extract] stuck-loop at ${state.url} on an existing API-keys page with masked credentials; ` +
                  `latest planner reason: ${nextStep.reason}`;
                args.steps.push(
                  `Post-verify: stuck-loop on an existing-keys page — classified as existing_account_no_extract, breaking out.`,
                );
                break;
              }
            } catch {
              // best-effort — fall through to the regular fallback path
              // if the page-text read failed.
            }
            // 0.8.3-rc.1 — wizard-forward auto-escalation. Before
            // jumping to URL fallbacks, check whether a Next/Continue/
            // Submit/Done button is visible in the inventory. The
            // planner sometimes keeps re-clicking the JUST-SELECTED
            // option ("Individual Contributor" card on Mixpanel's role
            // step) without realising it should now click Submit to
            // advance. Force-click the wizard-forward button once; if
            // it actually moves the page, the next iteration's
            // inventory-change check resets the stuck counter and the
            // bot continues normally.
            const leafChoice = pickOnboardingLeafChoice(
              inventory,
              recovery.triedWizardLeafChoices,
            );
            if (leafChoice !== null) {
              recovery.triedWizardLeafChoices.add(leafChoice.selector);
              args.steps.push(
                `Post-verify: stuck-loop ${recovery.stuckFiresAtUrl}x at ${state.url} — ` +
                  `parent role selected but a required leaf role is still available; clicking ` +
                  `${JSON.stringify(leafChoice.visibleText ?? leafChoice.ariaLabel)} before submitting.`,
              );
              try {
                await this.browser.click(leafChoice.selector);
                await this.browser.wait(2);
              } catch (err) {
                args.steps.push(
                  `Post-verify: wizard leaf-role click failed (${err instanceof Error ? err.message : String(err)}) — falling through.`,
                );
              }
              recovery.prevSignature = null;
              recovery.prevInventorySize = -1;
              hint = undefined;
              continue;
            }
            const WIZARD_FORWARD =
              /^\s*(?:next|continue|submit|finish|done|get\s+started)\s*$/i;
            const wizardBtn = inventory.find(
              (e) =>
                (e.tag === "button" || e.role === "button") &&
                WIZARD_FORWARD.test((e.visibleText ?? e.ariaLabel ?? "").trim()) &&
                e.visible === true,
            );
            if (wizardBtn !== undefined && !recovery.triedWizardForward.has(state.url)) {
              recovery.triedWizardForward.add(state.url);
              args.steps.push(
                `Post-verify: stuck-loop ${recovery.stuckFiresAtUrl}x at ${state.url} — wizard-forward escalation: clicking ${JSON.stringify(wizardBtn.visibleText ?? wizardBtn.ariaLabel)}.`,
              );
              try {
                await this.browser.click(wizardBtn.selector);
                await this.browser.wait(2);
              } catch (err) {
                args.steps.push(
                  `Post-verify: wizard-forward click failed (${err instanceof Error ? err.message : String(err)}) — falling through to URL fallback.`,
                );
              }
              recovery.prevSignature = null;
              recovery.prevInventorySize = -1;
              hint = undefined;
              continue;
            }
            const fallback = pickStuckLoopFallbackUrl(
              state.url,
              recovery.triedFallbackUrls,
              args.service,
              this.resolvedSignupUrl,
            );
            if (fallback !== null) {
              recovery.triedFallbackUrls.add(fallback);
              args.steps.push(
                `Post-verify: stuck-loop detected ${recovery.stuckFiresAtUrl}x at ${state.url} — escalating to a hardcoded API-key URL: ${fallback}`,
              );
              try {
                await this.browser.goto(fallback);
                await this.browser.waitForInteractiveDom(5, 15_000);
              } catch (err) {
                args.steps.push(
                  `Post-verify: stuck-loop fallback navigate failed (${err instanceof Error ? err.message : String(err)}) — continuing.`,
                );
              }
              // Reset signature tracking so the next round starts clean
              // against the new URL's inventory. Don't reset
              // recovery.stuckFiresAtUrl here — it's keyed by URL and the URL
              // about to be observed will be different, which naturally
              // resets it on the next loop entry.
              recovery.prevSignature = null;
              recovery.prevInventorySize = -1;
              hint = undefined;
              // Don't bump capturedRound — captureOnboardingRound above
              // already wrote a capture for this round (the stuck-loop
              // detector runs AFTER the capture, so the planner's
              // observed step IS on disk). Bumping again here would
              // leave a phantom gap in the chain that verifyCaptureChain
              // rejects as missing_round.
              continue;
            }
            // Every plausible fallback URL has been tried and we're
            // still stuck. Mark with the [stuck_loop] sentinel so the
            // caller surfaces planner_stuck instead of the generic
            // oauth_onboarding_failed, then break out of the loop.
            this.lastPostVerifyDoneReason =
              `[stuck_loop] planner re-picked the same ${nextStep.kind} step ${recovery.stuckFiresAtUrl} times at ${state.url} with no inventory change; ` +
              `hardcoded API-key URL fallbacks exhausted (tried: ${[...recovery.triedFallbackUrls].join(", ") || "none"}). ` +
              `Latest planner reason: ${nextStep.reason}`;
            args.steps.push(
              `Post-verify: stuck-loop unresolvable — breaking out with planner_stuck.`,
            );
            break;
          }
          args.steps.push(
            sameSelector
              ? `Post-verify: no-progress detected — same ${nextStep.kind} on same selector, inventory unchanged. Re-planning instead of re-running.`
              : `Post-verify: no-progress detected — successive click steps with no inventory change. Forcing a non-click action.`,
          );
          // A click that changed nothing often means an INLINE validation
          // error is gating submit (e.g. deepseek's "Please enter the
          // verification code" — red text, not a toast). Surface it + a
          // forensic snapshot so the stall is diagnosable instead of silent.
          const stallError = await this.browser.captureTransientAlert(0);
          let stallHint = "";
          if (stallError.length > 0) {
            args.steps.push(`Post-verify: page shows an inline message: "${stallError}"`);
            stallHint = ` The page currently shows this message: "${stallError}" — it explains the block; address it (the named field is likely empty/invalid to the form despite looking filled).`;
          }
          await saveDebugSnapshot(this.browser, "post-verify-stuck");
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
            uncheckedBoxHint +
            stallHint;
          recovery.prevSignature = signature;
          recovery.prevInventorySize = inventory.length;
          continue;
        }
        recovery.prevSignature = signature;
        recovery.prevInventorySize = inventory.length;
      } else {
        // Reset the signature on non-repeatable kinds so a `navigate`
        // followed by a `click` doesn't pattern-match the click against
        // a click before the navigate.
        recovery.prevSignature = null;
        recovery.prevInventorySize = inventory.length;
      }

      // Record the kind of the step we're ABOUT to execute (all re-plan
      // `continue` guards are behind us here) so next round can judge
      // whether it changed the page — the stalled-wizard breaker above.
      recovery.lastActionKind = nextStep.kind;
      recovery.lastActionSelector =
        "selector" in nextStep && typeof nextStep.selector === "string"
          ? nextStep.selector
          : null;

      if (nextStep.kind === "done") {
        // When the planner bails because it encountered Google's
        // device-verification challenge mid-post-verify (Algolia +
        // similar redirect their `signup_url` to a sign-in page,
        // OAuth handoff happens AFTER runOAuthFlow already exited),
        // fire the heightened-auth notifier AND wait the 2-minute
        // window for the operator to tap their phone. After the
        // wait, re-read the page state and continue post-verify —
        // Google's challenge typically clears within seconds of the
        // tap and the dashboard becomes accessible.
        if (
          this.maybeFirePostVerifyHeightenedAuth(
            nextStep.reason,
            args.service,
            args.steps,
          )
        ) {
          args.steps.push(
            "Post-verify: waiting 120s for the operator to clear Google's device challenge",
          );
          await this.browser.wait(120);
          // Re-loop — next iteration's waitForFormReady + inventory
          // read see the post-challenge dashboard.
          continue;
        }
        // Premature-done guard. The planner sometimes concludes "nothing
        // to extract" on an authenticated dashboard whose API keys live on
        // a settings/API-keys page it never visited — render's case: an
        // empty SERVICES list ("no services created yet") is NOT the same
        // as "no API keys", which sit under Account Settings. Before
        // accepting `done` with zero credentials captured, navigate to an
        // unvisited canonical keys URL (same fallback list the stuck-loop
        // escalation uses). Bounded by recovery.triedFallbackUrls — once every
        // candidate is exhausted, `done` is honored.
        const capturedCredCount = Object.keys(credentials).filter(
          (k) => !NON_CREDENTIAL_KEYS.has(k),
        ).length;
        if (capturedCredCount === 0 && recovery.prematureDoneFallbacks < MAX_PREMATURE_DONE_FALLBACKS) {
          // Prefer CLICKING a real API-keys nav link over guessing a URL.
          // The dashboard's own sidebar/menu link carries the correct href;
          // guessing /keys, /api-keys, /settings/api-keys 404s on services
          // that host keys at a non-standard path (unify-ai). Only when no
          // such link is in the DOM do we fall through to URL composition.
          const keysLink = findApiKeysNavLink(inventory, recovery.clickedKeysLinks);
          if (keysLink !== null) {
            recovery.prematureDoneFallbacks += 1;
            recovery.clickedKeysLinks.add(keysLink.selector);
            const label =
              (keysLink.visibleText ?? keysLink.ariaLabel ?? keysLink.href ?? keysLink.selector) || keysLink.selector;
            args.steps.push(
              `Post-verify: planner emitted done with no credential captured — ` +
                `clicking the in-page API-keys link "${label.slice(0, 60)}" ` +
                `(${keysLink.href ?? keysLink.selector}) before guessing a URL`,
            );
            try {
              await this.browser.click(keysLink.selector);
              await this.browser.waitForInteractiveDom(5, 15_000);
            } catch (err) {
              args.steps.push(
                `Post-verify: API-keys link click failed (${err instanceof Error ? err.message : String(err)}) — continuing.`,
              );
            }
            hint = undefined;
            continue;
          }
          const fallback = pickStuckLoopFallbackUrl(
            state.url,
            recovery.triedFallbackUrls,
            args.service,
            this.resolvedSignupUrl,
          );
          if (fallback !== null) {
            recovery.prematureDoneFallbacks += 1;
            recovery.triedFallbackUrls.add(fallback);
            args.steps.push(
              `Post-verify: planner emitted done with no credential captured — ` +
                `navigating to an unvisited API-keys URL before giving up: ${fallback}`,
            );
            try {
              await this.browser.goto(fallback);
              await this.browser.waitForInteractiveDom(5, 15_000);
            } catch (err) {
              args.steps.push(
                `Post-verify: premature-done fallback navigate failed (${err instanceof Error ? err.message : String(err)}) — continuing.`,
              );
            }
            hint = undefined;
            continue;
          }
        }
        this.lastPostVerifyDoneReason = nextStep.reason;
        break;
      }
      if (nextStep.kind === "wait") {
        const waitDecision = recoveryFlow.decideWait({
          url: state.url,
          inventoryCount: inventory.length,
          reason: nextStep.reason,
        });
        if (waitDecision.kind === "break") {
          this.lastPostVerifyDoneReason = waitDecision.doneReason;
          args.steps.push(waitDecision.message);
          break;
        }
        if (waitDecision.kind === "reload") {
          args.steps.push(waitDecision.message);
          try {
            await this.browser.goto(waitDecision.url);
            await this.browser.waitForInteractiveDom(5, 15_000).catch(() => undefined);
          } catch {
            // reload failed — next round's wait will reach the break below
          }
          continue;
        }
      } else {
        recoveryFlow.recordNonWait();
      }
      hint = undefined;
      try {
        if (nextStep.kind === "extract") {
          // rc.16 — record that the planner has now affirmatively
          // asked to extract from the current page. The top-of-iter
          // early-exit consults this to distinguish "api_key came
          // from a hidden field on a billing page" (don't exit) from
          // "api_key came from a labeled credential row the planner
          // just observed" (safe to exit on single-cred services).
          credentialTracker.recordPlannerExtract();
          const extractionRound =
            await credentialExtractionFlow.runPostSignupExtractionRound({
              credentials,
              reason: nextStep.reason,
              round,
              maxRounds: args.maxRounds,
              detectPresentedCredentialLabels:
                !credentialTracker.hasObservedMultiCredPage(),
              port: {
                extractText: () => this.browser.extractText(),
                extractAllInputValues: () => this.browser.extractAllInputValues(),
                extractCredentials: () => this.extractCredentials(),
                extractFromDomProximity: () => this.extractFromDomProximity(),
                revealMaskedCredentials: () =>
                  this.browser.revealMaskedCredentials(),
                extractLabeledCredentialCandidates: () =>
                  this.browser.extractLabeledCredentialCandidates(),
                countPresentedCredentialLabels: () =>
                  this.countPresentedCredentialLabels(),
              },
            });
          args.steps.push(...extractionRound.steps);

          if (
            extractionRound.presentedCredentialCount !== null &&
            extractionRound.presentedCredentialCount >= 2 &&
            credentialTracker.recordPageOffersMultiCred()
          ) {
            args.steps.push(
              `Post-verify ${round + 1}/${args.maxRounds}: page presents ${extractionRound.presentedCredentialCount} distinct credentials — holding the loop open to harvest all (not just the first).`,
            );
          }

          // Anything found across all tiers? hasMultiCredCredentials
          // also catches non-api_key labels (cloud_name, application_id).
          if (extractionRound.foundAnyCredential) {
            recoveryFlow.recordExtractionSuccess();
            continue;
          }

          // True extract failure — every tier missed. Try the legacy
          // single-value planner-quoted fallback for services whose
          // planner prose just bare-quotes the value without a known
          // label vocabulary (Railway UUID-only, IPInfo 14-hex).
          {
            const quoted = extractQuotedTokenFromReason(
              nextStep.reason,
              extractionRound.verifySource,
            );
            if (quoted !== null) {
              credentials.api_key = quoted;
              args.steps.push(
                `Post-verify ${round + 1}/${args.maxRounds}: extracted token via ` +
                  `planner-quoted fallback (${quoted.slice(0, 4)}…${quoted.slice(-4)})`,
              );
              recoveryFlow.recordExtractionSuccess();
              continue;
            }
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
            const failedExtract = recoveryFlow.decideFailedExtract();
            if (failedExtract.kind === "replan") {
              args.steps.push(failedExtract.message);
            }
            hint = failedExtract.hint;
          }
        } else if (nextStep.kind === "login") {
          const loginResult = await loginFlow.handleLoginRequest({
            ...(args.credentials !== undefined
              ? { credentials: args.credentials }
              : {}),
            steps: args.steps,
            port: {
              getState: () => this.browser.getState(),
              loginWithCredentials: (email, password, steps) =>
                this.loginWithCredentials(email, password, steps),
            },
          });
          if (loginResult.kind === "oauth_session_not_persisted") {
            throw new OAuthSessionNotPersistedError(
              `oauth_session_not_persisted: signed in to ${args.service} via OAuth but the ` +
                `page still presents a login screen (${loginResult.url !== null ? pathOf(loginResult.url) : "?"}) — the ` +
                `OAuth callback never established a session (anti-bot rejection of the callback, ` +
                `or a service-side session-storage issue). Finish the signup manually.`,
            );
          }
          if (loginResult.kind === "break") {
            break;
          }
        } else {
          const execution = await actionExecutor.execute({
            step: nextStep as PostSignupExecutableAction,
            credentials,
            snapshotPostClickAlert: () =>
              saveDebugSnapshot(this.browser, "post-verify-alert"),
          });
          args.steps.push(...execution.steps);
          if (execution.hint !== undefined) hint = execution.hint;
        }
      } catch (err) {
        args.steps.push(
          `Post-verify action failed (${nextStep.kind}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Don't bail — Claude may recover on the next round.
      }
      const syntheticResult = await syntheticCapture.afterAction({
        service: args.service,
        loopRound: round,
        capturedRound,
        oauth,
        actionKind: nextStep.kind,
        credentials,
        steps: args.steps,
        ...(this.lastResolvedModel !== undefined
          ? { resolvedModel: this.lastResolvedModel }
          : {}),
        ...(this.lastResolvedProvider !== undefined
          ? { resolvedProvider: this.lastResolvedProvider }
          : {}),
        ...(this.roundUploader !== undefined
          ? { roundUploader: this.roundUploader }
          : {}),
        port: {
          extractCredentials: () => this.extractCredentials(),
          getState: () => this.browser.getState(),
          buildInventory: () => this.buildInventory(args.steps, undefined, 80),
          captureRound: captureOnboardingRound,
        },
      });
      capturedRound = syntheticResult.capturedRound;
    }
    // 0.8.2-rc.10 — existing-account-no-extract classifier. Runs once
    // at loop exit when no credential surfaced AND no more specific
    // marker (paywall, anti-bot, stuck_loop) was already set on
    // lastPostVerifyDoneReason. The test identity
    // (methoxine@gmail.com) accumulates real signups across batches;
    // re-running against the same vendor lands the bot on an
    // authenticated dashboard whose API-keys page shows a masked
    // pre-existing key it cannot reveal (most vendors only show the
    // key value once at create-time). Reporting these as
    // oauth_onboarding_failed is misleading — the bot did navigate
    // correctly, the state is just unrecoverable for this identity.
    const alreadyClassified =
      this.lastPostVerifyDoneReason !== null &&
      this.lastPostVerifyDoneReason.startsWith("[");
    const noCredentialYet =
      credentials.api_key === undefined && credentials.username === undefined;
    // Distinct from a generic prior classification: ONLY the existing-
    // account path is recoverable by minting. A [stuck_loop] / [paywall]
    // / [anti_bot] marker is a different failure the mint flow can't fix,
    // so leave those alone.
    const alreadyExistingAccount =
      this.lastPostVerifyDoneReason !== null &&
      this.lastPostVerifyDoneReason.startsWith("[existing_account_no_extract]");
    // The mint flow is appropriate for the existing-account /
    // already-signed-in category ONLY. A [stuck_loop] / [paywall] /
    // [anti_bot] marker is a different, non-recoverable failure — leave
    // those alone. An UNclassified exit reaching here IS the
    // already-signed-in case (postVerifyLoop only runs on an
    // authenticated dashboard — `already_oauth` / post-OAuth), so it's
    // eligible too; the mint flow self-gates by requiring a real keys
    // page + a create affordance before it acts.
    const mintEligible =
      noCredentialYet && (!alreadyClassified || alreadyExistingAccount);
    if (mintEligible) {
      // SUCCEED-EVEN-WHEN-ACCOUNT-EXISTS: before bailing, navigate to
      // the keys page and either extract a readable key or mint a fresh
      // one. A new key is a valid outcome. attemptMintNewKey returns
      // null when there is genuinely no create affordance anywhere (key
      // creation paywalled / no keys page) — then we fall through to the
      // honest bail.
      let minted: Record<string, string> | null = null;
      try {
        minted = await this.attemptMintNewKey(args.steps, args.service);
      } catch {
        // best-effort — degrade to the existing classifier below
      }
      if (minted !== null && hasAnyExtractedCredential(minted)) {
        for (const [k, v] of Object.entries(minted)) {
          if (credentials[k] === undefined) credentials[k] = v;
        }
        // Clear any existing-account sentinel — we recovered.
        if (alreadyExistingAccount) this.lastPostVerifyDoneReason = null;
        args.steps.push(
          "Post-verify: existing-account / already-signed-in dashboard recovered — minted/extracted a usable key instead of bailing.",
        );
        await this.writeFastPathSyntheticCapture(
          args.service,
          capturedRound,
          oauth,
          "existing-account recovery synthetic extract — credentials were minted/extracted after the planner loop",
        );
        return credentials;
      }

      // Mint failed. If the masked-pre-existing-key shape is detectable
      // AND not already flagged by the stuck-loop early-exit, mark the
      // honest existing_account_no_extract bail so the caller surfaces
      // the precise status rather than the generic
      // no_credentials_after_already_signed_in.
      if (!alreadyExistingAccount) {
        try {
          const finalState = await this.browser.getState();
          const finalText = await this.browser.extractText().catch(() => "");
          if (
            detectExistingAccountNoExtract({
              url: finalState.url,
              pageText: finalText,
              lastPlannerReason: this.lastPostVerifyDoneReason ?? "",
            })
          ) {
            this.lastPostVerifyDoneReason =
              `[existing_account_no_extract] at ${finalState.url}; latest planner reason: ${this.lastPostVerifyDoneReason ?? "(none — loop exhausted)"}`;
            args.steps.push(
              "Post-verify: classified as existing_account_no_extract — pre-existing keys are masked and no key-minting affordance was found.",
            );
          }
        } catch {
          // best-effort classifier — never block returning credentials
        }
      }
    }
    return credentials;
  }

  // 0.8.3-rc.1 — write a single synthetic extract round when the
  // post-verify loop is about to fast-path exit (pre-loop extraction
  // already produced credentials, so no planner-driven round runs).
  // Without this, auto-promote sees no captures from the run and
  // skips publishing a skill — perplexity's "fast path" case.
  //
  // The synthesized capture pairs the CURRENT browser state (URL +
  // inventory) with a synthetic `extract` observation. The
  // synthesizer's stage-1 step builder will prepend a `navigate` to
  // the current URL and translate the synthetic round into an
  // `extract_via_*` step, giving the registry a minimal but correct
  // replay skill ("navigate to the credential page, extract").
  //
  // Best-effort: a capture failure here must NEVER block returning
  // the credential we already have.
  private async writeFastPathSyntheticCapture(
    service: string,
    capturedRound: number,
    oauth: boolean,
    reason =
      "fast-path synthetic extract — credentials were already on the page before any planner round ran",
  ): Promise<void> {
    try {
      const [state, inventory] = await Promise.all([
        this.browser.getState(),
        this.buildInventory([], undefined, 80),
      ]);
      captureOnboardingRound({
        service,
        round: capturedRound,
        oauth,
        state,
        inventory,
        observed: {
          kind: "extract",
          reason,
        },
      });
    } catch {
      // best-effort
    }
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
    const findLoginFields = (inventory: ReadonlyArray<InteractiveElement>) => {
      const emailEl =
        inventory.find((e) => e.tag === "input" && e.type === "email") ??
        inventory.find(
          (e) => e.tag === "input" && (e.type === "text" || e.type === null),
        );
      const pwEl = inventory.find((e) => e.tag === "input" && e.type === "password");
      return { emailEl, pwEl };
    };
    let inv = await this.buildInventory(steps);
    let { emailEl, pwEl } = findLoginFields(inv);

    // Poll for the form to render after a click. SPA login forms reveal on a
    // VARIABLE delay — portkey's "Continue with work email" → password form was
    // a render race where a fixed wait passed one run and missed the next
    // (stochastic login). Re-reads up to maxAttempts times ~1.2s apart, mutating
    // inv/emailEl/pwEl, returning as soon as the wanted field(s) appear. Uses a
    // throwaway steps array so polling doesn't spam the trail.
    const pollForFields = async (
      maxAttempts: number,
      requirePassword: boolean,
    ): Promise<void> => {
      for (let i = 0; i < maxAttempts; i++) {
        await this.browser.wait(1.2);
        inv = await this.buildInventory([]);
        ({ emailEl, pwEl } = findLoginFields(inv));
        const done = requirePassword
          ? pwEl !== undefined
          : pwEl !== undefined || emailEl !== undefined;
        if (done) return;
      }
    };

    // Two-stage email login: many login pages render only provider buttons
    // ("Continue with Google / Microsoft / work email", SSO) and reveal the
    // email+password inputs ONLY after you click the email option. portkey
    // (MEASURED 2026-06-17): /login is button-only with "Continue with work
    // email". Click that affordance — NOT Google/Microsoft/SSO — then re-read.
    if (emailEl === undefined || pwEl === undefined) {
      const emailButton = inv.find((e) => {
        if (e.tag !== "button" && e.type !== "submit") return false;
        const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.toLowerCase();
        return (
          t.includes("email") &&
          /\b(continue|log ?in|sign ?in|use|with|password)\b/.test(t) &&
          !/google|microsoft|apple|github|\bsso\b|single sign/.test(t)
        );
      });
      if (emailButton !== undefined) {
        // The continue button is frequently DISABLED until a Terms/consent
        // checkbox is ticked (portkey, MEASURED 2026-06-17: "Continue with
        // work email" stays inert until the TOS box is checked → the click
        // silently no-ops and the form never reveals). Tick required agreement
        // boxes first (skips marketing opt-ins; best-effort, never throws).
        const agreed = await this.browser.checkRequiredAgreementBoxes();
        if (agreed.length > 0) {
          steps.push(
            `Login: ticked terms/consent box(es) [${agreed.join(", ")}] to enable the button.`,
          );
          await this.browser.wait(1);
        }
        steps.push(
          `Login: two-stage page — clicking "${(emailButton.visibleText ?? "email")
            .slice(0, 40)
            .trim()}" to reveal the email/password form.`,
        );
        await this.browser.click(emailButton.selector);
        // Poll up to ~10s for the form to reveal (render race — see above).
        await pollForFields(8, false);
      }
    }

    // Progressive (email-first) login: some flows reveal ONLY the email field;
    // you enter it, click Continue, THEN the password field appears on the next
    // step. portkey (MEASURED 2026-06-17): "Continue with work email" → email
    // field → Continue → password. Fill the email, advance, and re-read.
    if (emailEl !== undefined && pwEl === undefined) {
      await this.browser.type(emailEl.selector, email).catch(() => undefined);
      const advance =
        inv.find((e) => e.type === "submit") ??
        inv.find(
          (e) =>
            (e.tag === "button" || e.type === "submit") &&
            /\b(continue|next|log ?in|sign ?in|submit)\b/i.test(
              `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`,
            ),
        );
      if (advance !== undefined) {
        steps.push(
          "Login: email-first flow — submitted the email, advancing to the password step.",
        );
        await this.browser.clickSubmit(advance.selector).catch(() => undefined);
        // Poll up to ~10s for the password step to render (render race).
        await pollForFields(8, true);
      }
    }
    if (pwEl === undefined) {
      steps.push("Login: no password field reachable — skipped.");
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
      // The email may already have been entered on the prior step.
      if (emailEl !== undefined) {
        await this.browser.type(emailEl.selector, email);
      }
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
    // A running summary of the steps already taken this session (most
    // recent last). The planner is STATELESS per call — without this it
    // re-does completed onboarding-wizard steps (role/company-size/ToS)
    // and re-issues navigates to URLs that already failed to advance.
    // Several existing prompt instructions ("if you already navigated
    // here once and the URL didn't change…") are dead without it.
    priorActions?: readonly string[];
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
${
  input.priorActions !== undefined && input.priorActions.length > 0
    ? `
STEPS ALREADY TAKEN this session (most recent last). You plan ONE step
at a time and do not otherwise remember earlier rounds — use this list
so you do NOT loop:
${input.priorActions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}
- Do NOT repeat a completed onboarding-wizard step. If you already
  selected a role / company-size / use-case or accepted the terms, that
  step is DONE — move forward, never back to it.
- Do NOT re-issue a {"kind":"navigate"} to a URL that already appears
  above and did not advance you. If a settings URL errored or bounced
  you back, try a DIFFERENT path or click a dashboard link instead.
- If the last 3+ steps above are the same kind on the same URL with no
  progress, you are stuck — try a genuinely different action or return
  {"kind":"done"}.
`
    : ""
}
Strategy:
- If a FULL, untruncated API key is visible, return {"kind":"extract"}.
- **MULTI-CREDENTIAL SERVICES** — when the page shows TWO OR MORE
  DISTINCT labeled credentials (e.g. Cloudinary shows cloud_name +
  api_key + api_secret; Algolia shows application_id + admin_api_key +
  search_api_key; Twilio shows account_sid + auth_token; Stripe shows
  publishable_key + secret_key; AWS shows access_key_id +
  secret_access_key) — return ONE {"kind":"extract"} step whose reason
  labels EVERY visible credential in the format
  \`<canonical_label>='<value>'\` (use SINGLE quotes around values).
  The bot's labeled-extractor will pull EACH labeled value into the
  credentials object. Example SHAPE (the bracketed parts are
  PLACEHOLDERS — you MUST substitute the REAL values visible on the
  CURRENT page; NEVER emit these literal bracket strings or any example
  values, and never name a service that is not the one you are on):
  "The API Keys page shows cloud_name='<real cloud_name from this page>'
  and api_key='<real api_key from this page>' in the table; api_secret
  is hidden behind a Reveal button."
  Use the standard canonical labels: api_key, api_secret, secret_key,
  publishable_key, access_token, client_id, client_secret, cloud_name,
  application_id, admin_api_key, search_api_key, account_sid,
  auth_token, app_key, org_id, consumer_key, consumer_secret,
  access_token_secret, project_api_key, personal_api_key.
  If only ONE credential is visible, omit the labels and quote the
  value as before — the single-cred fallback handles that path.
- A key shown masked or truncated (with "...", dots, or "•") is NOT
  extractable — its full value is shown only once, at creation. Do NOT
  return "extract" for a masked key, and do not return "extract" twice
  in a row. Instead click "Create API Key" / "New API Key" / "Generate"
  to make a fresh key, then extract its full value.
- **PARTIAL MULTI-CRED EXTRACT IS BETTER THAN ZERO** — on a multi-
  cred page where some credentials are visible and others are masked
  behind a Reveal button, return {"kind":"extract"} NOW for the
  visible labels (the bot's labeled extractor folds them into the
  credentials bundle) AND in the same reason field flag the masked
  credential so the bot's automatic reveal pass fires. Example SHAPE
  (substitute the REAL values from the current page — the bracketed
  parts are placeholders, never emit them literally): "cloud_name='<real
  value>' and api_key='<real value>' are visible in the table;
  api_secret is hidden behind a Reveal button — please unmask." The masked
  credential's label MUST appear with one of the trigger words
  (masked / hidden / reveal / unmask / bullets / asterisks) so the
  reveal pass triggers. Do this BEFORE attempting any explicit
  reveal click — getting the visible values into the bundle first
  means a failed reveal click only loses the masked credential, not
  the visible ones too.
- **REVEAL-CLICK AS A FALLBACK** — when the page has ONLY a masked
  credential (no visible siblings) AND there is a VISIBLE "Show",
  "Reveal", "Eye", or eye-icon button next to it, emit a CLICK on
  that button. If a previous reveal click had no effect (the page's
  inventory and screenshot look identical), do NOT keep retrying —
  emit {"kind":"extract"} anyway: the bot's labeled extractor will
  capture whatever IS visible (even if just a cloud_name with no
  api_secret) and return the partial bundle to the caller, which is
  more useful than five wasted rounds of clicking a dead reveal.
- To reach API keys, PREFER clicking a visible "API Keys" / "Tokens" /
  "Developer" / "Settings" link in the INVENTORY (a verified selector) — that
  always lands on the real page. Only use {"kind":"navigate"} to a GUESSED
  settings URL when NO such link is in the inventory, and NEVER guess the same
  URL twice. These pages usually live under user/ACCOUNT settings, not a
  project or workspace's settings.
- **404 RECOVERY.** If the page is a 404 / "not found" / "page doesn't exist"
  / "we couldn't find" (a guessed URL missed), do NOT retry it or guess
  another URL. {"kind":"navigate"} to the service's app ROOT/dashboard (the
  bare origin, e.g. https://app.<service>.com/) and find the API-keys link in
  the nav from there.
- **EXCEPT** when the page has a very small inventory (5 or fewer elements)
  and one of them is an onboarding CTA — patterns like "Get started",
  "Continue", "Activate", "Enable API", "Start free trial", "Set up".
  These are gating CTAs that unlock the API console; CLICKING them
  is required, navigate will just redirect you back. If you've already
  emitted a navigate once on this URL and the URL did not change on the
  next round, that is the signal — the service is gating the route. Click
  the visible CTA instead.
- Otherwise click a dashboard menu link like "API Keys" / "Tokens" /
  "Developer" / "Settings" — using its inventory selector.
- If there's an onboarding modal or a "Skip" link blocking, dismiss it.
- Some signup wizards present a CHOICE as a grid of clickable cards
  (Cloudinary's "What are you trying to do?", Koyeb's use-case picker,
  etc.) rather than as a standard \`<input type="radio">\`. Inventory
  lines tagged \`[card-radio N/M]\` are members of one such group —
  exactly one card needs to be clicked to advance past this wizard step.
  Prefer cards whose text matches "personal", "individual", "starter",
  "hobby", "free", "general", or "other"; if none clearly match, click
  the FIRST card (least committal). After the click, expect a
  "Continue" / "Next" button on the following round — do NOT return
  "done" while a card-radio cluster is still visible.
- Do NOT \`fill\` an input whose text is an illustrative EXAMPLE (it reads like
  a full sentence, e.g. "Optimize images for my eCommerce site…") when the page
  ALSO shows preset choice buttons for the same step (e.g. "Optimize assets",
  "Transform images", "Next"). That input is a placeholder, not a field to
  complete — click a preset option button or "Next" instead.
- **OPTIONAL SETUP / INTEGRATION WIZARD STEPS — SKIP them, do NOT complete.**
  Some post-signup wizards ask you to CONFIGURE the product, not to create the
  account: "What's your tech stack / framework / language?" (a grid of SDK or
  language logos), "Configure your sign-in methods", "Connect a repo / data
  source", "Invite your team", "Take a tour". None of these are required to
  reach an API key — engaging them only burns your limited turns. SKIP: click
  "Skip", "Skip for now", "I'll do this later", "Maybe later", "Not now", or a
  bare "Next"/"Continue" to advance WITHOUT selecting anything; if no such
  control exists, {"kind":"navigate"} straight to the app dashboard root or a
  settings / API-keys URL. Do NOT pick a framework/SDK card or fill integration
  config on these steps. (This is the OPPOSITE of a card-radio ACCOUNT-TYPE
  choice like "personal vs business" or a REQUIRED profile form, which you DO
  complete — the distinction is whether the step configures the PRODUCT/SDK
  rather than your account.)
- **BEELINE TO THE KEY — you have a limited turn budget.** Your turns are
  finite, so do not wander the onboarding flow. The moment a "Settings",
  "API Keys", "Tokens", or "Developer" link is in the inventory, GO THERE — do
  not detour through optional setup first. If you reach the authenticated
  dashboard, your very next step should head for the API-keys/settings area, not
  re-engage any setup wizard.
- **MULTI-FIELD PROFILE / ONBOARDING FORM ("Set up your account",
  "Tell us about yourself").** When the page is a form with SEVERAL fields
  (first/last name, country/region, company, job title, phone, use-case,
  cloud region) gating a "Continue" / "Next" / "Submit" button, you must
  fill EVERY visible empty text input and pick an option for EVERY
  unselected dropdown — across your one-action-per-turn budget — BEFORE
  clicking the gating button. Clicking it while ANY required field is
  empty just re-renders the same page with red "X is required" errors and
  wastes a round. Consult STEPS ALREADY TAKEN to see which fields you've
  done and fill a REMAINING empty one each turn; only click Continue once
  nothing is left empty.
- When choosing a dropdown/select option for a profile field (job title,
  role, use-case, company size, "how did you hear"), prefer a CONCRETE
  real option (e.g. "Software Engineer", "Startup") — NEVER pick
  "Other" / "None" / "Prefer not to say". Selecting "Other" SPAWNS an
  extra required free-text field ("Please specify") that you then also
  have to fill, costing rounds for no benefit.
${loginGuidance}
- If we're on a "verify your phone" / "verify email" wall, return done (we can't solve those).
- **EMPTY DASHBOARD — create the first resource.** Many services do NOT expose
  an API key until you create your first organization / project / cluster /
  database / service / workspace. If the dashboard shows NO existing resources
  (an empty state, "Create your first…", "No projects/clusters yet", "Get
  started by creating…", or just a lone "Create"/"New <resource>"/"+ New" CTA
  and nothing else useful), CLICK that CTA, then on the following rounds fill
  the minimal required fields (use a generated name like ts-<random> for
  name/slug fields, pick the first/free option for plans/regions) and confirm.
  The API-keys / tokens page appears only AFTER a resource exists. Do NOT
  return {"kind":"done"} or {"kind":"login"} on an empty dashboard while a
  create-resource CTA is visible — that is the path forward, not a dead end.
- **API-KEYS / TOKENS PAGE — the path to a key is CREATE, not extract.** On any
  API-keys / tokens / secrets page that offers a "Create" / "Generate" /
  "New token" / "New key" button, CLICK it to mint a fresh key — this holds
  whether the page is EMPTY (no keys yet) or LISTS EXISTING keys (masked ••••,
  with Copy / Reveal / Revoke buttons). An empty page has nothing to read, and
  existing keys are UNRECOVERABLE (shown once at creation, so their "Copy"
  button yields only the masked display or a useless id) — so {"kind":"extract"}
  returns nothing usable here either way. Do NOT extract and do NOT click an
  existing key's Copy button on this page. Extract ONLY when a COMPLETE,
  UNMASKED key value is actually displayed on screen (typically the one-time
  modal right after you click Create).
- **Pre-filled fields are DONE — advance, don't re-touch.** If a required
  onboarding field (first name, company, email) is ALREADY populated, or a
  required selectable is ALREADY selected, do NOT re-fill/re-select it — click
  Continue / Next / Submit to move forward. Re-filling a satisfied field loops.
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
      { kind: "image", media_type: imageMediaType(input.state.screenshot), data_base64: input.state.screenshot },
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
      // Deterministic: the same dashboard page must yield the same next step
      // run-to-run, so the offline eval is a faithful, noise-free signal and
      // signups don't "randomly" navigate differently (D2 / DESIGN-planner-
      // navigation-eval.md). The stall-detector + prior-action memory are the
      // escape from a deterministic loop.
      temperature: 0,
      // Fix C — pin a single model + provider + seed on the proxy path so
      // the same dashboard yields the same step regardless of which backend
      // OpenRouter would otherwise route to (the model/provider lottery
      // survives temperature 0).
      deterministic: true,
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
  // After a form submit, is the page a CONTINUATION step of the SAME signup
  // (amplitude's dedicated "Create your password" page is the canonical case)
  // rather than a dashboard, a credentials page, or a verify-your-email
  // screen? Returns a short label for the step trail, or null. Reused
  // fillValues already carry the password, so re-running planExecuteWithRetry
  // fills it. See isContinuationFormStep for the (conservative) signals.
  private async detectContinuationFormStep(): Promise<string | null> {
    let html = "";
    let url = "";
    let inventory: InteractiveElement[];
    try {
      const state = await this.browser.getState();
      html = state.html;
      url = state.url;
      inventory = await this.browser.extractInteractiveElements();
    } catch {
      return null;
    }
    return isContinuationFormStep(html, inventory)
      ? `continuation form at ${pathOf(url)}`
      : null;
  }

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
    // EXTRACTION_ENGINE (default-ON since 2026-06-15, strangler slice 4): route the
    // cross-pass accumulation + resolution through the pure extraction module
    // (extraction.ts). Flipped after pass-1 live validation (ipinfo → api_key) on
    // the dominant path; the truncated/clipboard path (pass 2) reuses the IDENTICAL
    // I/O as inline — only the unit-tested accumulation differs — and its
    // truncated-modal services (OpenRouter-class) are currently anti-bot-walled, so
    // its live blast radius is ~zero. The inline 5-pass body below is kept one cycle
    // as the explicit opt-out (EXTRACTION_ENGINE=0) and deleted next
    // (DESIGN-extraction-engine.md migration step 4).
    if (!/^(0|false|off|no)$/i.test(process.env.EXTRACTION_ENGINE ?? "")) {
      return this.extractCredentialsViaEngine();
    }
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

    // Never trust a credential read off a documentation page — it's a
    // realistic SAMPLE (Anthropic's /docs get-started shows a shape-valid
    // sk-ant-api03-... example). Returning empty keeps the post-verify loop
    // navigating to the real keys console instead of false-succeeding here.
    const curUrl =
      typeof this.browser.currentUrl === "function"
        ? this.browser.currentUrl()
        : "";
    if (typeof curUrl === "string" && isDocumentationUrl(curUrl)) {
      return credentials;
    }

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

  // EXTRACTION_ENGINE path (strangler slice 4) — the same five-pass extraction as
  // extractCredentials, but the cross-pass accumulation (first full wins; first
  // truncated remembered) + final resolution go through the pure module
  // (extraction.ts). This method owns only the I/O + the per-candidate regex
  // classification. Faithful to the inline passes (incl. the subtlety that passes
  // 3 + 4 accept FULL hits only — they never record a truncated stub).
  private async extractCredentialsViaEngine(): Promise<Record<string, string>> {
    const curUrl =
      typeof this.browser.currentUrl === "function" ? this.browser.currentUrl() : "";
    if (typeof curUrl === "string" && isDocumentationUrl(curUrl)) return {};

    let st = initialExtractionState();
    const classify = (text: string): CandidateClass => {
      const hit = extractApiKeyFromText(text);
      if (hit === null) return { kind: "none" };
      return isTruncatedCapture(text, hit) ? { kind: "truncated", value: hit } : { kind: "full", value: hit };
    };

    // Pass 1 — visible candidates (records truncated hits).
    for (const candidate of await this.browser.extractCredentialCandidates()) {
      st = accumulateCandidate(st, classify(candidate));
      if (hasFullHit(st)) return resolveExtraction(st);
    }
    // Pass 1b — body text (records truncated hits).
    if (!hasFullHit(st)) {
      st = accumulateCandidate(st, classify(await this.browser.extractText()));
      if (hasFullHit(st)) return resolveExtraction(st);
    }
    // Pass 2 — copy-button + clipboard recovery, only when a truncated stub was
    // seen. The copied value is accepted as a full hit directly (inline does the
    // same — no re-classification).
    if (!hasFullHit(st) && st.truncatedHit !== null) {
      const copied = await this.tryCopyButtonExtraction();
      if (copied !== null) {
        st = accumulateCandidate(st, { kind: "full", value: copied });
        if (hasFullHit(st)) return resolveExtraction(st);
      }
    }
    // Pass 3 — hidden-input scan. FULL hits only (inline ignores truncated here).
    if (!hasFullHit(st)) {
      try {
        for (const value of await this.browser.extractAllInputValues()) {
          const c = classify(value);
          if (c.kind !== "full") continue;
          st = accumulateCandidate(st, c);
          if (hasFullHit(st)) return resolveExtraction(st);
        }
      } catch {
        // non-fatal
      }
    }
    // Pass 4 — copy-button colocation. A bare UUID is accepted directly; otherwise
    // the normal extractor, FULL only (inline records no truncated here).
    if (!hasFullHit(st)) {
      try {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const candidate of await this.browser.extractCredentialsNearCopyButtons()) {
          const c: CandidateClass = UUID_RE.test(candidate)
            ? { kind: "full", value: candidate }
            : classify(candidate);
          if (c.kind !== "full") continue;
          st = accumulateCandidate(st, c);
          if (hasFullHit(st)) return resolveExtraction(st);
        }
      } catch {
        // non-fatal
      }
    }
    return resolveExtraction(st);
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
