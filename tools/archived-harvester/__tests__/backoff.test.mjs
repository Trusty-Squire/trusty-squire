import { describe, it, expect } from "vitest";
import {
  recordAttempt,
  isEligibleByBackoff,
  summarizeBackoffState,
} from "../backoff.mjs";

const HOUR = 3600 * 1000;
const T0 = Date.parse("2026-05-24T12:00:00Z");

describe("recordAttempt", () => {
  it("creates a fresh entry on first attempt with replay-ok outcome", () => {
    const state = recordAttempt({}, "ipinfo", "replay-ok", T0);
    expect(state.ipinfo.consecutive_failures).toBe(0);
    expect(state.ipinfo.last_attempt_at).toBe("2026-05-24T12:00:00.000Z");
    expect(state.ipinfo.last_success_at).toBe("2026-05-24T12:00:00.000Z");
    expect(state.ipinfo.backoff_until).toBeNull();
  });

  it("increments consecutive_failures on non-replay-ok outcome", () => {
    let s = recordAttempt({}, "railway", "failed", T0);
    s = recordAttempt(s, "railway", "failed", T0 + HOUR);
    expect(s.railway.consecutive_failures).toBe(2);
    expect(s.railway.backoff_until).toBeNull();
  });

  it("triggers backoff after 3 consecutive failures (BACKOFF_THRESHOLD)", () => {
    let s = recordAttempt({}, "railway", "failed", T0);
    s = recordAttempt(s, "railway", "failed", T0 + HOUR);
    s = recordAttempt(s, "railway", "failed", T0 + 2 * HOUR);
    expect(s.railway.consecutive_failures).toBe(3);
    expect(s.railway.backoff_until).not.toBeNull();
    // BACKOFF_EXTRA_HOURS = 24
    const backoffMs = Date.parse(s.railway.backoff_until);
    expect(backoffMs).toBeGreaterThan(T0 + 2 * HOUR + 23 * HOUR);
    expect(backoffMs).toBeLessThan(T0 + 2 * HOUR + 25 * HOUR);
  });

  it("resets the counter and lifts backoff on success after failures", () => {
    let s = recordAttempt({}, "railway", "failed", T0);
    s = recordAttempt(s, "railway", "failed", T0 + HOUR);
    s = recordAttempt(s, "railway", "failed", T0 + 2 * HOUR);
    expect(s.railway.backoff_until).not.toBeNull();

    s = recordAttempt(s, "railway", "replay-ok", T0 + 30 * HOUR);
    expect(s.railway.consecutive_failures).toBe(0);
    expect(s.railway.backoff_until).toBeNull();
    expect(s.railway.last_success_at).toBe(new Date(T0 + 30 * HOUR).toISOString());
  });

  it("preserves last_success_at across subsequent failures", () => {
    let s = recordAttempt({}, "openai", "replay-ok", T0);
    const successTs = s.openai.last_success_at;
    s = recordAttempt(s, "openai", "failed", T0 + 30 * HOUR);
    expect(s.openai.last_success_at).toBe(successTs);
  });

  it("does not mutate prior state object (immutable update)", () => {
    const initial = { ipinfo: { consecutive_failures: 0, last_attempt_at: null, last_success_at: null, backoff_until: null } };
    const snapshot = JSON.stringify(initial);
    recordAttempt(initial, "ipinfo", "failed", T0);
    expect(JSON.stringify(initial)).toBe(snapshot);
  });
});

describe("isEligibleByBackoff", () => {
  it("eligible when state has no entry for the slug", () => {
    expect(isEligibleByBackoff({}, "newsvc", T0).eligible).toBe(true);
  });

  it("eligible when last_attempt_at is null", () => {
    const state = { x: { consecutive_failures: 0, last_attempt_at: null, last_success_at: null, backoff_until: null } };
    expect(isEligibleByBackoff(state, "x", T0).eligible).toBe(true);
  });

  it("NOT eligible during 24h cooldown after recent attempt", () => {
    const state = recordAttempt({}, "ipinfo", "failed", T0);
    // 12h later — still in cooldown
    const verdict = isEligibleByBackoff(state, "ipinfo", T0 + 12 * HOUR);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/cooldown/);
  });

  it("eligible exactly 24h after last_attempt_at", () => {
    const state = recordAttempt({}, "ipinfo", "failed", T0);
    const verdict = isEligibleByBackoff(state, "ipinfo", T0 + 24 * HOUR);
    expect(verdict.eligible).toBe(true);
  });

  it("NOT eligible while backoff_until is in the future, even after cooldown", () => {
    // 3 failures → backoff_until = +24h after the 3rd
    let s = recordAttempt({}, "railway", "failed", T0);
    s = recordAttempt(s, "railway", "failed", T0 + HOUR);
    s = recordAttempt(s, "railway", "failed", T0 + 2 * HOUR);
    // 12h after last attempt — still inside both cooldown AND backoff
    const verdict = isEligibleByBackoff(s, "railway", T0 + 2 * HOUR + 12 * HOUR);
    expect(verdict.eligible).toBe(false);
    // Could be either "cooldown" or "backoff" message; both block. The
    // backoff check runs first in the implementation, so when backoff
    // is active the reason should mention backoff.
    expect(verdict.reason).toMatch(/backoff/);
  });

  it("eligible after backoff_until has passed", () => {
    let s = recordAttempt({}, "railway", "failed", T0);
    s = recordAttempt(s, "railway", "failed", T0 + HOUR);
    s = recordAttempt(s, "railway", "failed", T0 + 2 * HOUR);
    // 48h after the 3rd failure — backoff window has fully elapsed
    const verdict = isEligibleByBackoff(s, "railway", T0 + 2 * HOUR + 48 * HOUR);
    expect(verdict.eligible).toBe(true);
  });
});

describe("summarizeBackoffState", () => {
  it("sorts by last_attempt_at desc", () => {
    let s = recordAttempt({}, "alpha", "failed", T0);
    s = recordAttempt(s, "beta", "failed", T0 + 5 * HOUR);
    s = recordAttempt(s, "gamma", "failed", T0 + 2 * HOUR);
    const summary = summarizeBackoffState(s);
    expect(summary.map((e) => e.slug)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("handles empty state", () => {
    expect(summarizeBackoffState({})).toEqual([]);
  });
});
