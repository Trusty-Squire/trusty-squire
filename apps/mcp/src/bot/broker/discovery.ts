import { createHash } from "node:crypto";
import { closeSync, mkdirSync, lstatSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireProfileOperationGuard,
  ProfileBusyError,
  profileOperationLockOwner,
  profilePathIdentity,
  processBirthIdentityState,
  CHROME_PROFILE_DIR,
  type ProfileOperationLease,
} from "../profile.js";
import {
  BrokerClient,
  brokerEndpointHasLiveListener,
  brokerSpeaksLegacyWire,
} from "./transport.js";
import { readBrokerAccountBinding } from "./account-binding.js";
import { BrokerRefusal } from "./refusal.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

/** Bounded reclaim windows for a resident broker: SIGTERM first, then
 * SIGKILL only if the graceful window does not clear the profile election
 * lease and socket. Shared by prior-contract (#823) and same-contract
 * stale-credential (#849) reclaim. Internal timing only — never a tool
 * parameter or config knob. */
interface ReclaimTimings {
  termGraceMs: number;
  killGraceMs: number;
  pollMs: number;
}
const RECLAIM_TIMINGS: ReclaimTimings = {
  termGraceMs: 10_000,
  killGraceMs: 5_000,
  pollMs: 100,
};

/** Canonical profile discovery is independent of cwd and each client's TMPDIR. */
export function defaultBrokerSocket(profileDir = CHROME_PROFILE_DIR): string {
  const key = createHash("sha256")
    .update(profilePathIdentity(profileDir))
    .digest("hex")
    .slice(0, 32);
  return join(
    "/tmp",
    `trusty-squire-broker-${process.getuid?.() ?? "local"}-${key}`,
    "broker.sock",
  );
}

/** Where a profile's broker socket lives: the configured override, else the
 * derived default. Pure — no directory is created and nothing is asserted, so
 * a read-only probe can ask for a path that may not exist. */
export function brokerSocketPath(): string {
  const configured = process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  if (configured) return configured;
  return defaultBrokerSocket();
}

export function resolveBrokerSocket(): string {
  const path = brokerSocketPath();
  if (path !== defaultBrokerSocket()) return path;
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  return path;
}

export function brokerElectionRoot(profileDir = CHROME_PROFILE_DIR): string {
  return join(dirname(profilePathIdentity(profileDir)), ".trusty-squire-broker-leases");
}

export function brokerLaunchRoot(profileDir = CHROME_PROFILE_DIR): string {
  return join(brokerElectionRoot(profileDir), "launch");
}

async function prepareBrokerElectionRoot(profileDir: string): Promise<string> {
  const root = brokerElectionRoot(profileDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function brokerElectionIsHeld(profileDir: string): Promise<boolean> {
  const root = await prepareBrokerElectionRoot(profileDir);
  try {
    const lease = acquireProfileOperationGuard(profileDir, root);
    lease.release();
    return false;
  } catch (error) {
    if (error instanceof ProfileBusyError) return true;
    throw error;
  }
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "broker_lost";
}

function isUnauthorizedRefusal(error: unknown): boolean {
  return error instanceof BrokerRefusal && error.code === "unauthorized";
}

/** Contract B processed `connect` and rejected the token digest. A
 * prior-contract daemon never produces this: it refuses `connect` with
 * "Authenticate before issuing commands" and only authenticates `hello`. */
function isInvalidBrokerCredential(error: unknown): boolean {
  return (
    error instanceof BrokerRefusal &&
    error.code === "unauthorized" &&
    error.message === "Invalid broker credential"
  );
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort argv corroboration that a lease owner really is a broker
 * daemon: the daemon is spawned with a `broker` argv marker in this repo
 * (connectOrLaunchBroker's spawn, kept in sync with this check). Returns
 * true when the argv cannot be read, because the wire probe and election
 * lease already carry the positive identification. */
function processArgvLooksLikeBroker(pid: number): boolean {
  if (process.platform !== "linux") return true;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
    return argv.includes("broker");
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Connected SOCK_STREAM peers on a pathname Unix socket (Linux
 * `/proc/net/unix` state 03). Null when the count cannot be observed.
 * Reclaim uses this to refuse killing a stale-credential broker that still
 * has attached clients. */
function brokerSocketConnectedPeerCount(path: string): number | null {
  if (process.platform !== "linux") return null;
  try {
    let n = 0;
    for (const line of readFileSync("/proc/net/unix", "utf8").split("\n")) {
      if (!line.includes(path)) continue;
      const fields = line.trim().split(/\s+/);
      // Num: RefCount Protocol Flags Type St Inode Path…
      if (fields.length < 8) continue;
      if (fields.slice(7).join(" ") !== path) continue;
      if (fields[5] === "03") n += 1;
    }
    return n;
  } catch {
    return null;
  }
}

/** The profile election lease plus a live broker-argv process on this host
 * identify the resident: the daemon holds the election lease for its whole
 * life, so the lease owner is the daemon the wire probe proved resident.
 * Returns null when any link of that identification is missing. Shared by
 * prior-contract and same-contract stale-credential reclaim. */
function residentBrokerPid(profileDir: string): number | null {
  const owner = profileOperationLockOwner(profileDir, brokerElectionRoot(profileDir));
  if (owner === null || owner.host !== hostname()) return null;
  const { pid, start_time } = owner;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
  if (!isProcessAlive(pid)) return null;
  // A provably-reborn pid means the lease is a dead owner's leftover; the
  // ordinary scavenge path owns that case and no signal may be sent.
  if (start_time !== null && processBirthIdentityState({ pid, start_time }) === "stale") {
    return null;
  }
  if (!processArgvLooksLikeBroker(pid)) return null;
  return pid;
}

/** Wait for the election lease to become acquirable and the socket to have
 * no live listener. Acquiring (and releasing) reuses the lease machinery's
 * own stale-owner scavenging, which is what clears a SIGKILLed holder's
 * leftover lock. */
async function waitForReclaimClear(
  profileDir: string,
  path: string,
  deadline: number,
  pollMs: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    let electionFree = false;
    try {
      const lease = acquireProfileOperationGuard(profileDir, brokerElectionRoot(profileDir));
      lease.release();
      electionFree = true;
    } catch (error) {
      if (!(error instanceof ProfileBusyError)) throw error;
    }
    if (electionFree && !(await brokerEndpointHasLiveListener(path))) return true;
    await sleep(pollMs);
  }
  return false;
}

/** Reclaim the profile from a positively identified resident broker:
 * SIGTERM, then a bounded wait for its lease and socket to clear, escalating
 * to SIGKILL only if the graceful path does not clear it. Throws a refusal
 * that names the pid when reclaim cannot complete. */
async function terminateResidentBroker(
  profileDir: string,
  path: string,
  pid: number,
  timings: ReclaimTimings,
  unavailableMessage: (pid: number) => string,
): Promise<void> {
  for (const [signal, graceMs] of [
    ["SIGTERM", timings.termGraceMs],
    ["SIGKILL", timings.killGraceMs],
  ] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone: fall through and let the clear-wait decide.
    }
    if (await waitForReclaimClear(profileDir, path, Date.now() + graceMs, timings.pollMs)) {
      return;
    }
  }
  throw new BrokerRefusal("broker_unavailable", unavailableMessage(pid));
}

function staleCredentialLiveClientMessage(pid: number): string {
  return (
    `A resident broker (pid ${pid}) still owns this profile with a stale credential ` +
    `and an attached client; finish those sessions, or confirm no other client is ` +
    `attached and terminate pid ${pid} (TERM), then retry. No operator command was dispatched`
  );
}

function staleCredentialUnreclaimedMessage(pid: number): string {
  return (
    `A resident broker (pid ${pid}) still owns this profile's browser with a stale ` +
    `credential and could not be reclaimed; confirm no other client is attached, ` +
    `terminate pid ${pid} (TERM), then retry. No operator command was dispatched`
  );
}

/** Reclaims a resident prior-contract broker for this profile, if one is
 * positively identified: a live daemon that refuses Contract B's `connect`
 * but still authenticates the pre-Contract-B `hello` handshake, while
 * holding this profile's election lease. A same-contract daemon never
 * authenticates `hello` (or is reached only through the ENOENT/unavailable
 * path), so it is never a prior-contract reclaim target — stale-credential
 * reclaim owns that case separately. Returns whether a reclaim happened;
 * throws only when a reclaim was proven possible but could not complete. */
export async function reclaimPriorContractBrokerIfPresent(
  path: string,
  token: string,
  connectError: unknown,
  timings: ReclaimTimings = RECLAIM_TIMINGS,
): Promise<boolean> {
  if (!isUnauthorizedRefusal(connectError)) return false;
  if (!(await brokerSpeaksLegacyWire(path, token))) return false;
  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  const pid = residentBrokerPid(profileDir);
  if (pid === null) return false;
  await terminateResidentBroker(
    profileDir,
    path,
    pid,
    timings,
    (owner) =>
      `A resident broker from an older release (pid ${owner}) still owns this profile's browser and could not be reclaimed; no operator command was dispatched`,
  );
  return true;
}

/** Reclaims a same-contract broker whose credential digest no longer matches
 * the current agent session token: Contract B's `connect` handshake is
 * accepted (the current-contract successor of `hello`) and the credential is
 * rejected, the process holds this profile's election lease with a live
 * broker-argv owner on this host, the profile is enrolled to the caller's own
 * account, and the resident has no attached clients.
 *
 * The credential rejection alone cannot tell a rotated token from another
 * account's broker — one profile and one socket serve every account on the
 * box — so the profile's account binding is what proves the resident is ours.
 * A broker bound to another account (or carrying no readable binding) is left
 * alone and the original refusal propagates.
 *
 * A broker with attached clients is never killed; the refusal names the pid
 * and the manual TERM reclaim step. SIGKILL is skipped if a client appears
 * after SIGTERM. Returns whether a reclaim happened; throws when the
 * resident is identified but must not be (or could not be) reclaimed. */
export async function reclaimStaleCredentialBrokerIfPresent(
  path: string,
  accountId: string | undefined,
  connectError: unknown,
  timings: ReclaimTimings = RECLAIM_TIMINGS,
): Promise<boolean> {
  // A prior-contract daemon never produces this exact refusal (it refuses
  // `connect` with "Authenticate before issuing commands"), so the legacy
  // reclaim path owns that case and cannot double-signal here.
  if (!isInvalidBrokerCredential(connectError)) return false;
  if (accountId === undefined) return false;
  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  if ((await readBrokerAccountBinding(profileDir)) !== accountId) return false;
  const pid = residentBrokerPid(profileDir);
  if (pid === null) return false;
  // The connect that just rejected us may still appear as a peer for a
  // tick after socket.destroy(). Wait it out so an empty stale broker is
  // reclaimed instead of being mistaken for an attached client.
  const peerDeadline = Date.now() + 250;
  let peers = brokerSocketConnectedPeerCount(path) ?? 0;
  while (peers > 0 && Date.now() < peerDeadline) {
    await sleep(25);
    peers = brokerSocketConnectedPeerCount(path) ?? 0;
  }
  if (peers > 0) {
    throw new BrokerRefusal("broker_unavailable", staleCredentialLiveClientMessage(pid));
  }
  for (const [signal, graceMs] of [
    ["SIGTERM", timings.termGraceMs],
    ["SIGKILL", timings.killGraceMs],
  ] as const) {
    if (signal === "SIGKILL" && (brokerSocketConnectedPeerCount(path) ?? 0) > 0) {
      throw new BrokerRefusal("broker_unavailable", staleCredentialLiveClientMessage(pid));
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone: fall through and let the clear-wait decide.
    }
    if (await waitForReclaimClear(profileDir, path, Date.now() + graceMs, timings.pollMs)) {
      return true;
    }
  }
  throw new BrokerRefusal("broker_unavailable", staleCredentialUnreclaimedMessage(pid));
}

async function waitForBroker(
  path: string,
  token: string,
  failure?: () => Error | undefined,
): Promise<BrokerClient> {
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const launchFailure = failure?.();
    if (launchFailure !== undefined) throw launchFailure;
    try {
      return await BrokerClient.connect(path, token);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, BROKER_CONNECT_POLL_MS));
  }
  throw new BrokerRefusal(
    "broker_unavailable",
    "Broker did not become available within 10 seconds; no operator command was dispatched",
  );
}

export function brokerEnvironment(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...env, TRUSTY_SQUIRE_BROKER_SOCKET: path };
}

/**
 * A daemon claims the profile-operation lease during startup, BEFORE it
 * listens, so a lease another process holds kills it there — most often the
 * `connect` ceremony, which holds that lease for a whole interactive login.
 * Reporting that as a merely unavailable broker sends the caller to restart a
 * broker that cannot start, and the advised retry loops until connect ends.
 */
function daemonExitRefusal(
  profileDir: string,
  reason: NodeJS.Signals | number | null,
): BrokerRefusal {
  const owner = profileOperationLockOwner(profileDir, tmpdir());
  if (owner !== null && owner.host === hostname() && owner.pid !== process.pid)
    return new BrokerRefusal(
      "profile_busy",
      `The Chrome profile lease is held by pid ${owner.pid}; no operator command was dispatched`,
    );
  return new BrokerRefusal(
    "broker_unavailable",
    `Broker exited before attachment (${reason}); no operator command was dispatched`,
  );
}

export async function connectOrLaunchBroker(
  path: string,
  token: string,
  accountId: string | undefined,
): Promise<BrokerClient> {
  try {
    return await BrokerClient.connect(path, token);
  } catch (error) {
    if (isUnavailable(error)) {
      // A socket with no live listener is a dead predecessor's orphan; the new
      // broker's own bind reclaims it (probe -> unlink -> bind).
    } else if (await reclaimPriorContractBrokerIfPresent(path, token, error)) {
      // A reclaimed prior-contract broker freed the profile: fall through to
      // the ordinary launch of a current-contract daemon.
    } else if (await reclaimStaleCredentialBrokerIfPresent(path, accountId, error)) {
      // A reclaimed same-contract broker whose digest lagged a re-enrollment
      // or skipped maintenance refresh: fall through to a fresh daemon that
      // reads the current agent session token.
    } else {
      throw error;
    }
  }

  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  if (await brokerElectionIsHeld(profileDir)) return await waitForBroker(path, token);
  const launchRoot = brokerLaunchRoot(profileDir);
  let launchLease: ProfileOperationLease;
  try {
    await mkdir(launchRoot, { recursive: true, mode: 0o700 });
    launchLease = acquireProfileOperationGuard(profileDir, launchRoot);
  } catch (error) {
    if (error instanceof ProfileBusyError) return await waitForBroker(path, token);
    throw error;
  }
  try {
    try {
      return await BrokerClient.connect(path, token);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    if (await brokerElectionIsHeld(profileDir)) return await waitForBroker(path, token);
    // The broker's stderr carries its diagnostic channel (audit unseal lines,
    // captcha/handoff diag). "ignore" made every standard deployment mute —
    // measured while debugging the Bluesky signup gate (2026-09): the broker
    // printed nothing anywhere. The daemon outlives this parent (detached,
    // unref'd), so the log must be a real file fd, not a pipe: a pipe dies
    // with the parent and the first write afterwards EPIPEs the broker. Best
    // effort — a log that cannot be opened must not block the launch.
    let brokerLogFd: number | undefined;
    try {
      brokerLogFd = openSync(join(launchRoot, "broker.log"), "a", 0o600);
    } catch {
      brokerLogFd = undefined;
    }
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../bin.js", import.meta.url)), "broker"],
      {
        detached: true,
        stdio: brokerLogFd === undefined ? "ignore" : ["ignore", brokerLogFd, brokerLogFd],
        env: brokerEnvironment(process.env, path),
      },
    );
    // The child dups its own copies of the fd at spawn; release ours.
    if (brokerLogFd !== undefined) closeSync(brokerLogFd);
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", (code, signal) => {
      failure = daemonExitRefusal(profileDir, signal ?? code);
    });
    child.unref();
    return await waitForBroker(path, token, () => failure);
  } finally {
    launchLease.release();
  }
}
