// Session storage tests. We force the file backend (keytar fallback)
// by passing preferFile: true so they run cleanly in CI / containers
// without libsecret.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStorage, openSessionStorage } from "../session.js";

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-session-"));
  tmpFile = path.join(dir, "session.json");
});

afterEach(async () => {
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
});

describe("FileStorage", () => {
  it("round-trips session data with restrictive permissions", async () => {
    const store = new FileStorage(tmpFile);
    await store.write({
      agent_session_token: "tok",
      account_id: "acc_1",
      api_base_url: "http://api",
      saved_at: "2026-05-11T00:00:00Z",
    });
    const back = await store.read();
    expect(back?.agent_session_token).toBe("tok");
    const stat = await fs.stat(tmpFile);
    // 0o600 (-rw-------) on posix. Skip the strict check on non-posix.
    if (process.platform !== "win32") {
      expect((stat.mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("read returns null when the file is absent", async () => {
    const store = new FileStorage(tmpFile);
    expect(await store.read()).toBeNull();
  });

  it("clear removes the file, idempotent", async () => {
    const store = new FileStorage(tmpFile);
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

describe("openSessionStorage", () => {
  it("preferFile=true returns the file backend even when keytar is available", async () => {
    const store = await openSessionStorage({ preferFile: true });
    expect(store.backendName()).toBe("file");
  });

  it("TRUSTY_SQUIRE_SESSION_FILE=1 forces the file backend", async () => {
    const prev = process.env.TRUSTY_SQUIRE_SESSION_FILE;
    process.env.TRUSTY_SQUIRE_SESSION_FILE = "1";
    try {
      const store = await openSessionStorage();
      expect(store.backendName()).toBe("file");
    } finally {
      if (prev === undefined) delete process.env.TRUSTY_SQUIRE_SESSION_FILE;
      else process.env.TRUSTY_SQUIRE_SESSION_FILE = prev;
    }
  });

  it("ignores a falsey TRUSTY_SQUIRE_SESSION_FILE", async () => {
    const prev = process.env.TRUSTY_SQUIRE_SESSION_FILE;
    process.env.TRUSTY_SQUIRE_SESSION_FILE = "0";
    try {
      // Falls through to keytar-or-file; in CI/containers keytar is absent so
      // this still resolves to file — assert it doesn't THROW and returns a
      // valid backend rather than asserting a specific one.
      const store = await openSessionStorage();
      expect(["file", "keytar"]).toContain(store.backendName());
    } finally {
      if (prev === undefined) delete process.env.TRUSTY_SQUIRE_SESSION_FILE;
      else process.env.TRUSTY_SQUIRE_SESSION_FILE = prev;
    }
  });
});
