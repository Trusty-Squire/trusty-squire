// 2Captcha solver client — Tier 3 fallback for image-challenge
// reCAPTCHA v2.
//
// The bot's existing captcha handling is two tiers:
//   - Tier 1: behavior simulation (passes invisible reCAPTCHA v3 +
//             Turnstile-invisible — no cost)
//   - Tier 2: click-and-wait for visible checkboxes (passes reCAPTCHA
//             v2 checkbox + Turnstile checkbox — no cost)
//
// This module is Tier 3 — when Tier 2 times out on a reCAPTCHA v2
// image challenge (the "select all crosswalks" kind), submit the
// page's sitekey to 2Captcha's API. They route to a human solver
// (or their own ML), return a token in ~30-90s. We inject the token
// into the hidden `g-recaptcha-response` textarea + fire the
// onSuccess callback that the captcha widget registered.
//
// Cost: ~$0.003 per solve. Reliability: ~95% for vanilla v2 image
// challenge. IP-mismatch concern is theoretical for v2 (the token
// validation API doesn't check solver IP). Doesn't help with
// reCAPTCHA v3 / Enterprise scoring or Cloudflare Turnstile — those
// fail at the scoring layer, not the challenge layer.
//
// Env-gated: TWOCAPTCHA_API_KEY unset → module returns null and the
// existing captcha_blocked classification stands. No code path
// silently turns on a paid service.

const TWOCAPTCHA_BASE = "https://2captcha.com";

// Per-solve timeouts. The IN call should answer fast (sitekey
// submission is just queued). The RES polling can take 60-120s on
// busy days; we cap at 180s to keep the bot's overall budget bounded.
const IN_TIMEOUT_MS = 10_000;
const RES_POLL_INTERVAL_MS = 5_000;
const RES_TIMEOUT_MS = 180_000;

export interface TwoCaptchaSolverOpts {
  apiKey?: string;
  // Override globalThis.fetch (tests).
  fetchFn?: typeof globalThis.fetch;
  // Override polling sleep (tests).
  sleepFn?: (ms: number) => Promise<void>;
  // Override max polling deadline (tests).
  resTimeoutMs?: number;
}

export type TwoCaptchaResult =
  | { kind: "ok"; token: string; durationMs: number }
  | { kind: "no_key" }
  | { kind: "submission_failed"; reason: string }
  | { kind: "solve_timeout"; durationMs: number }
  | { kind: "solver_error"; reason: string };

export class TwoCaptchaSolver {
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly resTimeoutMs: number;

  constructor(opts: TwoCaptchaSolverOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.TWOCAPTCHA_API_KEY;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resTimeoutMs = opts.resTimeoutMs ?? RES_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  /**
   * Submit a reCAPTCHA v2 sitekey + page URL to 2Captcha, poll until
   * a token is returned (or the deadline elapses). Fire-and-forget
   * is wrong here — the caller is gated on the token to inject into
   * the page, so this is await-mandatory.
   */
  async solveRecaptchaV2(input: {
    sitekey: string;
    pageUrl: string;
    // Optional: data-action for reCAPTCHA v2 invisible / v3-styled
    // challenges. 2Captcha returns an action-bound token when set.
    action?: string;
  }): Promise<TwoCaptchaResult> {
    if (!this.isAvailable()) return { kind: "no_key" };
    const apiKey = this.apiKey!;
    const startMs = Date.now();

    // ── 1. Submit ────────────────────────────────────────────────
    const inUrl = new URL(`${TWOCAPTCHA_BASE}/in.php`);
    inUrl.searchParams.set("key", apiKey);
    inUrl.searchParams.set("method", "userrecaptcha");
    inUrl.searchParams.set("googlekey", input.sitekey);
    inUrl.searchParams.set("pageurl", input.pageUrl);
    inUrl.searchParams.set("json", "1");
    if (input.action !== undefined) inUrl.searchParams.set("action", input.action);

    let captchaId: string;
    try {
      const inRes = await withTimeout(
        this.fetchFn(inUrl.toString(), { method: "POST" }),
        IN_TIMEOUT_MS,
      );
      if (!inRes.ok) {
        return {
          kind: "submission_failed",
          reason: `in.php HTTP ${inRes.status}`,
        };
      }
      const body = (await inRes.json()) as { status: number; request: string };
      if (body.status !== 1) {
        // 2Captcha returns status=0 with a textual error code like
        // "ERROR_KEY_DOES_NOT_EXIST" / "ERROR_NO_SLOT_AVAILABLE".
        return {
          kind: "submission_failed",
          reason: body.request ?? "unknown_2captcha_error",
        };
      }
      captchaId = body.request;
    } catch (err) {
      return {
        kind: "submission_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // ── 2. Poll for the token ────────────────────────────────────
    const resUrl = new URL(`${TWOCAPTCHA_BASE}/res.php`);
    resUrl.searchParams.set("key", apiKey);
    resUrl.searchParams.set("action", "get");
    resUrl.searchParams.set("id", captchaId);
    resUrl.searchParams.set("json", "1");

    while (Date.now() - startMs < this.resTimeoutMs) {
      await this.sleepFn(RES_POLL_INTERVAL_MS);
      try {
        const resRes = await this.fetchFn(resUrl.toString());
        if (!resRes.ok) continue; // transient — retry on next tick
        const body = (await resRes.json()) as { status: number; request: string };
        if (body.status === 1) {
          return {
            kind: "ok",
            token: body.request,
            durationMs: Date.now() - startMs,
          };
        }
        // status=0 with request="CAPCHA_NOT_READY" means keep polling.
        // Any other status=0 request is a hard error (worker
        // unavailable, sitekey rejected, etc.).
        if (body.request === "CAPCHA_NOT_READY") continue;
        return {
          kind: "solver_error",
          reason: body.request ?? "unknown_res_error",
        };
      } catch {
        // Transient network error — retry on next tick.
      }
    }
    return { kind: "solve_timeout", durationMs: Date.now() - startMs };
  }
}

// Race a promise against a hard timeout. 2Captcha's in.php should
// answer in <2s; a 10s cap is generous.
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
