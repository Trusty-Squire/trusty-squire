// profile.ts — the bot's persistent Chrome profile location.
//
// One canonical path, shared by two callers: google-login.ts writes the
// user's Google session into this profile, and BrowserController
// launches signup runs from it — so an OAuth signup reuses that
// session instead of starting logged-out. Override with
// TRUSTY_SQUIRE_PROFILE_DIR.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { CHROME_PROFILE_DIR, currentProfileDir, profilePathIdentity } from "./profile-path.js";

export { CHROME_PROFILE_DIR, currentProfileDir, profilePathIdentity };

// Chrome's SingletonLock is a symlink whose target is "<hostname>-<pid>".
// It belongs to Chrome; Squire reads it for diagnostics and never unlinks it.

// Thrown when the operation guard or Chrome's SingletonLock proves that a
// live process already owns the profile. Interactive CLI/MCP entry points
// fail immediately with PROFILE_BUSY_MESSAGE instead of waiting or exposing
// a raw Playwright SingletonLock stack trace.
export class ProfileBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileBusyError";
  }
}

export const PROFILE_BUSY_MESSAGE =
  "another Trusty Squire session is already using the browser — close it first";

export interface ProfileOperationLease {
  release(): void;
}

export interface ProfileProcessIdentity {
  host: string;
  pid: number;
  start_time: string;
  user_data_dir: string;
  process_group_id?: number | "unknown";
  // Diagnostic marker retained for the portable process-group fallback.
  process_marker?: string;
}

export type ProcessIdentityState = "matching" | "stale" | "unknown";
export type ProfileCloseState = "closed" | "force_closed_unproven" | "unknown";

export type ProcessStartTimeRead =
  | { state: "present"; startTime: string }
  | { state: "missing" }
  | { state: "unknown" };

function readProcessStartTime(pid: number): ProcessStartTimeRead {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const startTime = close < 0 ? undefined : stat.slice(close + 2).split(" ")[19];
      return startTime === undefined ? { state: "unknown" } : { state: "present", startTime };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ESRCH" ? { state: "missing" } : { state: "unknown" };
    }
  }
  try {
    if (process.platform === "darwin") {
      const startTime = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .replace(/\s+/g, " ");
      return startTime.length > 0
        ? { state: "present", startTime: `darwin:${startTime}` }
        : processExistenceState(pid);
    }
    if (process.platform === "win32") {
      const command =
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
        `if ($null -eq $p) { exit 3 };` +
        `$p.CreationDate.ToUniversalTime().ToString('O')`;
      const startTime = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return startTime.length > 0
        ? { state: "present", startTime: `win32:${startTime}` }
        : processExistenceState(pid);
    }
  } catch {
    return processExistenceState(pid);
  }
  return { state: "unknown" };
}

type LinuxProcessGroupIdRead = number | "stale" | "unknown";

function readLinuxProcessGroupId(pid: number): LinuxProcessGroupIdRead {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const processGroup = close < 0 ? undefined : Number(stat.slice(close + 2).split(" ")[2]);
    return processGroup !== undefined && Number.isSafeInteger(processGroup) && processGroup > 0
      ? processGroup
      : "unknown";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function processExistenceState(pid: number): ProcessStartTimeRead {
  try {
    process.kill(pid, 0);
    return { state: "unknown" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
      ? { state: "missing" }
      : { state: "unknown" };
  }
}

export function processBirthIdentity(
  pid: number,
): Pick<ProfileProcessIdentity, "pid" | "start_time"> | null {
  const read = readProcessStartTime(pid);
  return read.state === "present" ? { pid, start_time: read.startTime } : null;
}

export function processBirthIdentityState(
  identity: Pick<ProfileProcessIdentity, "pid" | "start_time">,
  readStartTime: (pid: number) => ProcessStartTimeRead = readProcessStartTime,
): ProcessIdentityState {
  if (identity.start_time === "unknown") return "unknown";
  const actual = readStartTime(identity.pid);
  if (actual.state === "missing") return "stale";
  if (actual.state === "unknown") return "unknown";
  return actual.startTime === identity.start_time ? "matching" : "stale";
}

export type ProcessProfileArgumentState = ProcessIdentityState | "missing";

export function processProfileArgumentState(
  pid: number,
  profileDir: string,
): ProcessProfileArgumentState {
  if (process.platform !== "linux") return "unknown";
  try {
    const expected = profilePathIdentity(profileDir);
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
    let candidate = argv
      .find((arg) => arg.startsWith("--user-data-dir="))
      ?.slice("--user-data-dir=".length);

    // Chrome may overwrite argv with a human-readable process title after
    // launch. Linux then exposes one space-delimited cmdline entry instead of
    // the original NUL-delimited argv. Keep the launch identity usable only
    // when that title still contains one exact --user-data-dir argument.
    if (candidate === undefined && argv.length === 1) {
      const match = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))(?=\s|$)/.exec(
        argv[0]!,
      );
      candidate = match?.[1] ?? match?.[2] ?? match?.[3];
    }
    if (candidate === undefined) return "missing";
    return profilePathIdentity(candidate) === expected ? "matching" : "stale";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

export function processProfileState(pid: number, profileDir: string): ProcessIdentityState {
  const state = processProfileArgumentState(pid, profileDir);
  return state === "missing" ? "stale" : state;
}

export function profileProcessIdentity(
  pid: number,
  profileDir: string,
): ProfileProcessIdentity | null {
  const startTime = readProcessStartTime(pid);
  if (startTime.state !== "present" || processProfileState(pid, profileDir) !== "matching") {
    return null;
  }
  const processGroupId = readLinuxProcessGroupId(pid);
  return {
    host: hostname(),
    pid,
    start_time: startTime.startTime,
    user_data_dir: profilePathIdentity(profileDir),
    ...(process.platform === "linux"
      ? { process_group_id: processGroupId === pid ? processGroupId : "unknown" }
      : {}),
  };
}

interface ProfileProcessIdentityReaders {
  readBirthState?: (identity: ProfileProcessIdentity) => ProcessIdentityState;
  readGroupMarkerState?: (identity: ProfileProcessIdentity) => ProcessIdentityState;
}

function linuxOperatorMarkerState(pid: number, marker: string): ProcessIdentityState {
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return entries.includes(`TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER=${marker}`)
      ? "matching"
      : "stale";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function linuxProcessUidState(pid: number): ProcessIdentityState {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === null) return "unknown";
  try {
    const match = /^Uid:\s+(.+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (match === null) return "unknown";
    const uids = match[1]!.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
    return uids.includes(currentUid) ? "matching" : "stale";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

export interface ProfileGroupReaders {
  processIds?: () => number[];
  groupId?: (pid: number) => LinuxProcessGroupIdRead;
  markerState?: (pid: number, marker: string) => ProcessIdentityState;
  uidState?: (pid: number) => ProcessIdentityState;
  profileState?: (pid: number, profileDir: string) => ProcessIdentityState;
}

export function profileProcessGroupMarkerState(
  identity: ProfileProcessIdentity,
  readers: ProfileGroupReaders = {},
): ProcessIdentityState {
  if (process.platform !== "linux" || identity.process_marker === undefined) return "stale";
  if (identity.process_group_id === undefined || identity.process_group_id === "unknown")
    return "unknown";
  let unknown = false;
  try {
    const pids =
      readers.processIds?.() ??
      readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    for (const pid of pids) {
      const groupId = (readers.groupId ?? readLinuxProcessGroupId)(pid);
      // This is a GROUP proof. An unreadable marker on a process in a proven
      // different group cannot keep this dead owner's reaper alive forever.
      if (groupId !== "unknown" && groupId !== identity.process_group_id) continue;
      const markerState = (readers.markerState ?? linuxOperatorMarkerState)(
        pid,
        identity.process_marker,
      );
      if (markerState === "stale") continue;
      if (markerState === "unknown") {
        if ((readers.uidState ?? linuxProcessUidState)(pid) !== "stale") unknown = true;
        continue;
      }
      const profileState = (readers.profileState ?? processProfileState)(
        pid,
        identity.user_data_dir,
      );
      if (profileState !== "matching") {
        unknown = true;
        continue;
      }
      if (groupId === identity.process_group_id) return "matching";
      if (groupId === "unknown") unknown = true;
    }
  } catch {
    return "unknown";
  }
  return unknown ? "unknown" : "stale";
}

export function profileProcessIdentityState(
  identity: ProfileProcessIdentity,
  profileDir: string,
  readers: ProfileProcessIdentityReaders = {},
): ProcessIdentityState {
  if (identity.host !== hostname()) return "unknown";
  if (profilePathIdentity(identity.user_data_dir) !== profilePathIdentity(profileDir)) {
    return "stale";
  }
  const birth = readers.readBirthState?.(identity) ?? processBirthIdentityState(identity);
  if (birth === "matching") return processProfileState(identity.pid, profileDir);
  if (birth === "unknown") return "unknown";
  if (identity.process_marker === undefined || identity.process_group_id === undefined) {
    return "stale";
  }
  return readers.readGroupMarkerState?.(identity) ?? profileProcessGroupMarkerState(identity);
}

export function profileProcessMatches(
  identity: ProfileProcessIdentity,
  profileDir: string,
): boolean {
  return profileProcessIdentityState(identity, profileDir) === "matching";
}

export function signalProfileProcess(
  identity: ProfileProcessIdentity,
  profileDir: string,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): boolean {
  const leaderMatches = profileProcessMatches(identity, profileDir);
  const currentProcessGroupId = leaderMatches ? readLinuxProcessGroupId(identity.pid) : "stale";
  const markedGroupSurvives =
    !leaderMatches &&
    typeof identity.process_group_id === "number" &&
    identity.process_group_id === identity.pid &&
    identity.process_marker !== undefined &&
    linuxProcessGroupHasMarker(identity.process_group_id, identity.process_marker);
  if (!leaderMatches && !markedGroupSurvives) return false;
  const signalTarget =
    identity.process_group_id === identity.pid &&
    (currentProcessGroupId === identity.pid || markedGroupSurvives)
      ? -identity.pid
      : identity.pid;
  try {
    kill(signalTarget, signal);
    return true;
  } catch {
    return false;
  }
}

function linuxProcessGroupHasMarker(processGroupId: number, marker: string): boolean {
  if (process.platform !== "linux") return false;
  const prefix = "TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER=";
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (readLinuxProcessGroupId(pid) !== processGroupId) continue;
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (environ.some((value) => value === `${prefix}${marker}`)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function closeProfileWithProof(opts: {
  profileDir: string;
  identity: ProfileProcessIdentity | null;
  close: () => Promise<void>;
  forceClose: () => unknown;
  closeTimeoutMs?: number;
  proofTimeoutMs?: number;
  pollMs?: number;
  identityState?: () => ProcessIdentityState;
}): Promise<ProfileCloseState> {
  const closeTimeoutMs = opts.closeTimeoutMs ?? 15_000;
  const proofTimeoutMs = opts.proofTimeoutMs ?? 2_000;
  const pollMs = opts.pollMs ?? 25;
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    Promise.resolve()
      .then(opts.close)
      .then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
    new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), closeTimeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome !== "resolved") {
    try {
      opts.forceClose();
    } catch {
      return "force_closed_unproven";
    }
    return "force_closed_unproven";
  }
  if (opts.identity === null) return "unknown";
  const identityState =
    opts.identityState ?? (() => profileProcessIdentityState(opts.identity!, opts.profileDir));
  const deadline = Date.now() + proofTimeoutMs;
  let state = identityState();
  while (state !== "stale" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    state = identityState();
  }
  if (state === "stale") {
    return "closed";
  }
  if (state === "unknown") return "unknown";
  try {
    opts.forceClose();
  } catch {
    return "force_closed_unproven";
  }
  return "force_closed_unproven";
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
const profileOperationContext = new AsyncLocalStorage<ReadonlySet<string>>();

/** A stable SQLite file is only the lock's inode; it contains no owner record. It
 * must stay outside the profile directory because --force-relogin may replace
 * that directory while custody is held. */
export function profileOperationLockPath(profileDir: string): string {
  const identity = profilePathIdentity(profileDir);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return join(dirname(identity), `.trusty-squire-profile-${digest}.lock.sqlite`);
}

/** BEGIN EXCLUSIVE holds SQLite's OS byte-range lock on the open connection.
 * The kernel drops it on every exit path, including SIGKILL. The file itself
 * contains no owner record and is never unlinked. */
export function acquireProfileOperationGuard(
  profileDir: string = CHROME_PROFILE_DIR,
): ProfileOperationLease {
  const path = profileOperationLockPath(profileDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(path, { timeout: 0 });
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db?.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY" ||
        (error as { code?: string }).code === "SQLITE_LOCKED") {
      throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
    }
    throw error;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try { db!.exec("ROLLBACK"); } finally { db!.close(); }
    },
  };
}

export function profileOperationIsLocked(profileDir: string = CHROME_PROFILE_DIR): boolean {
  try {
    const lease = acquireProfileOperationGuard(profileDir);
    lease.release();
    return false;
  } catch (error) {
    if (error instanceof ProfileBusyError) return true;
    throw error;
  }
}

export async function acquireFreeProfileOperationGuard(
  profileDir: string = CHROME_PROFILE_DIR,
): Promise<ProfileOperationLease> {
  const lease = acquireProfileOperationGuard(profileDir);
  if (await waitForProfileFree(profileDir, { deadlineMs: 0 })) return lease;
  lease.release();
  throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
}

export async function withProfileOperationGuard<T>(
  profileDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = profilePathIdentity(profileDir);
  const active = profileOperationContext.getStore();
  if (active?.has(key) === true) return await fn();
  const lease = await acquireFreeProfileOperationGuard(profileDir);
  try {
    return await profileOperationContext.run(new Set([...(active ?? []), key]), fn);
  } finally {
    lease.release();
  }
}

// process.kill(pid, 0) is a liveness probe — it sends no signal, it only
// asks "does this pid exist and am I allowed to signal it". ESRCH = the
// process is gone (stale lock). EPERM = it exists but isn't ours (still
// alive — do NOT treat as stale). Any other error: assume alive, because
// yanking a live profile's lock corrupts it.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockHolder {
  host: string;
  pid: number;
  // True when the holder is a dead pid on THIS host — i.e. reclaimable.
  // A live pid, or any pid on another machine (shared profile), is not.
  stale: boolean;
}

// Read + parse Chrome's SingletonLock symlink ("<host>-<pid>"). null when
// there is no lock (the profile is free) or the link is malformed. A pure
// read: it never removes a lock, sweeps an owner, or signals a process.
export function readLockHolder(profileDir: string): LockHolder | null {
  const lockPath = join(profileDir, "SingletonLock");
  let target: string;
  try {
    if (!lstatSync(lockPath).isSymbolicLink()) return null;
    target = readlinkSync(lockPath);
  } catch {
    return null;
  }
  // The host may itself contain hyphens, so split on the LAST one.
  const dash = target.lastIndexOf("-");
  if (dash < 0) return null;
  const host = target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const onThisHost = host === hostname();
  return { host, pid, stale: onThisHost && !isPidAlive(pid) };
}

// The pid currently holding the profile's SingletonLock, IF it is on this
// host. Read right after a successful launch, this is unambiguously the
// Chrome WE just started (it created the lock). Stored by the caller so
// close() can verify the same process and reap it if it leaks. null when
// there's no lock or the holder is on another machine.
export function currentProfileHolderPid(profileDir: string = CHROME_PROFILE_DIR): number | null {
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname()) return null;
  return holder.pid;
}

export function signalProfileHolderIfOwned(
  profileDir: string,
  identity: ProfileProcessIdentity | null,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): boolean {
  if (identity === null) return false;
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname() || holder.pid !== identity.pid) return false;
  if (holder.stale) return false;
  signalProfileProcess(identity, profileDir, "SIGKILL", kill);
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WaitForProfileOptions {
  // Max time to wait for a LIVE cross-process holder to release.
  deadlineMs?: number;
  pollMs?: number;
  // Fired once, the first time we actually have to wait on a live holder
  // (so the caller can print "another run is using the browser — waiting…").
  onWait?: (holder: LockHolder) => void;
}

// Cross-process serialization gate for the shared Chrome profile.
//
// The signup bot (in the MCP server) and a separate `mcp connect` process
// both open the one profile, and Chrome single-instances it. Rather than
// run a parallel lock system, this waits on Chrome's OWN SingletonLock as
// the semaphore:
//   - no lock              → free, return immediately
//   - lock, holder dead    → let Chrome decide how to handle its own symlink
//   - lock, holder alive   → poll for release, up to deadlineMs
//
// Returns true once the profile is free to open, or false if a live
// holder never released within the deadline (caller surfaces ProfileBusyError).
// Interactive entry points pass a zero deadline: they await bounded owner
// recovery but do not poll a remaining live holder. Internal probes may wait.
export async function waitForProfileFree(
  profileDir: string = CHROME_PROFILE_DIR,
  opts: WaitForProfileOptions = {},
): Promise<boolean> {
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + deadlineMs;
  let warned = false;
  for (;;) {
    const holder = readLockHolder(profileDir);
    if (holder === null || holder.stale) return true;
    // Live holder (or a pid on another host we can't reclaim).
    if (!warned) {
      warned = true;
      opts.onWait?.(holder);
    }
    if (Date.now() >= deadline) return false; // never freed → busy
    await sleep(pollMs);
  }
}

// True when the error is Chrome/Playwright refusing to open the profile
// because the single-instance lock already exists.
function isSingletonCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ProcessSingleton|SingletonLock/i.test(msg);
}

// Open the profile, retrying on the free→launch race.
//
// waitForProfileFree closes the long window, but there is still a
// sub-second gap between "lock is absent" and Chrome creating it where a
// second process can win — launchPersistentContext then throws
// "Failed to create a ProcessSingleton". This wraps the launch: on that
// specific collision, `failFast` maps it immediately to the standard busy
// error. Legacy callers without `failFast` re-wait for the new holder
// (reclaiming it if it died) and relaunch up to `retries` times. Any other
// error, or a holder that never releases, propagates.
export async function launchWithProfileGate<T>(
  profileDir: string,
  launch: () => Promise<T>,
  opts: { retries?: number; reWaitMs?: number; failFast?: boolean } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await launch();
    } catch (err) {
      if (!isSingletonCollision(err)) throw err;
      if (opts.failFast === true) throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
      if (attempt >= retries) throw err;
      const free = await waitForProfileFree(profileDir, {
        deadlineMs: opts.reWaitMs ?? 30_000,
        pollMs: 500,
      });
      if (!free) {
        throw new ProfileBusyError(
          "bot Chrome profile stayed locked across launch retries — another run isn't releasing it",
        );
      }
    }
  }
}
