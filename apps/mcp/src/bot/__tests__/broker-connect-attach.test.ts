// Regression: `connect` must ATTACH to the live broker that owns the profile
// it is connecting, not compete with it for the profile.
//
// One shared browser per profile is the design. The broker owns it and holds
// the profile's operation lease; `connect` needs that same browser to seed the
// user's provider session, so it drains the broker through the maintenance
// handshake and takes the profile only for the duration of the plain login.
//
// The seam that broke: `withBrokerMaintenance` resolved the broker ENDPOINT
// from `CHROME_PROFILE_DIR` — frozen at module load — while `connect` guards
// the profile it resolved from the TARGET agent's recorded environment.
// Whenever those differ (a machine carrying more than one Squire stack, or any
// target whose recorded profile is not the process default), maintenance
// addressed a different profile's endpoint, found no socket, skipped the
// drain, and the exclusive guard then collided with the live broker — surfacing
// as "another Trusty Squire session is already using the browser — close it
// first" and, because the install never finished, a pairing code that does not
// exist and a `not_found` sign-in page.
//
// The fixture is a real separate process: it holds the profile operation lease
// in the exact on-disk format the lease machinery reads, and it speaks the
// connect/close maintenance contract over a real unix socket. Nothing here
// launches Chrome.
//
// A broker whose browser is still owned answers `draining` and connect reports
// that at once: an already-connected install never gets here (it is settled
// from reads before any broker work), so the only caller left is one that
// genuinely needs the login ceremony, and it must not wait.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as ProfileModule from "../profile.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({
    bind: async () => ({ agent_session_token: "fixture-token", account_id: "fixture-account" }),
  }),
}));

const TOKEN = "fixture-token";

/**
 * A real broker fixture: a separate process that
 *
 * - holds the profile operation lease (the file whose owner record the guard
 *   machinery reads) for as long as its browser is up,
 * - releases it while a maintenance window is open and re-claims it on the
 *   lease boundary (`close`), exactly like `BrokerRuntime`,
 * - answers the first `drainingReplies` maintain connects with
 *   `maintenance: "draining"` (live sessions still own the browser) before
 *   opening a window.
 */
const BROKER_FIXTURE_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const [marker, socketPath, lockPath, token, drainingReplies] = process.argv.slice(2);
if (marker !== "broker") process.exit(78);
function startTime() {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
function claim() {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ host: os.hostname(), pid: process.pid, start_time: startTime(), token: "lease" }),
    { mode: 0o600 },
  );
}
claim();
let remainingDraining = Number(drainingReplies) || 0;
let windowOpen = false;
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
        if (request.params?.token !== token) {
          reply({ error: { code: "unauthorized", message: "Invalid broker credential" } });
          continue;
        }
        if (request.params?.maintain === true) {
          if (remainingDraining > 0) {
            remainingDraining -= 1;
            reply({ result: { version: 1, clientId: "fixture", maintenance: "draining" } });
            continue;
          }
          fs.rmSync(lockPath, { force: true });
          windowOpen = true;
          reply({ result: { version: 1, clientId: "fixture", maintenance: "ready" } });
          continue;
        }
        reply({ result: { version: 1, clientId: "fixture" } });
        continue;
      }
      if (request.method === "close") {
        if (windowOpen) {
          windowOpen = false;
          claim();
        }
        reply({ result: { closed: true } });
        continue;
      }
      reply({ error: { code: "unsupported", message: "unsupported" } });
    }
  });
});
server.listen(socketPath);
setInterval(() => undefined, 1000);
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

/** The profile lease file the guard machinery will read, derived through the
 * real lease machinery so the fixture writes exactly where production reads. */
async function profileLockPath(
  profileModule: typeof ProfileModule,
  profileDir: string,
  lockRoot: string,
): Promise<string> {
  const lease = profileModule.acquireProfileOperationGuard(profileDir, lockRoot);
  const name = (await readdir(lockRoot)).find(
    (entry) => entry.startsWith("trusty-squire-profile-") && entry.endsWith(".lock"),
  )!;
  lease.release();
  await rm(join(lockRoot, name), { force: true });
  return join(lockRoot, name);
}

/**
 * The `connect` shape: `withConnectTargetEnvironment` re-points
 * `TRUSTY_SQUIRE_PROFILE_DIR` at the target's recorded profile BEFORE any
 * broker or browser work, so the live environment names the target while
 * `CHROME_PROFILE_DIR` still names the process default.
 */
async function connectFixture(drainingReplies: number): Promise<{
  result: unknown;
  profileIdentity: string;
  guardObservedFree: boolean;
  lockRestored: boolean;
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
  const { withBrokerMaintenance } = await import("../broker/maintenance.js");
  const { withProfileOperationGuard } = profileModule;

  const socketPath = discovery.defaultBrokerSocket(targetProfile);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const lockPath = await profileLockPath(profileModule, targetProfile, lockRoot);
  const scriptPath = join(root, "broker-fixture.cjs");
  await writeFile(scriptPath, BROKER_FIXTURE_SCRIPT, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [scriptPath, "broker", socketPath, lockPath, TOKEN, String(drainingReplies)],
    { stdio: "ignore" },
  );
  cleanup.children.push(child);
  await waitFor(() => existsSync(lockPath) && existsSync(socketPath));

  let guardObservedFree = false;
  const result = await withBrokerMaintenance(async () => {
    // A live broker owns this profile. Attaching to it is what frees the
    // exclusive guard connect takes next; without the drain this is the
    // ProfileBusyError the captain saw.
    guardObservedFree = !existsSync(lockPath);
    return await withProfileOperationGuard(targetProfile, async () => "connected");
  }).catch((error: unknown) => error);
  await waitFor(() => existsSync(lockPath), 5_000).catch(() => undefined);
  return {
    result,
    profileIdentity: profileModule.profilePathIdentity(targetProfile),
    guardObservedFree,
    lockRestored: existsSync(lockPath),
  };
}

describe("connect attaches to the live broker for the profile it is connecting", () => {
  it("drains the broker that owns the target profile, not the process default", async () => {
    const outcome = await connectFixture(0);
    expect(outcome.result).toBe("connected");
    // The broker released the profile for the duration of the operation...
    expect(outcome.guardObservedFree).toBe(true);
    // ...and took custody back on the lease boundary.
    expect(outcome.lockRestored).toBe(true);
  });

  it("reports the TARGET profile when that broker's browser is still owned", async () => {
    // The refusal is the other half of the same seam: it proves the endpoint
    // that answered belongs to the target profile, not the process default,
    // because the fixture listening on it is the target's.
    const outcome = await connectFixture(1);
    expect(outcome.result).toBeInstanceOf(Error);
    expect((outcome.result as Error).message).toContain(outcome.profileIdentity);
    // Nothing ran and the broker kept custody: no drain, no guard, no relaunch.
    expect(outcome.guardObservedFree).toBe(false);
    expect(outcome.lockRestored).toBe(true);
  });
});
