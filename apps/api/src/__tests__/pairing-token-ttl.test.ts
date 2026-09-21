// The pairing token's lifetime is a CONTRACT with the MCP CLI, not a private
// tuning knob. `connect` counts the ceremony wait as a local duration —
// `PAIRING_TOKEN_TTL_MS` in apps/mcp/src/pairing-ttl.ts — because differencing
// this server's `expires_at` against the caller's clock made the window a
// function of clock skew.
//
// The mirror is therefore load-bearing in both directions. Raise this TTL and
// connect stops waiting while the link is still live, then reports the run as
// `install_expired` with no sign-in URL; lower it and connect waits past a dead
// link and hands that link back. Neither side raises an error on its own, so
// this test is the alarm: change the TTL here and the MCP constant (plus its
// deadline test in apps/mcp/src/__tests__/install-targets-e2e.test.ts) has to
// move with it.

import { describe, expect, it } from "vitest";
import { issuePairingToken } from "../auth/pairing-token.js";

const MCP_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

describe("pairing token lifetime", () => {
  it("mints exactly the window the MCP connect ceremony waits for", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const record = issuePairingToken(now);

    expect(record.created_at.getTime()).toBe(now.getTime());
    expect(record.expires_at.getTime() - record.created_at.getTime()).toBe(
      MCP_PAIRING_TOKEN_TTL_MS,
    );
  });
});
