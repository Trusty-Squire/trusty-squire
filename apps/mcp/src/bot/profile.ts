// profile.ts — the bot's persistent Chrome profile location.
//
// One canonical path, shared by two callers: google-login.ts writes the
// user's Google session into this profile, and BrowserController
// launches signup runs from it — so an OAuth signup reuses that
// session instead of starting logged-out. Override with
// TRUSTY_SQUIRE_PROFILE_DIR.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CHROME_PROFILE_DIR =
  process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? join(homedir(), ".trusty-squire", "chrome-profile");

// Chrome's single-instance trio. SingletonLock is a symlink whose target
// is "<hostname>-<pid>"; the other two are sockets/cookies beside it.
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

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
}

export type ProcessIdentityState = "matching" | "stale" | "unknown";
export type ProfileCloseState = "closed" | "force_closed_unproven" | "unknown";

export type ProcessStartTimeRead =
  | { state: "present"; startTime: string }
  | { state: "missing" }
  | { state: "unknown" };

function readProcessStartTime(pid: number): ProcessStartTimeRead {
  if (process.platform !== "linux") return { state: "unknown" };
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

function processProfileState(pid: number, profileDir: string): ProcessIdentityState {
  if (process.platform !== "linux") return "unknown";
  try {
    const expected = resolve(profileDir);
    const matches = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .some(
        (arg) =>
          arg.startsWith("--user-data-dir=") &&
          resolve(arg.slice("--user-data-dir=".length)) === expected,
      );
    return matches ? "matching" : "stale";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

export function profileProcessIdentity(
  pid: number,
  profileDir: string,
): ProfileProcessIdentity | null {
  const startTime = readProcessStartTime(pid);
  if (startTime.state !== "present" || processProfileState(pid, profileDir) !== "matching") {
    return null;
  }
  return {
    host: hostname(),
    pid,
    start_time: startTime.startTime,
    user_data_dir: resolve(profileDir),
  };
}

export function profileProcessIdentityState(
  identity: ProfileProcessIdentity,
  profileDir: string,
): ProcessIdentityState {
  if (identity.host !== hostname()) return "unknown";
  if (resolve(identity.user_data_dir) !== resolve(profileDir)) return "stale";
  const birth = processBirthIdentityState(identity);
  if (birth !== "matching") return birth;
  return processProfileState(identity.pid, profileDir);
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
  if (!profileProcessMatches(identity, profileDir)) return false;
  try {
    kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
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
  if (state === "stale") return "closed";
  if (state === "unknown") return "unknown";
  try {
    opts.forceClose();
  } catch {
    return "force_closed_unproven";
  }
  return "force_closed_unproven";
}

interface ProfileOperationOwner {
  host: string;
  pid: number;
  token: string;
}

const profileOperationContext = new AsyncLocalStorage<ReadonlySet<string>>();

function profileOperationLockDir(profileDir: string, lockRoot: string): string {
  const digest = createHash("sha256").update(resolve(profileDir)).digest("hex").slice(0, 24);
  return join(lockRoot, `trusty-squire-profile-${digest}.lock`);
}

function readProfileOperationOwner(lockDir: string): ProfileOperationOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const owner = parsed as Partial<ProfileOperationOwner>;
    if (
      typeof owner.host !== "string" ||
      typeof owner.pid !== "number" ||
      typeof owner.token !== "string"
    ) {
      return null;
    }
    return { host: owner.host, pid: owner.pid, token: owner.token };
  } catch {
    return null;
  }
}

export function acquireProfileOperationGuard(
  profileDir: string = CHROME_PROFILE_DIR,
  lockRoot: string = tmpdir(),
): ProfileOperationLease {
  const lockDir = profileOperationLockDir(profileDir, lockRoot);
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readProfileOperationOwner(lockDir);
      if (owner !== null && owner.host === hostname() && !isPidAlive(owner.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
    }
    try {
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({ host: hostname(), pid: process.pid, token }),
        { mode: 0o600 },
      );
    } catch (err) {
      rmSync(lockDir, { recursive: true, force: true });
      throw err;
    }
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        if (readProfileOperationOwner(lockDir)?.token === token) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      },
    };
  }
}

export async function acquireFreeProfileOperationGuard(
  profileDir: string = CHROME_PROFILE_DIR,
  lockRoot: string = tmpdir(),
): Promise<ProfileOperationLease> {
  const lease = acquireProfileOperationGuard(profileDir, lockRoot);
  if (await waitForProfileFree(profileDir, { deadlineMs: 0 })) return lease;
  lease.release();
  throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
}

export async function withProfileOperationGuard<T>(
  profileDir: string,
  fn: () => Promise<T>,
  lockRoot: string = tmpdir(),
): Promise<T> {
  const key = resolve(profileDir);
  const active = profileOperationContext.getStore();
  if (active?.has(key) === true) return await fn();
  const lease = await acquireFreeProfileOperationGuard(profileDir, lockRoot);
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
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockHolder {
  host: string;
  pid: number;
  // True when the holder is a dead pid on THIS host — i.e. reclaimable.
  // A live pid, or any pid on another machine (shared profile), is not.
  stale: boolean;
}

// Read + parse Chrome's SingletonLock symlink ("<host>-<pid>"). null when
// there is no lock (the profile is free) or the link is malformed.
function readLockHolder(profileDir: string): LockHolder | null {
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

function removeSingletons(profileDir: string): void {
  for (const f of SINGLETON_FILES) {
    try {
      rmSync(join(profileDir, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

// Self-heal a stale Chrome SingletonLock on the bot profile.
//
// Chrome single-instances a userDataDir via SingletonLock. A run that was
// SIGKILLed or a bot Chrome we tore down hard leaves the lock behind, and
// Playwright's launchPersistentContext then aborts with "Failed to create
// a ProcessSingleton ... File exists". Removing it is safe ONLY when the
// holder is provably gone (dead pid on this host). A lock held by a LIVE
// pid is a genuine concurrent run and is left untouched. Returns true iff
// a stale lock was cleared. Never throws.
export function clearStaleSingletonLock(profileDir: string = CHROME_PROFILE_DIR): boolean {
  const holder = readLockHolder(profileDir);
  if (holder === null || !holder.stale) return false;
  removeSingletons(profileDir);
  return true;
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

export function reapLeakedProfileHolder(profileDir: string = CHROME_PROFILE_DIR): boolean {
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname()) return false;
  if (!holder.stale) {
    const identity = profileProcessIdentity(holder.pid, profileDir);
    if (identity === null || !signalProfileProcess(identity, profileDir, "SIGKILL")) return false;
  }
  removeSingletons(profileDir);
  return true;
}

export function reapProfileHolderIfOwned(
  profileDir: string,
  identity: ProfileProcessIdentity | null,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): boolean {
  if (identity === null) return false;
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname() || holder.pid !== identity.pid) return false;
  if (!holder.stale && !signalProfileProcess(identity, profileDir, "SIGKILL", kill)) return false;
  removeSingletons(profileDir);
  return true;
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
// The signup bot (in the MCP server) and a separate `mcp login` process
// both open the one profile, and Chrome single-instances it. Rather than
// run a parallel lock system, this waits on Chrome's OWN SingletonLock as
// the semaphore:
//   - no lock              → free, return immediately
//   - lock, holder dead    → stale, reclaim it (clearStaleSingletonLock)
//   - lock, holder alive   → a genuine concurrent run — poll until it
//                            releases, up to deadlineMs
//
// Returns true once the profile is free to open, or false if a live
// holder never released within the deadline (caller surfaces ProfileBusyError).
// Interactive entry points pass a zero deadline and fail immediately; narrow
// internal probes may opt into a bounded wait.
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
    if (holder === null) return true; // free
    if (holder.stale) {
      removeSingletons(profileDir);
      return true; // reclaimed a dead holder
    }
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
