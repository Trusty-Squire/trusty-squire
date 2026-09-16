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
  extractHcaptchaSitekey,
  extractRecaptchaSitekey,
  extractTurnstileSitekey,
  getHcaptchaSolveContext,
  hasCaptchaResponseTokenForVariant,
  injectHcaptchaToken,
  injectRecaptchaToken,
  injectTurnstileToken,
  waitForCaptchaResponseToken,
  withTimeout,
} from "./captcha.js";
import type { CaptchaVariant } from "./captcha.js";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "./browser.js";
import type { Session } from "./session/model.js";
import { audit } from "./session/lifecycle.js";

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
): Promise<{ token: string | null; outcome: string }> {
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
      : { token: null, outcome: res.kind };
  }

  if (variant === "hcaptcha") {
    const sitekey = await extractHcaptchaSitekey(browser, page);
    if (sitekey === null) return { token: null, outcome: "missing_sitekey" };
    const ctx = await getHcaptchaSolveContext(browser, page);
    const res = await solver.solveHcaptcha({
      sitekey,
      pageUrl,
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    return res.kind === "ok"
      ? { token: res.token, outcome: "ok" }
      : { token: null, outcome: res.kind };
  }

  if (variant === "turnstile") {
    const sitekey = await extractTurnstileSitekey(browser, page);
    if (sitekey === null) return { token: null, outcome: "missing_sitekey" };
    const res = await solver.solveTurnstile({ sitekey, pageUrl });
    return res.kind === "ok"
      ? { token: res.token, outcome: "ok" }
      : { token: null, outcome: res.kind };
  }

  return { token: null, outcome: "unsupported_variant" };
}

// The page half: write the token into the variant's widget and settle. This is
// a real page mutation — injectHcaptchaToken fires the site's own
// success/verify callbacks, which on an ordinary integration submits the form
// — so it belongs inside the caller's action boundary.
export async function injectCaptchaToken(
  browser: BrowserController,
  variant: string,
  token: string,
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  const inject =
    variant === "hcaptcha"
      ? injectHcaptchaToken
      : variant === "turnstile"
        ? injectTurnstileToken
        : variant === "recaptcha_v2" || variant === "recaptcha_v3"
          ? injectRecaptchaToken
          : null;
  if (inject === null) return { solved: false, outcome: "unsupported_variant" };
  if (!(await inject(browser, token, page))) return { solved: false, outcome: "inject_failed" };
  return {
    solved: await waitForCaptchaResponseToken(browser, 2_000, page),
    outcome: "ok",
  };
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

// Hard bound on a single API/2Captcha request on the operate path. Neither the
// vault proxy nor the credential listing carries a deadline of its own, so
// without this a black-holed connection outlives the solver's overall deadline
// and the session's auto-solve never re-arms.
const CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS = 20_000;

interface AutoSolveState {
  inFlight: boolean;
  lastFinishedAt: number;
  // A bought token waiting for a lease-holding caller to inject it, with the
  // document it was bought for.
  pending: { variant: CaptchaVariant; token: string; solvedUrl: string } | null;
}

// Weak ownership: attempt bookkeeping dies with the session object.
const attemptState = new WeakMap<Session, AutoSolveState>();

function autoSolveState(session: Session): AutoSolveState {
  const existing = attemptState.get(session);
  if (existing !== undefined) return existing;
  const fresh: AutoSolveState = { inFlight: false, lastFinishedAt: 0, pending: null };
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
 * Never throws and never rejects.
 */
export async function attemptOperateCaptchaAutoSolve(session: Session, page?: Page): Promise<void> {
  // A released card is live in the page. Injecting a token fires the site's own
  // success callbacks, which on a checkout is the order submit — and a payment
  // advances only through the operator's explicit actions, after the
  // re-observation the payment contract expects. The challenge surfaces
  // unchanged here.
  if (session.releasedPaymentCard !== null) return;
  await injectPendingCaptchaToken(session, page);
  startDetachedTokenFetch(session, page);
}

async function injectPendingCaptchaToken(session: Session, page?: Page): Promise<void> {
  const state = autoSolveState(session);
  const pending = state.pending;
  if (pending === null) return;
  state.pending = null;

  try {
    // A token is bound to the document it was bought for. The agent kept
    // driving while 2Captcha worked, so the form may have been submitted or
    // re-rendered — writing the old token into a different document poisons
    // the response field with a value the site will reject.
    if (!sameDocument(pending.solvedUrl, page?.url() ?? session.browser.currentUrl())) {
      audit(session.id, "captcha_autosolve", { variant: pending.variant, outcome: "stale_page" });
      return;
    }
    // The same question the fetch side asks before spending: a widget that
    // settled while 2Captcha worked — the agent clicked the checkbox, or the
    // substrate cleared it — needs nothing. Writing the bought token over it
    // would re-fire the site's success callbacks, which on an ordinary
    // integration submits the form a second time.
    if (await hasCaptchaResponseTokenForVariant(session.browser, pending.variant, page)) {
      audit(session.id, "captcha_autosolve", {
        variant: pending.variant,
        outcome: "already_settled",
      });
      return;
    }
    const res = await injectCaptchaToken(session.browser, pending.variant, pending.token, page);
    // The settle check answers "does ANY provider hold a token", which a
    // co-resident widget can satisfy on its own. Confirm against the DETECTED
    // provider's field, the same question the fetch pre-check asks, so a token
    // that landed nowhere backs off instead of suppressing the next attempt.
    const confirmed =
      res.solved &&
      (await hasCaptchaResponseTokenForVariant(session.browser, pending.variant, page));
    audit(session.id, "captcha_autosolve", {
      variant: pending.variant,
      outcome: res.solved && !confirmed ? "token_not_confirmed" : res.outcome,
      solved: confirmed,
    });
    if (!confirmed) state.lastFinishedAt = Date.now();
  } catch (error) {
    audit(session.id, "captcha_autosolve", {
      variant: pending.variant,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    state.lastFinishedAt = Date.now();
  }
}

function startDetachedTokenFetch(session: Session, page?: Page): void {
  const state = autoSolveState(session);
  if (state.inFlight) return;
  if (
    state.lastFinishedAt > 0 &&
    Date.now() - state.lastFinishedAt < CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS
  ) {
    return;
  }
  // Claim the slot SYNCHRONOUSLY. Observations are serialized by the session
  // call lease, but the fetch they start is not, so a later observation has to
  // see the claim even while this one is still detecting.
  state.inFlight = true;
  void runDetachedTokenFetch(session, page);
}

async function runDetachedTokenFetch(session: Session, page?: Page): Promise<void> {
  const state = autoSolveState(session);
  let failedAt = 0;
  let variant: CaptchaVariant | null = null;
  try {
    const det = await detectCaptchaVariant(session.browser, page);
    // Only a RENDERED challenge escalates to the solver. A mere checkbox
    // (or a settled widget) with a response token needs nothing, and a
    // no-challenge page must never spend the funded key.
    if (!det.challengeRendered || !AUTOSOLVE_VARIANTS.has(det.variant)) return;
    // Scoped to the DETECTED provider: a co-resident reCAPTCHA v3 badge token
    // must not read as "the rendered hCaptcha is already solved".
    if (await hasCaptchaResponseTokenForVariant(session.browser, det.variant, page)) return;
    variant = det.variant;

    const solvedUrl = page?.url() ?? session.browser.currentUrl();
    const solver = await buildTwoCaptchaSolver(session.api, {
      requestTimeoutMs: CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS,
    });
    const fetched = await fetchCaptchaToken(solver, session.browser, variant, page);
    if (fetched.token === null) {
      audit(session.id, "captcha_autosolve", {
        variant,
        outcome: fetched.outcome,
        solved: false,
      });
      failedAt = Date.now();
      return;
    }
    state.pending = { variant, token: fetched.token, solvedUrl };
  } catch (error) {
    // Best-effort: any solver or transport error — including the page or the
    // whole session going away mid-fetch — leaves the challenge on the page for
    // the agent to see, exactly as if no solver existed. A throw before a
    // variant was settled on is detection racing a navigation: nothing was
    // attempted, so there is nothing to audit and nothing to back off from.
    if (variant !== null) {
      audit(session.id, "captcha_autosolve", {
        variant,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      failedAt = Date.now();
    }
  } finally {
    state.inFlight = false;
    state.lastFinishedAt = failedAt;
  }
}
