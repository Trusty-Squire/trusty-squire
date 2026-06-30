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
const TWOCAPTCHA_API_BASE = "https://api.2captcha.com";

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

export type TwoCaptchaCoordinatesResult =
  | { kind: "ok"; coordinates: Array<{ x: number; y: number }>; durationMs: number }
  | Exclude<TwoCaptchaResult, { kind: "ok"; token: string; durationMs: number }>;

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
    // Invisible reCAPTCHA uses the same 2Captcha method as v2 checkbox, but
    // the provider needs the invisible flag to solve the right widget mode.
    invisible?: boolean;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "userrecaptcha",
      googlekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.invisible === true ? { invisible: "1" } : {}),
    });
  }

  /**
   * Submit an hCaptcha sitekey + page URL to 2Captcha (method=hcaptcha)
   * and poll for the token. hCaptcha (plausible, several others) is a
   * distinct provider from reCAPTCHA — 2Captcha routes it through a
   * different worker pool and the response token goes into the page's
   * `h-captcha-response` textarea, not `g-recaptcha-response`.
   */
  async solveHcaptcha(input: {
    sitekey: string;
    pageUrl: string;
    invisible?: boolean;
    userAgent?: string;
    data?: string;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "hcaptcha",
      sitekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.invisible === true ? { invisible: "1" } : {}),
      ...(input.userAgent !== undefined && input.userAgent.trim().length > 0
        ? { userAgent: input.userAgent }
        : {}),
      ...(input.data !== undefined && input.data.trim().length > 0 ? { data: input.data } : {}),
    });
  }

  /**
   * Submit a Cloudflare Turnstile sitekey + page URL to 2Captcha
   * (method=turnstile) and poll for the token. The returned token goes into
   * the page's `cf-turnstile-response` input + the widget's success callback.
   *
   * Historically NOT wired, on the belief that "Cloudflare IP-scores Turnstile
   * so a solver token is rejected." That belief was FALSIFIED 2026-06-12 (exa
   * fails on a fresh direct residential IP + real GPU — it is NOT IP-bound; see
   * STATE.md), so a 2Captcha token may actually be accepted. Optional
   * `action`/`data` fields carry through for the managed-challenge variants
   * that bind a cData/chlPageData blob.
   */
  async solveTurnstile(input: {
    sitekey: string;
    pageUrl: string;
    action?: string;
    data?: string;
  }): Promise<TwoCaptchaResult> {
    return this.submitAndPoll({
      method: "turnstile",
      sitekey: input.sitekey,
      pageurl: input.pageUrl,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  async solveCoordinates(input: {
    imageBase64: string;
    comment?: string;
    minClicks?: number;
    maxClicks?: number;
  }): Promise<TwoCaptchaCoordinatesResult> {
    if (!this.isAvailable()) return { kind: "no_key" };
    const apiKey = this.apiKey!;
    const startMs = Date.now();

    let taskId: number;
    try {
      const res = await withTimeout(
        this.fetchFn(`${TWOCAPTCHA_API_BASE}/createTask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientKey: apiKey,
            task: {
              type: "CoordinatesTask",
              body: input.imageBase64,
              ...(input.comment !== undefined ? { comment: input.comment } : {}),
              ...(input.minClicks !== undefined ? { minClicks: input.minClicks } : {}),
              ...(input.maxClicks !== undefined ? { maxClicks: input.maxClicks } : {}),
            },
          }),
        }),
        IN_TIMEOUT_MS,
      );
      if (!res.ok) return { kind: "submission_failed", reason: `createTask HTTP ${res.status}` };
      const body = (await res.json()) as {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        taskId?: number;
      };
      if (body.errorId !== 0 || typeof body.taskId !== "number") {
        return {
          kind: "submission_failed",
          reason: body.errorCode ?? body.errorDescription ?? "unknown_2captcha_error",
        };
      }
      taskId = body.taskId;
    } catch (err) {
      return {
        kind: "submission_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    while (Date.now() - startMs < this.resTimeoutMs) {
      await this.sleepFn(RES_POLL_INTERVAL_MS);
      try {
        const res = await this.fetchFn(`${TWOCAPTCHA_API_BASE}/getTaskResult`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientKey: apiKey, taskId }),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
          status?: string;
          solution?: { coordinates?: Array<{ x?: unknown; y?: unknown }> };
        };
        if (body.errorId !== 0) {
          return {
            kind: "solver_error",
            reason: body.errorCode ?? body.errorDescription ?? "unknown_res_error",
          };
        }
        if (body.status !== "ready") continue;
        const coordinates = (body.solution?.coordinates ?? [])
          .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (coordinates.length === 0) {
          return { kind: "solver_error", reason: "missing_coordinates" };
        }
        return { kind: "ok", coordinates, durationMs: Date.now() - startMs };
      } catch {
        // transient; retry on next tick
      }
    }
    return { kind: "solve_timeout", durationMs: Date.now() - startMs };
  }

  // Shared in.php submit + res.php poll. `params` carries the
  // provider-specific fields (method + sitekey param name); everything
  // else (auth, json, the polling loop, timeouts) is identical across
  // reCAPTCHA and hCaptcha.
  private async submitAndPoll(
    params: Record<string, string>,
  ): Promise<TwoCaptchaResult> {
    if (!this.isAvailable()) return { kind: "no_key" };
    const apiKey = this.apiKey!;
    const startMs = Date.now();

    // ── 1. Submit ────────────────────────────────────────────────
    const inUrl = new URL(`${TWOCAPTCHA_BASE}/in.php`);
    inUrl.searchParams.set("key", apiKey);
    for (const [k, v] of Object.entries(params)) inUrl.searchParams.set(k, v);
    inUrl.searchParams.set("json", "1");

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
