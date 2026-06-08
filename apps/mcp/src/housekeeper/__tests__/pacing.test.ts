// Inter-run pacing: IP-risk detection, daily cap, adaptive backoff.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunPacer, isIpRiskOutcome, pacingFromEnv } from "../pacing.js";

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), "pacing-")), "signup-pacing.json");
}
const FIXED_NOW = (): number => Date.UTC(2026, 5, 5, 12, 0, 0); // a fixed day

describe("isIpRiskOutcome", () => {
  it("flags the front-door rejections the burn surfaced", () => {
    for (const r of [
      "oauth_loop_detected: signed in twice but bounced to /login",
      "page.goto: net::ERR_CONNECTION_CLOSED at https://api.together.xyz/signin",
      "locator.waitFor: Timeout 20000ms exceeded.",
      "no_signup_link: found no on-domain candidates",
      "Navigation to \"https://dashboard.porter.run/login\" is interrupted",
    ]) {
      expect(isIpRiskOutcome(r)).toBe(true);
    }
  });
  it("does NOT flag clean outcomes / planner misses", () => {
    for (const r of [
      "signed up via bot; extracted 1 credential(s)",
      "no_credentials_after_already_signed_in: dashboard reached, no key",
      "manual_signup_required: clerk SPA won't automate",
    ]) {
      expect(isIpRiskOutcome(r)).toBe(false);
    }
  });
});

describe("pacingFromEnv", () => {
  it("defaults to 60s / cap 88 / backoff 5", () => {
    expect(pacingFromEnv({})).toEqual({ cooldownSec: 60, dailyCap: 88, maxBackoffMult: 5 });
  });
  it("honors env overrides incl. 0 (disabled)", () => {
    const c = pacingFromEnv({
      UNIVERSAL_BOT_RUN_COOLDOWN_SEC: "0",
      UNIVERSAL_BOT_DAILY_SIGNUP_CAP: "10",
      UNIVERSAL_BOT_PACE_MAX_BACKOFF: "2",
    });
    expect(c).toEqual({ cooldownSec: 0, dailyCap: 10, maxBackoffMult: 2 });
  });
});

describe("RunPacer — daily cap", () => {
  it("allows up to the cap then blocks; persists across instances (same day)", () => {
    const statePath = tmpState();
    const p = new RunPacer({ cooldownSec: 0, dailyCap: 2, maxBackoffMult: 5 }, { statePath, now: FIXED_NOW });
    expect(p.capRemaining()).toMatchObject({ allowed: true, used: 0, cap: 2 });
    p.recordRun("ok");
    expect(p.capRemaining()).toMatchObject({ allowed: true, used: 1 });
    p.recordRun("ok");
    // a fresh pacer reads the same state file → cap is durable, not per-process
    const p2 = new RunPacer({ cooldownSec: 0, dailyCap: 2, maxBackoffMult: 5 }, { statePath, now: FIXED_NOW });
    expect(p2.capRemaining()).toMatchObject({ allowed: false, used: 2, cap: 2 });
  });
  it("dailyCap=0 is unlimited", () => {
    const p = new RunPacer({ cooldownSec: 0, dailyCap: 0, maxBackoffMult: 5 }, { statePath: tmpState(), now: FIXED_NOW });
    for (let i = 0; i < 50; i++) p.recordRun("ok");
    expect(p.capRemaining().allowed).toBe(true);
  });
});

describe("RunPacer — adaptive backoff", () => {
  it("grows the cooldown per consecutive IP-risk run, caps it, resets on a clean run", async () => {
    const slept: number[] = [];
    const p = new RunPacer(
      { cooldownSec: 10, dailyCap: 0, maxBackoffMult: 3 },
      { statePath: tmpState(), now: FIXED_NOW, sleep: async (ms) => void slept.push(ms) },
    );
    expect(p.cooldownMs()).toBe(10_000); // base, no risk yet
    p.recordRun("oauth_loop");
    expect(p.cooldownMs()).toBe(20_000); // ×2
    p.recordRun("ERR_CONNECTION_CLOSED");
    expect(p.cooldownMs()).toBe(30_000); // ×3
    p.recordRun("Timeout 20000ms exceeded");
    expect(p.cooldownMs()).toBe(40_000); // ×4 (streak 3, cap 3 → 1+3)
    p.recordRun("oauth_loop");
    expect(p.cooldownMs()).toBe(40_000); // capped — streak 4 but maxBackoff 3
    p.recordRun("signed up via bot; extracted 1 credential");
    expect(p.cooldownMs()).toBe(10_000); // clean run resets the streak
    await p.cooldown();
    expect(slept).toEqual([10_000]);
  });
});
