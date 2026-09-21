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
//   * a real `listenBroker` answers on the socket connect resolves, as the
//     resident broker does (connect must settle from reads without ever
//     touching the broker's custody).
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
// The rows GitHub actually writes to the cookie store while signed in,
// confirmed against a real bot profile carrying a GitHub login.
const GITHUB_PERSISTED_COOKIES = ["dotcom_user"];
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

/**
 * A Chrome cookie store, in Chrome's own on-disk shape. The `cookies` table and
 * the columns written here are the serialized format the profile owns and the
 * probe reads; `Default/Cookies` is where Chrome puts it under a user-data-dir.
 */
async function writeProfileCookiesRaw(
  profileDir: string,
  cookies: Array<{ host: string; name: string; expires: number }>,
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
    for (const cookie of cookies) {
      const persistent = cookie.expires === 0 ? 0 : 1;
      insert.run(
        0,
        cookie.host,
        cookie.name,
        "",
        "/",
        cookie.expires,
        1,
        1,
        persistent,
        persistent,
      );
    }
  } finally {
    db.close();
  }
}

async function writeProfileCookies(
  profileDir: string,
  cookies: Array<{ host: string; name: string }>,
  expiresInMs = 30 * 86_400_000,
): Promise<void> {
  const expires = (Date.now() + expiresInMs + WINDOWS_EPOCH_OFFSET_MS) * 1000;
  await writeProfileCookiesRaw(
    profileDir,
    cookies.map((cookie) => ({ ...cookie, expires })),
  );
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

async function runConnect(): Promise<string> {
  const output: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  const error = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
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
  } catch {
    // These cases assert the PREFLIGHT decision, which is fully expressed in the
    // output above. What the ceremony then does with a stubbed API is not it.
  } finally {
    exit.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  return output.join("\n");
}

it("reports already connected while the broker owns the profile and its browser", async () => {
  await writeProfileCookies(
    profileDir,
    GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
  );
  // The resident broker's claim on the profile, in the on-disk form the lease
  // machinery reads. Opening the profile from here throws ProfileBusyError.
  profileLease = acquireProfileOperationGuard(profileDir);

  const socket = path.join(socketRoot, "b.sock");
  broker = await listenBroker(socket, {
    authenticate: async () => ({ accountId: "account-id", agentId: "connect" }),
    connected: async () => undefined,
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
  // Nothing waited on the profile: the old probe's pre-wait alone is 15s.
  expect(elapsed).toBeLessThan(5_000);
});

it("prints the same already-connected facts as JSON without changing the human line", async () => {
  await writeProfileCookies(
    profileDir,
    GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
  );
  profileLease = acquireProfileOperationGuard(profileDir);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const human: string[] = [];
  const machine: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    human.push(String(message));
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    machine.push(String(chunk));
    return true;
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
      json: true,
    });
  } finally {
    warn.mockRestore();
    write.mockRestore();
  }

  expect(human.join("\n")).toContain("Already connected");
  const report = JSON.parse(machine.join("").trim().split("\n").at(-1) ?? "{}") as {
    state: string;
    sign_in_url: string | null;
    account: { id: string; providers: string[] } | null;
    browser_location: { kind: string };
  };
  expect(report.state).toBe("connected");
  expect(report.sign_in_url).toBeNull();
  expect(report.account).toEqual({ id: "account-id", providers: ["google"] });
  expect(report.browser_location).toEqual({ kind: "none" });
});

// An ABSENT cookie store and an UNREADABLE one are different answers, and
// collapsing them is what stranded a bound machine with no profile: it can
// never be "already connected", and it must never be told to close a browser
// and re-run --force-relogin instead of simply signing in.
//
// `--force-relogin` wipes the whole profile before the confirm, so a confirm
// that is abandoned or times out leaves exactly this state with a still-valid
// agent token. Treating it as unverified makes every later plain `connect`
// refuse to run a sign-in, permanently.
it("runs the sign-in ceremony when the profile has no cookie store at all", async () => {
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).not.toContain("Already connected");
  expect(output).not.toContain("couldn't verify");
  // Past the preflight and into the ceremony, which announces itself first.
  expect(output).toContain("Opening the Trusty Squire install page");
});

it("stays unverified rather than re-pairing when the cookie store cannot be read", async () => {
  // Present but not a database: unknown, not proof of anything. A probe failure
  // must refresh the config and warn — never force the full ceremony, and never
  // claim connected (connect-loops-forever).
  await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
  await fs.writeFile(path.join(profileDir, "Default", "Cookies"), "not a sqlite database");
  profileLease = acquireProfileOperationGuard(profileDir);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).toContain("couldn't verify");
  expect(output).not.toContain("Already connected");
  // It also never approached the browser: the lease above is still untouched,
  // so no ProfileBusyError was raised against it.
  expect(output).not.toContain("Opening the Trusty Squire install page");
  expect(output).not.toContain("already using the browser");
});

it("does not claim a provider whose cookies have expired", async () => {
  await writeProfileCookies(
    profileDir,
    GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
    -86_400_000,
  );
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).not.toContain("Already connected");
  expect(output).toContain("Opening the Trusty Squire install page");
});

async function recordConnectedProviders(providers: string[]): Promise<string> {
  const sessionPath = path.join(process.env.XDG_CONFIG_HOME!, "trusty-squire", "session.json");
  const stored = JSON.parse(await fs.readFile(sessionPath, "utf8")) as Record<string, unknown>;
  await fs.writeFile(sessionPath, JSON.stringify({ ...stored, connected_providers: providers }));
  return sessionPath;
}

// Legacy bookkeeping: `connected_providers` is an add-only field older
// builds wrote after a ceremony. The preflight must NEVER read it as a veto
// over live cookie evidence — an add-only record that overrode the cookies
// told users their working GitHub session was dead and walked them into a
// needless re-ceremony, every run.

// Cookie evidence alone decides the claim. A stale add-only record that names
// fewer providers than the profile proves must not demote the claim or fire a
// bogus repair offer.
it("claims what the cookie store proves even when an old record names less", async () => {
  const sessionPath = await recordConnectedProviders(["google"]);
  await writeProfileCookies(profileDir, [
    ...GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
    ...GITHUB_PERSISTED_COOKIES.map((name) => ({ host: ".github.com", name })),
  ]);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).toContain("Already connected (google + github)");
  expect(output).not.toContain("GitHub session is not active");
  expect(output).not.toContain("Opening the Trusty Squire install page");
  // The preflight writes nothing back: the record stays as it was.
  const after = JSON.parse(await fs.readFile(sessionPath, "utf8")) as {
    connected_providers?: string[];
  };
  expect(after.connected_providers).toEqual(["google"]);
});

// The store holds only what Chrome PERSISTS. GitHub's `user_session` is
// session-scoped and never written, so probing for it reported every signed-in
// profile as signed out — and interactively that answer walks a fully connected
// machine into the ceremony, which is the reported failure.
it("claims a GitHub session from the rows Chrome actually persists", async () => {
  await recordConnectedProviders(["google", "github"]);
  await writeProfileCookies(profileDir, [
    ...GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
    ...GITHUB_PERSISTED_COOKIES.map((name) => ({ host: ".github.com", name })),
  ]);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).toContain("Already connected (google + github)");
  expect(output).not.toContain("GitHub session is not active");
  expect(output).not.toContain("Opening the Trusty Squire install page");
});

// Signing out of GitHub removes those rows; the repair offer must come back.
it("offers the GitHub repair once its persisted rows are gone", async () => {
  await recordConnectedProviders(["google", "github"]);
  await writeProfileCookies(
    profileDir,
    GOOGLE_SESSION_COOKIES.map((name) => ({ host: ".google.com", name })),
  );
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).toContain("Already connected (google)");
  expect(output).toContain("GitHub session is not active");
});

// A cookie with no expiry is not a cookie that expired in 1601.
it("accepts a persisted row that carries no expiry", async () => {
  await recordConnectedProviders(["google", "github"]);
  await writeProfileCookiesRaw(profileDir, [
    ...GOOGLE_SESSION_COOKIES.map((name) => ({
      host: ".google.com",
      name,
      expires: (Date.now() + 30 * 86_400_000 + WINDOWS_EPOCH_OFFSET_MS) * 1000,
    })),
    ...GITHUB_PERSISTED_COOKIES.map((name) => ({ host: ".github.com", name, expires: 0 })),
  ]);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profileDir);

  const output = await runConnect();

  expect(output).toContain("Already connected (google + github)");
});
