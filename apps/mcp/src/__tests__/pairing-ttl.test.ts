import { describe, expect, it } from "vitest";
import {
  LOGIN_RIG_LIFETIME_GRACE_MS,
  LOGIN_RIG_OWNED_LIFETIME_MS,
  PAIRING_TOKEN_TTL_MS,
} from "../pairing-ttl.js";

describe("login rig owned lifetime", () => {
  it("is the pairing-token window plus a one-minute backstop margin", () => {
    expect(PAIRING_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    expect(LOGIN_RIG_LIFETIME_GRACE_MS).toBe(60 * 1000);
    expect(LOGIN_RIG_OWNED_LIFETIME_MS).toBe(PAIRING_TOKEN_TTL_MS + LOGIN_RIG_LIFETIME_GRACE_MS);
  });
});
