// OAuth provider login as plain functions over the live BrowserController.
//
// Moved verbatim from browser.ts (design PR 6, layer-contracts): the
// controller keeps only page-lifetime state; every piece of OAuth logic —
// provider-tab handshake, consent/2FA challenge handling, completion
// evidence, session-cookie probes, and the operator action lease that
// serializes OAuth calls — lives here. Functions take the controller as
// their first argument and read its public OAuth state fields; the
// per-controller page slots stay on the controller's PageDriver.
//
// Click-dispatch bookkeeping (BrowserClickDispatchError) lives in
// click-dispatch.ts, a leaf module, so this file needs no runtime import
// back through browser.ts.

import type { ElementHandle, Frame, Page, Request } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import {
  classifyGoogleAuthState,
  extractGoogleHumanChallenge,
  extractGoogleNumberMatch,
  type GoogleHumanChallenge,
} from "./google-auth-state.js";
import type { HeightenedAuthNotificationResult } from "../api-client.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  markOperatorMutationDispatchAttempted,
  throwIfOperatorRequestCancelled,
} from "./request-cancellation.js";
import { BrowserClickDispatchError } from "./click-dispatch.js";
import type { BrowserController } from "./browser.js";

export interface ActiveOAuthAttempt {
  id: string;
  provider: OAuthProviderId | undefined;
  productPage: Page;
  productDocumentId: string;
  providerPage: Page | null;
  providerDocumentId: string | null;
  reporter: OAuthChallengeReporter | undefined;
  challengeEpoch?: {
    fingerprint: string;
    revision: string;
    expiresAt: number;
    reported: boolean;
    notification?: HeightenedAuthNotificationResult;
  };
}

// Fix C (operator reliability, 2026-09): an OAuth completion wait that times
// out proves only that the provider has not returned control yet — it is NOT
// evidence that a saved session expired, was revoked, or anything else about
// WHY. A live dogfood run hit this directly: Google threw a routine 2FA
// number-match challenge, the human hadn't tapped it yet when the wait
// elapsed, and the tool told the operator "the saved session may have
// expired" — a fabricated cause — while the login went on to succeed a few
// seconds later. `OAuthAwaitingHumanError` reports only what was observed
// (no origin-return within budget) and is recoverable: the caller should
// keep waiting / retry, not treat it as a dead end. `OAuthFailedError` is
// reserved for an actually-observed terminal signal (the page closed with no
// live recovery path) — still never a guess about the cause.
export type OAuthAwaitingHumanPhase = "not_attempted" | "pending";

export type OAuthChallengeReporter = (
  challenge: GoogleHumanChallenge,
  signal: AbortSignal,
) => Promise<HeightenedAuthNotificationResult>;

export class OAuthAwaitingHumanError extends Error {
  readonly phase: OAuthAwaitingHumanPhase;
  constructor(
    message: string,
    phase: OAuthAwaitingHumanPhase = "pending",
    readonly challenge?: GoogleHumanChallenge,
    readonly notification?: HeightenedAuthNotificationResult,
  ) {
    super(message);
    this.name = "OAuthAwaitingHumanError";
    this.phase = phase;
  }
}

export class OAuthFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthFailedError";
  }
}

export class OAuthOnboardingRequiredError extends Error {
  constructor(readonly origin: string) {
    super(`OAuth returned to a relying-party required-information form on ${origin}`);
    this.name = "OAuthOnboardingRequiredError";
  }
}

// The one observed denial/error signal OAuth defines: the provider redirects
// back to the relying party carrying `error=<code>` (RFC 6749 §4.1.2.1 in the
// query; §4.2.2.1 in the fragment for implicit flows). The code is reported
// verbatim — it is a fact the provider stated, not a guess.
const OAUTH_ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const OAUTH_RESPONSE_PARAMETER_NAMES = new Set([
  "access_token",
  "code",
  "error",
  "error_description",
  "error_uri",
  "expires_in",
  "id_token",
  "iss",
  "scope",
  "session_state",
  "state",
  "token_type",
]);
const OAUTH_RESPONSE_FRAGMENT_SIGNALS = new Set(["access_token", "code", "error", "id_token"]);

export function oauthErrorFromReturnUrl(
  url: string,
): { error: string; description: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const params of [
    parsed.searchParams,
    new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : ""),
  ]) {
    const error = params.get("error");
    if (error === null || !OAUTH_ERROR_CODE_RE.test(error)) continue;
    const description = params.get("error_description");
    return {
      error,
      description: description === null || description.length === 0 ? null : description,
    };
  }
  return null;
}

function oauthEndpointFamily(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function oauthRedirectChain(url: string): string[] | null {
  const chain: string[] = [];
  let source: string;
  try {
    source = new URL(url).href;
  } catch {
    return null;
  }
  const sourceFamily = oauthEndpointFamily(source);
  if (sourceFamily === null) return null;
  const seen = new Set<string>([sourceFamily]);
  while (chain.length < 2) {
    try {
      const redirectUri = new URL(source).searchParams.get("redirect_uri");
      if (redirectUri === null) break;
      const target = new URL(redirectUri);
      const targetFamily = oauthEndpointFamily(target.href);
      if (
        (target.protocol !== "http:" && target.protocol !== "https:") ||
        targetFamily === null ||
        seen.has(targetFamily)
      )
        return null;
      chain.push(target.href);
      seen.add(targetFamily);
      source = target.href;
    } catch {
      return null;
    }
  }
  if (chain.length === 2) {
    try {
      if (new URL(source).searchParams.has("redirect_uri")) return null;
    } catch {
      return null;
    }
  }
  return chain;
}

function oauthProviderForUrl(url: string): OAuthProviderId | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "accounts.google.com") return "google";
    if (host === "github.com") return "github";
    return null;
  } catch {
    return null;
  }
}

function oauthProviderOrigin(
  url: string,
  provider: OAuthProviderId | undefined,
  productOrigin: string,
): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin === productOrigin) return null;
    const recognizedProvider = oauthProviderForUrl(parsed.href);
    if (recognizedProvider === null || (provider !== undefined && recognizedProvider !== provider))
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function oauthRedirectTargetMatches(candidateUrl: string, expectedReturnUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(expectedReturnUrl);
    const expectedNames = [...new Set(expected.searchParams.keys())];
    const candidateFragment = new URLSearchParams(candidate.hash.slice(1));
    const hasOAuthResponseFragment =
      expected.hash.length === 0 &&
      candidate.hash.length > 1 &&
      [...candidateFragment.keys()].every((name) => OAUTH_RESPONSE_PARAMETER_NAMES.has(name)) &&
      [...candidateFragment.keys()].some((name) => OAUTH_RESPONSE_FRAGMENT_SIGNALS.has(name));
    const hasOnlyExpectedOrOAuthQueryParameters = [...new Set(candidate.searchParams.keys())].every(
      (name) => expectedNames.includes(name) || OAUTH_RESPONSE_PARAMETER_NAMES.has(name),
    );
    return (
      candidate.protocol === expected.protocol &&
      candidate.host === expected.host &&
      candidate.pathname === expected.pathname &&
      (candidate.hash === expected.hash || hasOAuthResponseFragment) &&
      hasOnlyExpectedOrOAuthQueryParameters &&
      expectedNames.every(
        (name) =>
          JSON.stringify(candidate.searchParams.getAll(name)) ===
          JSON.stringify(expected.searchParams.getAll(name)),
      )
    );
  } catch {
    return false;
  }
}

export interface OAuthCompletionEvidence {
  page: Page;
  terminal?: true;
  url?: string;
}

export function oauthAwaitingHumanMessage(productOrigin: string, budgetMs: number): string {
  return (
    `OAuth has not returned to ${productOrigin} within ${Math.ceil(budgetMs / 1000)} seconds. ` +
    "A consent screen or a 2FA/verification challenge may still be showing on the provider; " +
    "call operate_observe to check whether it has resolved, rather than treating this as a failure."
  );
}

const GOOGLE_ACCOUNT_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function extractGoogleAccountEmail(pageText: string): string | null {
  const chip = /Google Account:[^()]*\(([^)]+)\)/i.exec(pageText);
  if (chip?.[1] !== undefined) {
    const match = GOOGLE_ACCOUNT_EMAIL_RE.exec(chip[1]);
    if (match !== null) return match[0].trim();
  }
  return null;
}

// Map a cookie jar to the OAuth providers that have a LIVE logged-in session.
// The auth cookies that mean "signed in": GitHub → `user_session`; Google →
// a legacy *SID cookie. NID / CONSENT / 1P_JAR and the current account-chooser
// family are set even when logged out, so they are deliberately NOT signals.
// Host-scoped so a
// google.com cookie can't pass for github. Cookie NAMES + presence only;
// values are checked for non-triviality, never logged. Exported for tests.
export function sessionProvidersFromCookies(
  cookies: ReadonlyArray<{ name: string; value: string; domain: string }>,
): OAuthProviderId[] {
  const SIGNATURES: ReadonlyArray<{
    provider: OAuthProviderId;
    host: RegExp;
    names: readonly string[];
  }> = [{ provider: "github", host: /(^|\.)github\.com$/i, names: ["user_session"] }];
  const live: OAuthProviderId[] = [];
  for (const sig of SIGNATURES) {
    const present = cookies.some(
      (c) =>
        sig.host.test(c.domain.replace(/^\./, "")) &&
        sig.names.includes(c.name) &&
        c.value.length > 10,
    );
    if (present) live.push(sig.provider);
  }
  const googleSession = cookies.some(
    (cookie) =>
      /(^|\.)google\.com$/i.test(cookie.domain.replace(/^\./, "")) &&
      ["__Secure-1PSID", "SID", "HSID", "SSID", "APISID", "SAPISID"].includes(cookie.name) &&
      cookie.value.length > 10,
  );
  if (googleSession) live.push("google");
  return live;
}

// ───────────── Operator OAuth action lease ─────────────
// The deadline/lease core that serializes operator OAuth actions across
// sessions on one browser. The Session-coupled wrappers around it
// (withOAuthActionBoundary, runSerializedOAuthBoundary, …) stay in
// provision-session.ts; see the browser.ts move note in the design report.

let oauthActionLeaseTail: Promise<void> = Promise.resolve();

const DEFAULT_OAUTH_LOGIN_LEASE_COOLDOWN_MS = 3_000;
const DEFAULT_OAUTH_AUTOMATED_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_HUMAN_HANDOFF_TIMEOUT_MS = 5 * 60_000;

export interface OAuthActionDeadline {
  completionCheck?: () => Promise<OAuthCompletionEvidence | null>;
  expiresAt: number;
  timeoutMs: number;
  provider: OAuthProviderId | undefined;
  timedOut: boolean;
  inFlight: Set<Promise<unknown>>;
  phaseChanged: Promise<void>;
  signalPhaseChanged: () => void;
}

function configuredOAuthActionTimeoutMs(): number | null {
  const configured = Number(process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

export function oauthAutomatedActionTimeoutMs(): number {
  const configured = configuredOAuthActionTimeoutMs();
  return configured === null
    ? DEFAULT_OAUTH_AUTOMATED_ACTION_TIMEOUT_MS
    : Math.min(configured, DEFAULT_OAUTH_AUTOMATED_ACTION_TIMEOUT_MS);
}

export function oauthHumanHandoffTimeoutMs(): number {
  return configuredOAuthActionTimeoutMs() ?? DEFAULT_OAUTH_HUMAN_HANDOFF_TIMEOUT_MS;
}

export function oauthActionDeadline(provider: OAuthProviderId | undefined): OAuthActionDeadline {
  const timeoutMs = oauthAutomatedActionTimeoutMs();
  let signalPhaseChanged!: () => void;
  return {
    expiresAt: Date.now() + timeoutMs,
    timeoutMs,
    provider,
    timedOut: false,
    inFlight: new Set(),
    phaseChanged: new Promise<void>((resolve) => {
      signalPhaseChanged = resolve;
    }),
    signalPhaseChanged,
  };
}

export function resetOAuthActionDeadline(deadline: OAuthActionDeadline, timeoutMs: number): void {
  deadline.timeoutMs = timeoutMs;
  deadline.expiresAt = Date.now() + timeoutMs;
  deadline.timedOut = false;
  deadline.signalPhaseChanged();
  deadline.phaseChanged = new Promise<void>((resolve) => {
    deadline.signalPhaseChanged = resolve;
  });
}

export function oauthActionRemainingMs(deadline: OAuthActionDeadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

function trackOAuthActionPromise<T>(
  deadline: OAuthActionDeadline,
  promise: Promise<T>,
): Promise<T> {
  deadline.inFlight.add(promise);
  void promise.then(
    () => deadline.inFlight.delete(promise),
    () => deadline.inFlight.delete(promise),
  );
  return promise;
}

function expireOAuthAction(deadline: OAuthActionDeadline): void {
  if (deadline.timedOut) return;
  deadline.timedOut = true;
}

async function waitForOAuthActionQuiescence(deadline: OAuthActionDeadline): Promise<void> {
  for (;;) {
    const pending = [...deadline.inFlight];
    if (pending.length === 0) {
      await Promise.resolve();
      if (deadline.inFlight.size === 0) return;
      continue;
    }
    await Promise.allSettled(pending);
  }
}

// The backstop race itself only knows that its budget elapsed. The action
// boundary checks attempt-local browser completion evidence before exposing
// this fallback; without that evidence, report no guessed cause. Which fact depends on the phase: while the action was still
// queued behind a prior OAuth call's lease it was never attempted at all,
// whereas once running the inner browser.ts wait outlived its own deadline.
// Both are recoverable, not failures.
function oauthActionDeadlineError(
  deadline: OAuthActionDeadline,
  phase: "lease" | "action",
): OAuthAwaitingHumanError {
  const seconds = Math.ceil(deadline.timeoutMs / 1000);
  return new OAuthAwaitingHumanError(
    phase === "lease"
      ? "OAuth has not been attempted yet: it was still waiting behind a prior OAuth call " +
          `on this browser after ${seconds} seconds. Retry oauth_login.`
      : `OAuth action did not complete within ${seconds} seconds. ` +
          "Call operate_observe to check whether the pending step has resolved, rather than " +
          "treating this as a failure.",
    phase === "lease" ? "not_attempted" : "pending",
  );
}

export async function withinOAuthActionDeadline<T>(
  promise: Promise<T>,
  deadline: OAuthActionDeadline,
  phase: "lease" | "action" = "action",
): Promise<T> {
  const tracked = trackOAuthActionPromise(deadline, promise);
  const settled = tracked.then(
    (value) => ({ kind: "settled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  for (;;) {
    const remainingMs = oauthActionRemainingMs(deadline);
    if (remainingMs <= 0 || deadline.timedOut) {
      expireOAuthAction(deadline);
      throw oauthActionDeadlineError(deadline, phase);
    }
    const phaseChanged = deadline.phaseChanged;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      settled,
      phaseChanged.then(() => ({ kind: "phase_changed" as const })),
      new Promise<{ kind: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timed_out" }), remainingMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "phase_changed") continue;
    if (outcome.kind === "timed_out") {
      expireOAuthAction(deadline);
      throw oauthActionDeadlineError(deadline, phase);
    }
    if (outcome.kind === "rejected") throw outcome.error;
    return outcome.value;
  }
}

export function oauthLoginLeaseCooldownMs(): number {
  const configured = Number(process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(configured, 60_000)
    : DEFAULT_OAUTH_LOGIN_LEASE_COOLDOWN_MS;
}

async function waitForOAuthLeaseCooldown(cooldownMs: number): Promise<void> {
  if (cooldownMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, cooldownMs);
    timer.unref();
  });
}

export async function withOAuthActionLease<T>(
  deadline: OAuthActionDeadline | undefined,
  run: () => Promise<T>,
  releaseCooldownMs = 0,
): Promise<T> {
  let release!: () => void;
  const previous = oauthActionLeaseTail;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  oauthActionLeaseTail = previous.then(() => turn);
  let acquired = false;
  try {
    if (deadline === undefined) await previous;
    else await withinOAuthActionDeadline(previous, deadline, "lease");
    acquired = true;
    return await run();
  } finally {
    if (deadline === undefined) {
      release();
    } else if (!acquired) {
      void previous.then(release, release);
    } else {
      void waitForOAuthActionQuiescence(deadline)
        .then(() => waitForOAuthLeaseCooldown(releaseCooldownMs))
        .then(release, release);
    }
  }
}

// ───────────── OAuth handshake (T6/T7) ─────────────

// Click an OAuth provider button and adopt whichever page now
// carries the handshake. Google OAuth either redirects the current
// tab or opens a popup window; this normalizes both so the agent's
// consent loop can treat `browser.page` as "the page showing Google's
// screens" without caring which transport the service chose.
// settleAfterOAuth() restores the product page afterwards.
export async function loginWithOAuth(
  browser: BrowserController,
  selector: string,
  settleTimeoutMs = 30_000,
  consentProvider?: OAuthProviderId,
  expectedGoogleAccountEmail?: string | null,
  registerCompletionCheck?: (check: () => Promise<OAuthCompletionEvidence | null>) => void,
  onHumanHandoff?: () => number,
  dispatchAuthorizedClick?: (
    dispatch: (handle: ElementHandle<Element>, confirmTarget: () => Promise<void>) => Promise<void>,
  ) => Promise<void>,
  reportHumanChallenge?: OAuthChallengeReporter,
): Promise<void> {
  const product = browser.page;
  const context = browser.context;
  if (product === null || product.isClosed() || context === null) {
    throw new Error("OAuth login cannot start because the product page is unavailable");
  }
  if (
    browser.oauthProductPage !== null &&
    !browser.oauthProductPage.isClosed() &&
    browser.oauthProviderPage !== null &&
    !browser.oauthProviderPage.isClosed()
  ) {
    throw new OAuthAwaitingHumanError(
      "An owned OAuth attempt is still pending. Call operate_observe or oauth_settle; a second authorization attempt was not started.",
    );
  }

  browser.oauthProductPage = product;
  browser.oauthConsentAttemptedPhases.clear();
  browser.oauthProviderPage = null;
  browser.oauthProviderPageClosed = false;
  browser.oauthCompletionPage = null;
  browser.oauthTerminalCompletionUrl = null;
  browser.activeOAuthAttempt = {
    id: randomUUID(),
    provider: consentProvider,
    productPage: product,
    productDocumentId: browser.mainDocumentIdentity(product),
    providerPage: null,
    providerDocumentId: null,
    reporter: reportHumanChallenge,
  };
  const oauthBudgetMs = Math.max(1, settleTimeoutMs);
  const productUrl = product.url();
  let oauthDeadline = Date.now() + oauthBudgetMs;
  const remainingBudgetMs = (): number => Math.max(1, oauthDeadline - Date.now());
  const safeOrigin = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };
  const productOrigin = safeOrigin(productUrl);
  // Fix C: a timed-out wait only proves control has not returned to the
  // product origin yet — never assert WHY (expired session, denial, etc.).
  // A consent screen or 2FA challenge is routinely still showing; the
  // caller should keep waiting/retry, not treat this as a dead end.
  const awaitingHumanError = (): OAuthAwaitingHumanError =>
    new OAuthAwaitingHumanError(oauthAwaitingHumanMessage(safeOrigin(productUrl), oauthBudgetMs));
  const oauthFailedError = (reason: string): OAuthFailedError => new OAuthFailedError(reason);
  let recovery: Page | null = null;
  let providerPage: Page | null = null;
  let actionStarted = false;
  let productNavigated = false;
  let transientNavigated = false;
  let expectedReturnChain: readonly string[] | null = null;
  let pendingOnProvider = false;
  let lastTransientUrl = productUrl;
  let observedCallbackDenial: OAuthFailedError | null = null;
  const denialError = (url: string): OAuthFailedError | null => {
    const denial = oauthErrorFromReturnUrl(url);
    if (denial === null) return null;
    return oauthFailedError(
      `OAuth returned to ${safeOrigin(url)} with error=${denial.error}` +
        (denial.description === null ? "" : ` (${denial.description})`) +
        ".",
    );
  };
  let observedReturn: { page: Page; url: string } | null = null;
  let observedProductContinuation: { page: Page; url: string } | null = null;
  let onTransientNavigation: ((frame: Frame) => void) | null = null;
  let humanHandoffStarted = false;
  const startHumanHandoff = (): void => {
    if (humanHandoffStarted || onHumanHandoff === undefined) return;
    humanHandoffStarted = true;
    // Only the facade supplies a new absolute deadline here. Direct callers
    // retain the historical single deadline established above, so
    // loginWithOAuth(..., 3000) remains bounded to 3s total.
    oauthDeadline = onHumanHandoff();
  };
  const popupCapture: {
    page: Page | null;
    onNavigation: ((frame: Frame) => void) | null;
  } = { page: null, onNavigation: null };
  const captureExpectedReturnUrl = (url: string): void => {
    if (expectedReturnChain !== null) return;
    const providerOrigin = oauthProviderOrigin(url, consentProvider, productOrigin);
    if (providerOrigin === null) return;
    const chain = oauthRedirectChain(url);
    if (chain === null) {
      expectedReturnChain = [];
      return;
    }
    if (chain.length === 0) return;
    expectedReturnChain = chain.some((target) => oauthProviderForUrl(target) !== null) ? [] : chain;
  };
  const expectedReturnUrls = (): readonly string[] =>
    expectedReturnChain === null || expectedReturnChain.length === 0
      ? []
      : [expectedReturnChain[expectedReturnChain.length - 1]!];
  const matchesExpectedReturn = (url: string): boolean =>
    expectedReturnUrls().some((expected) => isOAuthReturnUrl(browser, url, expected));
  const attemptPage = (page: Page): boolean => page === product || page === popupCapture.page;
  // Playwright reports a popup's initial navigation before it can associate
  // the request with a frame. Keep that request inert until the opener's
  // creation-attributed popup event identifies its page; at that point the
  // frame is available and proves the request belongs to this attempt.
  const framelessNavigationRequests = new Set<Request>();
  const captureFramelessRequestsForPopup = (page: Page): void => {
    for (const request of framelessNavigationRequests) {
      try {
        const frame = request.frame();
        if (
          frame.parentFrame() === null &&
          frame.page() === page &&
          attemptPage(page) &&
          browser.ownedPages.has(page)
        ) {
          captureExpectedReturnUrl(request.url());
          framelessNavigationRequests.delete(request);
        }
      } catch {
        // The popup has not yet bound this request to its frame. Its next
        // redirect/page event will give us another chance before teardown.
      }
    }
  };
  const onContextRequest = (request: Request): void => {
    if (!actionStarted || !request.isNavigationRequest()) return;
    try {
      const frame = request.frame();
      if (
        frame.parentFrame() !== null ||
        !attemptPage(frame.page()) ||
        !browser.ownedPages.has(frame.page())
      ) {
        return;
      }
    } catch {
      // Playwright emits a popup's first navigation request before it
      // creates the frame. Do not capture it yet: a context-wide request
      // has no ownership proof until it binds to the popup that the source
      // page created for this attempt.
      framelessNavigationRequests.add(request);
      return;
    }
    captureExpectedReturnUrl(request.url());
  };
  let resolveProductNavigation: () => void = () => undefined;
  const productNavigationPromise = new Promise<void>((resolve) => {
    resolveProductNavigation = resolve;
  });
  const recordTopLevelNavigation = (page: Page, frame: Frame): void => {
    if (!actionStarted || frame !== page.mainFrame()) return;
    if (browser.activeOAuthAttempt?.providerPage === page) {
      browser.activeOAuthAttempt.providerDocumentId = null;
    }
    if (page === popupCapture.page) transientNavigated = true;
    const url = frame.url();
    const priorReturn = observedReturn;
    captureExpectedReturnUrl(url);
    if (matchesExpectedReturn(url)) observedCallbackDenial ??= denialError(url);
    if (matchesExpectedReturn(url) && oauthErrorFromReturnUrl(url) === null) {
      observedReturn = { page, url };
      return;
    }
    // An exact, attempt-owned callback may immediately redirect onward to
    // the product. Preserve that causal edge instead of demanding that the
    // callback pathname remain the final visible URL.
    if (
      priorReturn?.page === page &&
      safeOrigin(url) === productOrigin &&
      oauthErrorFromReturnUrl(url) === null
    ) {
      observedProductContinuation = { page, url };
      return;
    }
    if (priorReturn?.page === page) {
      observedReturn = null;
      observedProductContinuation = null;
    }
  };
  const onProductNavigation = (frame: Frame): void => {
    if (!actionStarted || frame !== product.mainFrame()) return;
    recordTopLevelNavigation(product, frame);
    if (
      observedReturn?.page !== product &&
      frame.url() !== productUrl &&
      !matchesExpectedReturn(frame.url())
    ) {
      observedReturn = null;
      observedProductContinuation = null;
    }
    productNavigated = true;
    startHumanHandoff();
    resolveProductNavigation();
  };
  const completionPage = (): Page | null => {
    // The creation-attributed popup can finish a reused-session redirect
    // before the initiating click resolves and assigns providerPage. The
    // outer deadline must inspect that same owned source in the meantime.
    if (
      observedProductContinuation !== null &&
      !observedProductContinuation.page.isClosed() &&
      observedProductContinuation.page.url() === observedProductContinuation.url
    ) {
      return observedProductContinuation.page;
    }
    for (const page of [product, providerPage ?? popupCapture.page]) {
      if (
        page === null ||
        page.isClosed() ||
        (page === product ? !productNavigated : !transientNavigated) ||
        !matchesExpectedReturn(page.url()) ||
        oauthErrorFromReturnUrl(page.url()) !== null
      ) {
        continue;
      }
      return page;
    }
    return null;
  };
  const relyingPartyOnboarding = async (page: Page): Promise<boolean> => {
    if (page.isClosed() || oauthProviderForUrl(page.url()) !== null) return false;
    return await page
      .evaluate(() => {
        const visible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const bounds = html.getBoundingClientRect();
          const style = getComputedStyle(html);
          return (
            bounds.width > 1 &&
            bounds.height > 1 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const requiredEmpty = Array.from(
          document.querySelectorAll("input[required],select[required],textarea[required]"),
        ).some((element) => visible(element) && !(element as HTMLInputElement).value?.trim());
        if (!requiredEmpty) return false;
        return Array.from(
          document.querySelectorAll('button,input[type="submit"],[role="button"]'),
        ).some(
          (element) =>
            visible(element) &&
            /^(?:continue|next|submit|finish|create|save)\b/i.test(
              ((element.textContent ?? "") || (element as HTMLInputElement).value || "").trim(),
            ),
        );
      })
      .catch(() => false);
  };
  const completionEvidence = async (): Promise<OAuthCompletionEvidence | null> => {
    if (!actionStarted) return null;
    const returnedPage = completionPage();
    if (returnedPage !== null) {
      const url = returnedPage.url();
      if (!returnedPage.isClosed() && returnedPage.url() === url && matchesExpectedReturn(url)) {
        return { page: returnedPage };
      }
    }
    if (observedReturn !== null && observedReturn.page.isClosed()) {
      return { page: observedReturn.page, terminal: true, url: observedReturn.url };
    }
    return null;
  };
  registerCompletionCheck?.(completionEvidence);
  product.on("framenavigated", onProductNavigation);
  context.on("request", onContextRequest);
  try {
    recovery = await context.newPage();
    browser.trackOpenedTabs(recovery);
    await recovery.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: remainingBudgetMs(),
    });

    let resolvePopup: (page: Page | null) => void = () => undefined;
    const popupPromise = new Promise<Page | null>((resolve) => {
      resolvePopup = resolve;
    });
    const onPopup = (page: Page): void => {
      if (!browser.ownedPages.has(page)) return;
      startHumanHandoff();
      popupCapture.page = page;
      captureFramelessRequestsForPopup(page);
      popupCapture.onNavigation = (frame: Frame): void => recordTopLevelNavigation(page, frame);
      page.on("framenavigated", popupCapture.onNavigation);
      popupCapture.onNavigation(page.mainFrame());
      product.off("popup", onPopup);
      resolvePopup(page);
    };
    const onProductClose = (): void => {
      product.off("popup", onPopup);
      product.off("framenavigated", onProductNavigation);
      resolvePopup(null);
    };
    product.on("popup", onPopup);
    product.once("close", onProductClose);
    try {
      if (Date.now() >= oauthDeadline) {
        throw new OAuthAwaitingHumanError(
          `OAuth has not been attempted yet: the ${Math.ceil(oauthBudgetMs / 1000)}-second ` +
            `budget elapsed before the OAuth control on ${safeOrigin(productUrl)} was clicked. ` +
            "Retry oauth_login.",
          "not_attempted",
        );
      }
      try {
        if (dispatchAuthorizedClick === undefined) {
          actionStarted = true;
          // Direct native login has no broker-prepared handle. Record the
          // same dispatch boundary while retaining ordinary click semantics.
          await browser.clickWithDispatchTracking(
            { kind: "selector", selector, method: "click" },
            undefined,
            () => browser.click({ kind: "selector", selector, method: "click" }),
          );
        } else {
          await dispatchAuthorizedClick(async (handle, confirmTarget) => {
            await browser.withModalInertNeutralized(selector, async () => {
              const materialSignature = (element: Element): string => {
                const control = element as HTMLElement;
                return JSON.stringify([
                  element.tagName.toLowerCase(),
                  element.getAttribute("role") ?? "",
                  element.getAttribute("aria-label") ?? "",
                  element.getAttribute("title") ?? "",
                  element instanceof HTMLInputElement ? element.value : "",
                  (control.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
                ]);
              };
              let expectedSignature: string;
              try {
                // Complete Playwright's actionability wait before the final
                // authorization check. The second click is intentionally
                // short: a new wait would reopen the intent-change window.
                await handle.click({ trial: true, timeout: 8000 });
                expectedSignature = await handle.evaluate(materialSignature);
                await confirmTarget();
              } catch (error) {
                throw new BrowserClickDispatchError("not_dispatched", error);
              }
              if (Date.now() >= oauthDeadline) {
                throw new OAuthAwaitingHumanError(
                  `OAuth has not been attempted yet: the ${Math.ceil(oauthBudgetMs / 1000)}-second ` +
                    `budget elapsed before the OAuth control on ${safeOrigin(productUrl)} was clicked. ` +
                    "Retry oauth_login.",
                  "not_attempted",
                );
              }
              const guardKey = `__ts_oauth_click_${Math.random().toString(36).slice(2)}`;
              await handle.evaluate(
                (element, guard) => {
                  const signature = (candidate: Element): string => {
                    const control = candidate as HTMLElement;
                    return JSON.stringify([
                      candidate.tagName.toLowerCase(),
                      candidate.getAttribute("role") ?? "",
                      candidate.getAttribute("aria-label") ?? "",
                      candidate.getAttribute("title") ?? "",
                      candidate instanceof HTMLInputElement ? candidate.value : "",
                      (control.innerText || candidate.textContent || "")
                        .replace(/\s+/g, " ")
                        .trim(),
                    ]);
                  };
                  const target = element as HTMLElement & Record<string, unknown>;
                  const state = {
                    blocked: false,
                    listener: (event: Event): void => {
                      if (signature(element) === guard.expected) return;
                      state.blocked = true;
                      event.preventDefault();
                      event.stopImmediatePropagation();
                    },
                  };
                  target[guard.key] = state;
                  element.addEventListener("click", state.listener, {
                    capture: true,
                    once: true,
                  });
                },
                { key: guardKey, expected: expectedSignature },
              );
              actionStarted = true;
              try {
                await browser.clickWithDispatchTracking(
                  { kind: "handle", handle, method: "click" },
                  undefined,
                  async () => {
                    await handle.click({ timeout: 1000, noWaitAfter: true });
                    const blocked = await handle.evaluate((element, key) => {
                      const target = element as HTMLElement &
                        Record<string, { blocked?: boolean } | undefined>;
                      return target[key]?.blocked === true;
                    }, guardKey);
                    if (blocked) {
                      throw new BrowserClickDispatchError(
                        "not_dispatched",
                        new Error("OAuth target intent changed at click dispatch"),
                      );
                    }
                  },
                );
              } finally {
                await handle
                  .evaluate((element, key) => {
                    const target = element as HTMLElement &
                      Record<string, { listener?: EventListenerOrEventListenerObject } | undefined>;
                    const state = target[key];
                    if (state?.listener !== undefined) {
                      element.removeEventListener("click", state.listener, { capture: true });
                    }
                    delete target[key];
                  }, guardKey)
                  .catch(() => undefined);
              }
            });
          });
        }
      } catch (error) {
        if (!product.isClosed()) {
          providerPage = popupCapture.page;
          pendingOnProvider = providerPage !== null || productNavigated;
          throw error;
        }
      }
      providerPage = await Promise.race([
        popupPromise,
        // A same-tab provider redirect is just as conclusive as a popup.
        // Do not burn two seconds of the OAuth budget waiting for a window
        // that this service will never open.
        productNavigationPromise.then(() => null),
        browser.sleep(Math.min(remainingBudgetMs(), 2_000)).then(() => null),
      ]);
    } finally {
      product.off("popup", onPopup);
      product.off("close", onProductClose);
      resolvePopup(null);
      resolveProductNavigation();
    }
    const transient = providerPage ?? product;
    if (popupCapture.page !== null && popupCapture.onNavigation !== null) {
      popupCapture.page.off("framenavigated", popupCapture.onNavigation);
      popupCapture.onNavigation = null;
    }
    lastTransientUrl = transient.url();
    onTransientNavigation = (frame: Frame): void => {
      if (frame === transient.mainFrame()) {
        lastTransientUrl = frame.url();
        recordTopLevelNavigation(transient, frame);
        if (transient !== product) transientNavigated = true;
      }
    };
    transient.on("framenavigated", onTransientNavigation);
    captureExpectedReturnUrl(transient.url());
    if (transient !== product) {
      transientNavigated = true;
      recordTopLevelNavigation(transient, transient.mainFrame());
    }
    const durableProduct = providerPage === null ? recovery : product;
    browser.oauthProductPage = durableProduct;
    browser.oauthProviderPage = transient;
    browser.oauthProviderPageClosed = transient.isClosed();
    restoreProductPageWhenOAuthPageCloses(browser, transient, durableProduct);
    browser.page = transient;
    if (browser.activeOAuthAttempt !== null) {
      browser.activeOAuthAttempt.providerPage = transient;
    }
    const hasTerminalCompletion = (): boolean =>
      observedReturn !== null && observedReturn.page.isClosed();
    let settled: Page | null = null;
    if (consentProvider === undefined) {
      settled = await waitForOAuthLifecycle(
        browser,
        expectedReturnUrls,
        remainingBudgetMs(),
        completionPage,
        hasTerminalCompletion,
      );
    } else {
      while (settled === null && Date.now() < oauthDeadline) {
        throwIfOperatorRequestCancelled();
        const remaining = oauthDeadline - Date.now();
        settled = await waitForOAuthLifecycle(
          browser,
          expectedReturnUrls,
          Math.min(1_000, remaining),
          completionPage,
          hasTerminalCompletion,
        );
        if (settled !== null || hasTerminalCompletion()) break;
        if (Date.now() >= oauthDeadline) break;
        const transientUrl = transient.url();
        if (oauthProviderForUrl(transientUrl) !== consentProvider) {
          if (await relyingPartyOnboarding(transient)) {
            pendingOnProvider = true;
            throw new OAuthOnboardingRequiredError(safeOrigin(transient.url()));
          }
          await browser.sleep(Math.min(250, remainingBudgetMs()));
          continue;
        }
        const providerDocumentId = browser.mainDocumentIdentity(transient);
        if (browser.activeOAuthAttempt !== null) {
          browser.activeOAuthAttempt.providerPage = transient;
          browser.activeOAuthAttempt.providerDocumentId = providerDocumentId;
          browser.activeOAuthAttempt.provider = consentProvider;
        }
        if (consentProvider === "google") {
          const bodyText = await transient
            .locator("body")
            .innerText({ timeout: Math.min(1_000, Math.max(1, remaining)) })
            .catch(() => "");
          const googleState = classifyGoogleAuthState(transientUrl, bodyText);
          if (googleState === "challenge") {
            const number = extractGoogleNumberMatch(bodyText);
            const revision = createHash("sha256")
              .update(
                `${providerDocumentId}\u0000${number ?? bodyText.trim()}\u0000${transientUrl}`,
              )
              .digest("base64url")
              .slice(0, 24);
            const attempt = browser.activeOAuthAttempt;
            if (attempt === null) continue;
            const challenge = extractGoogleHumanChallenge({
              attemptId: attempt.id,
              challengeRevision: revision,
              documentId: providerDocumentId,
              url: transientUrl,
              bodyText,
              observedAt: new Date(),
            });
            if (challenge !== null) {
              pendingOnProvider = true;
              throw await oauthHumanChallengeError(browser, challenge);
            }
          }
          if (googleState !== "chooser" && googleState !== "consent") {
            pendingOnProvider = true;
            await browser.sleep(Math.min(250, remainingBudgetMs()));
            continue;
          }
        }
        const consentBudgetMs = oauthDeadline - Date.now();
        const advanced = await advanceOAuthConsent(
          browser,
          consentProvider,
          consentBudgetMs,
          expectedGoogleAccountEmail,
        ).catch(() => false);
        if (!advanced) await browser.sleep(Math.min(250, remainingBudgetMs()));
      }
    }
    const observedUrls = [
      ...(providerPage !== null || productNavigated
        ? [transient.isClosed() ? lastTransientUrl : transient.url()]
        : []),
      ...(providerPage !== null && !product.isClosed() && product.url() !== productUrl
        ? [product.url()]
        : []),
    ];
    for (const observedUrl of observedUrls) {
      const denial = observedCallbackDenial ?? denialError(observedUrl);
      if (denial !== null) throw denial;
    }
    const completion = settled === null ? await completionEvidence() : { page: settled };
    if (completion === null) {
      pendingOnProvider = true;
      throw awaitingHumanError();
    }
    if (completion.terminal) {
      browser.oauthCompletionPage = null;
      browser.oauthTerminalCompletionUrl = completion.url ?? null;
    } else {
      browser.oauthCompletionPage = completion.page;
    }
    if (providerPage === null && product.isClosed()) {
      const reloaded = await recovery
        .reload({
          waitUntil: "domcontentloaded",
          timeout: Math.max(remainingBudgetMs(), 500),
        })
        .then(() => true)
        .catch(() => false);
      if (!reloaded) {
        throw new OAuthAwaitingHumanError(
          `${safeOrigin(productUrl)} closed during OAuth and could not be reloaded within the ` +
            "budget, so completion could not be confirmed. Call operate_observe to check the " +
            "current page.",
        );
      }
    }
  } catch (error) {
    if (observedCallbackDenial !== null) {
      pendingOnProvider = false;
      throw observedCallbackDenial;
    }
    throw error;
  } finally {
    product.off("framenavigated", onProductNavigation);
    context.off("request", onContextRequest);
    if (onTransientNavigation !== null) {
      (providerPage ?? product).off("framenavigated", onTransientNavigation);
    }
    if (popupCapture.page !== null && popupCapture.onNavigation !== null) {
      popupCapture.page.off("framenavigated", popupCapture.onNavigation);
    }
    const retainedProvider = providerPage ?? product;
    const providerStillShowing = pendingOnProvider && !retainedProvider.isClosed();
    if (providerStillShowing) {
      if (browser.oauthProviderPage !== retainedProvider) {
        const durableProduct = providerPage === null ? recovery : product;
        browser.oauthProductPage = durableProduct;
        browser.oauthProviderPage = retainedProvider;
        browser.oauthProviderPageClosed = false;
        restoreProductPageWhenOAuthPageCloses(browser, retainedProvider, durableProduct);
        if (browser.activeOAuthAttempt !== null) {
          browser.activeOAuthAttempt.providerPage = retainedProvider;
          browser.activeOAuthAttempt.providerDocumentId =
            browser.mainDocumentIdentity(retainedProvider);
        }
      }
      browser.page = retainedProvider;
    } else {
      browser.activeOAuthAttempt = null;
      const retained = product.isClosed() ? recovery : product;
      browser.page = retained?.isClosed() === false ? retained : browser.primaryPage;
      if (
        browser.page === product &&
        !product.isClosed() &&
        browser.oauthCompletionPage !== null &&
        !browser.oauthCompletionPage.isClosed()
      ) {
        browser.oauthProductPage = product;
        browser.oauthProviderPage = browser.oauthCompletionPage;
        browser.oauthProviderPageClosed = false;
      } else {
        browser.oauthProductPage = null;
        browser.oauthProviderPage = null;
        browser.oauthProviderPageClosed = false;
      }
      if (
        providerPage !== null &&
        providerPage !== browser.oauthCompletionPage &&
        !providerPage.isClosed()
      ) {
        await providerPage.close().catch(() => undefined);
      }
    }
    if (
      recovery !== null &&
      recovery !== browser.page &&
      !(providerStillShowing && recovery === browser.oauthProductPage) &&
      !recovery.isClosed()
    ) {
      await recovery.close().catch(() => undefined);
    }
    if (browser.page !== null && !browser.page.isClosed()) {
      await browser.page.bringToFront().catch(() => undefined);
      await browser.page
        .waitForLoadState("domcontentloaded", {
          timeout: remainingBudgetMs(),
        })
        .catch(() => undefined);
    }
  }
}

function restoreProductPageWhenOAuthPageCloses(
  browser: BrowserController,
  oauthPage: Page,
  product: Page | null,
): void {
  oauthPage.once("close", () => {
    if (browser.oauthProviderPage === oauthPage) browser.oauthProviderPageClosed = true;
    // A proven completion may close during the handoff back to the caller.
    // Its live refs are gone, but its already-validated URL remains a
    // terminal completion snapshot until the next ordinary observation.
    if (browser.oauthCompletionPage === oauthPage) {
      browser.oauthCompletionPage = null;
      browser.oauthTerminalCompletionUrl ??= oauthPage.url();
    }
    if (product === null || product.isClosed()) {
      browser.adoptLivePage();
      return;
    }
    if (browser.page === oauthPage || browser.page === null || browser.page.isClosed()) {
      browser.page = product;
      void product.bringToFront().catch(() => undefined);
    }
  });
}

function isOAuthReturnUrl(
  browser: BrowserController,
  candidateUrl: string,
  expectedReturnUrl: string | null,
): boolean {
  return expectedReturnUrl !== null && oauthRedirectTargetMatches(candidateUrl, expectedReturnUrl);
}

export async function waitForOAuthLifecycle(
  browser: BrowserController,
  expectedReturnUrls: () => readonly string[],
  timeoutMs: number,
  completionPage: () => Page | null,
  terminalCompletion: () => boolean,
): Promise<Page | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminalCompletion()) return null;
    const returnedPage = completionPage();
    if (returnedPage !== null) {
      const url = returnedPage.url();
      // A return to the relying party is the OAuth completion signal. A
      // dashboard can keep polling or streaming forever, so networkidle is
      // not a valid requirement for a completed OAuth redirect.
      const returnedUrl = url;
      const ready = await returnedPage
        .waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) })
        .then(() => true)
        .catch(() => false);
      if (
        !ready ||
        returnedPage.isClosed() ||
        !expectedReturnUrls().some((expected) =>
          isOAuthReturnUrl(browser, returnedPage.url(), expected),
        )
      ) {
        return null;
      }
      // Require the return URL to survive one event-loop turn so a transient
      // callback hop is never reported as the final product page.
      await browser.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      return !returnedPage.isClosed() &&
        returnedPage.url() === returnedUrl &&
        expectedReturnUrls().some((expected) =>
          isOAuthReturnUrl(browser, returnedPage.url(), expected),
        )
        ? returnedPage
        : null;
    }
    await browser.sleep(50);
  }
  return null;
}

// A legacy oauth_click may still have a provider popup in flight. Keep this
// intentionally small and non-sensitive so the operator boundary can turn a
// transient detached Playwright handle into guidance rather than exposing a
// driver exception to the planning model.
export function oauthTransitionStatus(browser: BrowserController): {
  productUrl: string | null;
  providerPageClosed: boolean;
  productPageViable: boolean;
  browserConnected: boolean;
} | null {
  // `== null` also tolerates structural fakes that leave the OAuth page slots
  // unset; real controllers always expose `Page | null` here.
  const product = browser.oauthProductPage;
  if (product == null) return null;
  let productUrl: string | null = null;
  if (!product.isClosed()) {
    try {
      productUrl = product.url();
    } catch {
      // A page may detach between isClosed() and url(); the structured
      // in-progress response must still win over the raw driver error.
    }
  }
  return {
    productUrl,
    providerPageClosed:
      browser.oauthProviderPageClosed || browser.oauthProviderPage?.isClosed() === true,
    productPageViable: !product.isClosed(),
    browserConnected: browser.isConnected(),
  };
}

export function completeOAuthTransitionRecovery(browser: BrowserController): void {
  const product = browser.oauthProductPage;
  if (product != null && !product.isClosed()) browser.page = product;
  browser.oauthProductPage = null;
  browser.oauthProviderPage = null;
  browser.oauthProviderPageClosed = false;
}

// Which OAuth providers have a live session in this profile's cookie jar.
export async function detectSessionProviders(
  browser: BrowserController,
): Promise<OAuthProviderId[]> {
  if (browser.context === null) return [];
  try {
    return sessionProvidersFromCookies(await browser.context.cookies());
  } catch {
    return [];
  }
}

export async function detectGoogleAccountEmail(
  browser: BrowserController,
  expectedGoogleAccountEmail?: string,
): Promise<string | null> {
  if (browser.context === null) return null;
  let identityPage: Page | null = null;
  try {
    // Deliberately unregistered: this identity probe (and its popups) must
    // never become the session's working page.
    identityPage = await browser.context.newPage();
    const identityUrl = new URL("https://myaccount.google.com/");
    const expectedEmail = expectedGoogleAccountEmail?.trim();
    if (expectedEmail !== undefined && expectedEmail.length > 0) {
      identityUrl.searchParams.set("authuser", expectedEmail);
    }
    await identityPage.goto(identityUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (new URL(identityPage.url()).hostname !== "myaccount.google.com") return null;
    const identityTokens = await identityPage
      .locator("[aria-label]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label") ?? ""),
      );
    for (const token of identityTokens) {
      const trimmed = token.trim();
      const email = /^Google Account:/i.test(trimmed) ? extractGoogleAccountEmail(trimmed) : null;
      if (email !== null) return email;
    }
    return null;
  } catch {
    return null;
  } finally {
    await identityPage?.close().catch(() => undefined);
  }
}

/** Read-only continuation of the same attempt. Never advances consent. */
export async function refreshOAuthHumanChallenge(
  browser: BrowserController,
): Promise<OAuthAwaitingHumanError | null> {
  // `== null` also tolerates structural fakes that leave the OAuth attempt
  // slot unset; real controllers always expose `ActiveOAuthAttempt | null`.
  const attempt = browser.activeOAuthAttempt;
  if (attempt == null || attempt.provider !== "google" || attempt.providerPage === null)
    return null;
  const page = attempt.providerPage;
  if (
    page.isClosed() ||
    browser.page !== page ||
    oauthProviderForUrl(page.url()) !== "google" ||
    (page !== attempt.productPage &&
      (attempt.productPage.isClosed() ||
        browser.mainDocumentIdentity(attempt.productPage) !== attempt.productDocumentId))
  ) {
    browser.activeOAuthAttempt = null;
    return null;
  }
  const documentId = browser.mainDocumentIdentity(page);
  const url = page.url();
  const text = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  if (
    browser.activeOAuthAttempt !== attempt ||
    page.isClosed() ||
    browser.page !== page ||
    browser.mainDocumentIdentity(page) !== documentId ||
    page.url() !== url
  )
    return null;
  const number = extractGoogleNumberMatch(text);
  const revision = createHash("sha256")
    .update(`${documentId}\u0000${number ?? text.trim()}\u0000${url}`)
    .digest("base64url")
    .slice(0, 24);
  const challenge = extractGoogleHumanChallenge({
    attemptId: attempt.id,
    challengeRevision: revision,
    documentId,
    url,
    bodyText: text,
    observedAt: new Date(),
  });
  const renderedState = classifyGoogleAuthState(new URL(url).origin, text);
  if (
    challenge === null ||
    text.trim() === "" ||
    renderedState === "chooser" ||
    renderedState === "consent" ||
    /(?:challenge|request|code|prompt).{0,40}expired|expired.{0,40}(?:challenge|request|code|prompt)/i.test(
      text,
    )
  ) {
    delete attempt.challengeEpoch;
    return null;
  }
  attempt.providerDocumentId = documentId;
  return await oauthHumanChallengeError(browser, challenge);
}

async function oauthHumanChallengeError(
  browser: BrowserController,
  challenge: GoogleHumanChallenge,
): Promise<OAuthAwaitingHumanError> {
  const attempt = browser.activeOAuthAttempt;
  if (attempt === null) return new OAuthAwaitingHumanError("OAuth attempt changed");
  const fingerprint = challenge.challenge_revision;
  if (
    attempt.challengeEpoch?.fingerprint !== fingerprint ||
    Date.now() >= attempt.challengeEpoch.expiresAt
  ) {
    attempt.challengeEpoch = {
      fingerprint,
      reported: false,
      revision: randomUUID(),
      expiresAt:
        challenge.expires_at === null ? Date.now() + 120_000 : Date.parse(challenge.expires_at),
    };
  }
  challenge = { ...challenge, challenge_revision: attempt.challengeEpoch.revision };
  const epoch = attempt.challengeEpoch;
  let notification = epoch.notification;
  if (!epoch.reported) {
    epoch.reported = true;
    if (attempt.reporter !== undefined) {
      const notificationAbort = new AbortController();
      const notificationBudgetMs = 2_000;
      let notificationTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOutNotification = new Promise<HeightenedAuthNotificationResult>((resolve) => {
        notificationTimer = setTimeout(() => {
          notificationAbort.abort(new Error("notification_timeout"));
          resolve({
            sent: false,
            deduped: false,
            attempt_id: challenge.attempt_id,
            challenge_revision: challenge.challenge_revision,
            delivery: {
              channel: null,
              status: "failed",
              error: "notification_timeout",
            },
          });
        }, notificationBudgetMs);
      });
      notificationTimer?.unref();
      try {
        notification = await Promise.race([
          attempt.reporter(challenge, notificationAbort.signal).catch((error: unknown) => ({
            sent: false,
            deduped: false,
            attempt_id: challenge.attempt_id,
            challenge_revision: challenge.challenge_revision,
            delivery: {
              channel: null,
              status: "failed" as const,
              error: error instanceof Error ? error.message : String(error),
            },
          })),
          timedOutNotification,
        ]);
      } finally {
        if (notificationTimer !== undefined) clearTimeout(notificationTimer);
      }
      epoch.notification = notification;
    }
  }
  const numberMessage =
    challenge.number === null
      ? "Google is asking for human verification; the number is unreadable."
      : `Google is asking you to tap ${challenge.number} on your phone.`;
  const deliveryMessage =
    notification === undefined
      ? "Paired notification was not attempted by the caller."
      : notification.delivery.status === "sent"
        ? `Paired notification sent via ${notification.delivery.channel ?? "configured channel"}.`
        : `Paired notification failed: ${notification.delivery.error ?? "delivery_failed"}.`;
  return new OAuthAwaitingHumanError(
    `${numberMessage} Automated consent stopped for attempt ${challenge.attempt_id}. ${deliveryMessage}`,
    "pending",
    challenge,
    notification,
  );
}

// Advance a provider's consent / account-chooser screen by one click.
// Returns false when no
// approve control is present — the agent then aborts rather than
// hang. Clicks only; never types (the critical guarantee holds here).
export async function advanceOAuthConsent(
  browser: BrowserController,
  provider: OAuthProviderId,
  timeoutMs = 8_000,
  expectedGoogleAccountEmail?: string | null,
): Promise<boolean> {
  if (!browser.page) throw new Error("Browser not started");
  const authorityPage = browser.page;
  const providerOwned = (): boolean => {
    const attempt = browser.activeOAuthAttempt;
    return (
      attempt !== null &&
      attempt.provider === provider &&
      attempt.providerPage === authorityPage &&
      attempt.providerDocumentId !== null &&
      !authorityPage.isClosed() &&
      browser.page === authorityPage &&
      oauthProviderForUrl(authorityPage.url()) === provider &&
      browser.mainDocumentIdentity(authorityPage) === attempt.providerDocumentId
    );
  };
  if (!providerOwned()) return false;
  const phaseSignature = await authorityPage
    .evaluate(() =>
      JSON.stringify([
        document.title,
        Array.from(
          document.querySelectorAll(
            '[data-identifier],button,input[type="submit"],[role="button"]',
          ),
        )
          .slice(0, 20)
          .map((element) => [
            element.getAttribute("data-identifier") ?? "",
            (element.textContent ?? (element as HTMLInputElement).value ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80),
          ]),
      ]),
    )
    .catch(() => "unreadable");
  const phaseKey = `${browser.mainDocumentIdentity(authorityPage)}\u0000${authorityPage.url()}\u0000${phaseSignature}`;
  const claimPhase = (): boolean => {
    if (!providerOwned() || browser.oauthConsentAttemptedPhases.has(phaseKey)) return false;
    browser.oauthConsentAttemptedPhases.add(phaseKey);
    return true;
  };
  if (browser.oauthConsentAttemptedPhases.has(phaseKey)) return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const hasBudget = (): boolean => Date.now() < deadline;
  const boundedTimeout = (limitMs: number): number =>
    Math.max(1, Math.min(limitMs, deadline - Date.now()));
  if (!hasBudget()) return false;
  if (provider === "github") {
    // GitHub App install flow can include an account target chooser before
    // the Install/Authorize screen:
    //   /apps/<app>/installations/select_target
    // It renders account/org cards as links/buttons, not as an approve
    // button. Advance exactly one visible target and let the caller's
    // consent loop re-classify the next GitHub page.
    if (
      /\/apps\/[^/]+\/installations\/select_target\b/.test(new URL(browser.page.url()).pathname)
    ) {
      const startUrl = browser.page.url();
      if (!hasBudget()) return false;
      if (!claimPhase()) return false;
      await markOperatorMutationDispatchAttempted();
      const clicked = await browser.page
        .evaluate((expiresAt) => {
          if (Date.now() >= expiresAt) return false;
          const visible = (el: HTMLElement): boolean => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return (
              r.width > 2 &&
              r.height > 2 &&
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              parseFloat(s.opacity || "1") > 0.01
            );
          };
          const bad = /\b(settings|marketplace|learn more|cancel|skip|back|terms|privacy)\b/i;
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              'a[href], button, [role="button"], [role="link"]',
            ),
          ).filter((el) => visible(el));
          const byHref = candidates.find((el) => {
            const href =
              el instanceof HTMLAnchorElement ? el.href : (el.getAttribute("href") ?? "");
            return /\/installations\/(?:new|permissions)\b/.test(href);
          });
          const target =
            byHref ??
            candidates.find((el) => {
              const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
              if (text.length === 0 || text.length > 80 || bad.test(text)) return false;
              return true;
            });
          if (target === undefined) return false;
          if (Date.now() >= expiresAt) return false;
          target.click();
          return true;
        }, deadline)
        .catch(() => false);
      if (clicked) {
        const advanced = await browser.page
          .waitForFunction((s) => window.location.href !== s, startUrl, {
            timeout: boundedTimeout(8_000),
          })
          .then(() => true)
          .catch(() => false);
        if (advanced) return true;
      }
    }
    // GitHub consent screen variants:
    //   Classic OAuth: "Authorize <app>"
    //   GitHub App (install + auth): "Authorize <app>", "Install",
    //                                "Install & authorize"
    //   Some flows show "Continue" or "Approve"
    // Negative match excludes Cancel/Deny.
    const startUrl = browser.page.url();
    const patterns: RegExp[] = [
      /^authorize(\b|\s)/i,
      /^install\s*(&|and)\s*authorize\b/i,
      /^install\b/i,
      /^approve\b/i,
      /^continue\b/i,
      /^grant\b/i,
    ];
    for (const re of patterns) {
      const btn = browser.page.getByRole("button", { name: re }).first();
      const count = await btn.count().catch(() => 0);
      if (count === 0) continue;
      // GitHub disables the Authorize button with a clickjacking-protection
      // COUNTDOWN (~3-8s) the first time you authorize an OAuth app that
      // requests org scopes (read:org). Clicking while disabled silently
      // no-ops and the URL never changes, so the whole consent bails
      // "no approve control" even though the button is right there
      // (MEASURED 2026-06-11: defang's "Authorize DefangLabs"). Poll up to
      // 12s for it to enable before clicking.
      {
        const deadline = Date.now() + boundedTimeout(12_000);
        while (Date.now() < deadline) {
          const disabled = await btn
            .evaluate((el) => {
              if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
                if (el.disabled) return true;
              }
              const aria = el.getAttribute("aria-disabled");
              return aria === "true" || aria === "";
            })
            .catch(() => false);
          if (!disabled) break;
          await browser.sleep(400);
        }
      }
      if (!hasBudget()) return false;
      try {
        if (!claimPhase()) return false;
        await markOperatorMutationDispatchAttempted();
        await btn.click({ timeout: boundedTimeout(8_000) });
      } catch {
        continue;
      }
      // Verify the click actually advanced — GitHub's consent click
      // navigates within ~2s. If the URL is unchanged after 4s the
      // click silently failed (wrong element, or button disabled
      // behind a hidden iframe). Return false so the caller knows.
      const advanced = await browser.page
        .waitForFunction((s) => window.location.href !== s, startUrl, {
          timeout: boundedTimeout(4_000),
        })
        .then(() => true)
        .catch(() => false);
      if (advanced) return true;
      // Click logged but URL didn't change — fall through to try the
      // next pattern (rare but covers misnamed candidates).
    }
    // Diagnostic: nothing matched OR every match failed to advance.
    // Log the visible button names so the failure trail tells us
    // what GitHub actually rendered.
    const seen = await browser.page
      .evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button, input[type="submit"], [role="button"]'),
        ) as HTMLElement[];
        return buttons
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 1 && r.height > 1;
          })
          .slice(0, 8)
          .map((b) => {
            const t = (b.textContent || (b as HTMLInputElement).value || "").trim();
            return t.slice(0, 50);
          })
          .filter((t) => t.length > 0);
      })
      .catch(() => [] as string[]);
    browser.logOperatorDiagnostic(
      `[operator] GitHub advanceOAuthConsent failed — visible buttons: ` +
        `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
    );
    return false;
  }
  // Google. Account chooser: Google renders each account with a
  // stable data-identifier attribute (the account email).
  const tiles = browser.page.locator("[data-identifier]");
  const expectedEmail = expectedGoogleAccountEmail?.trim().toLowerCase() ?? null;
  const matchingTileIndexes = await tiles
    .evaluateAll((elements, expected) => {
      return elements.flatMap((element, index) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        const identifier = element.getAttribute("data-identifier")?.trim().toLowerCase();
        return rect.width >= 2 &&
          rect.height >= 2 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          identifier !== undefined &&
          (expected === null || identifier === expected)
          ? [index]
          : [];
      });
    }, expectedEmail)
    .catch(() => [] as number[]);
  // Without account metadata, a sole visible chooser tile is still
  // unambiguous. Multiple accounts remain intentionally untouched.
  if (matchingTileIndexes.length === 1) {
    if (!hasBudget()) return false;
    try {
      if (!claimPhase()) return false;
      await markOperatorMutationDispatchAttempted();
      await tiles.nth(matchingTileIndexes[0]!).click({ timeout: boundedTimeout(1_000) });
      return true;
    } catch {
      // fall through to the approve-button path
    }
  }
  // Google's current account chooser also renders an identity as
  // an ordinary semantic button/link without data-identifier. Select only a
  // visible account-shaped row carrying an email address, and exclude only
  // account-management alternatives. Authentication state is not inferred
  // from provider-page content; completion remains the OAuth lifecycle signal.
  // The identity text stays inside the provider page and is never returned.
  const accountRows = browser.page.locator('button, [role="button"], [role="link"], a[href]');
  const accountRowLabels = await accountRows
    .evaluateAll((elements) => {
      const EXCLUDED = /(?:\buse another account|\bremove an account|\bmanage accounts?\b)/i;
      return elements.map((element, index) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        if (
          rect.width < 2 ||
          rect.height < 2 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          return null;
        }
        const labels = [
          element.getAttribute("aria-label") ?? "",
          element.textContent ?? "",
          ...Array.from(element.querySelectorAll<HTMLElement>("[aria-label], *")).flatMap(
            (descendant) => [
              descendant.getAttribute("aria-label") ?? "",
              descendant.textContent ?? "",
            ],
          ),
        ]
          .map((label) => label.replace(/\s+/g, " ").trim())
          .filter((label) => label.length > 0);
        return labels.some((label) => EXCLUDED.test(label)) ? null : { index, labels };
      });
    })
    .catch(() => [] as Array<{ index: number; labels: string[] } | null>);
  const matchingAccountRows =
    expectedEmail === null
      ? []
      : accountRowLabels.filter((candidate) => {
          if (candidate === null) return false;
          return candidate.labels.some((label) => {
            const emails = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
            return emails.some((email) => email.toLowerCase() === expectedEmail);
          });
        });
  const accountRowIndex = matchingAccountRows.length === 1 ? matchingAccountRows[0]!.index : -1;
  if (accountRowIndex >= 0) {
    if (!hasBudget()) return false;
    try {
      if (!claimPhase()) return false;
      await markOperatorMutationDispatchAttempted();
      await accountRows.nth(accountRowIndex).click({ timeout: boundedTimeout(1_000) });
      return true;
    } catch {
      // fall through to the approve-button path
    }
  }
  // Consent screen: the approve control's name varies by Google's
  // consent layout — "Continue", "Allow", "Allow access" (the
  // /signin/oauth/consent?part=… variant meilisearch hits). Match on a
  // startsWith verb set (not exact) so "Allow access" resolves, while
  // the verbs exclude Cancel/Deny/Back/No. Wait for the button to
  // render — the consent SPA paints the approve control a beat after
  // domcontentloaded, and the old exact-match + no-wait returned false
  // before it appeared.
  const APPROVE_NAME = /^(?:continue|allow|accept|agree)\b/i;
  const approve = browser.page.getByRole("button", { name: APPROVE_NAME }).first();
  try {
    await approve.waitFor({ state: "visible", timeout: boundedTimeout(1_000) });
  } catch {
    // not visible within the window — fall through to the DOM-scan path
  }
  if ((await approve.count().catch(() => 0)) > 0) {
    if (!hasBudget()) return false;
    try {
      if (!claimPhase()) return false;
      await markOperatorMutationDispatchAttempted();
      await approve.click({ timeout: boundedTimeout(1_000) });
      return true;
    } catch {
      // fall through to the DOM-scan fallback
    }
  }
  // Fallback: scan the DOM for an approve-like clickable when the ARIA
  // role query missed it (Google occasionally renders the control as a
  // <div role>/<span> or an <input type=submit value="Allow access">).
  // Click the first visible candidate whose text is an approve verb and
  // is NOT a cancel/deny/back. Log what was visible on failure.
  if (!hasBudget()) return false;
  if (!claimPhase()) return false;
  await markOperatorMutationDispatchAttempted();
  const clicked = await browser.page
    .evaluate((expiresAt) => {
      if (Date.now() >= expiresAt) return null;
      const APPROVE = /^(?:continue|allow|accept|agree)\b/i;
      const DENY = /\b(?:cancel|deny|back|no\b|not now|reject)\b/i;
      const els = Array.from(
        document.querySelectorAll('button, input[type="submit"], [role="button"], a[href]'),
      ) as HTMLElement[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const t = (el.textContent || (el as HTMLInputElement).value || "").trim();
        if (t.length === 0 || t.length > 40) continue;
        if (DENY.test(t)) continue;
        if (APPROVE.test(t)) {
          if (Date.now() >= expiresAt) return null;
          (el as HTMLElement).click();
          return t.slice(0, 40);
        }
      }
      return null;
    }, deadline)
    .catch(() => null);
  if (clicked !== null) return true;
  const seen = await browser.page
    .evaluate(() => {
      const els = Array.from(
        document.querySelectorAll('button, input[type="submit"], [role="button"]'),
      ) as HTMLElement[];
      return els
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        })
        .slice(0, 8)
        .map((b) => (b.textContent || (b as HTMLInputElement).value || "").trim().slice(0, 40))
        .filter((t) => t.length > 0);
    })
    .catch(() => [] as string[]);
  browser.logOperatorDiagnostic(
    `[operator] Google advanceOAuthConsent failed — visible buttons: ` +
      `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
  );
  return false;
}

// Restore the product page once the OAuth handshake completes. A
// no-op for the same-tab redirect flow (the active page already IS
// the product page); for the popup flow, waits briefly for the popup
// to close, then switches `browser.page` back to the product tab.
export async function settleAfterOAuth(
  browser: BrowserController,
  operationPage?: Page,
): Promise<Page> {
  const product = browser.oauthProductPage;
  const active = browser.page;
  const provider = browser.oauthProviderPage;
  const isLifecyclePage = (page: Page | null | undefined): boolean =>
    page !== null && page !== undefined && (page === product || page === provider);
  const isCompletedPopupPair = active === product && operationPage === provider;
  if (
    product === null ||
    product.isClosed() ||
    active === null ||
    !isLifecyclePage(active) ||
    (operationPage !== undefined &&
      (!isLifecyclePage(operationPage) || (operationPage !== active && !isCompletedPopupPair)))
  ) {
    throw new Error("OAuth lifecycle no longer matches the resolved operation page");
  }
  let settled = false;
  try {
    if (product === active && (provider === null || provider === product || provider.isClosed())) {
      settled = true;
      return product;
    }
    for (let i = 0; i < 12 && provider !== null && !provider.isClosed(); i++) {
      await browser.sleep(1000);
      if (product.isClosed()) {
        throw new Error("OAuth lifecycle product page became unavailable");
      }
    }
    if (
      provider !== null &&
      provider !== product &&
      !provider.isClosed() &&
      browser.oauthProductPage === product &&
      browser.oauthProviderPage === provider &&
      !product.isClosed()
    ) {
      if (browser.oauthCompletionPage === provider) browser.oauthCompletionPage = null;
      await provider.close().catch(() => undefined);
    }
    if (product.isClosed()) {
      throw new Error("OAuth lifecycle product page became unavailable");
    }
    browser.page = product;
    await product.bringToFront().catch(() => undefined);
    await product.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => undefined);
    settled = true;
    return product;
  } finally {
    if (settled) {
      browser.oauthProductPage = null;
      browser.oauthProviderPage = null;
      browser.oauthProviderPageClosed = false;
    }
  }
}
