// pacing.ts — inter-run pacing for the discover (live-signup) loop.
//
// The housekeeper paced BETWEEN batches (--interval-seconds, 12h) but fired
// signups back-to-back WITHIN a batch. A 20-service run then put ~20+ signups
// through one residential exit in an hour and burned its reputation (high-
// scrutiny services started rejecting the session at the OAuth callback). This
// adds three guards to keep a clean exit clean:
//   1. a base cooldown between runs (spreads the activity),
//   2. ADAPTIVE backoff — when a run shows IP-risk symptoms (OAuth-callback
//      rejection, dropped connection, timeout, served-challenge), the cooldown
//      grows so the bot slows down exactly when the IP starts getting flagged,
//   3. a per-IP DAILY signup cap — stop the batch before we torch the exit.
//
// All three are env-tunable; pacing is per-process state for the streak + a
// small JSON file for the daily counter.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PacingConfig {
  cooldownSec: number; // base inter-run cooldown
  dailyCap: number; // max discover signups per day (0 = unlimited)
  maxBackoffMult: number; // cap on the adaptive multiplier
}

export function pacingFromEnv(env: NodeJS.ProcessEnv = process.env): PacingConfig {
  const num = (k: string, d: number): number => {
    const v = Number.parseInt(env[k] ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    cooldownSec: num("UNIVERSAL_BOT_RUN_COOLDOWN_SEC", 60),
    dailyCap: num("UNIVERSAL_BOT_DAILY_SIGNUP_CAP", 30),
    maxBackoffMult: num("UNIVERSAL_BOT_PACE_MAX_BACKOFF", 5),
  };
}

// A front-door rejection that means the residential exit is getting flagged
// (vs a clean planner/extract miss) — these drive the adaptive backoff. Kept
// in sync with the failure shapes the 2026-06-05 burn surfaced.
export function isIpRiskOutcome(reason: string): boolean {
  const r = (reason ?? "").toLowerCase();
  return (
    r.includes("oauth_loop") ||
    r.includes("err_connection_closed") ||
    r.includes("err_connection_reset") ||
    r.includes("econnreset") ||
    r.includes("connection closed") ||
    r.includes("err_timed_out") ||
    /timeout \d+ms exceeded/.test(r) ||
    r.includes("no_signup_link") ||
    (r.includes("navigation") && r.includes("interrupted"))
  );
}

interface PacingState {
  date: string;
  discoverCount: number;
}

export interface PacerDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  statePath?: string;
  log?: (msg: string) => void;
}

const DEFAULT_STATE_PATH = join(homedir(), ".trusty-squire", "signup-pacing.json");

export class RunPacer {
  private riskStreak = 0;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly statePath: string;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly cfg: PacingConfig,
    deps: PacerDeps = {},
  ) {
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowFn = deps.now ?? ((): number => Date.now());
    this.statePath = deps.statePath ?? DEFAULT_STATE_PATH;
    this.log = deps.log ?? ((): void => {});
  }

  private today(): string {
    return new Date(this.nowFn()).toISOString().slice(0, 10);
  }

  private read(): PacingState {
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8")) as PacingState;
      if (s.date === this.today()) return s;
    } catch {
      // fresh / new day
    }
    return { date: this.today(), discoverCount: 0 };
  }

  private write(s: PacingState): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(s));
    } catch {
      // best-effort — pacing must never crash the batch
    }
  }

  // Whether another discover run is within the daily cap.
  capRemaining(): { allowed: boolean; used: number; cap: number } {
    const s = this.read();
    const allowed = this.cfg.dailyCap === 0 || s.discoverCount < this.cfg.dailyCap;
    return { allowed, used: s.discoverCount, cap: this.cfg.dailyCap };
  }

  // Record a finished discover run: bump the daily counter + the risk streak.
  recordRun(reason: string): void {
    const s = this.read();
    this.write({ date: s.date, discoverCount: s.discoverCount + 1 });
    if (isIpRiskOutcome(reason)) {
      this.riskStreak += 1;
      this.log(`[pace] IP-risk signal — backing off (streak ${this.riskStreak})`);
    } else {
      this.riskStreak = 0;
    }
  }

  // Cooldown before the next run: base × (1 + min(streak, maxBackoff)).
  cooldownMs(): number {
    const mult = 1 + Math.min(this.riskStreak, this.cfg.maxBackoffMult);
    return this.cfg.cooldownSec * 1000 * mult;
  }

  async cooldown(): Promise<number> {
    const ms = this.cooldownMs();
    if (ms > 0) {
      this.log(`[pace] cooldown ${Math.round(ms / 1000)}s before next run`);
      await this.sleepFn(ms);
    }
    return ms;
  }
}
