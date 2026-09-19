// `connect` is the ONE onboarding + re-auth pathway.
//
// Two defects are pinned here:
//  1. Nothing may hand a user (or a host agent) the removed `login` command —
//     not the CLI dispatcher, not a help line, not a runtime remedy string.
//  2. connect must not report success on the machine claim alone. The claim
//     proves the account plumbing; only the post-ceremony LIVE provider probe
//     proves the bot can wear the user's identity at a third-party site.

import { describe, expect, it, vi } from "vitest";
import {
  connectIncompleteMessage,
  decideConnectPreflight,
  decideConnectComplete,
  preflightUnverifiedMessage,
  providersConnectMustAwait,
  runCli,
  type ConnectIncompleteReason,
} from "../cli.js";
import type { SessionData } from "../../session.js";
import { openSessionStorage } from "../../session.js";

const boundSession: SessionData = {
  api_base_url: "https://api.example.test",
  saved_at: "2026-09-04T00:00:00.000Z",
  machine_token: "machine",
  agent_session_token: "agent",
  account_id: "account",
};

describe("the login subcommand is gone", () => {
  it("refuses to run it and names connect instead", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(runCli(["login", "--provider=google"])).rejects.toThrow("exit:64");
      const message = String(error.mock.calls.at(-1)?.[0] ?? "");
      expect(message).toContain("`login` has been removed");
      expect(message).toContain("connect");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe("logout", () => {
  it("does not report clearing an account that is not installed", async () => {
    const storage = await openSessionStorage();
    await storage.write(boundSession);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runCli(["logout", "--account=not-installed"]);
      expect(warn).toHaveBeenCalledWith("✓ No local session to clear.");
      expect(await storage.read("account")).toMatchObject({ agent_session_token: "agent" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("decideConnectPreflight", () => {
  it("refreshes config without a connected claim when the live probe fails", () => {
    expect(decideConnectPreflight(boundSession, true, null)).toEqual({ kind: "unverified" });
    const message = preflightUnverifiedMessage("profile is in use");
    expect(message).toContain("profile is in use");
    expect(message).toContain("config was refreshed");
    expect(message).not.toContain("Already connected");
  });

  it("re-pairs an expired agent token even when the live probe failed", () => {
    expect(decideConnectPreflight(boundSession, false, null)).toEqual({ kind: "ceremony" });
  });
});

// The probe's wait list and the gate's demand list are the same contract seen
// from two sides. When they drifted, a run whose Google sign-in had just
// succeeded was rejected `no_google_session`: the probe stopped at the first
// non-empty read — GitHub cookies already on disk from an earlier run — while
// Google's were still inside Chrome's commit window.
describe("providersConnectMustAwait matches what the success gate demands", () => {
  const cases: Array<undefined | "google" | "github"> = [undefined, "google", "github"];

  it("waits for exactly the providers that would satisfy the gate", () => {
    for (const requested of cases) {
      const awaited = providersConnectMustAwait(requested);
      expect(decideConnectComplete(awaited, requested), `requested=${requested}`).toEqual({
        ok: true,
      });
    }
  });

  it("always waits for Google, whatever was explicitly requested", () => {
    for (const requested of cases) {
      expect(providersConnectMustAwait(requested), `requested=${requested}`).toContain("google");
    }
  });

  it("never lets a stale GitHub cookie answer for a Google sign-in still committing", () => {
    // What the probe would see on its first read in the reported state.
    expect(decideConnectComplete(["github"])).toEqual({
      ok: false,
      reason: "no_google_session",
    });
    // So "github" alone must never be the whole wait list.
    for (const requested of cases) {
      expect(providersConnectMustAwait(requested), `requested=${requested}`).not.toEqual([
        "github",
      ]);
    }
  });
});

describe("decideConnectComplete (connect's success gate)", () => {
  it("passes only with a live Google session", () => {
    expect(decideConnectComplete(["google"])).toEqual({ ok: true });
    expect(decideConnectComplete(["google", "github"])).toEqual({ ok: true });
  });

  it("fails when the ceremony left no live Google session", () => {
    expect(decideConnectComplete([])).toEqual({ ok: false, reason: "no_google_session" });
    expect(decideConnectComplete(["github"])).toEqual({
      ok: false,
      reason: "no_google_session",
    });
  });

  it("fails closed when the live probe itself failed", () => {
    // Unverifiable is not verified: reporting success here is exactly how an
    // install ended up "connected" with no session behind it.
    expect(decideConnectComplete(null)).toEqual({ ok: false, reason: "probe_failed" });
  });

  it("fails when a scoped --force-relogin provider didn't land", () => {
    expect(decideConnectComplete(["google"], "github")).toEqual({
      ok: false,
      reason: "requested_provider_missing",
    });
    expect(decideConnectComplete(["google", "github"], "github")).toEqual({ ok: true });
  });
});

describe("connectIncompleteMessage", () => {
  const reasons: ConnectIncompleteReason[] = [
    "probe_failed",
    "no_google_session",
    "requested_provider_missing",
  ];

  it("always routes the fix back through connect, never the removed command", () => {
    for (const reason of reasons) {
      for (const skipBrowser of [false, true]) {
        const message = connectIncompleteMessage(reason, skipBrowser);
        expect(message).toContain("connect --force-relogin");
        expect(message).not.toContain("mcp login");
      }
    }
  });

  it("explains why --skip-browser can't establish the session", () => {
    expect(connectIncompleteMessage("no_google_session", true)).toContain("--skip-browser");
    expect(connectIncompleteMessage("no_google_session", false)).not.toContain("--skip-browser");
  });
});
