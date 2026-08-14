// Onboarding recovery fixes:
//  #1 — `connect` must not short-circuit on a present-but-EXPIRED agent
//       token (agent sessions have a 24h absolute cap). agentTokenStillValid
//       probes the server; only an auth rejection counts as invalid.
//  #3 — the confirm browser / headless noVNC tunnel must stay open until
//       explicit Finish during normal onboarding.

import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTokenStillValid,
  claimHeartbeatMessage,
  connectCompletionOptions,
  decideProvisioned,
  parseArgs,
  shouldCompleteInstallClaim,
  withConnectProfileGuard,
} from "../install/cli.js";
import { clearBrowserProfile } from "../bot/login-state.js";
import { withProfileOperationGuard } from "../bot/profile.js";
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

describe("shouldCompleteInstallClaim (force-relogin teardown)", () => {
  it("keeps one canonical guard while a symlinked profile is reset", async () => {
    const base = mkdtempSync(join(tmpdir(), "ts-connect-profile-"));
    const target = join(base, "profile");
    const alias = join(base, "profile-alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    try {
      await withConnectProfileGuard(alias, async (canonicalProfileDir) => {
        expect(canonicalProfileDir).toBe(target);
        clearBrowserProfile(canonicalProfileDir);
        await withProfileOperationGuard(canonicalProfileDir, async () => undefined);
      });
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("completes force-relogin once the provider session has seeded", () => {
    expect(
      shouldCompleteInstallClaim(
        true, // claimed
        true, // completeOnClaim (force-relogin)
        true, // sessionSeeded
      ),
    ).toBe(true);
  });

  it("does NOT tear down force-relogin on a bare claim before the session seeds", () => {
    // The bug: the API flips to `claimed` when the OAuth identity lands, which on
    // a cold profile is BEFORE Google finishes (its second challenge). Tearing
    // down here killed the noVNC mid-sign-in. Must stay open.
    expect(
      shouldCompleteInstallClaim(
        true, // claimed
        true, // completeOnClaim
        false, // sessionSeeded — sign-in still in flight
      ),
    ).toBe(false);
  });

  it("does not let Finish override the requested provider seed", () => {
    expect(
      shouldCompleteInstallClaim(
        true,
        true,
        false, // not seeded…
        true, // …and Finish cannot substitute for it
      ),
    ).toBe(false);
    expect(shouldCompleteInstallClaim(true, true, false, true)).toBe(false);
  });

  it("keeps first-time onboarding open for the explicit Finish step", () => {
    expect(shouldCompleteInstallClaim(true, false, false)).toBe(false);
  });

  it("completes first-time onboarding only after explicit Finish", () => {
    expect(shouldCompleteInstallClaim(true, false, false, true)).toBe(true);
  });

  it("keeps plain onboarding open through optional GitHub until explicit Finish", () => {
    // Step 1: Google claimed the install and seeded its provider cookie. This
    // used to close noVNC before the user could complete optional GitHub.
    expect(shouldCompleteInstallClaim(true, false, true, false)).toBe(false);
    // Step 2: another provider cookie landing still is not wizard completion.
    expect(shouldCompleteInstallClaim(true, false, true, false)).toBe(false);
    // Only the per-run loopback signal fired by Finish is terminal.
    expect(shouldCompleteInstallClaim(true, false, true, true)).toBe(true);
  });

  it("does not substitute provider cookies when callback storage is unavailable", () => {
    expect(shouldCompleteInstallClaim(true, false, true, false)).toBe(false);
  });

  it("does not accept an explicit Finish signal before the account claim", () => {
    expect(shouldCompleteInstallClaim(false, false, true, true)).toBe(false);
    expect(shouldCompleteInstallClaim(true, false, false)).toBe(false);
  });

  it("never completes before the account claim succeeds", () => {
    expect(shouldCompleteInstallClaim(false, true, true, true)).toBe(false);
  });

  it("maps parsed force-relogin flags to connect completion behavior", () => {
    expect(connectCompletionOptions(parseArgs(["connect"]))).toEqual({
      completeOnClaim: false,
      completionProvider: "google",
    });
    expect(connectCompletionOptions(parseArgs(["connect", "--force-relogin"]))).toEqual({
      completeOnClaim: true,
      completionProvider: "google",
    });
    expect(connectCompletionOptions(parseArgs(["connect", "--force-relogin=github"]))).toEqual({
      completeOnClaim: true,
      completionProvider: "github",
    });
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
