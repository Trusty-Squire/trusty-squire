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
// The fixture is a real separate process: it holds the profile operation lease
// in the exact on-disk format the lease machinery reads, and it speaks the
// connect/open/close wire contract over a real unix socket. Nothing here
// launches Chrome — and crucially, the lock is NEVER released: attaching
// means tab-sharing the broker's browser, not taking the profile from it.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as ProfileModule from "../profile.js";
import { controlLabelV2 } from "../compact-observation-v2.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({
    bind: async () => ({
      agent_session_token: "fixture-token",
      account_id: "fixture-account",
    }),
  }),
}));

const TOKEN = "fixture-token";
const CONFIRM_URL = "https://trustysquire.ai/install/confirm?install=fixture";
// Minted by the same function the real observation uses, so the fixture can
// never encode a label shape production does not emit.
const SIGN_OUT_LABEL = controlLabelV2("Sign out")!;

/**
 * A real broker fixture: a separate process that
 *
 * - holds the profile operation lease (the file whose owner record the guard
 *   machinery reads) for as long as it lives — like `BrokerRuntime`, which
 *   keeps the election guard across its whole custody,
 * - answers the connect handshake and then one `open` with a session id,
 *   recording what it was asked to open,
 * - records the session `close` and answers it (the lease-boundary close).
 */
const BROKER_FIXTURE_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const [marker, socketPath, lockPath, token] = process.argv.slice(2);
if (marker !== "broker") process.exit(78);
function startTime() {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
fs.writeFileSync(
  lockPath,
  JSON.stringify({ host: os.hostname(), pid: process.pid, start_time: startTime(), token: "lease" }),
  { mode: 0o600 },
);
const seen = { openUrl: null, closedSession: null, commands: [] };
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
        reply({ result: { version: 1, clientId: "fixture" } });
        continue;
      }
      if (request.method === "open") {
        seen.openUrl = request.params?.serviceUrl ?? null;
        reply({ result: { sessionId: "tab-1" } });
        continue;
      }
      if (request.method === "command") {
        seen.commands = seen.commands || [];
        seen.commands.push({
          name: request.params?.name ?? null,
          args: request.params?.args ?? null,
        });
        // GitHub's logout page renders its confirm control; the observe-then-
        // click drive must find a Sign out row in the returned action map.
        // The label is the @slug alias controlLabelV2 really mints for an
        // accessible name of "Sign out" — a bare "sign-out" is a shape no
        // observation emits, and matching against it passes here while the
        // click never fires in production.
        reply({
          result:
            request.params?.name === "operate_observe"
              ? { safe_table: [{ ref: "@e5", role: "button", label: ${JSON.stringify(SIGN_OUT_LABEL)} }] }
              : { ok: true },
        });
        continue;
      }
      if (request.method === "close") {
        // The connection-level close (release) carries no session id; only
        // the session-tab close is worth recording.
        if (request.params?.sessionId != null) seen.closedSession = request.params.sessionId;
        reply({ result: { closed: true } });
        continue;
      }
      reply({ error: { code: "unsupported", message: "unsupported" } });
    }
  });
});
server.listen(socketPath);
fs.writeFileSync(lockPath + ".seen", JSON.stringify(seen), { mode: 0o600 });
const persist = () => fs.writeFileSync(lockPath + ".seen", JSON.stringify(seen), { mode: 0o600 });
setInterval(persist, 50);
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
async function connectFixture(opts: {
  forceReloginProviders?: readonly string[];
} = {}): Promise<{
  result: unknown;
  profileIdentity: string;
  lockNeverReleased: boolean;
  openUrl: string | null;
  closedSession: string | null;
  commands: { name: string | null; args: Record<string, unknown> | null }[];
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
  const { tryRunCeremonyInSharedBroker } = await import("../google-login.js");

  const socketPath = discovery.defaultBrokerSocket(targetProfile);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const lockPath = await profileLockPath(profileModule, targetProfile, lockRoot);
  const scriptPath = join(root, "broker-fixture.cjs");
  await writeFile(scriptPath, BROKER_FIXTURE_SCRIPT, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [scriptPath, "broker", socketPath, lockPath, TOKEN],
    { stdio: "ignore" },
  );
  cleanup.children.push(child);
  await waitFor(() => existsSync(lockPath) && existsSync(socketPath));

  await waitFor(() => existsSync(lockPath + ".seen"), 5_000).catch(() => undefined);
  const result = await tryRunCeremonyInSharedBroker({
    profileDir: targetProfile,
    url: CONFIRM_URL,
    deadline: Date.now() + 5_000,
    pollUntilDone: async () => true,
    bannerLabel: "fixture",
    ...(opts.forceReloginProviders
      ? { forceReloginProviders: opts.forceReloginProviders as ("google" | "github")[] }
      : {}),
  }).catch((error: unknown) => error);
  // The fixture persists its record on a short interval; wait for the close
  // so the assertion below cannot race the last persist tick.
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(lockPath + ".seen", "utf8")).closedSession !== null;
    } catch {
      return false;
    }
  }, 5_000).catch(() => undefined);
  const seen = ((): {
    openUrl: string | null;
    closedSession: string | null;
    commands: { name: string | null; args: Record<string, unknown> | null }[];
  } => {
    try {
      return JSON.parse(readFileSync(lockPath + ".seen", "utf8"));
    } catch {
      return { openUrl: null, closedSession: null, commands: [] };
    }
  })();
  return {
    result,
    profileIdentity: profileModule.profilePathIdentity(targetProfile),
    // Attaching never released the broker's custody of the profile, not even
    // momentarily: the ceremony is a tab in the broker's browser.
    lockNeverReleased: existsSync(lockPath),
    openUrl: seen.openUrl,
    closedSession: seen.closedSession,
    commands: seen.commands,
  };
}

describe("connect attaches to the live broker for the profile it is connecting", () => {
  it(
    "opens the confirm tab through the broker that owns the TARGET profile, not the process default",
    { timeout: 30_000 },
    async () => {
      const outcome = await connectFixture();
    expect(outcome.result).toEqual({ status: "satisfied", closeState: "closed" });
    // The confirm URL went to the broker whose socket belongs to the target
    // profile — the fixture is the only listener on it, and it received the
    // tab open.
    expect(outcome.openUrl).toBe(CONFIRM_URL);
    // The session tab is closed at the lease boundary.
    expect(outcome.closedSession).toBe("tab-1");
    // The profile lease was never touched: no drain, no guard, no second
    // Chrome, no wait.
      expect(outcome.lockNeverReleased).toBe(true);
    },
  );

  it(
    "drives the deferred --force-relogin logout through the shared session's own commands",
    { timeout: 30_000 },
    async () => {
      const outcome = await connectFixture({ forceReloginProviders: ["google", "github"] });
      expect(outcome.result).toEqual({ status: "satisfied", closeState: "closed" });
      expect(outcome.openUrl).toBe(CONFIRM_URL);
      // The logout drive rode the SAME session tab the ceremony opened — plain
      // operate_* commands on the wire, no extra session, no CDP attach:
      // Google's GET logout, GitHub's logout navigation, an observation whose
      // action map names the Sign out control, the click on THAT OBSERVED REF
      // (a bare text selector never resolves — operate_click only accepts a
      // ref a prior observation minted), then back to the confirm page for
      // the fresh sign-in.
      expect(outcome.commands).toEqual([
        { name: "operate_navigate", args: { url: "https://accounts.google.com/Logout" } },
        { name: "operate_navigate", args: { url: "https://github.com/logout" } },
        { name: "operate_observe", args: {} },
        { name: "operate_click", args: { ref: "@e5" } },
        { name: "operate_navigate", args: { url: CONFIRM_URL } },
      ]);
      expect(outcome.lockNeverReleased).toBe(true);
    },
  );
});
