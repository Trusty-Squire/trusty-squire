// A live box surfaced 33 accumulated `mcp server` processes, some holding
// live operator Chromes — the disconnect-triggered shutdown in server.ts
// (transport.onclose / stdin EOF / SIGTERM, covered by bin-smoke.test.ts)
// never fired because the host abandoned the child without closing its
// stdio or signaling it. shouldIdleExit is the pure decision function behind
// the time-bound backstop for that case.
//
// An open provision session owns its own Chrome and profile. A session left
// open by an abandoned server can only be freed by that server itself exiting.
// shouldIdleExit therefore
// uses a longer bound when a session is open rather than never exiting, but
// still applies real teardown (closeAllProvisionSessions, which kills the
// leased Chrome) once that longer bound is crossed.

import { describe, expect, it } from "vitest";
import { shouldReapOwner } from "../bot/owner-process-reaper.js";
import { shouldReapIdleProvisionSession } from "../bot/provision-session.js";
import { shouldIdleExit } from "../server.js";

describe("shouldIdleExit", () => {
  const timeoutMs = 1_000;
  const timeoutWithSessionMs = 5_000;

  it("stays false while activity is within the no-session timeout", () => {
    expect(shouldIdleExit(1_500, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true once idle time reaches the no-session timeout", () => {
    expect(shouldIdleExit(2_000, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("stays false with an open session before the (longer) session timeout", () => {
    expect(shouldIdleExit(3_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true with an open session once the longer timeout is crossed", () => {
    expect(shouldIdleExit(6_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("re-arms after fresh activity moves lastActivityAt forward", () => {
    expect(shouldIdleExit(2_000, 1_900, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });
});

describe("idle provision-session reap decision", () => {
  it("reaps only a terminally idle action boundary", () => {
    expect(shouldReapIdleProvisionSession(5_000, 1_000, 0, false, false, 4_000)).toBe(true);
  });

  it("never crosses an in-flight action boundary", () => {
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 1, false, false, 4_000)).toBe(false);
  });

  it("never reaps an initializing or already-closing session", () => {
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 0, true, false, 4_000)).toBe(false);
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 0, false, true, 4_000)).toBe(false);
  });

  it("re-arms from the most recent completed activity", () => {
    expect(shouldReapIdleProvisionSession(5_000, 4_900, 0, false, false, 4_000)).toBe(false);
  });
});

describe("owner reap decision", () => {
  it("reaps only a birth-verified stale owner", () => {
    expect(shouldReapOwner("stale")).toBe(true);
    expect(shouldReapOwner("matching")).toBe(false);
    expect(shouldReapOwner("unknown")).toBe(false);
  });
});
