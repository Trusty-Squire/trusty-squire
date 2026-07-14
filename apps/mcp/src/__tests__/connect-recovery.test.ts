// Onboarding recovery fixes:
//  #1 — `connect` must not short-circuit on a present-but-EXPIRED agent
//       token (agent sessions have a 24h absolute cap). agentTokenStillValid
//       probes the server; only an auth rejection counts as invalid.
//  #3 — the confirm browser / headless noVNC tunnel must tear down when
//       an already-provisioned account redirects to /vault, not only on
//       the explicit /install/done. isClaimTerminalUrl encodes that.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentTokenStillValid,
  claimHeartbeatMessage,
  decideProvisioned,
  isClaimTerminalUrl,
  shouldCompleteInstallClaim,
} from "../install/cli.js";
import type { SessionData } from "../session.js";

function fakeFetch(status: number): typeof fetch {
  return (async () => new Response(null, { status })) as unknown as typeof fetch;
}

const fullSession: SessionData = {
  api_base_url: "https://api.test",
  saved_at: "2026-05-30T00:00:00.000Z",
  machine_token: "mt",
  agent_session_token: "st",
  account_id: "acc_1",
};

describe("agentTokenStillValid (fix #1: expired-token detection)", () => {
  it("returns true on 200 (token live)", async () => {
    expect(await agentTokenStillValid("https://api.test", "tok", fakeFetch(200))).toBe(true);
  });

  it("returns false on 401 (expired/revoked → must re-pair, not short-circuit)", async () => {
    expect(await agentTokenStillValid("https://api.test", "tok", fakeFetch(401))).toBe(false);
  });

  it("returns false on 403", async () => {
    expect(await agentTokenStillValid("https://api.test", "tok", fakeFetch(403))).toBe(false);
  });

  it("treats a non-auth status (500) as 'probably fine' (don't force re-login on a server blip)", async () => {
    expect(await agentTokenStillValid("https://api.test", "tok", fakeFetch(500))).toBe(true);
  });

  it("treats a network error as 'probably fine'", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await agentTokenStillValid("https://api.test", "tok", throwingFetch)).toBe(true);
  });

  it("calls the agent-authed endpoint with the bearer token", async () => {
    let seen: { url?: string; auth?: string | undefined } = {};
    const spyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: typeof url === "string" ? url : url.toString(),
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await agentTokenStillValid("https://api.test", "mcp_session_abc", spyFetch);
    expect(seen.url).toBe("https://api.test/v1/vault/credentials");
    expect(seen.auth).toBe("Bearer mcp_session_abc");
  });
});

describe("decideProvisioned (fast-path gate: write config without a re-claim)", () => {
  it("is NOT connected when the account token is valid but the bot has no Google session", () => {
    // Connect identity: account-bound plumbing alone is hollow. The bot must
    // hold the user's Google session before connect can skip the browser flow.
    expect(decideProvisioned(fullSession, true, [])).toBeNull();
  });

  it("is NOT connected with only optional GitHub; Google is the primary identity", () => {
    expect(decideProvisioned(fullSession, true, ["github"])).toBeNull();
  });

  it("connected and carries the confirmed providers when Google is present", () => {
    expect(decideProvisioned(fullSession, true, ["google"])).toEqual({
      providers: ["google"],
    });
    expect(decideProvisioned(fullSession, true, ["google", "github"])).toEqual({
      providers: ["google", "github"],
    });
  });

  it("NOT provisioned when the agent token failed to validate (→ re-pair)", () => {
    expect(decideProvisioned(fullSession, false, ["google"])).toBeNull();
  });

  it("NOT provisioned when the session is null or missing a required field", () => {
    expect(decideProvisioned(null, true, ["google"])).toBeNull();
    const noAgentToken = { ...fullSession };
    delete noAgentToken.agent_session_token;
    expect(decideProvisioned(noAgentToken as SessionData, true, [])).toBeNull();
    const noAccount = { ...fullSession };
    delete noAccount.account_id;
    expect(decideProvisioned(noAccount as SessionData, true, [])).toBeNull();
  });
});

describe("isClaimTerminalUrl (fix #3: noVNC teardown)", () => {
  it("matches the explicit Finish target", () => {
    expect(isClaimTerminalUrl("https://trustysquire.ai/install/done")).toBe(true);
    expect(isClaimTerminalUrl("https://trustysquire.ai/install/done?x=1")).toBe(true);
  });

  it("matches /vault — the redirect an already-provisioned account lands on", () => {
    expect(isClaimTerminalUrl("https://trustysquire.ai/vault")).toBe(true);
    expect(isClaimTerminalUrl("https://trustysquire.ai/vault/approvals")).toBe(true);
    expect(isClaimTerminalUrl("https://trustysquire.ai/agents")).toBe(true);
  });

  it("does NOT match the confirm/login pages still mid-flow", () => {
    expect(isClaimTerminalUrl("https://trustysquire.ai/install?token=abc")).toBe(false);
    expect(isClaimTerminalUrl("https://trustysquire.ai/login?next=/vault")).toBe(false);
    expect(isClaimTerminalUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
  });
});

describe("shouldCompleteInstallClaim (force-relogin teardown)", () => {
  it("completes force-relogin as soon as the account claim succeeds", () => {
    expect(
      shouldCompleteInstallClaim(
        true,
        true,
        "https://trustysquire.ai/install?token=abc",
      ),
    ).toBe(true);
  });

  it("keeps first-time onboarding open for the explicit Finish step", () => {
    expect(
      shouldCompleteInstallClaim(
        true,
        false,
        "https://trustysquire.ai/install?token=abc",
      ),
    ).toBe(false);
  });

  it("keeps first-time onboarding open until its primary page is available", () => {
    expect(shouldCompleteInstallClaim(true, false, undefined)).toBe(false);
  });

  it("completes first-time onboarding after Finish reaches a terminal page", () => {
    expect(
      shouldCompleteInstallClaim(
        true,
        false,
        "https://trustysquire.ai/install/done",
      ),
    ).toBe(true);
  });

  it("never completes before the account claim succeeds", () => {
    expect(
      shouldCompleteInstallClaim(
        false,
        true,
        "https://trustysquire.ai/install/done",
      ),
    ).toBe(false);
  });

  it("is wired to the parsed --force-relogin flag in connect", () => {
    const cliSource = readFileSync(
      fileURLToPath(new URL("../install/cli.ts", import.meta.url)),
      "utf8",
    );
    expect(cliSource).toMatch(/completeOnClaim:\s*args\.forceRelogin/);
    expect(cliSource).toMatch(/context\.pages\(\)\[0\]\?\.url\(\)/);
  });
});

describe("claimHeartbeatMessage (claimed install awaiting Finish)", () => {
  it("asks for sign-in only before the install is claimed", () => {
    expect(claimHeartbeatMessage(false)).toMatch(/finish signing in/i);
  });

  it("asks for the Finish click after sign-in has claimed the install", () => {
    const message = claimHeartbeatMessage(true);
    expect(message).toMatch(/sign-in complete/i);
    expect(message).toMatch(/click Finish/i);
    expect(message).not.toMatch(/waiting.*signing in/i);
  });
});
