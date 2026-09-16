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
// non-blocking — it starts the solve detached and returns at once, so when no
// credential is vaulted, or the solve fails, stalls, or is still running, the
// caller surfaces the challenge exactly as it does today. It never throws and
// never hard-fails a session.

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
// is metadata-only — no secret.
export async function buildTwoCaptchaSolver(
  api: ApiClient | undefined,
  opts: { requestTimeoutMs?: number } = {},
): Promise<TwoCaptchaSolver> {
  const bounds =
    opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {};
  if (api !== undefined) {
    try {
      const { credentials } = await api.listCredentials();
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

export async function solveCaptchaWithTokenSolver(
  solver: TwoCaptchaSolver,
  browser: BrowserController,
  variant: string,
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  if (!solver.isAvailable()) return { solved: false, outcome: "no_key" };

  // A token is bound to the document it was solved for. 2Captcha answers tens
  // of seconds later, by which time the agent may have submitted the form or
  // the site may have re-rendered a FRESH challenge — writing the old token
  // into that document poisons the response field with a value the site will
  // reject, and makes the page look solved to every later check.
  const solvedUrl = page?.url() ?? browser.currentUrl();
  const stillOnSolvedDocument = (): boolean =>
    sameDocument(solvedUrl, page?.url() ?? browser.currentUrl());

  if (variant === "recaptcha_v2" || variant === "recaptcha_v3") {
    const sitekey = await extractRecaptchaSitekey(browser, page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveRecaptchaV2({
      sitekey,
      pageUrl: solvedUrl,
      ...(variant === "recaptcha_v3" ? { invisible: true } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    if (!stillOnSolvedDocument()) return { solved: false, outcome: "stale_page" };
    const injected = await injectRecaptchaToken(browser, res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await waitForCaptchaResponseToken(browser, 2_000, page),
      outcome: "ok",
    };
  }

  if (variant === "hcaptcha") {
    const sitekey = await extractHcaptchaSitekey(browser, page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const ctx = await getHcaptchaSolveContext(browser, page);
    const res = await solver.solveHcaptcha({
      sitekey,
      pageUrl: solvedUrl,
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    if (!stillOnSolvedDocument()) return { solved: false, outcome: "stale_page" };
    const injected = await injectHcaptchaToken(browser, res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await waitForCaptchaResponseToken(browser, 2_000, page),
      outcome: "ok",
    };
  }

  if (variant === "turnstile") {
    const sitekey = await extractTurnstileSitekey(browser, page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveTurnstile({ sitekey, pageUrl: solvedUrl });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    if (!stillOnSolvedDocument()) return { solved: false, outcome: "stale_page" };
    const injected = await injectTurnstileToken(browser, res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await waitForCaptchaResponseToken(browser, 2_000, page),
      outcome: "ok",
    };
  }

  return { solved: false, outcome: "unsupported_variant" };
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
// on a later observation instead of on every poll. A successful solve does not
// arm it — the next challenge after a navigation is a different challenge.
const CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS = 30_000;

// Hard bound on a single 2Captcha request on the operate path. The transport is
// Squire's injecting proxy, which carries no per-request deadline of its own, so
// without this one stalled POST outlives the solver's overall deadline and the
// session's auto-solve never re-arms.
const CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS = 20_000;

// Weak ownership: attempt bookkeeping dies with the session object.
const attemptState = new WeakMap<Session, { inFlight: boolean; lastFinishedAt: number }>();

/**
 * Best-effort token solve for a captcha challenge detected during the general
 * operate_* drive. Starts the solve DETACHED and returns immediately: a
 * 2Captcha solve takes tens of seconds, and the observation that noticed the
 * challenge must never be gated on it (an operate_* call blocked on a solve
 * holds its session-call lease, which wedges every later call and
 * operate_finish). The observation therefore surfaces the challenge exactly as
 * it does today; when the detached solve lands its token, the NEXT observation
 * sees the cleared page — the in-flight guard and the variant-scoped token
 * pre-check keep it from starting a second solver in the meantime. Never
 * throws and never rejects.
 */
export function attemptOperateCaptchaAutoSolve(session: Session, page?: Page): void {
  const state = attemptState.get(session);
  if (state !== undefined) {
    if (state.inFlight) return;
    if (
      state.lastFinishedAt > 0 &&
      Date.now() - state.lastFinishedAt < CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS
    ) {
      return;
    }
  }
  // Claim the slot SYNCHRONOUSLY. Observations are serialized by the session
  // call lease, but the solve they start no longer is, so a later observation
  // has to see the claim even while this one is still detecting.
  attemptState.set(session, { inFlight: true, lastFinishedAt: 0 });
  void runDetachedAutoSolve(session, page);
}

async function runDetachedAutoSolve(session: Session, page?: Page): Promise<void> {
  // Only a FAILED attempt arms the retry cooldown: nothing to solve, and a
  // solve that landed its token, both leave the next observation free.
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

    const solver = await buildTwoCaptchaSolver(session.api, {
      requestTimeoutMs: CAPTCHA_AUTOSOLVE_REQUEST_TIMEOUT_MS,
    });
    const res = await solveCaptchaWithTokenSolver(solver, session.browser, variant, page);
    // The solver's own settle check answers "does ANY provider hold a token",
    // which a co-resident widget can satisfy on its own. Confirm against the
    // DETECTED provider's field, the same question the pre-check above asks, so
    // a token that landed nowhere is a failed attempt that arms the cooldown
    // rather than a recorded success that suppresses the next one.
    const confirmed =
      res.solved && (await hasCaptchaResponseTokenForVariant(session.browser, variant, page));
    audit(session.id, "captcha_autosolve", {
      variant,
      outcome: res.solved && !confirmed ? "token_not_confirmed" : res.outcome,
      solved: confirmed,
    });
    if (!confirmed) failedAt = Date.now();
  } catch (error) {
    // Best-effort: any solver or transport error — including the page or the
    // whole session going away mid-solve — leaves the challenge on the page for
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
    attemptState.set(session, { inFlight: false, lastFinishedAt: failedAt });
  }
}
