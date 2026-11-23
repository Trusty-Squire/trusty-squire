// Regression: `connect`'s login ceremony must ATTACH to the live broker that
// owns the profile it is connecting — as an ordinary broker client opening a
// session tab at the confirm URL — not compete with it for the profile.
//
// One shared browser per profile is the design. The broker owns it and holds
// the profile's operation lease; `connect` needs that same browser to seed the
// user's provider session, so it opens the confirm page as a TAB in the
// broker's browser and never touches the profile lease at all.
//
// The seam that broke: the old maintenance wrapper resolved the broker
// ENDPOINT from `CHROME_PROFILE_DIR` — frozen at module load — while `connect`
// guards the profile it resolved from the TARGET agent's recorded environment.
// Whenever those differ (a machine carrying more than one Squire stack, or any
// target whose recorded profile is not the process default), connect
// addressed a different profile's endpoint and then collided with the live
// broker — surfacing as "another Trusty Squire session is already using the
// browser — close it first" and, because the install never finished, a pairing
// code that does not exist and a `not_found` sign-in page.
//
// The broker daemon now runs the ceremony itself (broker/ceremony.ts), so the
// attach is one `ceremony` call on the target profile's socket. The fixture is
// a real separate process: it holds the profile's SQLite lock through an open
// transaction and speaks the connect/ceremony wire contract over a real unix
// socket. Nothing here launches Chrome — and crucially, the lock is NEVER
// released: attaching means asking the broker that owns the browser, not
// taking the profile from it.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerAccountBindingPath } from "../broker/account-binding.js";
import { writeBrokerUnitMarker } from "../broker/managed-marker.js";
import type { CeremonyRequest } from "../broker/ceremony.js";

vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({
    bind: async () => ({
      agent_session_token: "fixture-token",
      account_id: "fixture-account",
    }),
  }),
}));

const require = createRequire(import.meta.url);
const CONFIRM_URL = "https://trustysquire.ai/install?token=fixture";
const TUNNEL_URL = "https://tunnel.invalid/#p=fixture";

/**
 * A real broker fixture: a separate process that
 *
 * - holds the profile's kernel SQLite lock for as long as it lives — like `BrokerRuntime`, which
 *   keeps the election guard across its whole custody,
 * - answers the connect handshake and then `ceremony`, recording what it was asked,
 * - can stand in for an older release (no token-less handshake, or no `ceremony` method).
 */
const BROKER_FIXTURE_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const [marker, socketPath, lockPath, mode] = process.argv.slice(2);
if (marker !== "broker") process.exit(78);
const lockDb = new (require(process.env.TS_SQLITE))(lockPath, { timeout: 0 });
lockDb.exec("BEGIN EXCLUSIVE");
process.on("exit", () => lockDb.close());
const seen = { ceremony: [] };
const persist = () => fs.writeFileSync(lockPath + ".seen", JSON.stringify(seen), { mode: 0o600 });
const server = net.createServer((socket) => {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const end = buffered.indexOf("\\n");
      if (end < 0) break;
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let request;
      try {
        request = JSON.parse(frame);
      } catch {
        socket.destroy();
        return;
      }
      const reply = (payload) => socket.write(JSON.stringify({ id: request.id, ...payload }) + "\\n");
      if (request.method === "connect") {
        if (mode === "legacy") {
          reply({
            error: { code: "unauthorized", message: "Authenticate before issuing commands" },
          });
          continue;
        }
        reply({ result: { version: 1, clientId: "fixture" } });
        continue;
      }
      if (request.method === "ceremony") {
        seen.ceremony.push(request.params);
        persist();
        if (mode === "outdated") {
          reply({ error: { code: "unknown_method", message: "Unknown broker method" } });
          continue;
        }
        reply({
          result:
            request.params.action === "get"
              ? { state: "none" }
              : {
                  state: "live",
                  confirm_url: request.params.confirmUrl,
                  browser_location: { kind: "virtual", url: ${JSON.stringify(TUNNEL_URL)} },
                  reused: false,
                },
        });
        continue;
      }
      if (request.method === "close") {
        reply({ result: { closed: true } });
        continue;
      }
      reply({ error: { code: "unsupported", message: "unsupported" } });
    }
  });
});
try {
  fs.rmSync(socketPath, { force: true });
} catch {}
server.listen(socketPath);
persist();
`;

const cleanup: { dirs: string[]; children: ChildProcess[] } = { dirs: [], children: [] };

/** `CHROME_PROFILE_DIR` freezes on the first import, so every fixture restores
 * the live environment the sandbox setup file established. */
let sandboxProfile: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (sandboxProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
  else process.env.TRUSTY_SQUIRE_PROFILE_DIR = sandboxProfile;
  for (const child of cleanup.children.splice(0)) child.kill("SIGKILL");
  for (const dir of cleanup.dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ts-connect-attach-"));
  cleanup.dirs.push(path);
  return path;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("fixture did not become ready");
}

const START = {
  action: "start" as const,
  confirmUrl: CONFIRM_URL,
  setupCode: "fixture",
  apiBase: "https://api.invalid",
  ttlMs: 600_000,
  callerHasDisplay: false,
  finalize: {
    baseSession: { api_base_url: "https://api.invalid", saved_at: "2026-11-22T00:00:00.000Z" },
    applyServerPrefs: true,
    agentConfigs: [{ target: "codex" as const }],
  },
} satisfies CeremonyRequest;

/**
 * The `connect` shape: `withConnectTargetEnvironment` re-points
 * `TRUSTY_SQUIRE_PROFILE_DIR` at the target's recorded profile BEFORE any
 * broker or browser work, so the live environment names the target while
 * `CHROME_PROFILE_DIR` still names the process default.
 */
async function connectFixture(
  opts: { mode?: "current" | "legacy" | "outdated"; boundAccount?: string } = {},
): Promise<{
  result: unknown;
  lockNeverReleased: boolean;
  ceremony: Record<string, unknown>[];
}> {
  const root = await tempDir();
  const lockRoot = join(root, "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const targetProfile = join(root, "profiles", "target");
  await mkdir(targetProfile, { recursive: true, mode: 0o700 });
  // The profile lock machinery and the broker fixture both keep their lock
  // files under the temp root, so this test never touches the real /tmp.
  vi.stubEnv("TMPDIR", lockRoot);

  // Imported here so `CHROME_PROFILE_DIR` freezes on the process default
  // (the isolated sandbox profile) BEFORE the connect shape re-points the
  // live environment at the target.
  const profileModule = await import("../profile.js");
  sandboxProfile ??= process.env.TRUSTY_SQUIRE_PROFILE_DIR!;
  const defaultProfile = sandboxProfile;
  expect(profileModule.CHROME_PROFILE_DIR).toBe(defaultProfile);
  expect(profileModule.profilePathIdentity(targetProfile)).not.toBe(
    profileModule.profilePathIdentity(defaultProfile),
  );
  process.env.TRUSTY_SQUIRE_PROFILE_DIR = targetProfile;

  const discovery = await import("../broker/discovery.js");
  const { requestBrokerCeremony } = await import("../google-login.js");

  const socketPath = discovery.defaultBrokerSocket(targetProfile);
  if (opts.boundAccount !== undefined) {
    const anchor = profileModule.profileDeviceAnchor(targetProfile);
    if (anchor === null) throw new Error("fixture profile has no device anchor");
    await writeBrokerUnitMarker(targetProfile, {
      version: 1,
      socket: socketPath,
      profile: anchor,
      accountBinding: opts.boundAccount,
    });
    await writeFile(
      brokerAccountBindingPath(targetProfile),
      JSON.stringify({ version: 1, accountId: opts.boundAccount }),
    );
  }
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const lockPath = profileModule.profileOperationLockPath(targetProfile);
  const scriptPath = join(root, "broker-fixture.cjs");
  await writeFile(scriptPath, BROKER_FIXTURE_SCRIPT, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [scriptPath, "broker", socketPath, lockPath, opts.mode ?? "current"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TS_SQLITE: require.resolve("better-sqlite3") },
    },
  );
  child.stderr?.on("data", (chunk) => process.stderr.write(`[broker fixture] ${String(chunk)}`));
  cleanup.children.push(child);
  await waitFor(() => existsSync(lockPath + ".seen") && existsSync(socketPath));

  const result = await requestBrokerCeremony(targetProfile, START).catch((error: unknown) => error);
  const seen = JSON.parse(readFileSync(lockPath + ".seen", "utf8")) as {
    ceremony: Record<string, unknown>[];
  };
  return {
    result,
    // Attaching never released the broker's custody of the profile, not even
    // momentarily: the ceremony is a tab in the broker's browser.
    lockNeverReleased: profileModule.profileOperationIsLocked(targetProfile),
    ceremony: seen.ceremony,
  };
}

describe("connect attaches to the live broker for the profile it is connecting", () => {
  it(
    "asks the broker that owns the TARGET profile, not the process default, for the ceremony",
    { timeout: 30_000 },
    async () => {
      const outcome = await connectFixture();
      expect(outcome.result).toEqual({
        state: "live",
        confirm_url: CONFIRM_URL,
        browser_location: { kind: "virtual", url: TUNNEL_URL },
        reused: false,
      });
      // The fixture is the only listener on the target profile's socket, and
      // it received the whole start request.
      expect(outcome.ceremony).toEqual([START]);
      expect(outcome.lockNeverReleased).toBe(true);
    },
  );

  it(
    "reaches the ceremony even when the profile is bound to another account",
    { timeout: 30_000 },
    async () => {
      const outcome = await connectFixture({ boundAccount: "previous-account" });
      expect(outcome.result).toMatchObject({ state: "live" });
      expect(outcome.lockNeverReleased).toBe(true);
    },
  );

  it(
    "names the restart when the resident broker predates the daemon-owned ceremony",
    { timeout: 30_000 },
    async () => {
      const outcome = await connectFixture({ mode: "outdated" });
      expect(outcome.result).toBeInstanceOf(Error);
      const refusal = outcome.result as Error & { code?: string };
      expect(refusal.code).toBe("broker_outdated");
      expect(refusal.message).toMatch(/restart/i);
      expect(refusal.message).toContain("run connect again");
    },
  );

  it(
    "propagates an identified resident's refusal instead of reporting a generic busy browser",
    { timeout: 30_000 },
    async () => {
      // A live resident from an older release refuses the token-less
      // handshake. The refusal names the resident and its recovery step, so
      // it must surface verbatim.
      const outcome = await connectFixture({ mode: "legacy" });
      expect(outcome.result).toBeInstanceOf(Error);
      const refusal = outcome.result as Error & { code?: string };
      expect(refusal.message).toContain("Authenticate before issuing commands");
      expect(refusal.code).toBe("unauthorized");
    },
  );
});
