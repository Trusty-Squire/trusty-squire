// One file per account.
//
// Measured on a live box: `account_id` moved from 01KS0BKRYTVE9T9FAQQ31A4MK3 to
// 01M1N0CBVSCX7GGR94S0JYQW1G when the operator connected under a SECOND Trusty
// Squire account. The flat file meant the second connect overwrote the first
// account's binding, so servers still serving the first read the second's scope
// — a real credential_not_found for a credential that exists in the FIRST
// account's vault.
//
// One file per account makes that STRUCTURAL: writing account B touches only
// B's file, so there is no shared document to race on and no lock to get wrong.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSessionMissingError, SessionStore, UNBOUND_ACCOUNT_KEY } from "../session.js";
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

/** The legacy flat pointer/mirror an older running build reads. */
async function pointerOnDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(tmpFile, "utf8")) as Record<string, unknown>;
}

function accountFile(accountId: string): string {
  return path.join(dir, "sessions", `${accountId}.json`);
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
// processes that loaded a pre-per-account build weeks ago and read the flat
// session.json. An earlier revision reshaped that file ON READ and broke four
// of them.
describe("compatibility with builds that are already running", () => {
  const flat = {
    api_base_url: "http://api",
    saved_at: "2026-05-01T00:00:00Z",
    account_id: ACCOUNT_A,
    machine_token: "tsm_legacy",
    agent_session_token: "tok_legacy",
    connected_providers: ["google"],
  };

  it("reads a pre-per-account flat file as that account's entry", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(flat));
    const store = new SessionStore(tmpFile);
    expect(await store.read(ACCOUNT_A)).toMatchObject({
      agent_session_token: "tok_legacy",
      connected_providers: ["google"],
    });
    expect(await store.read()).toMatchObject({ agent_session_token: "tok_legacy" });
    expect(await store.currentAccountId()).toBe(ACCOUNT_A);
    expect(await store.listAccounts()).toEqual([ACCOUNT_A]);
  });

  it("NEVER rewrites on read — the file older servers read is untouched", async () => {
    const original = JSON.stringify(flat);
    await fs.writeFile(tmpFile, original);
    const store = new SessionStore(tmpFile);
    await store.read();
    await store.read(ACCOUNT_A);
    await store.listAccounts();
    await store.currentAccountId();
    expect(await fs.readFile(tmpFile, "utf8")).toBe(original);
    await expect(fs.stat(path.join(dir, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps session.json as the current-account pointer in the ORIGINAL flat shape", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(flat));
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_B, "tok_b"));

    // What an OLD build reads: a complete flat entry for the current account,
    // exactly where it has always looked - no wrapper, no accounts map.
    const pointer = await pointerOnDisk();
    expect(pointer).toMatchObject({
      api_base_url: "http://api",
      account_id: ACCOUNT_B,
      agent_session_token: "tok_b",
    });
    expect(pointer).not.toHaveProperty("accounts");
    expect(pointer).not.toHaveProperty("version");
  });

  it("migrates a legacy flat install into sessions/ only on an explicit write", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(flat));
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_B, "tok_b"));
    // B is now a file of its own; A is still readable from the legacy flat copy
    // until it is itself rewritten.
    expect(JSON.parse(await fs.readFile(accountFile(ACCOUNT_B), "utf8"))).toMatchObject({
      agent_session_token: "tok_b",
    });
    await store.write({ ...flat, saved_at: "t2" });
    expect(JSON.parse(await fs.readFile(accountFile(ACCOUNT_A), "utf8"))).toMatchObject({
      agent_session_token: "tok_legacy",
    });
    expect(await store.listAccounts()).toEqual([ACCOUNT_A, ACCOUNT_B].sort());
  });

  it("survives an OLD build overwriting the pointer with its own flat object", async () => {
    const store = new SessionStore(tmpFile);
    await store.write(entry(ACCOUNT_A, "tok_a"));
    await store.write(entry(ACCOUNT_B, "tok_b"));
    // A pre-per-account build rewrites the flat pointer and knows nothing of
    // sessions/. Per-account truth is untouched, which is the whole point.
    await fs.writeFile(tmpFile, JSON.stringify(entry(ACCOUNT_B, "tok_b2")));

    expect(await store.read(ACCOUNT_A)).toMatchObject({ agent_session_token: "tok_a" });
    expect(await store.read(ACCOUNT_B)).toMatchObject({ agent_session_token: "tok_b" });
    expect(await store.listAccounts()).toEqual([ACCOUNT_A, ACCOUNT_B].sort());
  });

  it("keys a flat session that never bound an account under the reserved key", async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ api_base_url: "http://api", saved_at: "t" }));
    const store = new SessionStore(tmpFile);
    expect(await store.currentAccountId()).toBe(UNBOUND_ACCOUNT_KEY);
    expect(await store.read()).toMatchObject({ api_base_url: "http://api" });
  });
});

// The lock this design replaces existed only because one document held every
// account. With per-account files the guarantee is structural.
describe("concurrent writers cannot destroy another account", () => {
  it("two writers adding DIFFERENT accounts both survive", async () => {
    const store = new SessionStore(tmpFile);
    await Promise.all([
      store.write(entry(ACCOUNT_A, "tok_a")),
      store.write(entry(ACCOUNT_B, "tok_b")),
    ]);
    expect(await store.read(ACCOUNT_A)).toMatchObject({ agent_session_token: "tok_a" });
    expect(await store.read(ACCOUNT_B)).toMatchObject({ agent_session_token: "tok_b" });
    expect(await store.listAccounts()).toEqual([ACCOUNT_A, ACCOUNT_B].sort());
  });

  it("many interleaved writers all survive, and none is lost", async () => {
    const store = new SessionStore(tmpFile);
    const ids = Array.from({ length: 12 }, (_, i) => `01ACCOUNT${String(i).padStart(4, "0")}`);
    await Promise.all(ids.map((id) => store.write(entry(id, `tok_${id}`))));
    expect(await store.listAccounts()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(await store.read(id)).toMatchObject({ agent_session_token: `tok_${id}` });
    }
  });

  it("leaves no temp files behind under concurrency", async () => {
    const store = new SessionStore(tmpFile);
    await Promise.all([
      store.write(entry(ACCOUNT_A, "tok_a")),
      store.write(entry(ACCOUNT_B, "tok_b")),
    ]);
    const stray = [...(await fs.readdir(dir)), ...(await fs.readdir(path.join(dir, "sessions")))];
    expect(stray.filter((name) => name.includes(".tmp-"))).toEqual([]);
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

  it("names the bound account, what IS installed, and the remedy", () => {
    const error = new AccountSessionMissingError(ACCOUNT_A, [ACCOUNT_B], {
      pid: 1595293,
      version: "1.1.13-rc.26",
    });
    expect(error.code).toBe("account_session_missing");
    expect(error.message).toContain(ACCOUNT_A);
    expect(error.message).toContain(ACCOUNT_B);
    expect(error.message).toMatch(/connect|restart/i);
  });
});
