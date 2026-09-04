// profile.ts — the bot's persistent Chrome profile location.
//
// One canonical path, shared by two callers: google-login.ts writes the
// user's Google session into this profile, and BrowserController
// launches signup runs from it — so an OAuth signup reuses that
// session instead of starting logged-out. Override with
// TRUSTY_SQUIRE_PROFILE_DIR.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  linkSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CHROME_PROFILE_DIR =
  process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? join(homedir(), ".trusty-squire", "chrome-profile");

export function profilePathIdentity(profileDir: string): string {
  const absolute = resolve(profileDir);
  const suffix: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(candidate), ...suffix.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

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
  process_group_id?: number | "unknown";
  // Exact per-launch marker inherited by every browser process. It lets the
  // owner reaper prove a detached process group still belongs to this launch
  // after the group's original leader has exited.
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

function linuxProfileProcessGroupMarkerState(
  identity: ProfileProcessIdentity,
): ProcessIdentityState {
  if (process.platform !== "linux" || identity.process_marker === undefined) return "stale";
  let unknown = false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const markerState = linuxOperatorMarkerState(pid, identity.process_marker);
      if (markerState === "stale") continue;
      if (markerState === "unknown") {
        if (linuxProcessUidState(pid) !== "stale") unknown = true;
        continue;
      }
      const profileState = processProfileState(pid, identity.user_data_dir);
      if (profileState !== "matching") {
        unknown = true;
        continue;
      }
      const groupId = readLinuxProcessGroupId(pid);
      if (identity.process_group_id === "unknown") return "unknown";
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
  return readers.readGroupMarkerState?.(identity) ?? linuxProfileProcessGroupMarkerState(identity);
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
    clearStaleSingletonLock(opts.profileDir);
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

interface ProfileOperationOwner {
  host: string;
  pid: number;
  start_time: string | null;
  token: string;
}

const profileOperationContext = new AsyncLocalStorage<ReadonlySet<string>>();
const PROFILE_OPERATION_ORPHAN_GRACE_MS = 30_000;

function profileOperationLockDir(profileDir: string, lockRoot: string): string {
  const digest = createHash("sha256")
    .update(profilePathIdentity(profileDir))
    .digest("hex")
    .slice(0, 24);
  return join(lockRoot, `trusty-squire-profile-${digest}.lock`);
}

function readProfileOperationOwner(lockDir: string): ProfileOperationOwner | null {
  try {
    const ownerPath = lstatSync(lockDir).isDirectory() ? join(lockDir, "owner.json") : lockDir;
    const parsed: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const owner = parsed as Partial<ProfileOperationOwner>;
    if (
      typeof owner.host !== "string" ||
      typeof owner.pid !== "number" ||
      (owner.start_time !== undefined && typeof owner.start_time !== "string") ||
      typeof owner.token !== "string"
    ) {
      return null;
    }
    return {
      host: owner.host,
      pid: owner.pid,
      start_time: owner.start_time ?? null,
      token: owner.token,
    };
  } catch {
    return null;
  }
}

function profileOperationArtifactState(path: string): ProcessIdentityState {
  const owner = readProfileOperationOwner(path);
  if (owner !== null) {
    if (owner.host !== hostname()) return "unknown";
    if (owner.start_time === null) {
      return processExistenceState(owner.pid).state === "missing" ? "stale" : "unknown";
    }
    return processBirthIdentityState({ pid: owner.pid, start_time: owner.start_time });
  }
  try {
    return Date.now() - lstatSync(path).mtimeMs >= PROFILE_OPERATION_ORPHAN_GRACE_MS
      ? "stale"
      : "unknown";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "stale" : "unknown";
  }
}

function quarantineReclaimableProfileOperationLock(lockDir: string): boolean {
  if (profileOperationArtifactState(lockDir) !== "stale") return false;
  const tombstone = `${lockDir}.stale-${randomUUID()}`;
  try {
    renameSync(lockDir, tombstone);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  if (profileOperationArtifactState(tombstone) === "stale") {
    rmSync(tombstone, { recursive: true, force: true });
    return true;
  }
  return false;
}

function profileOperationArtifacts(
  lockDir: string,
  lockRoot: string,
  kind: "claim" | "stale",
): string[] {
  const prefix = `${basename(lockDir)}.${kind}-`;
  try {
    return readdirSync(lockRoot)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(lockRoot, name));
  } catch {
    return [];
  }
}

function scavengeProfileOperationArtifacts(lockDir: string, lockRoot: string): boolean {
  let retainedTombstone = false;
  for (const tombstone of profileOperationArtifacts(lockDir, lockRoot, "stale")) {
    if (profileOperationArtifactState(tombstone) === "stale") {
      rmSync(tombstone, { recursive: true, force: true });
    } else {
      retainedTombstone = true;
    }
  }
  for (const claim of profileOperationArtifacts(lockDir, lockRoot, "claim")) {
    if (profileOperationArtifactState(claim) === "stale") {
      rmSync(claim, { recursive: true, force: true });
    }
  }
  return retainedTombstone;
}

function restoreOwnedProfileOperationTombstone(
  lockDir: string,
  lockRoot: string,
  token: string,
): boolean {
  for (const tombstone of profileOperationArtifacts(lockDir, lockRoot, "stale")) {
    if (readProfileOperationOwner(tombstone)?.token !== token) continue;
    try {
      linkSync(tombstone, lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (readProfileOperationOwner(lockDir)?.token !== token) return false;
    }
    rmSync(tombstone, { force: true });
    return readProfileOperationOwner(lockDir)?.token === token;
  }
  return false;
}

function ownedProfileOperationLease(
  lockDir: string,
  lockRoot: string,
  token: string,
): ProfileOperationLease {
  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      if (readProfileOperationOwner(lockDir)?.token === token) {
        rmSync(lockDir, { recursive: true, force: true });
        return;
      }
      for (const tombstone of profileOperationArtifacts(lockDir, lockRoot, "stale")) {
        if (readProfileOperationOwner(tombstone)?.token === token) {
          rmSync(tombstone, { recursive: true, force: true });
          return;
        }
      }
    },
  };
}

export function acquireProfileOperationGuard(
  profileDir: string = CHROME_PROFILE_DIR,
  lockRoot: string = tmpdir(),
): ProfileOperationLease {
  const lockDir = profileOperationLockDir(profileDir, lockRoot);
  const token = randomUUID();
  const birth = processBirthIdentity(process.pid);
  const startTime = birth?.start_time ?? "unknown";
  for (;;) {
    if (scavengeProfileOperationArtifacts(lockDir, lockRoot)) {
      if (
        restoreOwnedProfileOperationTombstone(lockDir, lockRoot, token) &&
        !scavengeProfileOperationArtifacts(lockDir, lockRoot)
      ) {
        return ownedProfileOperationLease(lockDir, lockRoot, token);
      }
      throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
    }
    const claimPath = `${lockDir}.claim-${randomUUID()}`;
    writeFileSync(
      claimPath,
      JSON.stringify({ host: hostname(), pid: process.pid, start_time: startTime, token }),
      { mode: 0o600, flag: "wx" },
    );
    try {
      linkSync(claimPath, lockDir);
    } catch (err) {
      rmSync(claimPath, { force: true });
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        lstatSync(lockDir);
      } catch (lockErr) {
        if ((lockErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (quarantineReclaimableProfileOperationLock(lockDir)) {
        continue;
      }
      throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
    }
    rmSync(claimPath, { force: true });
    try {
      if (scavengeProfileOperationArtifacts(lockDir, lockRoot)) {
        if (
          !restoreOwnedProfileOperationTombstone(lockDir, lockRoot, token) ||
          scavengeProfileOperationArtifacts(lockDir, lockRoot)
        ) {
          rmSync(lockDir, { recursive: true, force: true });
          throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
        }
      }
    } catch (err) {
      if (readProfileOperationOwner(lockDir)?.token === token) {
        rmSync(lockDir, { recursive: true, force: true });
      }
      throw err;
    }
    return ownedProfileOperationLease(lockDir, lockRoot, token);
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
  const key = profilePathIdentity(profileDir);
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
    if (identity !== null) signalProfileProcess(identity, profileDir, "SIGKILL");
    return false;
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
  if (!holder.stale) {
    signalProfileProcess(identity, profileDir, "SIGKILL", kill);
    return false;
  }
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
// The signup bot (in the MCP server) and a separate `mcp connect` process
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
