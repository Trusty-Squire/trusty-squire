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
// non-blocking in outcome — when no credential is vaulted, or the solve fails
// or times out, the caller surfaces the challenge exactly as it does today.
// It never throws and never hard-fails a session.

import type { Page } from "playwright";
import {
  TwoCaptchaSolver,
  type TwoCaptchaVaultProxy,
  detectCaptchaVariant,
  extractHcaptchaSitekey,
  extractRecaptchaSitekey,
  extractTurnstileSitekey,
  getHcaptchaSolveContext,
  injectHcaptchaToken,
  injectRecaptchaToken,
  injectTurnstileToken,
  waitForCaptchaResponseToken,
} from "./captcha.js";
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
): Promise<TwoCaptchaSolver> {
  if (api !== undefined) {
    try {
      const { credentials } = await api.listCredentials();
      const hasVaulted = credentials.some((c) => (c.service ?? "").toLowerCase() === "2captcha");
      if (hasVaulted) {
        return new TwoCaptchaSolver({ vaultProxy: makeTwoCaptchaVaultProxy(api) });
      }
    } catch {
      // Listing failed (offline / transient) — fall back to the env key.
    }
  }
  return new TwoCaptchaSolver();
}

export async function solveCaptchaWithTokenSolver(
  solver: TwoCaptchaSolver,
  browser: BrowserController,
  variant: string,
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  if (!solver.isAvailable()) return { solved: false, outcome: "no_key" };

  if (variant === "recaptcha_v2" || variant === "recaptcha_v3") {
    const sitekey = await extractRecaptchaSitekey(browser, page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveRecaptchaV2({
      sitekey,
      pageUrl: page?.url() ?? browser.currentUrl(),
      ...(variant === "recaptcha_v3" ? { invisible: true } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
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
      pageUrl: page?.url() ?? browser.currentUrl(),
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
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
    const res = await solver.solveTurnstile({
      sitekey,
      pageUrl: page?.url() ?? browser.currentUrl(),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await injectTurnstileToken(browser, res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await waitForCaptchaResponseToken(browser, 2_000, page),
      outcome: "ok",
    };
  }

  return { solved: false, outcome: "unsupported_variant" };
}

// ── operate-path auto-solve ──

// The checkbox-family challenges a token solver can clear. Turnstile is
// deliberately excluded: its managed challenge clears on its own (and
// detectCaptchaVariant never reports a rendered Turnstile image grid).
// recaptcha_v3 is invisible scoring — included only because a rendered bframe
// alongside a badge means the substrate path already failed and the solver is
// the remaining escalation (same as the provision gate).
const AUTOSOLVE_VARIANTS = new Set(["hcaptcha", "recaptcha_v2", "recaptcha_v3"]);

// A solve takes tens of seconds on 2Captcha and each successful one costs the
// operator's funded key. Bound retries: skip while one attempt is in flight
// and for this long after the last attempt finished, so a failing challenge
// surfaces to the agent immediately and re-attempts only on a later
// observation instead of on every poll.
export const CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS = 30_000;

// Weak ownership: attempt bookkeeping dies with the session object.
const attemptState = new WeakMap<Session, { inFlight: boolean; lastFinishedAt: number }>();

/**
 * Best-effort token solve for a captcha challenge detected during the general
 * operate_* drive. Call before an observation captures the page: a solved
 * challenge clears before the DOM is read, so the returned observation reflects
 * the post-solve page; an unsolved one surfaces the challenge blocker exactly
 * as before. Never throws; returns whether a token was injected and settled.
 */
export async function attemptOperateCaptchaAutoSolve(
  session: Session,
  page?: Page,
): Promise<boolean> {
  const state = attemptState.get(session);
  if (state !== undefined) {
    if (state.inFlight) return false;
    if (Date.now() - state.lastFinishedAt < CAPTCHA_AUTOSOLVE_RETRY_COOLDOWN_MS) return false;
  }

  let variant: string;
  try {
    const det = await detectCaptchaVariant(session.browser, page);
    // Only a RENDERED challenge escalates to the solver. A mere checkbox
    // (or a settled widget) with a response token needs nothing, and a
    // no-challenge page must never spend the funded key.
    if (!det.challengeRendered || !AUTOSOLVE_VARIANTS.has(det.variant)) return false;
    const token = await waitForCaptchaResponseToken(session.browser, 0, page).catch(() => false);
    if (token) return false;
    variant = det.variant;
  } catch {
    // Detection raced a navigation or a closed page — nothing to solve.
    return false;
  }

  attemptState.set(session, { inFlight: true, lastFinishedAt: 0 });
  try {
    const solver = await buildTwoCaptchaSolver(session.api);
    const res = await solveCaptchaWithTokenSolver(solver, session.browser, variant, page);
    audit(session.id, "captcha_autosolve", {
      variant,
      outcome: res.outcome,
      solved: res.solved,
    });
    return res.solved;
  } catch (error) {
    // Best-effort: any solver or transport error leaves the challenge on the
    // page for the agent to see, exactly as if no solver existed.
    audit(session.id, "captcha_autosolve", {
      variant,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    attemptState.set(session, { inFlight: false, lastFinishedAt: Date.now() });
  }
}
