// One session file, one entry per account.
//
// Measured on a live box: `account_id` moved from 01KS0BKRYTVE9T9FAQQ31A4MK3 to
// 01M1N0CBVSCX7GGR94S0JYQW1G when the operator connected under a SECOND Trusty
// Squire account. The flat file meant the second connect overwrote the first
// account's binding, so servers still serving the first read the second's scope
// — a real credential_not_found for a credential that exists in the FIRST
// account's vault.
//
// Keyed by account, connecting a second account destroys nothing, and each
// server reads only the account it was launched for.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSessionMissingError,
  parseSessionAccounts,
  SessionStore,
  UNBOUND_ACCOUNT_KEY,
} from "../session.js";
import { createSessionGuard } from "../session-guard.js";

const ACCOUNT_A = "01KS0BKRYTVE9T9FAQQ31A4MK3";
const ACCOUNT_B = "01M1N0CBVSCX7GGR94S0JYQW1G";

let dir: string;
let tmpFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-accounts-"));
  tmpFile = path.join(dir, "session.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function entry(accountId: string, token: string) {
  return {
    api_base_url: "http://api",
    saved_at: "2026-09-04T00:00:00.000Z",
    account_id: accountId,
    agent_session_token: token,
    machine_token: `machine_${token}`,
  };
}

async function onDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(tmpFile, "utf8")) as Record<string, unknown>;
}

describe("SessionStore", () => {
  it("a connect under a second account never destroys the first", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));

    expect(await store.read(ACCOUNT_A)).toMatchObject({ agent_session_token: "tok_a" });
    expect(await store.read(ACCOUNT_B)).toMatchObject({ agent_session_token: "tok_b" });
    expect(await store.listAccounts()).toEqual([ACCOUNT_A, ACCOUNT_B]);
    // A reader with no account of its own follows the most recent connect.
    expect(await store.currentAccountId()).toBe(ACCOUNT_B);
    expect(await store.read()).toMatchObject({ account_id: ACCOUNT_B });
  });

  it("re-connecting an existing account updates only that entry", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));
    await store.write({ ...entry(ACCOUNT_A, "tok_a2"), connected_providers: ["google"] });

    expect(await store.read(ACCOUNT_A)).toMatchObject({
      agent_session_token: "tok_a2",
      connected_providers: ["google"],
    });
    expect(await store.read(ACCOUNT_B)).toMatchObject({ agent_session_token: "tok_b" });
  });

  it("keeps a pre-claim entry under a reserved key, then supersedes it", async () => {
    const store = new SessionStore(tmpFile);
    await store.write({ api_base_url: "http://api", saved_at: "t0", machine_token: "m" });
    expect(await store.listAccounts()).toEqual([UNBOUND_ACCOUNT_KEY]);
    expect(await store.read()).toMatchObject({ machine_token: "m" });

    await store.write(entry(ACCOUNT_A, "tok_a"));
    expect(await store.listAccounts()).toEqual([ACCOUNT_A]);
  });

  it("clear removes one account and leaves the others installed", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));

    await store.clear(ACCOUNT_B);
    expect(await store.listAccounts()).toEqual([ACCOUNT_A]);
    expect(await store.read(ACCOUNT_A)).toMatchObject({ agent_session_token: "tok_a" });
    expect(await store.currentAccountId()).toBe(ACCOUNT_A);
  });

  it("clear deletes the file once the last account is gone, idempotently", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.clear();
    await store.clear();
    expect(await store.read()).toBeNull();
    await expect(fs.stat(tmpFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no temp files behind (writes land by atomic rename)", async () => {
    await new SessionStore(tmpFile).write(entry(ACCOUNT_A, "tok_a"));
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

});

// Running servers cannot be upgraded in place: the box carries `mcp server`
// processes that loaded a pre-v2 build weeks ago and read this same file. An
// earlier revision reshaped the file ON READ and broke four of them.
describe("compatibility with builds that are already running", () => {
  const flat = {
    api_base_url: "http://api",
    saved_at: "2026-05-01T00:00:00Z",
    account_id: ACCOUNT_A,
    machine_token: "tsm_legacy",
    agent_session_token: "tok_legacy",
    connected_providers: ["google"],
  };

  it("reads a pre-v2 flat file as that account's entry", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(flat));
    const store = new SessionStore(tmpFile);
    expect(await store.read(ACCOUNT_A)).toMatchObject({
      agent_session_token: "tok_legacy",
      connected_providers: ["google"],
    });
    expect(await store.read()).toMatchObject({ agent_session_token: "tok_legacy" });
    expect(await store.currentAccountId()).toBe(ACCOUNT_A);
  });

  it("NEVER rewrites the file on read — byte-for-byte untouched", async () => {
    const original = JSON.stringify(flat);
    await fs.writeFile(tmpFile, original);
    const store = new SessionStore(tmpFile);
    await store.read();
    await store.read(ACCOUNT_A);
    await store.listAccounts();
    await store.currentAccountId();
    expect(await fs.readFile(tmpFile, "utf8")).toBe(original);
  });

  it("a v2 write stays readable by a pre-v2 build: current account at the top level", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(flat));
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_B, "tok_b"));

    // What an OLD build reads — the flat top level — is the current account,
    // complete, exactly where it has always looked.
    const document = await onDisk();
    expect(document).toMatchObject({
      api_base_url: "http://api",
      account_id: ACCOUNT_B,
      agent_session_token: "tok_b",
    });
    // What a v2 build reads: both accounts, neither destroyed.
    expect(await store.listAccounts()).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(await store.read(ACCOUNT_A)).toMatchObject({ agent_session_token: "tok_legacy" });
  });

  it("survives an OLD build's write, which drops the map and keeps the top level", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));
    // Simulate a pre-v2 build writing its flat object over ours.
    await fs.writeFile(tmpFile, JSON.stringify({ ...entry(ACCOUNT_B, "tok_b2") }));

    // Degraded to exactly pre-v2 behaviour for the account that build serves —
    // readable, not corrupt.
    expect(await store.read(ACCOUNT_B)).toMatchObject({ agent_session_token: "tok_b2" });
    expect(await store.read(ACCOUNT_A)).toBeNull();
    // The next v2 write re-establishes the map.
    await store.write(entry(ACCOUNT_A, "tok_a2"));
    expect(await store.listAccounts()).toEqual([ACCOUNT_B, ACCOUNT_A]);
  });

  it("prefers the top level over a stale map entry for the current account", () => {
    // What an old build's write leaves behind if the map somehow survives.
    const view = parseSessionAccounts({
      ...entry(ACCOUNT_A, "tok_fresh"),
      accounts: {
        [ACCOUNT_A]: entry(ACCOUNT_A, "tok_stale"),
        [ACCOUNT_B]: entry(ACCOUNT_B, "tok_b"),
      },
    });
    expect(view.accounts[ACCOUNT_A]).toMatchObject({ agent_session_token: "tok_fresh" });
    expect(view.accounts[ACCOUNT_B]).toMatchObject({ agent_session_token: "tok_b" });
    expect(view.currentAccountId).toBe(ACCOUNT_A);
  });

  it("keys a flat session that never bound an account under the reserved key", () => {
    const view = parseSessionAccounts({ api_base_url: "http://api", saved_at: "t" });
    expect(view.accounts[UNBOUND_ACCOUNT_KEY]).toMatchObject({ api_base_url: "http://api" });
    expect(view.currentAccountId).toBe(UNBOUND_ACCOUNT_KEY);
    expect(view.flatOnly).toBe(true);
  });
});

describe("two concurrent servers, two accounts", () => {
  const guardFor = (accountId: string | undefined, pid: number) =>
    createSessionGuard({
      openStorage: async () => new SessionStore(tmpFile),
      accountId,
      self: { pid, version: "1.1.13-rc.27" },
    });

  it("the server bound to the first account keeps working after the second connects", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));

    // Server A launched with TRUSTY_SQUIRE_ACCOUNT_ID=<A>.
    const a = guardFor(ACCOUNT_A, 1595293);
    expect(await a.bind()).toMatchObject({ agent_session_token: "tok_a" });

    // The operator connects a SECOND account.
    await store.write(entry(ACCOUNT_B, "tok_b"));
    const b = guardFor(ACCOUNT_B, 2297170);
    expect(await b.bind()).toMatchObject({ agent_session_token: "tok_b" });

    // Distinct state; neither reads the other's, and A is not disturbed.
    expect(a.boundAccountId()).toBe(ACCOUNT_A);
    expect(b.boundAccountId()).toBe(ACCOUNT_B);
    expect(await a.bind()).toMatchObject({ agent_session_token: "tok_a" });
    expect(await a.inspect()).toEqual({ problem: null });
    expect(await b.inspect()).toEqual({ problem: null });
  });

  it("a server with no account in its launch env adopts the account it reads", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    const legacy = guardFor(undefined, 1905550);
    expect(legacy.boundAccountId()).toBeNull();
    expect(await legacy.bind()).toMatchObject({ agent_session_token: "tok_a" });
    expect(legacy.boundAccountId()).toBe(ACCOUNT_A);

    // Having adopted A, a later connect under B does not move it.
    await store.write(entry(ACCOUNT_B, "tok_b"));
    expect(await legacy.bind()).toMatchObject({ agent_session_token: "tok_a" });
  });

  it("fails loudly when its own account entry is removed, naming what is installed", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));
    const a = guardFor(ACCOUNT_A, 1595293);
    await a.bind();
    expect(await a.inspect()).toEqual({ problem: null });

    await store.clear(ACCOUNT_A);

    const report = await a.inspect();
    expect(report.problem?.code).toBe("account_session_missing");
    expect(report.problem?.message).toContain("pid 1595293");
    expect(report.problem?.message).toContain(ACCOUNT_A);
    expect(report.problem?.message).toContain(ACCOUNT_B);
    expect(report.problem?.message).toMatch(/Refusing to fall back to another account/);
    expect(report.problem?.message).toMatch(/connect|restart/i);
    // It never silently substitutes the surviving account's session.
    expect(await store.read(ACCOUNT_A)).toBeNull();
  });

  it("stays quiet before anything is bound", async () => {
    expect(await guardFor(undefined, 1).inspect()).toEqual({ problem: null });
  });

  it("stays quiet when its account is not installed YET (connect still running)", async () => {
    // Launched with TRUSTY_SQUIRE_ACCOUNT_ID set before the claim landed. That
    // is "not installed yet", not "removed" — the unauthenticated reconnect
    // path owns the message, so the guard must not preempt it.
    const pending = guardFor(ACCOUNT_A, 1946249);
    expect(await pending.bind()).toBeNull();
    expect(await pending.inspect()).toEqual({ problem: null });

    await new SessionStore(tmpFile).write(entry(ACCOUNT_A, "tok_a"));
    expect(await pending.bind()).toMatchObject({ agent_session_token: "tok_a" });
    expect(await pending.inspect()).toEqual({ problem: null });
  });

  it("names the running build alongside the account", () => {
    const error = new AccountSessionMissingError(ACCOUNT_A, [ACCOUNT_B], {
      pid: 1595293,
      version: "1.1.13-rc.26",
    });
    expect(error.code).toBe("account_session_missing");
    expect(error.message).toContain("v1.1.13-rc.26");
    expect(error.message).toContain("pid 1595293");
  });
});
