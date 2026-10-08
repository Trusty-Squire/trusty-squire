// Shared 2Captcha token-solve plumbing + the operate-path auto-solve.
//
// Moved out of provision-session.ts (where it backed the provision captcha
// gate) so the general operate_* drive can call ONE implementation. Every
// 2Captcha call is routed through `use_credential` against the vaulted
// "2captcha" credential via makeTwoCaptchaVaultProxy, so the raw key never
// enters the operator process; a TWOCAPTCHA_API_KEY env fallback keeps
// back-compat for installs without a vaulted credential.
//
// attemptOperateCaptchaAutoSolve is the operate-path entry: best-effort and
// non-blocking — it injects an already-bought token and starts the next fetch
// detached, so when no credential is vaulted, or the solve fails, stalls, or is
// still running, the caller surfaces the challenge exactly as it does today. It
// never throws and never hard-fails a session.

import type { Page } from "playwright";
import {
  TwoCaptchaSolver,
  type TwoCaptchaVaultProxy,
  detectCaptchaVariant,
  recaptchaEvidenceDiag,
  recaptchaPageReacted,
  injectRecaptchaTokenDetail,
  extractHcaptchaSitekey,
  extractRecaptchaSitekey,
  extractTurnstileSitekey,
  getHcaptchaSolveContext,
  findHcaptchaWidgetPageUrl,
  hasCaptchaResponseTokenForVariant,
  hasHcaptchaResponseTokenWithCompat,
  injectHcaptchaToken,
  injectTurnstileToken,
  waitForCaptchaResponseToken,
  withTimeout,
  solveVisibleCaptcha,
} from "./captcha.js";
import type { CaptchaSolveResult, CaptchaVariant, TwoCaptchaResult } from "./captcha.js";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "./browser.js";
import type { Session } from "./session/model.js";
import { audit } from "./session/lifecycle.js";

/** The checkbox and token entry points shared by drive and the direct tool. */
export async function runOperateCaptchaSolve(
  session: Session,
  options: {
    pressCheckbox?: boolean;
    autoSolve?: boolean;
    pressTimeoutMs?: number;
    page?: Page | undefined;
    attemptAutoSolve?: ((session: Session, page?: Page) => Promise<string>) | undefined;
    pressCheckboxChallenge?: ((session: Session, page?: Page) => Promise<CaptchaSolveResult>) | undefined;
  } = {},
): Promise<{ outcome: string; checkbox?: CaptchaSolveResult }> {
  const page = options.page ?? session.browser.page ?? undefined;
  const checkbox = options.pressCheckbox
    ? await (options.pressCheckboxChallenge ??
        ((s: Session, p?: Page) =>
          solveVisibleCaptcha(s.browser, options.pressTimeoutMs ?? 30_000, p)))(session, page)
    : undefined;
  const outcome =
    options.autoSolve === false
      ? checkbox?.found && checkbox.solved
        ? "ok"
        : checkbox?.found
          ? "checkbox_unsolved"
          : "no_checkbox"
      : await (options.attemptAutoSolve ?? attemptOperateCaptchaAutoSolve)(session, page);
  return { outcome, ...(checkbox === undefined ? {} : { checkbox }) };
}

// A TwoCaptchaVaultProxy backed by the MCP api-client: every 2Captcha call is
// routed through use_credential against the vaulted "2captcha" credential, so
// the raw key is injected server-side and never lives in this process. The
// ${SECRET} placeholder goes in the query (`key`) or JSON body (`clientKey`)
// per the request's keyInjection; the proxy substitutes it at the boundary.
export function makeTwoCaptchaVaultProxy(api: ApiClient): TwoCaptchaVaultProxy {
  return {
    async request(req) {
      const http: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
        query?: Record<string, string>;
      } = { method: req.method, url: req.url };
      if (req.keyInjection.in === "query") {
        http.query = { ...(req.query ?? {}), [req.keyInjection.name]: "${SECRET}" };
      } else {
        http.headers = { "content-type": "application/json" };
        http.body = JSON.stringify({
          [req.keyInjection.name]: "${SECRET}",
          ...(req.jsonBody ?? {}),
        });
      }
      const { response } = await api.useCredential({ service: "2captcha", http });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => JSON.parse(response.body) as unknown,
      };
    },
  };
}

// Build the right-transport solver for a session's api-client: vault-proxy
// when the install vaulted a "2captcha" credential (key never in this
// process), else the env key (TWOCAPTCHA_API_KEY, back-compat). Listing creds
// is metadata-only — no secret. `requestTimeoutMs` bounds every request on the
// path, the listing included: it carries no deadline of its own, so a
// black-holed connection here would hang a caller that has to settle.
export async function buildTwoCaptchaSolver(
  api: ApiClient | undefined,
  opts: { requestTimeoutMs?: number } = {},
): Promise<TwoCaptchaSolver> {
  const bounds =
    opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {};
  if (api !== undefined) {
    try {
      const listing = api.listCredentials();
      const { credentials } =
        opts.requestTimeoutMs === undefined
          ? await listing
          : await withTimeout(listing, opts.requestTimeoutMs);
      const hasVaulted = credentials.some((c) => (c.service ?? "").toLowerCase() === "2captcha");
      if (hasVaulted) {
        return new TwoCaptchaSolver({ vaultProxy: makeTwoCaptchaVaultProxy(api), ...bounds });
      }
    } catch {
      // Listing failed (offline / transient) — fall back to the env key.
    }
  }
  return new TwoCaptchaSolver(bounds);
}

// The 2Captcha half of a solve: pick the variant's sitekey off the page and
// buy a token for it. Writes nothing — a caller that cannot mutate the page
// right now (the operate drive, which holds no session-call lease while the
// solve runs) can hold the token and inject it later.
export async function fetchCaptchaToken(
  solver: TwoCaptchaSolver,
  browser: BrowserController,
  variant: string,
  page?: Page,
): Promise<{ token: string | null; outcome: string; reason?: string | undefined }> {
  if (!solver.isAvailable()) return { token: null, outcome: "no_key" };
  const pageUrl = page?.url() ?? browser.currentUrl();

  if (variant === "recaptcha_v2" || variant === "recaptcha_v3") {
    const sitekey = await extractRecaptchaSitekey(browser, page);
    if (sitekey === null) return { token: null, outcome: "missing_sitekey" };
    const res = await solver.solveRecaptchaV2({
      sitekey,
      pageUrl,
      ...(variant === "recaptcha_v3" ? { invisible: true } : {}),
    });
    return res.kind === "ok"
      ? { token: res.token, outcome: "ok" }
      : { token: null, outcome: res.kind, reason: nonOkReason(res) };
  }

  if (variant === "hcaptcha") {
    const sitekey = await extractHcaptchaSitekey(browser, page);
    if (sitekey === null) return { token: null, outcome: "missing_sitekey" };
    const ctx = await getHcaptchaSolveContext(browser, page);
    // Attribute the solve to the page that actually hosts the widget: when the
    // render container lives in a cross-origin frame (Bluesky's signup gate),
    // the token's siteverify hostname must be that frame's origin, not the
    // top page's — a hostname mismatch is exactly the shape a server-side
    // verify rejects with a generic "invalid" error.
    const widgetPageUrl = await findHcaptchaWidgetPageUrl(browser, page);
    const solvePageUrl = widgetPageUrl ?? pageUrl;
    console.error(
      `[captcha-autosolve-diag] session=hcaptcha-solve pageUrl_origin=${new URL(solvePageUrl).origin}${new URL(solvePageUrl).pathname} top_origin=${new URL(pageUrl).origin}`,
    );
    const res = await solver.solveHcaptcha({
      sitekey,
      pageUrl: solvePageUrl,
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    return res.kind === "ok"
      ? { token: res.token, outcome: "ok" }
      : { token: null, outcome: res.kind, reason: nonOkReason(res) };
  }

  if (variant === "turnstile") {
    const sitekey = await extractTurnstileSitekey(browser, page);
    if (sitekey === null) return { token: null, outcome: "missing_sitekey" };
    const res = await solver.solveTurnstile({ sitekey, pageUrl });
    return res.kind === "ok"
      ? { token: res.token, outcome: "ok" }
      : { token: null, outcome: res.kind, reason: nonOkReason(res) };
  }

  return { token: null, outcome: "unsupported_variant" };
}

function nonOkReason(res: Exclude<TwoCaptchaResult, { kind: "ok" }>): string | undefined {
  return res.kind === "submission_failed" || res.kind === "solver_error" ? res.reason : undefined;
}

// The page half: write the token into the variant's widget and settle. This is
// a real page mutation — injectHcaptchaToken fires the site's own
// success/verify callbacks, which on an ordinary integration submits the form
// — so it belongs inside the caller's action boundary.
export function captchaInjectSettled(input: {
  challengeRendered: boolean;
  callbacksFired: number;
  tokenPresent: boolean;
  pageReacted: boolean;
}): { solved: boolean; outcome: string } {
  if (input.callbacksFired > 0) return { solved: true, outcome: "ok" };
  if (input.tokenPresent && input.pageReacted) return { solved: true, outcome: "ok" };
  if (input.challengeRendered) return { solved: false, outcome: "challenge_still_rendered" };
  return { solved: input.tokenPresent, outcome: "ok" };
}

export async function injectCaptchaToken(
  browser: BrowserController,
  variant: string,
  token: string,
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  const recaptcha = variant === "recaptcha_v2" || variant === "recaptcha_v3";
  const inject =
    variant === "hcaptcha"
      ? injectHcaptchaToken
      : variant === "turnstile"
        ? injectTurnstileToken
        : null;
  if (!recaptcha && inject === null) return { solved: false, outcome: "unsupported_variant" };
  const urlBefore = page?.url() ?? browser.currentUrl();
  let callbacksFired = 0;
  if (recaptcha) {
    const diag = await injectRecaptchaTokenDetail(browser, token, page ?? null);
    if (!diag.ok) return { solved: false, outcome: "inject_failed" };
    callbacksFired = diag.callbacksFired;
  } else if (inject === null || !(await inject(browser, token, page))) {
    return { solved: false, outcome: "inject_failed" };
  }
  const tokenPresent = await waitForCaptchaResponseToken(browser, 2_000, page);
  // hCaptcha / Turnstile: the minted response field is the success signal
  // (see captcha-solve-token-signal). A leftover painted image grid is not a
  // miss — re-detecting it here discarded a token that had already landed
  // in a cross-origin gate frame (Bluesky).
  const pageReacted = recaptcha ? await recaptchaPageReacted(page, urlBefore) : tokenPresent;
  const after =
    recaptcha && tokenPresent && callbacksFired === 0 && !pageReacted
      ? await detectCaptchaVariant(browser, page)
      : { challengeRendered: false };
  return captchaInjectSettled({
    challengeRendered: after.challengeRendered,
    callbacksFired,
    tokenPresent,
    pageReacted,
  });
}

export async function solveCaptchaWithTokenSolver(
  solver: TwoCaptchaSolver,
  browser: BrowserController,
  variant: string,
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  const fetched = await fetchCaptchaToken(solver, browser, variant, page);
  if (fetched.token === null) return { solved: false, outcome: fetched.outcome };
  return injectCaptchaToken(browser, variant, fetched.token, page);
}

// Same document, not same string: a fragment change never replaces the
// document, anything else (path, query, origin) does.
function sameDocument(a: string, b: string): boolean {
  const withoutFragment = (url: string): string => {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return url;
    }
  };
  return withoutFragment(a) === withoutFragment(b);
}

// ── operate-path auto-solve ──

// The checkbox-family challenges a token solver can clear. Turnstile is
// deliberately excluded: its managed challenge clears on its own (and
// detectCaptchaVariant never reports a rendered Turnstile image grid).
// recaptcha_v3 is invisible scoring — included only because a rendered bframe
// alongside a badge means the substrate path already failed and the solver is
// the remaining escalation (same as the provision gate).
const AUTOSOLVE_VARIANTS = new Set<CaptchaVariant>(["hcaptcha", "recaptcha_v2", "recaptcha_v3"]);

// A solve takes tens of seconds on 2Captcha and each successful one costs the
// operator's funded key. Bound RETRIES: skip while one attempt is in flight
// and for this long after a FAILED attempt, so a failing challenge re-attempts
// on a later observation instead of on every poll. A token that landed does not
// arm it — the next challenge after a navigation is a different challenge.
const CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS = 30_000;

/** How long to wait after the challenge-form POST before reading frame URLs. */
const GATE_POST_SETTLE_MS = 4_000;

// One surface dump per page: the SDK shape does not change under us.
const hcaptchaSurfaceDumped = new WeakSet<object>();

// Hard bound on a single API/2Captcha request on the operate path. Neither the
// vault proxy nor the credential listing carries a deadline of its own, so
// without this a black-holed connection outlives the solver's overall deadline
// and the session's auto-solve never re-arms.
const CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS = 20_000;

// hCaptcha and reCAPTCHA tokens expire about two minutes after they are minted.
// A 2Captcha solve can take most of that on its own, and the stash then waits
// for the next observation — which the agent controls. Past this the token is
// dead: injecting it would report a solve the site rejects.
const CAPTCHA_TOKEN_LIFETIME_MS = 120_000;

// When a bought token dies unconsumed, the agent's observe cadence is slower
// than the token's shelf life — so re-purchasing on the very next observation
// buys another token that dies the same way. Back off geometrically per
// consecutive expiry; the cap keeps a slow agent still re-arming eventually.
const CAPTCHA_AUTOSOLVE_EXPIRY_BACKOFF_MAX_MS = 480_000;

function expiryBackoffMs(consecutiveExpiries: number): number {
  const raw = CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS * 2 ** (consecutiveExpiries - 1);
  return Math.min(raw, CAPTCHA_AUTOSOLVE_EXPIRY_BACKOFF_MAX_MS);
}

// Live-widget injection is the delivery path, including on pages that embed
// the widget in a /gate/ iframe (Bluesky). A standalone scratch-page handoff
// bought a token and then never wrote it into the widget the page uses
// (gauntlet 2026-09-27: token_purchased → gate_handoff_started →
// autosolve_disabled delivered=0 → "Invalid verification code").

interface AutoSolveState {
  inFlight: boolean;
  lastFinishedAt: number;
  // Geometric backoff after a token died unconsumed (see expiryBackoffMs).
  consecutiveExpiries: number;
  expiryBackoffUntil: number;
  // A bought token waiting for a lease-holding caller to inject it, with the
  // document it was bought for and when it was minted.
  pending: {
    variant: CaptchaVariant;
    token: string;
    solvedUrl: string;
    fetchedAt: number;
  } | null;
}

// One question, asked at every point the operate path decides whether a
// challenge still needs a token: before spending, before injecting a stashed
// token, and to confirm the injection landed. Asking it differently anywhere
// would make an attempt buy a token it then discards, or record a solve the
// page never took.
function variantTokenPresent(
  session: Session,
  variant: CaptchaVariant,
  page?: Page,
): Promise<boolean> {
  return variant === "hcaptcha"
    ? hasHcaptchaResponseTokenWithCompat(session.browser, page)
    : hasCaptchaResponseTokenForVariant(session.browser, variant, page);
}

// Weak ownership: attempt bookkeeping dies with the session object.
const attemptState = new WeakMap<Session, AutoSolveState>();

function autoSolveState(session: Session): AutoSolveState {
  const existing = attemptState.get(session);
  if (existing !== undefined) return existing;
  const fresh: AutoSolveState = {
    inFlight: false,
    lastFinishedAt: 0,
    consecutiveExpiries: 0,
    expiryBackoffUntil: 0,
    pending: null,
  };
  attemptState.set(session, fresh);
  return fresh;
}

/**
 * Best-effort captcha auto-solve for the general operate_* drive, in two
 * halves split along the session-call lease.
 *
 * Injecting a token is a real page mutation that fires the site's own
 * success callbacks (typically the form's submit handler), so it happens HERE,
 * awaited, inside the caller's action boundary — and a token that lands is
 * reflected in the very observation that injects it. Buying the token takes
 * tens of seconds on 2Captcha, so that half runs detached: an operate_* call
 * blocked on it would hold its lease and wedge every later call and
 * operate_finish.
 *
 * Never throws and never rejects. The returned string is the last
 * decision this call made (inject landed, fetch armed, or why it cannot
 * solve) so a caller that would otherwise finish stuck can say why.
 */
export async function attemptOperateCaptchaAutoSolve(
  session: Session,
  page?: Page,
): Promise<string> {
  // A released card is live in the page. Injecting a token fires the site's own
  // success callbacks, which on a checkout is the order submit — and a payment
  // advances only through the operator's explicit actions, after the
  // re-observation the payment contract expects. The challenge surfaces
  // unchanged here.
  audit(session.id, "captcha_autosolve", {
    outcome: "autosolve_entry",
    card_released: session.releasedPaymentCard !== null,
  });
  if (session.releasedPaymentCard !== null) return "card_released";
  const injected = await injectPendingCaptchaToken(session, page);
  const fetch = await startDetachedTokenFetch(session, page);
  if (injected === "injected" || injected === "already_settled") return injected;
  return fetch;
}

export function captchaAutoSolveHasWork(session: Session): boolean {
  const state = attemptState.get(session);
  return state !== undefined && (state.inFlight || state.pending !== null);
}

export async function injectPendingCaptchaToken(
  session: Session,
  page?: Page,
): Promise<string | null> {
  const state = autoSolveState(session);
  const pending = state.pending;
  if (pending === null) return null;
  state.pending = null;

  try {
    // The token itself has a shelf life, and both the solve and the wait for a
    // lease-holding caller eat into it. A dead token must not be written: it
    // would fill the response field, read back as solved, and leave the agent
    // submitting a value the site rejects with nothing left to retry.
    if (Date.now() - pending.fetchedAt > CAPTCHA_TOKEN_LIFETIME_MS) {
      state.consecutiveExpiries += 1;
      state.expiryBackoffUntil = Date.now() + expiryBackoffMs(state.consecutiveExpiries);
      audit(session.id, "captcha_autosolve", {
        variant: pending.variant,
        outcome: "token_expired",
      });
      console.error(
        `[captcha-autosolve-diag] session=${session.id} variant=${pending.variant} outcome=token_expired age_ms=${Date.now() - pending.fetchedAt}`,
      );
      return "token_expired";
    }
    // A token is bound to the document it was bought for. The agent kept
    // driving while 2Captcha worked, so the form may have been submitted or
    // re-rendered — writing the old token into a different document poisons
    // the response field with a value the site will reject.
    if (!sameDocument(pending.solvedUrl, page?.url() ?? session.browser.currentUrl())) {
      audit(session.id, "captcha_autosolve", { variant: pending.variant, outcome: "stale_page" });
      console.error(
        `[captcha-autosolve-diag] session=${session.id} variant=${pending.variant} outcome=stale_page`,
      );
      return "stale_page";
    }
    // The same question the fetch side asks before spending: a widget that
    // settled while 2Captcha worked — the agent clicked the checkbox, or the
    // substrate cleared it — needs nothing. Writing the bought token over it
    // would re-fire the site's success callbacks, which on an ordinary
    // integration submits the form a second time.
    if (await variantTokenPresent(session, pending.variant, page)) {
      audit(session.id, "captcha_autosolve", {
        variant: pending.variant,
        outcome: "already_settled",
      });
      console.error(
        `[captcha-autosolve-diag] session=${session.id} variant=${pending.variant} outcome=already_settled`,
      );
      state.consecutiveExpiries = 0;
      state.expiryBackoffUntil = 0;
      return "already_settled";
    }
    // The token is being consumed — the purchase→consume pipeline worked this
    // time, so a later expiry would be a fresh observation, not a streak.
    state.consecutiveExpiries = 0;
    state.expiryBackoffUntil = 0;
    const res = await injectCaptchaToken(session.browser, pending.variant, pending.token, page);
    // injectCaptchaToken's own settle check answers "does ANY provider hold a
    // token", which a co-resident widget can satisfy on its own. Confirm where
    // this variant's token actually belongs, so a token that landed nowhere
    // backs off instead of suppressing the next attempt.
    const confirmed = res.solved && (await variantTokenPresent(session, pending.variant, page));
    const outcome =
      confirmed
        ? res.outcome
        : res.outcome === "ok"
          ? "token_not_confirmed"
          : res.outcome;
    audit(session.id, "captcha_autosolve", {
      variant: pending.variant,
      outcome,
      solved: confirmed,
    });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} variant=${pending.variant} outcome=${outcome} confirmed=${confirmed} age_ms=${Date.now() - pending.fetchedAt}`,
    );
    if (!confirmed) state.lastFinishedAt = Date.now();
    // Gate handoff: the fill POSTs the challenge form into a hidden frame and
    // the gate answers with a redirect carrying the completion code. Give the
    // POST a moment, then find that code on a frame URL and point the original
    // challenge frame at it - the embedding page's own iframe onLoad handler
    // reads the code from there and finishes the flow. Diagnostic output uses
    // param NAMES and presence only; values are never printed.
    if (page) {
      void deliverGateHandoff(page, pending.variant);
    }
    return confirmed ? "injected" : outcome;
  } catch (error) {
    audit(session.id, "captcha_autosolve", {
      variant: pending.variant,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    state.lastFinishedAt = Date.now();
    return "error";
  }
}

/** One-shot per page: post-inject frame-URL handoff is only meaningful once. */
const gateHandoffAttempted = new WeakSet<object>();

async function deliverGateHandoff(page: Page, variant: string): Promise<void> {
  if (variant !== "hcaptcha" || gateHandoffAttempted.has(page)) return;
  gateHandoffAttempted.add(page);
  await new Promise((resolve) => setTimeout(resolve, GATE_POST_SETTLE_MS));
  try {
    let handoffUrl: string | null = null;
    const frameDesc: string[] = [];
    for (const frame of page.frames()) {
      let url: URL;
      try {
        url = new URL(frame.url());
      } catch {
        frameDesc.push("unreadable");
        continue;
      }
      const paramNames = Array.from(url.searchParams.keys());
      const code = url.searchParams.get("code");
      frameDesc.push(`${url.host}${url.pathname}?[${paramNames.join(",")}]${code ? "+CODE" : ""}`);
      if (code && url.searchParams.has("state") && !handoffUrl) {
        handoffUrl = frame.url();
      }
    }
    console.error(`[captcha-postinject-diag] frames=${JSON.stringify(frameDesc)}`);
    if (!handoffUrl) return;
    const mainFrame = page.mainFrame();
    const delivered = await mainFrame
      .evaluate((src) => {
        const el = document.querySelector<HTMLIFrameElement>(
          `iframe#captcha-iframe, iframe[src*="gate/signup"]`,
        );
        if (!el) return false;
        el.src = src;
        return true;
      }, handoffUrl)
      .catch(() => false);
    console.error(`[captcha-postinject-diag] delivered=${delivered}`);
  } catch {
    // diagnostic/handoff is best-effort
  }
}

async function startDetachedTokenFetch(session: Session, page?: Page): Promise<string> {
  const state = autoSolveState(session);
  if (state.inFlight) {
    audit(session.id, "captcha_autosolve", { outcome: "fetch_skipped", reason: "in_flight" });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} outcome=fetch_skipped reason=in_flight`,
    );
    return "in_flight";
  }
  if (
    state.lastFinishedAt > 0 &&
    Date.now() - state.lastFinishedAt < CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS
  ) {
    audit(session.id, "captcha_autosolve", { outcome: "fetch_skipped", reason: "cooldown" });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} outcome=fetch_skipped reason=cooldown`,
    );
    return "cooldown";
  }
  if (Date.now() < state.expiryBackoffUntil) {
    audit(session.id, "captcha_autosolve", { outcome: "fetch_skipped", reason: "expiry_backoff" });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} outcome=fetch_skipped reason=expiry_backoff expiries=${state.consecutiveExpiries} remaining_ms=${state.expiryBackoffUntil - Date.now()}`,
    );
    return "expiry_backoff";
  }
  // Claim the slot SYNCHRONOUSLY. Observations are serialized by the session
  // call lease, but the fetch they start is not, so a later observation has to
  // see the claim even while this one is still detecting.
  state.inFlight = true;
  return await runDetachedTokenFetch(session, page);
}

async function runDetachedTokenFetch(session: Session, page?: Page): Promise<string> {
  const state = autoSolveState(session);
  let variant: CaptchaVariant | null = null;
  audit(session.id, "captcha_autosolve", { outcome: "fetch_start" });
  try {
    const det = await detectCaptchaVariant(session.browser, page);
    // Detection visibility: without this line a silent early return is
    // indistinguishable from the fetch never having run at all (the gap this
    // module exists to close).
    audit(session.id, "captcha_autosolve", {
      variant: det.variant,
      outcome: "detect",
      challenge_rendered: det.challengeRendered,
    });
    // Unsealed diag line for the detect state: the audit outcome here is a
    // sealed value, so without this there is NO readable record of whether
    // detection saw a rendered challenge — making a silent early return
    // indistinguishable from the auto-solve never running at all.
    const evidence =
      det.recaptcha === undefined ? "" : ` ${recaptchaEvidenceDiag(det.recaptcha)}`;
    console.error(
      `[captcha-autosolve-diag] session=${session.id} variant=${det.variant} outcome=detect challenge_rendered=${det.challengeRendered}${evidence}`,
    );
    // Only a RENDERED challenge escalates to the solver. A mere checkbox
    // (or a settled widget) with a response token needs nothing, and a
    // no-challenge page must never spend the funded key.
    if (!det.challengeRendered || !AUTOSOLVE_VARIANTS.has(det.variant)) {
      state.inFlight = false;
      return det.challengeRendered ? "unsupported_variant" : "no_challenge";
    }
    // Scoped to the DETECTED provider: a co-resident reCAPTCHA v3 badge token
    // must not read as "the rendered hCaptcha is already solved".
    if (await variantTokenPresent(session, det.variant, page)) {
      state.inFlight = false;
      return "already_settled";
    }
    variant = det.variant;

    const solver = await buildTwoCaptchaSolver(session.api, {
      requestTimeoutMs: CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS,
    });
    if (!solver.isAvailable()) {
      audit(session.id, "captcha_autosolve", {
        variant,
        outcome: "no_key",
        solved: false,
        solver_ready: false,
      });
      console.error(
        `[captcha-autosolve-diag] session=${session.id} variant=${variant} outcome=no_key`,
      );
      state.inFlight = false;
      return "no_key";
    }
    void purchaseCaptchaToken(session, page, variant, solver);
    return "fetch_started";
  } catch (error) {
    // Best-effort: any solver or transport error — including the page or the
    // whole session going away mid-fetch — leaves the challenge on the page for
    // the agent to see, exactly as if no solver existed. Detection racing a
    // navigation is still audited: a silent swallow is indistinguishable from
    // the fetch never running (the gap this module exists to close).
    audit(session.id, "captcha_autosolve", {
      ...(variant !== null ? { variant } : {}),
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} variant=${variant} outcome=error error=${error instanceof Error ? error.message : String(error)}`,
    );
    state.inFlight = false;
    state.lastFinishedAt = Date.now();
    return "error";
  }
}

async function purchaseCaptchaToken(
  session: Session,
  page: Page | undefined,
  variant: CaptchaVariant,
  solver: TwoCaptchaSolver,
): Promise<void> {
  const state = autoSolveState(session);
  let failedAt = 0;
  try {
    // One-shot SDK-surface dump (no credential values, shape only): tells us
    // where the site's hcaptcha SDK keeps its callbacks before we rely on the
    // injection path firing them.
    if (page && !hcaptchaSurfaceDumped.has(page)) {
      hcaptchaSurfaceDumped.add(page);
      try {
        const frames: Array<Record<string, unknown>> = [];
        for (const frame of page.frames()) {
          try {
            const info = await frame.evaluate(() => {
              const win = window as unknown as Record<string, unknown>;
              const deepCount = (sel: string): number => {
                let n = 0;
                const walk = (root: Document | ShadowRoot): void => {
                  n += root.querySelectorAll(sel).length;
                  for (const el of Array.from(root.querySelectorAll("*"))) {
                    const sr = (el as HTMLElement).shadowRoot;
                    if (sr) walk(sr);
                  }
                };
                walk(document);
                return n;
              };
              const cfg = win.___hcaptcha_cfg as Record<string, unknown> | undefined;
              const cfgFns = cfg
                ? Object.entries(cfg)
                    .filter(([, v]) => typeof v === "function")
                    .map(([k]) => k)
                    .join(",")
                : "none";
              const hc = win.hcaptcha as Record<string, unknown> | undefined;
              return {
                hcKeys: hc ? Object.keys(hc).join(",").slice(0, 120) : "absent",
                cfgFns,
                textareas: deepCount(
                  'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"], textarea[name="g-recaptcha-response"]',
                ),
                hosts: deepCount(".h-captcha, [data-hcaptcha-widget-id], [data-hcaptcha-response]"),
                iframes: deepCount('iframe[src*="hcaptcha.com"], iframe[id^="captcha"]'),
              };
            });
            frames.push({ url: frame.url().slice(0, 90), ...info });
          } catch {
            frames.push({ url: frame.url().slice(0, 90), error: true });
          }
        }
        console.error(`[captcha-surface-diag] ${JSON.stringify(frames)}`);
      } catch {
        // diagnostic only
      }
    }
    const solvedUrl = page?.url() ?? session.browser.currentUrl();
    const fetched = await fetchCaptchaToken(solver, session.browser, variant, page);
    if (fetched.token === null) {
      audit(session.id, "captcha_autosolve", {
        variant,
        outcome: fetched.outcome,
        solved: false,
        // Audit values seal strings, so the outcome itself is unreadable in
        // the trail; expose the two discriminating booleans beside it.
        solver_ready: solver.isAvailable(),
        sitekey_missing: fetched.outcome === "missing_sitekey",
        reason: fetched.reason,
      });
      // The audit trail seals every string, including the 2captcha error code
      // this branch exists to surface; emit it unsealed to stderr so the
      // operator's own diagnostics can read it. Contains no credential value.
      console.error(
        `[captcha-autosolve-diag] session=${session.id} variant=${variant} outcome=${fetched.outcome} reason=${fetched.reason ?? "n/a"}`,
      );
      failedAt = Date.now();
      return;
    }
    state.pending = { variant, token: fetched.token, solvedUrl, fetchedAt: Date.now() };
    audit(session.id, "captcha_autosolve", { variant, outcome: "token_purchased" });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} variant=${variant} outcome=token_purchased`,
    );
  } catch (error) {
    audit(session.id, "captcha_autosolve", {
      variant,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `[captcha-autosolve-diag] session=${session.id} variant=${variant} outcome=error error=${error instanceof Error ? error.message : String(error)}`,
    );
    failedAt = Date.now();
  } finally {
    state.inFlight = false;
    state.lastFinishedAt = failedAt;
  }
}
