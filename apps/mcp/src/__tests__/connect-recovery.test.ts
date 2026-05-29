// Onboarding recovery fixes:
//  #1 — `connect` must not short-circuit on a present-but-EXPIRED agent
//       token (agent sessions have a 24h absolute cap). agentTokenStillValid
//       probes the server; only an auth rejection counts as invalid.
//  #3 — the confirm browser / headless noVNC tunnel must tear down when
//       an already-provisioned account redirects to /vault, not only on
//       the explicit /install/done. isClaimTerminalUrl encodes that.

import { describe, expect, it } from "vitest";
import { agentTokenStillValid, isClaimTerminalUrl } from "../install/cli.js";

function fakeFetch(status: number): typeof fetch {
  return (async () => new Response(null, { status })) as unknown as typeof fetch;
}

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
