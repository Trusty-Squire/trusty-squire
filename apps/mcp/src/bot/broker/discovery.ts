import { createHash } from "node:crypto";
import { closeSync, mkdirSync, lstatSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
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
import { BrokerRefusal } from "./refusal.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

/** Bounded reclaim windows for a resident prior-contract broker: SIGTERM
 * first, then SIGKILL only if the graceful window does not clear the
 * profile election lease and socket. Internal timing only — never a tool
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

export function resolveBrokerSocket(): string {
  const configured = process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  if (configured) return configured;
  const path = defaultBrokerSocket();
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

/** The profile election lease plus a live prior-contract handshake identify
 * the resident positively: the daemon holds the election lease for its whole
 * life, so the lease owner is the daemon the probe proved resident. Returns
 * null when any link of that identification is missing. */
function priorContractBrokerPid(profileDir: string): number | null {
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

/** Reclaim the profile from the positively identified prior-contract broker:
 * SIGTERM, then a bounded wait for its lease and socket to clear, escalating
 * to SIGKILL only if the graceful path does not clear it. Throws a refusal
 * that names the resident older-contract broker when reclaim cannot
 * complete. */
async function terminatePriorContractBroker(
  profileDir: string,
  path: string,
  pid: number,
  timings: ReclaimTimings,
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
  throw new BrokerRefusal(
    "broker_unavailable",
    `A resident broker from an older release (pid ${pid}) still owns this profile's browser and could not be reclaimed; no operator command was dispatched`,
  );
}

/** Reclaims a resident prior-contract broker for this profile, if one is
 * positively identified: a live daemon that refuses Contract B's `connect`
 * but still authenticates the pre-Contract-B `hello` handshake, while
 * holding this profile's election lease. A same-contract daemon — including
 * one that holds the lease before its socket appears — never authenticates
 * `hello` (or is reached only through the ENOENT/unavailable path), so it is
 * never a reclaim target. Returns whether a reclaim happened; throws only
 * when a reclaim was proven possible but could not complete. */
export async function reclaimPriorContractBrokerIfPresent(
  path: string,
  token: string,
  connectError: unknown,
  timings: ReclaimTimings = RECLAIM_TIMINGS,
): Promise<boolean> {
  if (!isUnauthorizedRefusal(connectError)) return false;
  if (!(await brokerSpeaksLegacyWire(path, token))) return false;
  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  const pid = priorContractBrokerPid(profileDir);
  if (pid === null) return false;
  await terminatePriorContractBroker(profileDir, path, pid, timings);
  return true;
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

export async function connectOrLaunchBroker(path: string, token: string): Promise<BrokerClient> {
  try {
    return await BrokerClient.connect(path, token);
  } catch (error) {
    if (isUnavailable(error)) {
      // A socket with no live listener is a dead predecessor's orphan; the new
      // broker's own bind reclaims it (probe -> unlink -> bind).
    } else if (!(await reclaimPriorContractBrokerIfPresent(path, token, error))) {
      throw error;
    }
    // A reclaimed prior-contract broker freed the profile: fall through to
    // the ordinary launch of a new-contract daemon.
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
      failure = new BrokerRefusal(
        "broker_unavailable",
        `Broker exited before attachment (${signal ?? code}); no operator command was dispatched`,
      );
    });
    child.unref();
    return await waitForBroker(path, token, () => failure);
  } finally {
    launchLease.release();
  }
}
