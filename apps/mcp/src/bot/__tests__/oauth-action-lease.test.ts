import { describe, expect, it } from "vitest";
import { withOAuthActionLease } from "../oauth-login.js";

describe("Google OAuth action serialization", () => {
  it("runs concurrent sign-ins one at a time without refusing either", async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
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
