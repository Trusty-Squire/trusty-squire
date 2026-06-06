// Pre-auth upgrade token: HS256, 15-min TTL, billing-checkout scope.

import { describe, expect, it } from "vitest";
import { mintUpgradeToken, verifyUpgradeToken } from "../auth/upgrade-token.js";

const SECRET = "dev-test-secret-do-not-use-anywhere-else";
const NOW = 1_700_000_000_000;
const FIFTEEN_MIN = 15 * 60 * 1000;

describe("upgrade-token", () => {
  it("round-trips a valid token back to the account id", () => {
    const t = mintUpgradeToken("acct_1", SECRET, NOW);
    expect(verifyUpgradeToken(t, SECRET, NOW)).toBe("acct_1");
    // Still valid just inside the window.
    expect(verifyUpgradeToken(t, SECRET, NOW + FIFTEEN_MIN - 1000)).toBe("acct_1");
  });

  it("rejects an expired token (past the 15-min TTL)", () => {
    const t = mintUpgradeToken("acct_1", SECRET, NOW);
    expect(verifyUpgradeToken(t, SECRET, NOW + FIFTEEN_MIN + 1000)).toBeNull();
  });

  it("rejects a wrong signing secret", () => {
    const t = mintUpgradeToken("acct_1", SECRET, NOW);
    expect(verifyUpgradeToken(t, "other-secret", NOW)).toBeNull();
  });

  it("rejects a tampered payload (re-signs would be needed)", () => {
    const t = mintUpgradeToken("acct_1", SECRET, NOW);
    const [h, , s] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "acct_evil", scope: "billing-checkout", iat: NOW / 1000, exp: NOW / 1000 + 900 }),
    ).toString("base64url");
    expect(verifyUpgradeToken(`${h}.${forged}.${s}`, SECRET, NOW)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyUpgradeToken("not-a-token", SECRET, NOW)).toBeNull();
    expect(verifyUpgradeToken("", SECRET, NOW)).toBeNull();
  });
});
