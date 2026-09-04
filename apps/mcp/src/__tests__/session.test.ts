// Session store mechanics. One store, one pathway: the 0600 file. The keytar
// backend (and the TRUSTY_SQUIRE_SESSION_FILE hatch that existed to opt out of
// it) is gone — on headless Linux keytar's probe passed, so it got selected,
// then the per-login keyring wiped the session between SSH logins.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionStorage, SessionStore } from "../session.js";

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-session-"));
  tmpFile = path.join(dir, "session.json");
});

afterEach(async () => {
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("round-trips session data with restrictive permissions", async () => {
    const store = new SessionStore(tmpFile);
    await store.write({
      agent_session_token: "tok",
      account_id: "acc_1",
      api_base_url: "http://api",
      saved_at: "2026-05-11T00:00:00Z",
    });
    expect((await store.read())?.agent_session_token).toBe("tok");
    const stat = await fs.stat(tmpFile);
    // 0o600 (-rw-------) on posix. Skip the strict check on non-posix.
    if (process.platform !== "win32") {
      expect((stat.mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("read returns null when the file is absent", async () => {
    expect(await new SessionStore(tmpFile).read()).toBeNull();
  });

  it("loads legacy sessions while pruning the retired proxy credential", async () => {
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        api_base_url: "http://api",
        saved_at: "x",
        account_id: "acc_1",
        agent_session_token: "tok",
        proxy_url: "http://user:secret@proxy.example:8080",
      }),
    );

    const store = new SessionStore(tmpFile);
    const session = await store.read();
    expect(session).toMatchObject({ agent_session_token: "tok" });
    expect(session).not.toHaveProperty("proxy_url");
    // Pruning is in-memory: the read leaves the file alone (other, older
    // servers read it too). The next write is what persists the pruning.
    expect(await fs.readFile(tmpFile, "utf8")).toContain("proxy_url");
    await store.write({ ...session!, saved_at: "y" });
    expect(await fs.readFile(tmpFile, "utf8")).not.toContain("proxy_url");
  });

  it("reads without writing, even where a write would fail", async () => {
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        api_base_url: "http://api",
        saved_at: "x",
        account_id: "acc_1",
        agent_session_token: "tok",
        proxy_url: "http://user:secret@proxy.example:8080",
      }),
    );
    // Read-only directory: any attempt to persist on the read path would throw.
    await fs.chmod(path.dirname(tmpFile), 0o500);
    try {
      const session = await new SessionStore(tmpFile).read();
      expect(session).toMatchObject({ agent_session_token: "tok" });
      expect(session).not.toHaveProperty("proxy_url");
    } finally {
      await fs.chmod(path.dirname(tmpFile), 0o700);
    }
  });

  it("clear removes the file, idempotent", async () => {
    const store = new SessionStore(tmpFile);
    await store.write({
      agent_session_token: "tok",
      account_id: "acc",
      api_base_url: "http://api",
      saved_at: "x",
    });
    await store.clear();
    await store.clear(); // no-throw on missing
    expect(await store.read()).toBeNull();
  });
});

describe("test containment", () => {
  it("the DEFAULT session path never resolves to a real home", async () => {
    // Guards the incident this suite caused once: a test reached the live
    // ~/.config/trusty-squire/session.json and reshaped it under the running
    // servers sharing it. See src/__tests__/setup/isolate-config-home.ts.
    const { path: resolved } = new SessionStore();
    expect(resolved.startsWith(os.tmpdir())).toBe(true);
    expect(resolved).not.toContain(path.join(os.userInfo().homedir, ".config"));
  });
});

describe("openSessionStorage", () => {
  it("always resolves the file store", async () => {
    expect(await openSessionStorage({ filePath: tmpFile })).toBeInstanceOf(SessionStore);
  });

  it("honours the caller's file path", async () => {
    expect((await openSessionStorage({ filePath: tmpFile })).path).toBe(tmpFile);
  });
});
