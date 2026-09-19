// Regression: an install that is ALREADY connected must not be blocked by a
// busy browser.
//
// The captain's phone showed "Setting up this machine." and then
// "another Trusty Squire session is already using the browser — close it
// first", on a machine that was already installed. The steady state on any
// machine that has used the MCP server is a resident broker holding the
// profile's operation lease and a live Chrome on that profile — so connect's
// own "are you already connected?" question contended with the browser the
// question was about, and answered `unverified` on exactly the machines that
// were connected.
//
// Both halves of that contention are REAL here, not mocked:
//
//   * the profile's operation lease is held for the whole test by a lock record
//     naming this live process, exactly as a resident broker holds it. Anything
//     on connect's path that opens the profile throws ProfileBusyError.
//   * a real `listenBroker` answers on the socket connect resolves, replying
//     `draining` to any maintenance handshake and counting the attempts.
//
// The provider probe is NOT stubbed: connect runs the real one against a real
// Chrome-shaped cookie store. Only the network API is faked — a genuine process
// boundary.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { connect } from "../cli.js";
import { listenBroker } from "../../bot/broker/transport.js";
import {
  acquireProfileOperationGuard,
  profilePathIdentity,
  type ProfileOperationLease,
} from "../../bot/profile.js";

const GOOGLE_SESSION_COOKIES = ["__Secure-1PSID", "SID", "HSID", "SSID", "APISID", "SAPISID"];
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

/**
 * A Chrome cookie store, in Chrome's own on-disk shape. The `cookies` table and
 * the columns written here are the serialized format the profile owns and the
 * probe reads; `Default/Cookies` is where Chrome puts it under a user-data-dir.
 */
async function writeProfileCookies(
  profileDir: string,
  cookies: Array<{ host: string; name: string }>,
): Promise<void> {
  await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(profileDir, "Default", "Cookies"));
  try {
    db.exec(
      "create table cookies (creation_utc integer, host_key text, name text, value text, " +
        "path text, expires_utc integer, is_secure integer, is_httponly integer, " +
        "has_expires integer, is_persistent integer)",
    );
    const insert = db.prepare(
      "insert into cookies (creation_utc, host_key, name, value, path, expires_utc, " +
        "is_secure, is_httponly, has_expires, is_persistent) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const expires = (Date.now() + 30 * 86_400_000 + WINDOWS_EPOCH_OFFSET_MS) * 1000;
    for (const cookie of cookies) {
      insert.run(0, cookie.host, cookie.name, "", "/", expires, 1, 1, 1, 1);
    }
  } finally {
    db.close();
  }
}

let tmpHome: string;
let profileDir: string;
let socketRoot: string;
let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let broker: { close: () => Promise<void> } | undefined;
let profileLease: ProfileOperationLease | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-busy-broker-home-"));
  socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ts-busy-broker-sock-"));
  profileDir = profilePathIdentity(path.join(tmpHome, ".trusty-squire", "chrome-profile"));
  process.env.HOME = tmpHome;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, "trusty-squire"), { recursive: true });
  await fs.writeFile(
    path.join(process.env.XDG_CONFIG_HOME, "trusty-squire", "session.json"),
    JSON.stringify({
      api_base_url: "https://api.example.test",
      saved_at: "2026-09-04T00:00:00.000Z",
      machine_token: "machine-token",
      agent_session_token: "agent-token",
      account_id: "account-id",
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  profileLease?.release();
  profileLease = undefined;
  await broker?.close();
  broker = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(socketRoot, { recursive: true, force: true });
});

it("reports already connected while the broker owns the profile and its browser", async () => {
  await writeProfileCookies(
    profileDir,
    GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
  );
  // The resident broker's claim on the profile, in the on-disk form the lease
  // machinery reads. Opening the profile from here throws ProfileBusyError.
  profileLease = acquireProfileOperationGuard(profileDir);

  const socket = path.join(socketRoot, "b.sock");
  let maintainAttempts = 0;
  broker = await listenBroker(socket, {
    authenticate: async () => ({ accountId: "account-id", agentId: "connect" }),
    connected: async (_principal, params) => {
      if (params.maintain === true) maintainAttempts += 1;
      return params.maintain === true ? { maintenance: "draining" } : undefined;
    },
    call: async () => ({ closed: true }),
    disconnect: async () => undefined,
  });
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", socket);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  const started = Date.now();
  try {
    await connect({
      command: "connect",
      target: "cursor",
      apiBase: "https://api.example.test",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });
  } finally {
    warn.mockRestore();
  }
  const elapsed = Date.now() - started;

  expect(output.join("\n")).toContain("Already connected");
  // The reported string, and the unverified fallback it arrives on.
  expect(output.join("\n")).not.toContain("already using the browser");
  expect(output.join("\n")).not.toContain("couldn't verify");
  // The broker was never asked to give up its browser.
  expect(maintainAttempts).toBe(0);
  // And nothing waited on the profile: the old probe's pre-wait alone is 15s.
  expect(elapsed).toBeLessThan(5_000);
});

it("stays unverified rather than re-pairing when the profile cannot be read", async () => {
  // No cookie store at all: the probe throws. A probe failure must refresh the
  // config and warn — never force the full ceremony (connect-loops-forever).
  profileLease = acquireProfileOperationGuard(profileDir);

  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);
  const output: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  try {
    await connect({
      command: "connect",
      target: "cursor",
      apiBase: "https://api.example.test",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });
  } finally {
    warn.mockRestore();
  }

  expect(output.join("\n")).toContain("couldn't verify");
  expect(output.join("\n")).not.toContain("Already connected");
});
