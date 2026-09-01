import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  operatorBrowserProcessCommandState,
  operatorBrowserProcessMarkerState,
  type OperatorBrowserProcessMarkerState,
} from "./operator-browser-watchdog.js";
import { sweepOperatorProfilePoolOrphans } from "./operator-profile-pool.js";
import {
  processBirthIdentity,
  processBirthIdentityState,
  processProfileArgumentState,
  profilePathIdentity,
  profileProcessIdentityState,
  signalProfileProcess,
  type ProcessIdentityState,
  type ProcessProfileArgumentState,
  type ProfileProcessIdentity,
} from "./profile.js";

interface OwnerIdentity {
  pid: number;
  start_time: string;
}

interface OwnerLaunchRecord {
  marker: string;
  user_data_dir: string;
  anchor?: OwnerIdentity;
}

export interface OwnerHelperIdentity {
  pid: number;
  start_time: string;
  marker: string;
  process_group_id?: number;
}

interface OwnerPendingHelper {
  marker: string;
  state: "pending";
}

type OwnerHelperRecord = OwnerHelperIdentity | OwnerPendingHelper;

interface OwnerReaperManifest {
  version: 5;
  token: string;
  owner: OwnerIdentity;
  resources: ProfileProcessIdentity[];
  launches: OwnerLaunchRecord[];
  helpers: OwnerHelperRecord[];
}

type OwnerReaperManifestRead =
  | { state: "present"; manifest: OwnerReaperManifest }
  | { state: "missing" }
  | { state: "unknown" };

export interface OwnerProcessReaper {
  readonly manifestPath: string;
  readonly token: string;
  isAvailable(): boolean;
  restart(): boolean;
  track(identity: ProfileProcessIdentity): void;
  untrack(identity: ProfileProcessIdentity): void;
  trackLaunch(marker: string, profileDir: string): void;
  bindLaunch(marker: string, identity: ProfileProcessIdentity): boolean;
  launchAnchor(marker: string, profileDir: string): OwnerIdentity | null;
  untrackLaunch(marker: string): void;
  reserveHelper(marker: string): void;
  bindHelper(marker: string, identity: OwnerHelperIdentity): void;
  untrackHelper(marker: string): void;
  stop(): void;
}

export const OWNER_HELPER_MARKER_ENV = "TRUSTY_SQUIRE_OWNER_HELPER_MARKER";
export const OWNER_REAPER_WORKER_MARKER_ENV = "TRUSTY_SQUIRE_OWNER_REAPER_WORKER_MARKER";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_WORKER_READY_TIMEOUT_MS = 2_000;
const DEFAULT_WORKER_STABILITY_MS = 100;
const WORKER_RECOVERY_DELAY_MS = 100;
const workerReadyWait = new Int32Array(new SharedArrayBuffer(4));
const moduleRequire = createRequire(import.meta.url);
let activeReaper: OwnerProcessReaper | null = null;

function defaultRootDir(): string {
  const configured = (process.env.TRUSTY_SQUIRE_REAPER_DIR ?? "").trim();
  return configured.length > 0
    ? resolve(configured)
    : join(homedir(), ".trusty-squire", "owner-reapers");
}

function envPositiveMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function isOwnerIdentity(value: unknown): value is OwnerIdentity {
  if (value === null || typeof value !== "object") return false;
  const owner = value as Partial<OwnerIdentity>;
  return (
    Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 && typeof owner.start_time === "string"
  );
}

function isLaunch(value: unknown): value is OwnerLaunchRecord {
  if (value === null || typeof value !== "object") return false;
  const launch = value as Partial<OwnerLaunchRecord>;
  const allowedKeys = new Set(["marker", "user_data_dir", "anchor"]);
  return (
    Object.keys(launch).every((key) => allowedKeys.has(key)) &&
    typeof launch.marker === "string" &&
    typeof launch.user_data_dir === "string" &&
    (launch.anchor === undefined || isOwnerIdentity(launch.anchor))
  );
}

function isProfileProcessIdentity(value: unknown): value is ProfileProcessIdentity {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Partial<ProfileProcessIdentity>;
  return (
    typeof identity.host === "string" &&
    Number.isSafeInteger(identity.pid) &&
    (identity.pid ?? 0) > 0 &&
    typeof identity.start_time === "string" &&
    typeof identity.user_data_dir === "string" &&
    (identity.process_group_id === undefined ||
      identity.process_group_id === "unknown" ||
      Number.isSafeInteger(identity.process_group_id)) &&
    (identity.process_marker === undefined || typeof identity.process_marker === "string")
  );
}

function isHelper(value: unknown): value is OwnerHelperRecord {
  if (value === null || typeof value !== "object") return false;
  const helper = value as Partial<OwnerHelperIdentity & OwnerPendingHelper>;
  if (helper.state === "pending") {
    return (
      typeof helper.marker === "string" &&
      helper.pid === undefined &&
      helper.start_time === undefined &&
      helper.process_group_id === undefined
    );
  }
  return (
    Number.isSafeInteger(helper.pid) &&
    (helper.pid ?? 0) > 0 &&
    typeof helper.start_time === "string" &&
    typeof helper.marker === "string" &&
    (helper.process_group_id === undefined || Number.isSafeInteger(helper.process_group_id))
  );
}

function readManifest(path: string): OwnerReaperManifestRead {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerReaperManifest>;
    const allowedKeys = new Set(["version", "token", "owner", "resources", "launches", "helpers"]);
    if (
      Object.keys(value).some((key) => !allowedKeys.has(key)) ||
      value.version !== 5 ||
      typeof value.token !== "string" ||
      !isOwnerIdentity(value.owner) ||
      !Array.isArray(value.resources) ||
      !value.resources.every(isProfileProcessIdentity) ||
      !Array.isArray(value.launches) ||
      !value.launches.every(isLaunch) ||
      !Array.isArray(value.helpers) ||
      !value.helpers.every(isHelper)
    ) {
      return { state: "unknown" };
    }
    return { state: "present", manifest: value as OwnerReaperManifest };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unknown" };
  }
}

function writeManifest(path: string, manifest: OwnerReaperManifest): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function shouldReapOwner(state: ProcessIdentityState): boolean {
  return state === "stale";
}

function ownerState(manifest: OwnerReaperManifest): ProcessIdentityState {
  const running = linuxProcessRunningState(manifest.owner.pid);
  return running === "matching" ? processBirthIdentityState(manifest.owner) : running;
}

type ProcessGroupIdRead = number | "stale" | "unknown";

function linuxProcessGroupId(pid: number): ProcessGroupIdRead {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return "unknown";
    const processGroupId = Number(
      stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[2],
    );
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : "unknown";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function linuxProcessUidState(pid: number): ProcessIdentityState {
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (ownerUid === null) return "unknown";
  try {
    const match = /^Uid:\s+(.+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (match === null) return "unknown";
    const uids = match[1]!.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
    return uids.includes(ownerUid) ? "matching" : "stale";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function linuxProcessRunningState(pid: number): ProcessIdentityState {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return "unknown";
    const state = stat.slice(close + 2).split(" ")[0];
    return state === "Z" || state === "X" ? "stale" : "matching";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function helperProcessMarkerState(
  pid: number,
  marker: string,
  readEnvironment: (pid: number) => string = (processId) =>
    readFileSync(`/proc/${processId}/environ`, "utf8"),
): ProcessIdentityState {
  try {
    return readEnvironment(pid).split("\0").includes(`${OWNER_HELPER_MARKER_ENV}=${marker}`)
      ? "matching"
      : "stale";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

interface HelperIdentityReaders {
  readProcessIds?: () => number[];
  readProcessGroupId?: (pid: number) => ProcessGroupIdRead;
  readRunningState?: (pid: number) => ProcessIdentityState;
  readMarkerState?: (pid: number, marker: string) => ProcessIdentityState;
  readBirthState?: (identity: OwnerHelperIdentity) => ProcessIdentityState;
  readUidState?: (pid: number) => ProcessIdentityState;
}

function processIds(readProcessIds?: () => number[]): number[] {
  return (
    readProcessIds?.() ??
    readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
  );
}

function helperGroupMarkerState(
  processGroupId: number,
  marker: string,
  readers: HelperIdentityReaders = {},
): ProcessIdentityState {
  if (process.platform !== "linux" && readers.readProcessIds === undefined) return "stale";
  let unknown = false;
  try {
    for (const pid of processIds(readers.readProcessIds)) {
      const groupId = (readers.readProcessGroupId ?? linuxProcessGroupId)(pid);
      if (groupId === "unknown") {
        const running =
          readers.readRunningState?.(pid) ??
          (readers.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
        if (running === "stale") continue;
        const markerState = (readers.readMarkerState ?? helperProcessMarkerState)(pid, marker);
        if (
          markerState === "matching" ||
          (markerState === "unknown" &&
            (readers.readUidState ?? linuxProcessUidState)(pid) !== "stale")
        ) {
          unknown = true;
        }
        continue;
      }
      if (groupId === "stale" || groupId !== processGroupId) continue;
      const running =
        readers.readRunningState?.(pid) ??
        (readers.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
      if (running === "stale") continue;
      if (running === "unknown") {
        unknown = true;
        continue;
      }
      const markerState = (readers.readMarkerState ?? helperProcessMarkerState)(pid, marker);
      if (markerState === "matching") return "matching";
      if (markerState === "unknown") unknown = true;
    }
  } catch {
    return "unknown";
  }
  return unknown ? "unknown" : "stale";
}

function exactHelperMarkerProcessScan(
  marker: string,
  readers: HelperIdentityReaders = {},
): { matching: number[]; unknown: boolean } {
  if (process.platform !== "linux" && readers.readProcessIds === undefined) {
    return { matching: [], unknown: false };
  }
  const matching: number[] = [];
  let unknown = false;
  try {
    for (const pid of processIds(readers.readProcessIds)) {
      const running =
        readers.readRunningState?.(pid) ??
        (readers.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
      if (running === "stale") continue;
      if (running === "unknown") {
        if ((readers.readUidState ?? linuxProcessUidState)(pid) !== "stale") unknown = true;
        continue;
      }
      const markerState = (readers.readMarkerState ?? helperProcessMarkerState)(pid, marker);
      if (markerState === "matching") matching.push(pid);
      else if (
        markerState === "unknown" &&
        (readers.readUidState ?? linuxProcessUidState)(pid) !== "stale"
      ) {
        unknown = true;
      }
    }
  } catch {
    unknown = true;
  }
  return { matching, unknown };
}

export function ownerHelperIdentityState(
  identity: OwnerHelperRecord,
  readers: HelperIdentityReaders = {},
): ProcessIdentityState {
  if ("state" in identity) {
    const scan = exactHelperMarkerProcessScan(identity.marker, readers);
    if (scan.matching.length > 0) return "matching";
    return scan.unknown ? "unknown" : "stale";
  }
  if (identity.process_group_id !== undefined) {
    const groupState = helperGroupMarkerState(identity.process_group_id, identity.marker, readers);
    if (groupState !== "stale") return groupState;
  }
  const running =
    readers.readRunningState?.(identity.pid) ??
    (readers.readBirthState === undefined ? linuxProcessRunningState(identity.pid) : "matching");
  if (running !== "matching") return running;
  const birth = readers.readBirthState?.(identity) ?? processBirthIdentityState(identity);
  if (birth !== "matching") return birth;
  return (readers.readMarkerState ?? helperProcessMarkerState)(identity.pid, identity.marker);
}

function signalOwnerHelper(identity: OwnerHelperRecord, signal: NodeJS.Signals): boolean {
  if (process.platform !== "linux") return false;
  if ("state" in identity) {
    let signalled = false;
    const groups = new Set<number>();
    for (const pid of exactHelperMarkerProcessScan(identity.marker).matching) {
      const groupId = linuxProcessGroupId(pid);
      if (
        typeof groupId === "number" &&
        helperGroupMarkerState(groupId, identity.marker) === "matching"
      ) {
        groups.add(groupId);
      }
    }
    for (const groupId of groups) {
      try {
        process.kill(-groupId, signal);
        signalled = true;
      } catch {}
    }
    return signalled;
  }
  const groupId = identity.process_group_id;
  const target =
    groupId !== undefined && helperGroupMarkerState(groupId, identity.marker) === "matching"
      ? -groupId
      : ownerHelperIdentityState(identity) === "matching"
        ? identity.pid
        : null;
  if (target === null) return false;
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

interface BrowserIdentityReaders {
  anchor?: OwnerIdentity;
  readProcessIds?: () => number[];
  readBirthIdentity?: (pid: number) => OwnerIdentity | null;
  readMarker?: (pid: number) => string | null;
  readMarkerState?: (pid: number) => OperatorBrowserProcessMarkerState;
  readCommandState?: (pid: number) => ProcessIdentityState;
  readProfileState?: (pid: number, profileDir: string) => ProcessProfileArgumentState;
  readBirthState?: (identity: OwnerIdentity) => ProcessIdentityState;
  readRunningState?: (pid: number) => ProcessIdentityState;
  readUidState?: (pid: number) => ProcessIdentityState;
}

function browserMarkerState(
  pid: number,
  readers: BrowserIdentityReaders,
): OperatorBrowserProcessMarkerState {
  if (readers.readMarkerState !== undefined) return readers.readMarkerState(pid);
  if (readers.readMarker !== undefined) {
    const marker = readers.readMarker(pid);
    return marker === null ? { state: "missing" } : { state: "present", marker };
  }
  return operatorBrowserProcessMarkerState(pid);
}

function launchAnchorTrustState(
  launch: OwnerLaunchRecord,
  readers: BrowserIdentityReaders,
): "pending" | "trusted" | "unknown" {
  if (launch.anchor === undefined) return "pending";
  const runningState = (readers.readRunningState ?? linuxProcessRunningState)(launch.anchor.pid);
  if (runningState === "unknown") return "unknown";
  if (runningState === "stale") return "trusted";
  const birthState =
    readers.readBirthState?.(launch.anchor) ?? processBirthIdentityState(launch.anchor);
  if (birthState === "unknown") return "unknown";
  if (birthState === "stale") return "trusted";
  const commandState = (readers.readCommandState ?? operatorBrowserProcessCommandState)(
    launch.anchor.pid,
  );
  const markerState = browserMarkerState(launch.anchor.pid, readers);
  const profileState = (readers.readProfileState ?? processProfileArgumentState)(
    launch.anchor.pid,
    launch.user_data_dir,
  );
  // The anchor is a birth identity (pid + start_time) recorded at this launch,
  // so we are already looking at THIS launch's process. Chrome overwrites its
  // own /proc/<pid>/environ memory when it rewrites process titles, which erases
  // the owner marker there — so a live chromium anchor is NEVER re-readable by
  // marker even though it is genuinely ours. Its per-launch --user-data-dir is a
  // unique ownership token that survives, so a matching chromium command plus a
  // matching profile is definitive. A marker that IS still readable must not
  // positively name a different launch; a missing/erased marker does not.
  const markerContradicts =
    markerState.state === "present" && markerState.marker !== launch.marker;
  return commandState === "matching" && profileState === "matching" && !markerContradicts
    ? "trusted"
    : "unknown";
}

function exactMarkerProcessScan(
  launch: OwnerLaunchRecord,
  readers: BrowserIdentityReaders = {},
): { matching: OwnerIdentity[]; unknown: boolean; anchor?: OwnerIdentity } {
  if (process.platform !== "linux" && readers.readProcessIds === undefined) {
    return { matching: [], unknown: false };
  }
  const matching: OwnerIdentity[] = [];
  const missingProfile: OwnerIdentity[] = [];
  const anchorTrust = launchAnchorTrustState(launch, readers);
  let discoveredAnchor: OwnerIdentity | undefined;
  let unknown = anchorTrust === "unknown";
  try {
    for (const pid of processIds(readers.readProcessIds)) {
      const commandState = (readers.readCommandState ?? operatorBrowserProcessCommandState)(pid);
      if (commandState === "stale") continue;
      const markerState = browserMarkerState(pid, readers);
      if (markerState.state === "unknown") {
        // Only a CONFIRMED chromium process (commandState "matching") whose
        // marker we transiently cannot read is conservatively treated as
        // maybe-ours. A process we cannot even confirm is chromium — e.g. a
        // hardened own-uid process such as sshd, whose /proc/<pid>/exe and
        // environ are both EACCES, so commandState reads "unknown" — cannot be
        // our marked browser: our own login browser launches unhardened under
        // our uid with a readable environ. Poisoning the scan on such a process
        // made every login-browser teardown report closure unproven.
        if (
          commandState === "matching" &&
          (readers.readUidState ?? linuxProcessUidState)(pid) !== "stale"
        ) {
          unknown = true;
        }
        continue;
      }
      if (markerState.state !== "present" || markerState.marker !== launch.marker) continue;
      if (commandState !== "matching") {
        unknown = true;
        continue;
      }
      const profileState = (readers.readProfileState ?? processProfileArgumentState)(
        pid,
        launch.user_data_dir,
      );
      if (profileState !== "matching" && profileState !== "missing") {
        unknown = true;
        continue;
      }
      const identity = (readers.readBirthIdentity ?? processBirthIdentity)(pid);
      if (identity === null) {
        if ((readers.readRunningState ?? linuxProcessRunningState)(pid) !== "stale") unknown = true;
        continue;
      }
      const birthState = readers.readBirthState?.(identity) ?? processBirthIdentityState(identity);
      if (birthState !== "matching") {
        if (birthState === "unknown") unknown = true;
        continue;
      }
      if (profileState === "matching") {
        matching.push(identity);
        discoveredAnchor ??= identity;
      } else {
        missingProfile.push(identity);
      }
    }
  } catch {
    unknown = true;
  }
  const missingProfileTrusted =
    anchorTrust === "trusted" || (anchorTrust === "pending" && discoveredAnchor !== undefined);
  if (missingProfileTrusted) matching.push(...missingProfile);
  else if (missingProfile.length > 0) unknown = true;
  return {
    matching,
    unknown,
    ...(launch.anchor === undefined && discoveredAnchor !== undefined
      ? { anchor: discoveredAnchor }
      : {}),
  };
}

function exactMarkerIdentityMatches(
  launch: OwnerLaunchRecord,
  identity: OwnerIdentity,
  readers: BrowserIdentityReaders = {},
): boolean {
  const scan = exactMarkerProcessScan(launch, {
    ...readers,
    readProcessIds: () => [identity.pid],
  });
  return scan.matching.some(
    (current) => current.pid === identity.pid && current.start_time === identity.start_time,
  );
}

export function ownerBrowserLaunchState(
  marker: string,
  profileDir: string,
  readers: BrowserIdentityReaders = {},
): ProcessIdentityState {
  const launch: OwnerLaunchRecord = {
    marker,
    user_data_dir: profilePathIdentity(profileDir),
    ...(readers.anchor === undefined ? {} : { anchor: readers.anchor }),
  };
  const scan = exactMarkerProcessScan(launch, readers);
  if (scan.matching.length > 0) return "matching";
  return scan.unknown ? "unknown" : "stale";
}

export async function terminateOwnerBrowserLaunch(
  marker: string,
  profileDir: string,
  options: {
    graceMs?: number;
    readProcessIds?: () => number[];
    readBirthIdentity?: (pid: number) => OwnerIdentity | null;
    readMarkerState?: (pid: number) => OperatorBrowserProcessMarkerState;
    readCommandState?: (pid: number) => ProcessIdentityState;
    readProfileState?: (pid: number, profileDir: string) => ProcessProfileArgumentState;
    readBirthState?: (identity: OwnerIdentity) => ProcessIdentityState;
    readRunningState?: (pid: number) => ProcessIdentityState;
    anchor?: OwnerIdentity;
    readUidState?: (pid: number) => ProcessIdentityState;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const anchor = options.anchor ?? activeReaper?.launchAnchor(marker, profileDir) ?? undefined;
  const readers: BrowserIdentityReaders = {
    ...(anchor === undefined ? {} : { anchor }),
    ...(options.readProcessIds === undefined ? {} : { readProcessIds: options.readProcessIds }),
    ...(options.readBirthIdentity === undefined
      ? {}
      : { readBirthIdentity: options.readBirthIdentity }),
    ...(options.readMarkerState === undefined ? {} : { readMarkerState: options.readMarkerState }),
    ...(options.readCommandState === undefined
      ? {}
      : { readCommandState: options.readCommandState }),
    ...(options.readProfileState === undefined
      ? {}
      : { readProfileState: options.readProfileState }),
    ...(options.readBirthState === undefined ? {} : { readBirthState: options.readBirthState }),
    ...(options.readRunningState === undefined
      ? {}
      : { readRunningState: options.readRunningState }),
    ...(options.readUidState === undefined ? {} : { readUidState: options.readUidState }),
  };
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const wait =
    options.wait ??
    (async (ms) => await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const graceMs =
    options.graceMs ?? envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const launch: OwnerLaunchRecord = {
    marker,
    user_data_dir: profilePathIdentity(profileDir),
    ...(anchor === undefined ? {} : { anchor }),
  };
  const scan = (): ReturnType<typeof exactMarkerProcessScan> => {
    const result = exactMarkerProcessScan(launch, readers);
    if (launch.anchor === undefined && result.anchor !== undefined) launch.anchor = result.anchor;
    return result;
  };
  const matching = (): OwnerIdentity[] => scan().matching;
  const signal = (identities: readonly OwnerIdentity[], signalName: NodeJS.Signals): void => {
    for (const identity of identities) {
      if (!exactMarkerIdentityMatches(launch, identity, readers)) continue;
      try {
        kill(identity.pid, signalName);
      } catch {}
    }
  };
  const initial = matching();
  if (initial.length === 0) {
    return scan().unknown === false;
  }
  signal(initial, "SIGTERM");
  await wait(graceMs);
  const resistant = matching();
  if (resistant.length === 0) {
    return scan().unknown === false;
  }
  signal(resistant, "SIGKILL");
  await wait(graceMs);
  return matching().length === 0 && scan().unknown === false;
}

function signalTrackedResources(manifest: OwnerReaperManifest, signal: NodeJS.Signals): number {
  let signalled = 0;
  for (const identity of manifest.resources) {
    if (signalProfileProcess(identity, identity.user_data_dir, signal)) signalled += 1;
  }
  for (const launch of manifest.launches) {
    const scan = exactMarkerProcessScan(launch);
    if (launch.anchor === undefined && scan.anchor !== undefined) launch.anchor = scan.anchor;
    for (const identity of scan.matching) {
      if (!exactMarkerIdentityMatches(launch, identity)) continue;
      try {
        process.kill(identity.pid, signal);
        signalled += 1;
      } catch {}
    }
  }
  for (const helper of manifest.helpers) {
    if (signalOwnerHelper(helper, signal)) signalled += 1;
  }
  return signalled;
}

function manifestCleanupComplete(manifest: OwnerReaperManifest): boolean {
  return (
    manifest.resources.every(
      (identity) => profileProcessIdentityState(identity, identity.user_data_dir) === "stale",
    ) &&
    manifest.launches.every((launch) => {
      const scan = exactMarkerProcessScan(launch);
      return scan.matching.length === 0 && !scan.unknown;
    }) &&
    manifest.helpers.every((helper) => ownerHelperIdentityState(helper) === "stale")
  );
}

async function reapManifest(path: string, manifest: OwnerReaperManifest): Promise<number> {
  const graceMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const signalled = signalTrackedResources(manifest, "SIGTERM");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs));
  const latestRead = readManifest(path);
  const latest = latestRead.state === "present" ? latestRead.manifest : manifest;
  for (const launch of latest.launches) {
    if (launch.anchor !== undefined) continue;
    const prior = manifest.launches.find(
      (candidate) =>
        candidate.marker === launch.marker && candidate.user_data_dir === launch.user_data_dir,
    );
    if (prior?.anchor !== undefined) launch.anchor = prior.anchor;
  }
  signalTrackedResources(latest, "SIGKILL");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs));
  await sweepOperatorProfilePoolOrphans().catch(() => undefined);
  if (latestRead.state === "present" && manifestCleanupComplete(latest)) {
    rmSync(path, { force: true });
  }
  return signalled;
}

export async function sweepOrphanedOwnerProcesses(rootDir = defaultRootDir()): Promise<number> {
  await new Promise<void>((resolveStart) => setImmediate(resolveStart));
  if (process.platform !== "linux" || !existsSync(rootDir)) return 0;
  let reaped = 0;
  for (const entry of readdirSync(rootDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(rootDir, entry);
    const read = readManifest(path);
    if (read.state !== "present" || !shouldReapOwner(ownerState(read.manifest))) continue;
    reaped += await reapManifest(path, read.manifest);
  }
  return reaped;
}

export async function runOwnerProcessReaperWorker(
  manifestPath: string,
  onReady: () => void = () => undefined,
): Promise<void> {
  const pollMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_POLL_MS", DEFAULT_POLL_MS);
  let ready = false;
  for (;;) {
    const read = readManifest(manifestPath);
    if (read.state === "missing") return;
    if (read.state === "unknown") {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
      continue;
    }
    if (!ready) {
      onReady();
      ready = true;
    }
    if (shouldReapOwner(ownerState(read.manifest))) {
      await reapManifest(manifestPath, read.manifest);
      if (readManifest(manifestPath).state === "missing") return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

function ownerReaperWorkerRunning(identity: OwnerIdentity): boolean {
  if (processBirthIdentityState(identity) !== "matching") return false;
  return linuxProcessRunningState(identity.pid) === "matching";
}

function waitForOwnerReaperWorker(
  worker: ChildProcess,
  readyPath: string,
  token: string,
): OwnerIdentity | null {
  if (worker.pid === undefined) return null;
  const timeoutMs = envPositiveMs(
    "TRUSTY_SQUIRE_REAPER_READY_TIMEOUT_MS",
    DEFAULT_WORKER_READY_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        version?: unknown;
        token?: unknown;
        pid?: unknown;
      };
      if (ready.version === 1 && ready.token === token && ready.pid === worker.pid) {
        const identity = processBirthIdentity(worker.pid);
        if (identity === null) return null;
        Atomics.wait(workerReadyWait, 0, 0, DEFAULT_WORKER_STABILITY_MS);
        return ownerReaperWorkerRunning(identity) ? identity : null;
      }
    } catch {}
    Atomics.wait(workerReadyWait, 0, 0, 5);
  }
  return null;
}

interface OwnerReaperWorkerHandle {
  isAvailable(): boolean;
  stop(): boolean;
}

function terminateOwnerHelperAfterRegistrationFailure(
  child: ChildProcess,
  record: OwnerHelperRecord,
): boolean {
  const graceMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  signalOwnerHelper(record, "SIGTERM");
  Atomics.wait(workerReadyWait, 0, 0, graceMs);
  if (ownerHelperIdentityState(record) !== "stale") {
    signalOwnerHelper(record, "SIGKILL");
    Atomics.wait(workerReadyWait, 0, 0, graceMs);
  }
  return ownerTrackedHelperState(child) === "stale" || ownerHelperIdentityState(record) === "stale";
}

const trackedHelperProcesses = new WeakMap<ChildProcess, OwnerHelperRecord>();

function launchOwnerReaperWorker(
  workerPath: string,
  manifestPath: string,
  rootDir: string,
  token: string,
  spawnWorker: typeof spawn,
  onUnexpectedExit: () => void,
): OwnerReaperWorkerHandle | null {
  const workerExecArgs = workerPath.endsWith(".ts")
    ? ["--import", moduleRequire.resolve("tsx")]
    : [];
  const readyPath = join(rootDir, `${process.pid}-${token}-${randomUUID()}.ready`);
  const workerMarker = `v1:reaper:${token}:${randomUUID()}`;
  let worker: ChildProcess;
  try {
    worker = spawnWorker(
      process.execPath,
      [...workerExecArgs, workerPath, manifestPath, readyPath, token],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          [OWNER_HELPER_MARKER_ENV]: workerMarker,
          [OWNER_REAPER_WORKER_MARKER_ENV]: workerMarker,
        },
      },
    );
    worker.unref();
  } catch {
    rmSync(readyPath, { force: true });
    return null;
  }

  let workerRecord: OwnerHelperRecord = { marker: workerMarker, state: "pending" };
  if (worker.pid !== undefined) {
    const birth = processBirthIdentity(worker.pid);
    const processGroupId = linuxProcessGroupId(worker.pid);
    if (birth !== null && typeof processGroupId === "number") {
      workerRecord = { ...birth, marker: workerMarker, process_group_id: processGroupId };
    }
  }
  trackedHelperProcesses.set(worker, workerRecord);

  let exited = false;
  let ready = false;
  let stopping = false;
  const markExited = (): void => {
    if (exited) return;
    exited = true;
    if (ready && !stopping) onUnexpectedExit();
  };
  worker.once("error", markExited);
  worker.once("exit", markExited);
  const identity = waitForOwnerReaperWorker(worker, readyPath, token);
  rmSync(readyPath, { force: true });
  if (identity === null || exited) {
    stopping = true;
    if (!terminateOwnerHelperAfterRegistrationFailure(worker, workerRecord)) {
      throw new Error("owner process reaper worker group did not terminate");
    }
    trackedHelperProcesses.delete(worker);
    return null;
  }
  ready = true;
  return {
    isAvailable: () => !exited && ownerReaperWorkerRunning(identity),
    stop: () => {
      stopping = true;
      exited = true;
      const terminated = terminateOwnerHelperAfterRegistrationFailure(worker, workerRecord);
      if (terminated) trackedHelperProcesses.delete(worker);
      return terminated;
    },
  };
}

export function startOwnerProcessReaper(
  options: { rootDir?: string; workerPath?: string } = {},
  runtime: { spawn?: typeof spawn; beforeWorkerLaunch?: () => void } = {},
): OwnerProcessReaper | null {
  if (process.platform !== "linux") return null;
  if (activeReaper !== null) return activeReaper.restart() ? activeReaper : null;
  const rootDir = resolve(options.rootDir ?? defaultRootDir());
  ensurePrivateDir(rootDir);
  const startupSweep = setImmediate(() => {
    void sweepOrphanedOwnerProcesses(rootDir).catch(() => undefined);
  });
  startupSweep.unref();

  const owner = processBirthIdentity(process.pid);
  if (owner === null) return null;
  const token = randomUUID();
  const manifestPath = join(rootDir, `${owner.pid}-${token}.json`);
  let manifest: OwnerReaperManifest = {
    version: 5,
    token,
    owner,
    resources: [],
    launches: [],
    helpers: [],
  };
  writeManifest(manifestPath, manifest);

  const compiledWorkerPath = fileURLToPath(
    new URL("./owner-process-reaper-worker.js", import.meta.url),
  );
  const sourceWorkerPath = fileURLToPath(
    new URL("./owner-process-reaper-worker.ts", import.meta.url),
  );
  const workerPath =
    options.workerPath ?? (existsSync(compiledWorkerPath) ? compiledWorkerPath : sourceWorkerPath);
  if (!existsSync(workerPath)) {
    rmSync(manifestPath, { force: true });
    return null;
  }

  const spawnWorker = runtime.spawn ?? spawn;
  let stopped = false;
  let workerGeneration = 0;
  let worker: OwnerReaperWorkerHandle | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer === null) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };
  const scheduleRecovery = (): void => {
    if (stopped || recoveryTimer !== null) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (stopped || worker?.isAvailable()) return;
      worker = null;
      try {
        launchWorker();
      } catch {}
      if (worker === null) scheduleRecovery();
    }, WORKER_RECOVERY_DELAY_MS);
    recoveryTimer.unref();
  };
  const launchWorker = (): OwnerReaperWorkerHandle | null => {
    runtime.beforeWorkerLaunch?.();
    const generation = ++workerGeneration;
    const launched = launchOwnerReaperWorker(
      workerPath,
      manifestPath,
      rootDir,
      token,
      spawnWorker,
      () => {
        if (generation !== workerGeneration) return;
        worker = null;
        scheduleRecovery();
      },
    );
    if (launched !== null) worker = launched;
    return launched;
  };
  const ensureWorker = (): boolean => {
    if (stopped) return false;
    if (worker?.isAvailable()) return true;
    clearRecoveryTimer();
    worker?.stop();
    worker = null;
    try {
      return launchWorker() !== null;
    } catch {
      scheduleRecovery();
      return false;
    }
  };

  if (!ensureWorker()) {
    stopped = true;
    clearRecoveryTimer();
    rmSync(manifestPath, { force: true });
    return null;
  }

  const requireAvailable = (): void => {
    if (!ensureWorker()) throw new Error("owner process reaper worker unavailable");
  };
  const update = (next: OwnerReaperManifest): void => {
    manifest = next;
    writeManifest(manifestPath, manifest);
  };
  const reaper: OwnerProcessReaper = {
    manifestPath,
    token,
    isAvailable: () => !stopped && worker?.isAvailable() === true,
    restart: ensureWorker,
    track: (identity) => {
      requireAvailable();
      update({
        ...manifest,
        resources: [...manifest.resources.filter((entry) => entry.pid !== identity.pid), identity],
      });
    },
    untrack: (identity) => {
      if (stopped) return;
      update({
        ...manifest,
        resources: manifest.resources.filter(
          (entry) => entry.pid !== identity.pid || entry.start_time !== identity.start_time,
        ),
      });
    },
    trackLaunch: (marker, profileDir) => {
      requireAvailable();
      update({
        ...manifest,
        launches: [
          ...manifest.launches.filter((entry) => entry.marker !== marker),
          { marker, user_data_dir: profilePathIdentity(profileDir) },
        ],
      });
    },
    bindLaunch: (marker, identity) => {
      requireAvailable();
      const launch = manifest.launches.find((entry) => entry.marker === marker);
      // Ownership is proven by the birth-identity + unique per-launch profile
      // (profileProcessIdentityState "matching"), a random per-launch
      // --user-data-dir no other process shares. The environ marker is only a
      // non-contradiction check here: Chrome erases its own marker from
      // /proc/<pid>/environ when it rewrites process titles, so requiring the
      // marker to still be readable back from the browser process left the
      // anchor permanently unbound and every login-browser teardown reporting
      // closure unproven. A marker that IS readable must not name a different
      // launch; an erased marker does not disqualify.
      const processMarker = operatorBrowserProcessMarkerState(identity.pid);
      if (
        launch === undefined ||
        profilePathIdentity(identity.user_data_dir) !== launch.user_data_dir ||
        profileProcessIdentityState(identity, launch.user_data_dir) !== "matching" ||
        (processMarker.state === "present" && processMarker.marker !== marker)
      ) {
        return false;
      }
      update({
        ...manifest,
        launches: manifest.launches.map((entry) =>
          entry.marker === marker
            ? { ...entry, anchor: { pid: identity.pid, start_time: identity.start_time } }
            : entry,
        ),
      });
      return true;
    },
    launchAnchor: (marker, profileDir) => {
      const normalizedProfile = profilePathIdentity(profileDir);
      return (
        manifest.launches.find(
          (entry) => entry.marker === marker && entry.user_data_dir === normalizedProfile,
        )?.anchor ?? null
      );
    },
    untrackLaunch: (marker) => {
      if (stopped) return;
      update({
        ...manifest,
        launches: manifest.launches.filter((entry) => entry.marker !== marker),
      });
    },
    reserveHelper: (marker) => {
      requireAvailable();
      update({
        ...manifest,
        helpers: [
          ...manifest.helpers.filter((entry) => entry.marker !== marker),
          { marker, state: "pending" },
        ],
      });
    },
    bindHelper: (marker, identity) => {
      requireAvailable();
      if (!manifest.helpers.some((entry) => entry.marker === marker)) return;
      update({
        ...manifest,
        helpers: [...manifest.helpers.filter((entry) => entry.marker !== marker), identity],
      });
    },
    untrackHelper: (marker) => {
      if (stopped) return;
      update({
        ...manifest,
        helpers: manifest.helpers.filter((entry) => entry.marker !== marker),
      });
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearRecoveryTimer();
      const stoppedWorker = worker?.stop() ?? true;
      worker = null;
      if (stoppedWorker) rmSync(manifestPath, { force: true });
      if (activeReaper === reaper) activeReaper = null;
    },
  };
  activeReaper = reaper;
  return reaper;
}

export function ensureOwnerProcessReaper(): OwnerProcessReaper | null {
  if (activeReaper !== null) return activeReaper.restart() ? activeReaper : null;
  return startOwnerProcessReaper();
}

export function stopOwnerProcessReaper(): void {
  activeReaper?.stop();
}

export function trackOwnerProcess(identity: ProfileProcessIdentity): void {
  ensureOwnerProcessReaper()?.track(identity);
}

export function untrackOwnerProcess(identity: ProfileProcessIdentity): void {
  activeReaper?.untrack(identity);
}

export function trackOwnerBrowserLaunch(
  marker: string,
  profileDir: string,
  runtime: { ensureReaper?: typeof ensureOwnerProcessReaper } = {},
): void {
  const reaper = (runtime.ensureReaper ?? ensureOwnerProcessReaper)();
  if (process.platform === "linux" && reaper === null) {
    throw new Error("owner process reaper unavailable for local browser launch");
  }
  reaper?.trackLaunch(marker, profileDir);
}

export function bindOwnerBrowserLaunch(marker: string, identity: ProfileProcessIdentity): boolean {
  if (process.platform !== "linux") return true;
  return activeReaper?.bindLaunch(marker, identity) === true;
}

// Launch markers remain tracked until exact-marker cleanup completes. Linux has
// one custodian: the owner reaper. This compatibility hook intentionally does
// not arm a second process watchdog.
export function markOwnerBrowserLaunchTerminal(_marker: string): void {}

export function untrackOwnerBrowserLaunch(marker: string): void {
  activeReaper?.untrackLaunch(marker);
}

export function reconcileOwnerBrowserLaunchAfterLeaderExit(
  marker: string,
  profileDir: string,
  launchState: (
    marker: string,
    profileDir: string,
  ) => ProcessIdentityState = ownerBrowserLaunchState,
): void {
  if (launchState(marker, profileDir) === "stale") untrackOwnerBrowserLaunch(marker);
}

export function spawnOwnerTrackedHelper(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  runtime: { spawn?: typeof spawn } = {},
): ChildProcess {
  const reaper = ensureOwnerProcessReaper();
  if (process.platform === "linux" && reaper === null) {
    throw new Error("owner process reaper unavailable for session helper");
  }
  const marker = `v1:${randomUUID()}`;
  reaper?.reserveHelper(marker);
  let child: ChildProcess;
  try {
    child = (runtime.spawn ?? spawn)(command, [...args], {
      ...options,
      detached: process.platform === "linux" ? true : options.detached,
      env: {
        ...(options.env ?? process.env),
        [OWNER_HELPER_MARKER_ENV]: marker,
      },
    });
  } catch (error) {
    reaper?.untrackHelper(marker);
    throw error;
  }
  if (process.platform === "linux") {
    let record: OwnerHelperRecord = { marker, state: "pending" };
    if (child.pid !== undefined) {
      const birth = processBirthIdentity(child.pid);
      const processGroupId = linuxProcessGroupId(child.pid);
      if (birth !== null && typeof processGroupId === "number") {
        record = { ...birth, marker, process_group_id: processGroupId };
      }
    }
    trackedHelperProcesses.set(child, record);
    const releaseIfStale = (): void => {
      setTimeout(() => {
        if (trackedHelperProcesses.get(child) !== record) return;
        if (ownerHelperIdentityState(record) !== "stale") return;
        activeReaper?.untrackHelper(marker);
        trackedHelperProcesses.delete(child);
      }, 0).unref();
    };
    child.once("error", releaseIfStale);
    child.once("exit", releaseIfStale);
    if (!("state" in record)) {
      try {
        reaper?.bindHelper(marker, record);
      } catch (error) {
        if (terminateOwnerHelperAfterRegistrationFailure(child, record)) {
          try {
            reaper?.untrackHelper(marker);
            trackedHelperProcesses.delete(child);
          } catch {}
        }
        throw error;
      }
    }
  }
  return child;
}

export function signalOwnerTrackedHelper(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const identity = trackedHelperProcesses.get(child);
  if (identity !== undefined) return signalOwnerHelper(identity, signal);
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export function ownerTrackedHelperState(child: ChildProcess): ProcessIdentityState {
  const identity = trackedHelperProcesses.get(child);
  if (identity !== undefined) return ownerHelperIdentityState(identity);
  return child.exitCode !== null || child.signalCode !== null ? "stale" : "matching";
}

export async function waitForOwnerTrackedHelperExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ownerTrackedHelperState(child) !== "stale" && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(25, Math.max(1, deadline - Date.now())));
      timer.unref();
    });
  }
  return ownerTrackedHelperState(child) === "stale";
}

export function releaseOwnerTrackedHelper(child: ChildProcess): boolean {
  const record = trackedHelperProcesses.get(child);
  if (record === undefined || ownerHelperIdentityState(record) !== "stale") return false;
  activeReaper?.untrackHelper(record.marker);
  trackedHelperProcesses.delete(child);
  return true;
}
