import { describe, expect, it } from "vitest";
import {
  OAuthAwaitingHumanError,
  oauthActionDeadline,
  oauthHumanHandoffTimeoutMs,
  resetOAuthActionDeadline,
  withinOAuthActionDeadline,
  withOAuthActionLease,
} from "../oauth-login.js";

describe("Google OAuth action serialization", () => {
  it("runs concurrent sign-ins one at a time without refusing either", async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withOAuthActionLease(undefined, async () => {
      active++;
      peak = Math.max(peak, active);
      await firstBlocked;
      active--;
      return "first";
    });
    const second = withOAuthActionLease(undefined, async () => {
      active++;
      peak = Math.max(peak, active);
      active--;
      return "second";
    });
    await Promise.resolve();
    expect(active).toBe(1);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(peak).toBe(1);
  });
});

describe("OAuth action deadline under a caller budget", () => {
  // Kenari, 1.1.54: a max_seconds 45 drive dispatched Google OAuth, reached the
  // consent page, and the human-handoff re-arm let the call run past 60 s.
  it("never re-arms past the caller's remaining budget", async () => {
    const started = Date.now();
    const deadline = oauthActionDeadline("google", 80);
    expect(deadline.expiresAt).toBeLessThanOrEqual(started + 80 + 5);
    const pending = withinOAuthActionDeadline(new Promise<never>(() => {}), deadline);
    resetOAuthActionDeadline(deadline, oauthHumanHandoffTimeoutMs());
    expect(deadline.expiresAt).toBe(deadline.capAt);
    await expect(pending).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps the provider's own windows when the caller has no budget", () => {
    const deadline = oauthActionDeadline("google");
    expect(deadline.capAt).toBeUndefined();
    resetOAuthActionDeadline(deadline, oauthHumanHandoffTimeoutMs());
    expect(deadline.expiresAt - Date.now()).toBeGreaterThan(60_000);
  });
});
