// Round-12 review-2: connect's re-enroll mints a fresh agent_session_token,
// and a resident broker still holding the previous digest would otherwise
// send every presented credential into the stale-credential reclaim path —
// which refuses while any lane's client is still attached, wedging the
// re-enroll behind its own resident. The daemon's handshake hook now adopts
// the credential IN PLACE — no maintenance window, no drain — but only when
// the presented token matches the daemon's own bound account entry, byte for
// byte, in the same account. Everything else stays strictly refused.

import { describe, expect, it } from "vitest";
import { authenticateOrAdoptCurrentCredential } from "../broker/daemon.js";
import { OperatorBroker } from "../broker/operator.js";

const account = {
  accountId: "acct-1",
  agentSessionToken: "stale-token",
  apiBaseUrl: "http://unused.test",
  registryBaseUrl: "http://unused.test",
};

function broker(token = "stale-token"): OperatorBroker {
  // A FRESH config object per broker: refreshCredentials assigns
  // `this.config.agentSessionToken`, and a shared object would leak the
  // adopted token into every later test's digest.
  return new OperatorBroker({ ...account, agentSessionToken: token });
}

describe("authenticateOrAdoptCurrentCredential (daemon handshake credential adoption)", () => {
  it("a matching bound entry is adopted in place and the presented token authenticates", async () => {
    const b = broker();
    const stored = { account_id: "acct-1", agent_session_token: "fresh-token" };
    // The presented token fails the OLD digest...
    expect(await b.authenticate("fresh-token")).toBeNull();
    // ...but the hook re-reads the daemon's own account entry, sees the same
    // token string, refreshes in place, and retries.
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      "acct-1",
      async () => stored,
      "fresh-token",
    );
    expect(principal).toEqual({ accountId: "acct-1", agentId: expect.any(String) });
    // The refresh was REAL: the presented token now authenticates directly,
    // and the stale one is dead.
    expect(await b.authenticate("fresh-token")).not.toBeNull();
    expect(await b.authenticate("stale-token")).toBeNull();
  });

  it("a token the store has never seen stays refused — and nothing is refreshed", async () => {
    const b = broker();
    const stored = { account_id: "acct-1", agent_session_token: "fresh-token" };
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      "acct-1",
      async () => stored,
      "stray-token",
    );
    expect(principal).toBeNull();
    // The store's credential was never adopted: the stale digest still rules.
    expect(await b.authenticate("stale-token")).not.toBeNull();
    expect(await b.authenticate("fresh-token")).toBeNull();
  });

  it("an entry for a different account is ignored", async () => {
    const b = broker();
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      "acct-1",
      async () => ({ account_id: "acct-2", agent_session_token: "other-token" }),
      "other-token",
    );
    expect(principal).toBeNull();
    expect(await b.authenticate("other-token")).toBeNull();
  });

  it("a daemon with no bound account never reads the store", async () => {
    const b = broker();
    let reads = 0;
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      null,
      async () => {
        reads += 1;
        return { account_id: "acct-1", agent_session_token: "fresh-token" };
      },
      "fresh-token",
    );
    expect(principal).toBeNull();
    expect(reads).toBe(0);
  });

  it("a refused refresh (or a failed store read) is swallowed into the strict refusal", async () => {
    // refreshCredentials throws for live sessions (maintenance) or account
    // drift; a store read can also fail outright. Either way the hook must
    // keep the honest refusal — the stale-credential reclaim path reports it.
    const b = broker();
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      "acct-1",
      async () => {
        throw new Error("store unavailable");
      },
      "fresh-token",
    );
    expect(principal).toBeNull();
    expect(await b.authenticate("fresh-token")).toBeNull();
  });

  it("a live credential still authenticates without touching the store", async () => {
    const b = broker();
    let reads = 0;
    const principal = await authenticateOrAdoptCurrentCredential(
      b,
      "acct-1",
      async () => {
        reads += 1;
        return null;
      },
      "stale-token",
    );
    expect(principal).toEqual({ accountId: "acct-1", agentId: expect.any(String) });
    expect(reads).toBe(0);
  });
});
