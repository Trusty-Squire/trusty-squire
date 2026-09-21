import { describe, expect, it } from "vitest";
import {
  LOGIN_RIG_LIFETIME_GRACE_MS,
  LOGIN_RIG_OWNED_LIFETIME_MS,
  PAIRING_TOKEN_TTL_MS,
  loginRigOwnedLifetimeMs,
} from "../pairing-ttl.js";

describe("login rig owned lifetime", () => {
  it("is the pairing-token window plus a one-minute backstop margin", () => {
    expect(PAIRING_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    expect(LOGIN_RIG_LIFETIME_GRACE_MS).toBe(60 * 1000);
    expect(LOGIN_RIG_OWNED_LIFETIME_MS).toBe(PAIRING_TOKEN_TTL_MS + LOGIN_RIG_LIFETIME_GRACE_MS);
    expect(loginRigOwnedLifetimeMs({})).toBe(LOGIN_RIG_OWNED_LIFETIME_MS);
  });

  it("accepts a positive override for tests and refuses everything else", () => {
    expect(loginRigOwnedLifetimeMs({ TRUSTY_SQUIRE_LOGIN_RIG_LIFETIME_MS: "250" })).toBe(250);
    expect(loginRigOwnedLifetimeMs({ TRUSTY_SQUIRE_LOGIN_RIG_LIFETIME_MS: "0" })).toBe(
      LOGIN_RIG_OWNED_LIFETIME_MS,
    );
    expect(loginRigOwnedLifetimeMs({ TRUSTY_SQUIRE_LOGIN_RIG_LIFETIME_MS: "-1" })).toBe(
      LOGIN_RIG_OWNED_LIFETIME_MS,
    );
    expect(loginRigOwnedLifetimeMs({ TRUSTY_SQUIRE_LOGIN_RIG_LIFETIME_MS: "nope" })).toBe(
      LOGIN_RIG_OWNED_LIFETIME_MS,
    );
  });
});
