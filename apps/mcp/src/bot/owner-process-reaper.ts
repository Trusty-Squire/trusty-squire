import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  operatorBrowserProcessCommandState,
  operatorBrowserProcessMarkerState,
  operatorBrowserProcessMatchesMarker,
  registerOperatorBrowserLaunchWatchdog,
  type OperatorBrowserLaunchWatchdogRegistration,
  type OperatorBrowserProcessMarkerState,
} from "./operator-browser-watchdog.js";
import { sweepOperatorProfilePoolOrphans } from "./operator-profile-pool.js";
import {
  clearStaleSingletonLock,
  processBirthIdentity,
  processBirthIdentityState,
  profileProcessIdentityState,
  signalProfileProcess,
  type ProcessIdentityState,
  type ProfileProcessIdentity,
} from "./profile.js";

interface OwnerIdentity {
  pid: number;
  start_time: string;
}

interface OwnerLaunchRecord {
  marker: string;
  user_data_dir: string;
}

interface OwnerProfileRecord {
  path: string;
  token: string;
  state: "pending" | "ready";
  staging_path?: string;
  reservation_path?: string;
}

interface OwnerArtifactRecord {
  path: string;
  root_path?: string;
  token: string;
  state: "pending" | "ready";
  reservation_path?: string;
}

type OwnerReaperManifestRead =
  | { state: "present"; manifest: OwnerReaperManifest }
  | { state: "missing" }
  | { state: "unknown" };

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
  profiles: OwnerProfileRecord[];
  helpers: OwnerHelperRecord[];
  artifacts: OwnerArtifactRecord[];
}

export interface OwnerProcessReaper {
  readonly manifestPath: string;
  readonly token: string;
  isAvailable(): boolean;
  restart(): boolean;
  track(identity: ProfileProcessIdentity): void;
  untrack(identity: ProfileProcessIdentity): void;
  trackLaunch(marker: string, profileDir: string): void;
  untrackLaunch(marker: string): void;
  reserveProfile(
    profileDir: string,
    stagingDir: string,
    reservationPath: string,
    token: string,
  ): void;
  commitProfile(profileDir: string, token: string): void;
  untrackProfile(profileDir: string): void;
  reserveHelper(marker: string): void;
  bindHelper(marker: string, identity: OwnerHelperIdentity): void;
  untrackHelper(marker: string): void;
  reserveArtifact(
    artifactDir: string,
    artifactRoot: string,
    reservationPath: string,
    token: string,
  ): void;
  commitArtifact(artifactDir: string, token: string): void;
  untrackArtifact(artifactDir: string): void;
  stop(): void;
}

export const OWNER_PROFILE_SIGNATURE_FILE = ".trusty-squire-owner-profile.json";
export const OWNER_ARTIFACT_SIGNATURE_FILE = ".trusty-squire-owner-artifact.json";
export const OWNER_ARTIFACT_ROOT_SIGNATURE_FILE = ".trusty-squire-owner-artifact-root.json";
export const OWNER_HELPER_MARKER_ENV = "TRUSTY_SQUIRE_OWNER_HELPER_MARKER";
export const OWNER_REAPER_WORKER_MARKER_ENV = "TRUSTY_SQUIRE_OWNER_REAPER_WORKER_MARKER";
const EPHEMERAL_PROFILE_PREFIX = "trusty-squire-operate-";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_WORKER_READY_TIMEOUT_MS = 2_000;
const DEFAULT_WORKER_STABILITY_MS = 100;
const PROFILE_RESERVATION_PREFIX = ".trusty-squire-profile-reservation-";
const ARTIFACT_RESERVATION_PREFIX = ".trusty-squire-artifact-reservation-";
const DEFAULT_WORKER_RECOVERY_BACKOFF_MS = 100;
const MAX_WORKER_RECOVERY_BACKOFF_MS = 5_000;
const REQUIRED_OWNER_REAPER_WORKERS = 2;
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

function isLaunch(value: unknown): value is OwnerLaunchRecord {
  if (value === null || typeof value !== "object") return false;
  const launch = value as Partial<OwnerLaunchRecord>;
  return typeof launch.marker === "string" && typeof launch.user_data_dir === "string";
}

function isProfile(value: unknown): value is OwnerProfileRecord {
  if (value === null || typeof value !== "object") return false;
  const profile = value as Partial<OwnerProfileRecord>;
  return (
    typeof profile.path === "string" &&
    typeof profile.token === "string" &&
    (profile.staging_path === undefined || typeof profile.staging_path === "string") &&
    (profile.reservation_path === undefined || typeof profile.reservation_path === "string") &&
    (profile.state === undefined || profile.state === "pending" || profile.state === "ready")
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
    typeof helper.start_time === "string" &&
    typeof helper.marker === "string" &&
    (helper.process_group_id === undefined || Number.isSafeInteger(helper.process_group_id))
  );
}

function isArtifact(value: unknown): value is OwnerArtifactRecord {
  if (value === null || typeof value !== "object") return false;
  const artifact = value as Partial<OwnerArtifactRecord>;
  return (
    typeof artifact.path === "string" &&
    typeof artifact.token === "string" &&
    (artifact.root_path === undefined || typeof artifact.root_path === "string") &&
    (artifact.reservation_path === undefined || typeof artifact.reservation_path === "string") &&
    (artifact.state === undefined || artifact.state === "pending" || artifact.state === "ready")
  );
}

function readManifest(path: string): OwnerReaperManifestRead {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      token?: string;
      owner?: OwnerIdentity;
      resources?: ProfileProcessIdentity[];
      launches?: unknown[];
      profiles?: unknown[];
      helpers?: unknown[];
      artifacts?: unknown[];
    };
    if (
      (value.version !== 1 &&
        value.version !== 2 &&
        value.version !== 3 &&
        value.version !== 4 &&
        value.version !== 5) ||
      typeof value.token !== "string" ||
      value.owner === undefined ||
      !Number.isSafeInteger(value.owner.pid) ||
      typeof value.owner.start_time !== "string" ||
      !Array.isArray(value.resources)
    ) {
      return { state: "unknown" };
    }
    const resources = value.resources.filter(
      (resource): resource is ProfileProcessIdentity =>
        resource !== null &&
        typeof resource === "object" &&
        typeof resource.host === "string" &&
        Number.isSafeInteger(resource.pid) &&
        typeof resource.start_time === "string" &&
        typeof resource.user_data_dir === "string",
    );
    const versionWithLaunches = value.version >= 2;
    const normalizedLaunches =
      versionWithLaunches && Array.isArray(value.launches) ? value.launches : [];
    const profiles = versionWithLaunches && Array.isArray(value.profiles) ? value.profiles : [];
    const helpers = value.version >= 3 && Array.isArray(value.helpers) ? value.helpers : [];
    const artifacts = value.version >= 5 && Array.isArray(value.artifacts) ? value.artifacts : [];
    if (
      resources.length !== value.resources.length ||
      normalizedLaunches.some((launch) => !isLaunch(launch)) ||
      profiles.some((profile) => !isProfile(profile)) ||
      helpers.some((helper) => !isHelper(helper)) ||
      artifacts.some((artifact) => !isArtifact(artifact))
    ) {
      return { state: "unknown" };
    }
    return {
      state: "present",
      manifest: {
        version: 5,
        token: value.token,
        owner: value.owner,
        resources,
        launches: normalizedLaunches as OwnerLaunchRecord[],
        profiles: (
          profiles as Array<
            Omit<OwnerProfileRecord, "state"> & { state?: OwnerProfileRecord["state"] }
          >
        ).map((profile) => ({ ...profile, state: profile.state ?? "ready" })),
        helpers: helpers as OwnerHelperRecord[],
        artifacts: (
          artifacts as Array<
            Omit<OwnerArtifactRecord, "state"> & { state?: OwnerArtifactRecord["state"] }
          >
        ).map((artifact) => ({ ...artifact, state: artifact.state ?? "ready" })),
      },
    };
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

export function shouldReapOwner(ownerState: ProcessIdentityState): boolean {
  return ownerState === "stale";
}

function ownerState(manifest: OwnerReaperManifest): ProcessIdentityState {
  const running = linuxProcessRunningState(manifest.owner.pid);
  if (running !== "matching") return running;
  return processBirthIdentityState(manifest.owner);
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
    return Number.isSafeInteger(processGroupId) && processGroupId > 0
      ? processGroupId
      : "unknown";
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

function helperGroupMarkerState(
  processGroupId: number,
  marker: string,
  options: HelperIdentityReaders = {},
): ProcessIdentityState {
  if (process.platform !== "linux" && options.readProcessIds === undefined) return "stale";
  let unknown = false;
  try {
    const processIds =
      options.readProcessIds?.() ??
      readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    for (const pid of processIds) {
      const groupId = (options.readProcessGroupId ?? linuxProcessGroupId)(pid);
      if (groupId === "unknown") {
        const runningState =
          options.readRunningState?.(pid) ??
          (options.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
        if (runningState === "stale") continue;
        const markerState = (options.readMarkerState ?? helperProcessMarkerState)(pid, marker);
        if (
          markerState === "matching" ||
          (markerState === "unknown" &&
            (options.readUidState ?? linuxProcessUidState)(pid) !== "stale")
        ) {
          unknown = true;
        }
        continue;
      }
      if (groupId === "stale" || groupId !== processGroupId) continue;
      const runningState =
        options.readRunningState?.(pid) ??
        (options.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
      if (runningState === "stale") continue;
      if (runningState === "unknown") {
        unknown = true;
        continue;
      }
      const state = (options.readMarkerState ?? helperProcessMarkerState)(pid, marker);
      if (state === "matching") return "matching";
      if (state === "unknown") unknown = true;
    }
  } catch {
    return "unknown";
  }
  return unknown ? "unknown" : "stale";
}

function exactHelperMarkerProcessScan(
  marker: string,
  options: HelperIdentityReaders = {},
): { matching: number[]; unknown: boolean } {
  if (process.platform !== "linux" && options.readProcessIds === undefined) {
    return { matching: [], unknown: false };
  }
  const matching: number[] = [];
  let unknown = false;
  try {
    const processIds =
      options.readProcessIds?.() ??
      readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    for (const pid of processIds) {
      const runningState =
        options.readRunningState?.(pid) ??
        (options.readProcessIds === undefined ? linuxProcessRunningState(pid) : "matching");
      if (runningState === "stale") continue;
      if (runningState === "unknown") {
        if ((options.readUidState ?? linuxProcessUidState)(pid) !== "stale") unknown = true;
        continue;
      }
      const state = (options.readMarkerState ?? helperProcessMarkerState)(pid, marker);
      if (state === "matching") matching.push(pid);
      else if (
        state === "unknown" &&
        (options.readUidState ?? linuxProcessUidState)(pid) !== "stale"
      ) {
        unknown = true;
      }
    }
  } catch {
    unknown = true;
  }
  return { matching, unknown };
}

function exactHelperMarkerProcessIds(marker: string): number[] {
  return exactHelperMarkerProcessScan(marker).matching;
}

export function ownerHelperIdentityState(
  identity: OwnerHelperRecord,
  options: HelperIdentityReaders = {},
): ProcessIdentityState {
  if ("state" in identity) {
    const scan = exactHelperMarkerProcessScan(identity.marker, options);
    if (scan.matching.length > 0) return "matching";
    return scan.unknown ? "unknown" : "stale";
  }
  if (identity.process_group_id !== undefined) {
    const groupState = helperGroupMarkerState(identity.process_group_id, identity.marker, options);
    if (groupState !== "stale") return groupState;
  }
  const running =
    options.readRunningState?.(identity.pid) ??
    (options.readBirthState === undefined ? linuxProcessRunningState(identity.pid) : "matching");
  if (running !== "matching") return running;
  const birth = options.readBirthState?.(identity) ?? processBirthIdentityState(identity);
  if (birth !== "matching") return birth;
  return (options.readMarkerState ?? helperProcessMarkerState)(identity.pid, identity.marker);
}

function signalOwnerHelper(identity: OwnerHelperRecord, signal: NodeJS.Signals): boolean {
  if (process.platform !== "linux") return false;
  if ("state" in identity) {
    let signalled = false;
    const groups = new Set(
      exactHelperMarkerProcessIds(identity.marker).flatMap((pid) => {
        const groupId = linuxProcessGroupId(pid);
        return typeof groupId !== "number" ||
          helperGroupMarkerState(groupId, identity.marker) !== "matching"
          ? []
          : [groupId];
      }),
    );
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

function exactMarkerProcessScan(
  marker: string,
  options: {
    readProcessIds?: () => number[];
    readMarker?: (pid: number) => string | null;
    readMarkerState?: (pid: number) => OperatorBrowserProcessMarkerState;
    readCommandState?: (pid: number) => ProcessIdentityState;
    readUidState?: (pid: number) => ProcessIdentityState;
  } = {},
): { matching: number[]; unknown: boolean } {
  if (process.platform !== "linux" && options.readProcessIds === undefined) {
    return { matching: [], unknown: false };
  }
  const matching: number[] = [];
  let unknown = false;
  try {
    const processIds =
      options.readProcessIds?.() ??
      readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    for (const pid of processIds) {
      const commandState = (options.readCommandState ?? operatorBrowserProcessCommandState)(pid);
      if (commandState === "stale") continue;
      const markerState =
        options.readMarkerState?.(pid) ??
        (options.readMarker !== undefined
          ? (() => {
              const value = options.readMarker!(pid);
              return value === null
                ? ({ state: "missing" } as const)
                : ({ state: "present", marker: value } as const);
            })()
          : operatorBrowserProcessMarkerState(pid));
      if (markerState.state === "unknown") {
        if ((options.readUidState ?? linuxProcessUidState)(pid) !== "stale") unknown = true;
        continue;
      }
      if (markerState.state !== "present" || markerState.marker !== marker) continue;
      if (commandState === "matching") matching.push(pid);
      else unknown = true;
    }
  } catch {
    unknown = true;
  }
  return { matching, unknown };
}

function exactMarkerProcessIds(marker: string): number[] {
  return exactMarkerProcessScan(marker).matching;
}

export function ownerBrowserLaunchState(
  marker: string,
  options: Parameters<typeof exactMarkerProcessScan>[1] = {},
): ProcessIdentityState {
  const scan = exactMarkerProcessScan(marker, options);
  if (scan.matching.length > 0) return "matching";
  return scan.unknown ? "unknown" : "stale";
}

export async function terminateOwnerBrowserLaunch(
  marker: string,
  options: {
    graceMs?: number;
    readProcessIds?: () => number[];
    processMatches?: (pid: number, marker: string) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const usesDefaultIdentity =
    options.readProcessIds === undefined && options.processMatches === undefined;
  const readProcessIds = options.readProcessIds ?? (() => exactMarkerProcessIds(marker));
  const processMatches =
    options.processMatches ??
    ((pid, expectedMarker) => operatorBrowserProcessMatchesMarker(pid, expectedMarker));
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const wait =
    options.wait ??
    (async (ms) => await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const graceMs =
    options.graceMs ?? envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const matching = (): number[] => readProcessIds().filter((pid) => processMatches(pid, marker));
  const signal = (pids: readonly number[], signalName: NodeJS.Signals): void => {
    for (const pid of pids) {
      if (!processMatches(pid, marker)) continue;
      try {
        kill(pid, signalName);
      } catch {}
    }
  };
  const initial = matching();
  if (initial.length === 0) {
    return !usesDefaultIdentity || ownerBrowserLaunchState(marker) === "stale";
  }
  signal(initial, "SIGTERM");
  await wait(graceMs);
  const resistant = matching();
  if (resistant.length === 0) {
    return !usesDefaultIdentity || ownerBrowserLaunchState(marker) === "stale";
  }
  signal(resistant, "SIGKILL");
  await wait(graceMs);
  return (
    matching().length === 0 && (!usesDefaultIdentity || ownerBrowserLaunchState(marker) === "stale")
  );
}

function signalTrackedResources(manifest: OwnerReaperManifest, signal: NodeJS.Signals): number {
  let signalled = 0;
  for (const identity of manifest.resources) {
    if (signalProfileProcess(identity, identity.user_data_dir, signal)) signalled += 1;
  }
  for (const launch of manifest.launches) {
    for (const pid of exactMarkerProcessIds(launch.marker)) {
      if (!operatorBrowserProcessMatchesMarker(pid, launch.marker)) continue;
      try {
        process.kill(pid, signal);
        signalled += 1;
      } catch {
        // It exited between discovery and the signal.
      }
    }
  }
  for (const helper of manifest.helpers) {
    if (signalOwnerHelper(helper, signal)) signalled += 1;
  }
  return signalled;
}

function profileSignatureMatches(record: OwnerProfileRecord, directory: string): boolean {
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return false;
    const signature = JSON.parse(
      readFileSync(join(directory, OWNER_PROFILE_SIGNATURE_FILE), "utf8"),
    ) as {
      version?: unknown;
      token?: unknown;
      path?: unknown;
    };
    return (
      signature.version === 1 &&
      signature.token === record.token &&
      signature.path === resolve(record.path)
    );
  } catch {
    return false;
  }
}

function signedEphemeralProfile(record: OwnerProfileRecord): boolean {
  const path = resolve(record.path);
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith(EPHEMERAL_PROFILE_PREFIX)) {
    return false;
  }
  return profileSignatureMatches(record, path);
}

function signedStagedEphemeralProfile(record: OwnerProfileRecord): boolean {
  if (record.state !== "pending" || record.staging_path === undefined) return false;
  const stagingPath = resolve(record.staging_path);
  if (
    dirname(stagingPath) !== resolve(tmpdir()) ||
    !basename(stagingPath).startsWith(".trusty-squire-profile-staging-")
  ) {
    return false;
  }
  return profileSignatureMatches(record, stagingPath);
}

function profileReservationMatches(record: OwnerProfileRecord): boolean {
  if (
    record.state !== "pending" ||
    record.staging_path === undefined ||
    record.reservation_path === undefined
  ) {
    return false;
  }
  const reservationPath = resolve(record.reservation_path);
  if (
    dirname(reservationPath) !== resolve(tmpdir()) ||
    !basename(reservationPath).startsWith(PROFILE_RESERVATION_PREFIX)
  ) {
    return false;
  }
  try {
    const stat = lstatSync(reservationPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const reservation = JSON.parse(readFileSync(reservationPath, "utf8")) as {
      version?: unknown;
      token?: unknown;
      path?: unknown;
      staging_path?: unknown;
    };
    return (
      reservation.version === 1 &&
      reservation.token === record.token &&
      reservation.path === resolve(record.path) &&
      reservation.staging_path === resolve(record.staging_path)
    );
  } catch {
    return false;
  }
}

function trackedPathState(path: string): ProcessIdentityState {
  try {
    lstatSync(path);
    return "matching";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function ownerProfileState(
  record: OwnerProfileRecord,
  readPathState: (path: string) => ProcessIdentityState = trackedPathState,
): ProcessIdentityState {
  const states = [
    readPathState(record.path),
    ...(record.staging_path === undefined ? [] : [readPathState(record.staging_path)]),
    ...(record.reservation_path === undefined ? [] : [readPathState(record.reservation_path)]),
  ];
  if (states.every((state) => state === "stale")) return "stale";
  if (states.some((state) => state === "unknown")) return "unknown";
  if (
    signedEphemeralProfile(record) ||
    signedStagedEphemeralProfile(record) ||
    profileReservationMatches(record)
  ) {
    return "matching";
  }
  return "unknown";
}

function privateDirectoryMatches(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    return realpathSync(path) === resolve(path);
  } catch {
    return false;
  }
}

function readExactArtifactSignature(signaturePath: string): {
  version?: unknown;
  token?: unknown;
  path?: unknown;
  root_path?: unknown;
  owner_token?: unknown;
} | null {
  try {
    const stat = lstatSync(signaturePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    return JSON.parse(readFileSync(signaturePath, "utf8")) as {
      version?: unknown;
      token?: unknown;
      path?: unknown;
      root_path?: unknown;
      owner_token?: unknown;
    };
  } catch {
    return null;
  }
}

function artifactRootSignatureMatches(record: OwnerArtifactRecord, ownerToken: string): boolean {
  if (record.root_path === undefined) return false;
  const rootPath = resolve(record.root_path);
  if (!privateDirectoryMatches(rootPath)) return false;
  const signature = readExactArtifactSignature(join(rootPath, OWNER_ARTIFACT_ROOT_SIGNATURE_FILE));
  return (
    signature?.version === 1 &&
    signature.token === record.token &&
    signature.path === rootPath &&
    signature.owner_token === ownerToken
  );
}

function artifactLayoutMatches(record: OwnerArtifactRecord): boolean {
  if (record.root_path === undefined) return false;
  const path = resolve(record.path);
  const rootPath = resolve(record.root_path);
  return (
    dirname(path) === rootPath && basename(rootPath) === `.trusty-squire-owner-${record.token}`
  );
}

function artifactSignatureMatches(record: OwnerArtifactRecord, ownerToken: string): boolean {
  try {
    const path = resolve(record.path);
    if (!artifactLayoutMatches(record) || !artifactRootSignatureMatches(record, ownerToken)) {
      return false;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    const signature = readExactArtifactSignature(join(path, OWNER_ARTIFACT_SIGNATURE_FILE));
    return (
      signature?.version === 1 &&
      signature.token === record.token &&
      signature.path === path &&
      signature.root_path === resolve(record.root_path!) &&
      signature.owner_token === ownerToken
    );
  } catch {
    return false;
  }
}

function artifactReservationMatches(record: OwnerArtifactRecord, ownerToken: string): boolean {
  if (
    record.state !== "pending" ||
    record.root_path === undefined ||
    record.reservation_path === undefined ||
    !artifactLayoutMatches(record)
  ) {
    return false;
  }
  const reservationPath = resolve(record.reservation_path);
  if (!basename(reservationPath).startsWith(ARTIFACT_RESERVATION_PREFIX)) return false;
  try {
    const stat = lstatSync(reservationPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const reservation = JSON.parse(readFileSync(reservationPath, "utf8")) as {
      version?: unknown;
      token?: unknown;
      path?: unknown;
      root_path?: unknown;
      owner_token?: unknown;
    };
    return (
      reservation.version === 1 &&
      reservation.token === record.token &&
      reservation.path === resolve(record.path) &&
      reservation.root_path === resolve(record.root_path) &&
      reservation.owner_token === ownerToken
    );
  } catch {
    return false;
  }
}

function ownerArtifactState(
  record: OwnerArtifactRecord,
  ownerToken: string,
  readPathState: (path: string) => ProcessIdentityState = trackedPathState,
): ProcessIdentityState {
  const states = [
    readPathState(record.path),
    ...(record.root_path === undefined ? [] : [readPathState(record.root_path)]),
    ...(record.reservation_path === undefined ? [] : [readPathState(record.reservation_path)]),
  ];
  if (states.every((state) => state === "stale")) return "stale";
  if (states.some((state) => state === "unknown")) return "unknown";
  if (
    artifactSignatureMatches(record, ownerToken) ||
    artifactReservationMatches(record, ownerToken)
  ) {
    return "matching";
  }
  return "unknown";
}

function profileProcessesAreStale(
  manifest: OwnerReaperManifest,
  profile: OwnerProfileRecord,
): boolean {
  const profileDir = resolve(profile.path);
  return (
    manifest.resources
      .filter((identity) => resolve(identity.user_data_dir) === profileDir)
      .every(
        (identity) => profileProcessIdentityState(identity, identity.user_data_dir) === "stale",
      ) &&
    manifest.launches
      .filter((launch) => resolve(launch.user_data_dir) === profileDir)
      .every((launch) => ownerBrowserLaunchState(launch.marker) === "stale")
  );
}

type OwnerReaperRemove = (path: string, options: { recursive?: boolean; force?: boolean }) => void;

interface OwnerReaperOperations {
  removePath?: OwnerReaperRemove;
  readPathState?: (path: string) => ProcessIdentityState;
}

function removeTrackedPath(
  removePath: OwnerReaperRemove,
  path: string,
  options: { recursive?: boolean; force?: boolean },
): void {
  try {
    removePath(path, options);
  } catch {}
}

function cleanTrackedProfiles(
  manifest: OwnerReaperManifest,
  removePath: OwnerReaperRemove = rmSync,
  readPathState: (path: string) => ProcessIdentityState = trackedPathState,
): void {
  for (const identity of manifest.resources) {
    if (profileProcessIdentityState(identity, identity.user_data_dir) === "stale") {
      clearStaleSingletonLock(identity.user_data_dir);
    }
  }
  for (const profile of manifest.profiles) {
    if (!profileProcessesAreStale(manifest, profile)) continue;
    const finalState = readPathState(profile.path);
    const stagingState =
      profile.staging_path === undefined ? "stale" : readPathState(profile.staging_path);
    const reservationState =
      profile.reservation_path === undefined ? "stale" : readPathState(profile.reservation_path);
    const reservationMatches =
      reservationState === "matching" && profileReservationMatches(profile);
    if (finalState === "matching" && signedEphemeralProfile(profile)) {
      removeTrackedPath(removePath, profile.path, { recursive: true, force: true });
    }
    if (
      profile.staging_path !== undefined &&
      stagingState === "matching" &&
      (signedStagedEphemeralProfile(profile) || reservationMatches)
    ) {
      removeTrackedPath(removePath, profile.staging_path, { recursive: true, force: true });
    }
    if (profile.reservation_path !== undefined && reservationMatches) {
      const finalAfter = readPathState(profile.path);
      const stagingAfter =
        profile.staging_path === undefined ? "stale" : readPathState(profile.staging_path);
      if (finalAfter === "stale" && stagingAfter === "stale") {
        removeTrackedPath(removePath, profile.reservation_path, { force: true });
      }
    }
  }
}

function cleanTrackedArtifacts(
  manifest: OwnerReaperManifest,
  removePath: OwnerReaperRemove = rmSync,
  readPathState: (path: string) => ProcessIdentityState = trackedPathState,
): void {
  for (const artifact of manifest.artifacts) {
    const artifactState = readPathState(artifact.path);
    const rootState =
      artifact.root_path === undefined ? "stale" : readPathState(artifact.root_path);
    const reservationState =
      artifact.reservation_path === undefined
        ? "stale"
        : readPathState(artifact.reservation_path);
    const reservationMatches =
      reservationState === "matching" &&
      artifactReservationMatches(artifact, manifest.token);
    const rootMatches =
      rootState === "matching" && artifactRootSignatureMatches(artifact, manifest.token);
    const reservedRootMatches =
      reservationMatches &&
      rootState === "matching" &&
      artifactLayoutMatches(artifact) &&
      privateDirectoryMatches(resolve(artifact.root_path!));
    const reservedLeafMatches =
      reservationMatches &&
      rootMatches &&
      artifactState === "matching" &&
      artifactLayoutMatches(artifact) &&
      privateDirectoryMatches(resolve(artifact.path));
    if (
      artifactState === "matching" &&
      rootState === "matching" &&
      (artifactSignatureMatches(artifact, manifest.token) || reservedLeafMatches)
    ) {
      removeTrackedPath(removePath, artifact.path, { recursive: true, force: true });
    }
    if (
      artifact.root_path !== undefined &&
      readPathState(artifact.path) === "stale" &&
      (rootMatches || reservedRootMatches)
    ) {
      removeTrackedPath(removePath, artifact.root_path, { recursive: true, force: true });
    }
    if (
      artifact.reservation_path !== undefined &&
      reservationMatches &&
      readPathState(artifact.path) === "stale" &&
      (artifact.root_path === undefined || readPathState(artifact.root_path) === "stale")
    ) {
      removeTrackedPath(removePath, artifact.reservation_path, { force: true });
    }
  }
}

function manifestCleanupComplete(
  manifest: OwnerReaperManifest,
  readPathState: (path: string) => ProcessIdentityState = trackedPathState,
): boolean {
  return (
    manifest.resources.every(
      (identity) => profileProcessIdentityState(identity, identity.user_data_dir) === "stale",
    ) &&
    manifest.launches.every((launch) => ownerBrowserLaunchState(launch.marker) === "stale") &&
    manifest.helpers.every((helper) => ownerHelperIdentityState(helper) === "stale") &&
    manifest.profiles.every((profile) => ownerProfileState(profile, readPathState) === "stale") &&
    manifest.artifacts.every(
      (artifact) => ownerArtifactState(artifact, manifest.token, readPathState) === "stale",
    )
  );
}

async function reapManifest(
  path: string,
  manifest: OwnerReaperManifest,
  operations: OwnerReaperOperations = {},
): Promise<number> {
  const graceMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const signalled = signalTrackedResources(manifest, "SIGTERM");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs));
  const latestRead = readManifest(path);
  const latest = latestRead.state === "present" ? latestRead.manifest : manifest;
  signalTrackedResources(latest, "SIGKILL");
  const readPathState = operations.readPathState ?? trackedPathState;
  cleanTrackedProfiles(latest, operations.removePath, readPathState);
  cleanTrackedArtifacts(latest, operations.removePath, readPathState);
  await sweepOperatorProfilePoolOrphans().catch(() => undefined);
  if (
    latestRead.state === "present" &&
    manifestCleanupComplete(latest, readPathState)
  ) {
    removeTrackedPath(operations.removePath ?? rmSync, path, { force: true });
  }
  return signalled;
}

export async function sweepOrphanedOwnerProcesses(
  rootDir = defaultRootDir(),
  operations: OwnerReaperOperations = {},
): Promise<number> {
  if (process.platform !== "linux" || !existsSync(rootDir)) return 0;
  let reaped = 0;
  for (const entry of readdirSync(rootDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(rootDir, entry);
    const read = readManifest(path);
    if (read.state !== "present" || !shouldReapOwner(ownerState(read.manifest))) continue;
    reaped += await reapManifest(path, read.manifest, operations);
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
    const manifest = read.manifest;
    if (!ready) {
      onReady();
      ready = true;
    }
    if (shouldReapOwner(ownerState(manifest))) {
      await reapManifest(manifestPath, manifest);
      if (readManifest(manifestPath).state === "missing") return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

function ownerReaperWorkerRunning(identity: OwnerIdentity): boolean {
  if (processBirthIdentityState(identity) !== "matching") return false;
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = close < 0 ? undefined : stat.slice(close + 2).split(" ")[0];
    return state !== undefined && state !== "Z" && state !== "X";
  } catch {
    return false;
  }
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
    if (
      worker.pid !== undefined &&
      !terminateOwnerHelperAfterRegistrationFailure(worker, workerRecord)
    ) {
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
  void sweepOrphanedOwnerProcesses(rootDir).catch(() => undefined);
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
    profiles: [],
    helpers: [],
    artifacts: [],
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
  let stopped = false;
  const spawnWorker = runtime.spawn ?? spawn;
  let workerGeneration = 0;
  let recovering = false;
  let recoveryAttempt = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const workerHandles = new Map<number, OwnerReaperWorkerHandle>();
  function clearRecoveryTimer(): void {
    if (recoveryTimer === null) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  function scheduleWorkerRecovery(immediate = false): void {
    if (stopped || recovering || recoveryTimer !== null) return;
    const read = readManifest(manifestPath);
    if (
      read.state === "missing" ||
      (read.state === "present" && manifestCleanupComplete(read.manifest))
    ) {
      return;
    }
    const base = envPositiveMs(
      "TRUSTY_SQUIRE_REAPER_RECOVERY_BACKOFF_MS",
      DEFAULT_WORKER_RECOVERY_BACKOFF_MS,
    );
    const delay = immediate
      ? 0
      : Math.min(base * 2 ** Math.min(recoveryAttempt, 6), MAX_WORKER_RECOVERY_BACKOFF_MS);
    recoveryAttempt += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (stopped || recovering) return;
      recovering = true;
      let launched: OwnerReaperWorkerHandle | null = null;
      try {
        launched = launchWorker();
      } catch {}
      recovering = false;
      if (launched === null || workerHandles.size < REQUIRED_OWNER_REAPER_WORKERS) {
        scheduleWorkerRecovery();
      } else {
        recoveryAttempt = 0;
      }
    }, delay);
    recoveryTimer.unref();
  }
  function launchWorker(): OwnerReaperWorkerHandle | null {
    runtime.beforeWorkerLaunch?.();
    const generation = ++workerGeneration;
    const handle = launchOwnerReaperWorker(
      workerPath,
      manifestPath,
      rootDir,
      token,
      spawnWorker,
      () => {
        workerHandles.delete(generation);
        scheduleWorkerRecovery(true);
      },
    );
    if (handle !== null) workerHandles.set(generation, handle);
    return handle;
  }
  if (launchWorker() === null) {
    rmSync(manifestPath, { force: true });
    return null;
  }
  const discardUnavailableWorkers = (): void => {
    for (const [generation, handle] of workerHandles) {
      if (handle.isAvailable()) continue;
      handle.stop();
      workerHandles.delete(generation);
    }
  };
  const isAvailable = (): boolean => {
    if (stopped) return false;
    discardUnavailableWorkers();
    return workerHandles.size > 0;
  };
  const ensureRequiredWorkers = (): boolean => {
    if (stopped) return false;
    clearRecoveryTimer();
    discardUnavailableWorkers();
    while (workerHandles.size < REQUIRED_OWNER_REAPER_WORKERS) {
      if (launchWorker() === null) {
        if (workerHandles.size > 0) scheduleWorkerRecovery();
        return false;
      }
    }
    recoveryAttempt = 0;
    return true;
  };
  const restart = (): boolean => {
    return ensureRequiredWorkers();
  };
  const requireAvailable = (): void => {
    if (!ensureRequiredWorkers()) throw new Error("owner process reaper worker unavailable");
  };
  const update = (next: OwnerReaperManifest): void => {
    manifest = next;
    writeManifest(manifestPath, manifest);
  };
  const reaper: OwnerProcessReaper = {
    manifestPath,
    token,
    isAvailable,
    restart,
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
          { marker, user_data_dir: resolve(profileDir) },
        ],
      });
    },
    untrackLaunch: (marker) => {
      if (stopped) return;
      update({
        ...manifest,
        launches: manifest.launches.filter((entry) => entry.marker !== marker),
      });
    },
    reserveProfile: (profileDir, stagingDir, reservationPath, profileToken) => {
      requireAvailable();
      const path = resolve(profileDir);
      const stagingPath = resolve(stagingDir);
      const durableReservationPath = resolve(reservationPath);
      if (
        dirname(path) !== resolve(tmpdir()) ||
        !basename(path).startsWith(EPHEMERAL_PROFILE_PREFIX) ||
        dirname(stagingPath) !== resolve(tmpdir()) ||
        !basename(stagingPath).startsWith(".trusty-squire-profile-staging-") ||
        dirname(durableReservationPath) !== resolve(tmpdir()) ||
        !basename(durableReservationPath).startsWith(PROFILE_RESERVATION_PREFIX)
      )
        return;
      update({
        ...manifest,
        profiles: [
          ...manifest.profiles.filter((entry) => entry.path !== path),
          {
            path,
            staging_path: stagingPath,
            reservation_path: durableReservationPath,
            token: profileToken,
            state: "pending",
          },
        ],
      });
    },
    commitProfile: (profileDir, profileToken) => {
      requireAvailable();
      const path = resolve(profileDir);
      const reserved = manifest.profiles.some(
        (entry) => entry.path === path && entry.token === profileToken && entry.state === "pending",
      );
      if (!reserved) return;
      update({
        ...manifest,
        profiles: [
          ...manifest.profiles.filter((entry) => entry.path !== path),
          { path, token: profileToken, state: "ready" },
        ],
      });
    },
    untrackProfile: (profileDir) => {
      if (stopped) return;
      const path = resolve(profileDir);
      update({ ...manifest, profiles: manifest.profiles.filter((entry) => entry.path !== path) });
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
    reserveArtifact: (artifactDir, artifactRoot, reservationPath, artifactToken) => {
      requireAvailable();
      const path = resolve(artifactDir);
      const rootPath = resolve(artifactRoot);
      const durableReservationPath = resolve(reservationPath);
      if (
        dirname(durableReservationPath) !== rootDir ||
        !basename(durableReservationPath).startsWith(ARTIFACT_RESERVATION_PREFIX)
      ) {
        return;
      }
      update({
        ...manifest,
        artifacts: [
          ...manifest.artifacts.filter((entry) => entry.path !== path),
          {
            path,
            root_path: rootPath,
            token: artifactToken,
            state: "pending",
            reservation_path: durableReservationPath,
          },
        ],
      });
    },
    commitArtifact: (artifactDir, artifactToken) => {
      requireAvailable();
      const path = resolve(artifactDir);
      const reserved = manifest.artifacts.find(
        (entry) =>
          entry.path === path && entry.token === artifactToken && entry.state === "pending",
      );
      if (!reserved) return;
      update({
        ...manifest,
        artifacts: [
          ...manifest.artifacts.filter((entry) => entry.path !== path),
          { path, root_path: reserved.root_path, token: artifactToken, state: "ready" },
        ],
      });
    },
    untrackArtifact: (artifactDir) => {
      if (stopped) return;
      const path = resolve(artifactDir);
      update({
        ...manifest,
        artifacts: manifest.artifacts.filter((entry) => entry.path !== path),
      });
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearRecoveryTimer();
      for (const launch of manifest.launches) {
        trackedLaunchWatchdogs.get(launch.marker)?.dispose();
        trackedLaunchWatchdogs.delete(launch.marker);
      }
      trackedSessionArtifacts.clear();
      let workersStopped = true;
      for (const handle of workerHandles.values()) {
        if (!handle.stop()) workersStopped = false;
      }
      workerHandles.clear();
      if (workersStopped) rmSync(manifestPath, { force: true });
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
const trackedLaunchWatchdogs = new Map<string, OperatorBrowserLaunchWatchdogRegistration>();
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
  if (!trackedLaunchWatchdogs.has(marker)) {
    trackedLaunchWatchdogs.set(marker, registerOperatorBrowserLaunchWatchdog(marker));
  }
}
export function markOwnerBrowserLaunchTerminal(marker: string): void {
  trackedLaunchWatchdogs.get(marker)?.permitTerminalCleanup();
}
export function untrackOwnerBrowserLaunch(marker: string): void {
  trackedLaunchWatchdogs.get(marker)?.dispose();
  trackedLaunchWatchdogs.delete(marker);
  activeReaper?.untrackLaunch(marker);
}
export function reconcileOwnerBrowserLaunchAfterLeaderExit(
  marker: string,
  launchState: (marker: string) => ProcessIdentityState = ownerBrowserLaunchState,
): void {
  if (launchState(marker) === "stale") untrackOwnerBrowserLaunch(marker);
}

export function createOwnerEphemeralProfile(
  operations: {
    path?: () => string;
    stagingPath?: () => string;
    reservationPath?: () => string;
    writeReservation?: (path: string, contents: string) => void;
    createDirectory?: (path: string) => void;
    writeSignature?: (path: string, contents: string) => void;
    publish?: (stagingPath: string, path: string) => void;
  } = {},
): string {
  const reaper = ensureOwnerProcessReaper();
  if (process.platform === "linux" && reaper === null) {
    throw new Error("owner process reaper unavailable for ephemeral profile");
  }
  const token = randomUUID();
  const profileDir = resolve(
    operations.path?.() ?? join(tmpdir(), `${EPHEMERAL_PROFILE_PREFIX}${randomUUID()}`),
  );
  const stagingDir = resolve(
    operations.stagingPath?.() ?? join(tmpdir(), `.trusty-squire-profile-staging-${token}`),
  );
  const reservationPath = resolve(
    operations.reservationPath?.() ?? join(tmpdir(), `${PROFILE_RESERVATION_PREFIX}${token}.json`),
  );
  reaper?.reserveProfile(profileDir, stagingDir, reservationPath, token);
  let reservationCreated = false;
  let created = false;
  let published = false;
  try {
    const reservation = `${JSON.stringify({
      version: 1,
      token,
      path: profileDir,
      staging_path: stagingDir,
    })}\n`;
    (
      operations.writeReservation ??
      ((path, contents) => writeFileSync(path, contents, { mode: 0o600, flag: "wx" }))
    )(reservationPath, reservation);
    reservationCreated = true;
    (operations.createDirectory ?? ((path) => mkdirSync(path, { mode: 0o700 })))(stagingDir);
    created = true;
    chmodSync(stagingDir, 0o700);
    const signature = `${JSON.stringify({ version: 1, token, path: profileDir })}\n`;
    (
      operations.writeSignature ??
      ((path, contents) =>
        writeFileSync(join(path, OWNER_PROFILE_SIGNATURE_FILE), contents, {
          mode: 0o600,
          flag: "wx",
        }))
    )(stagingDir, signature);
    (operations.publish ?? renameSync)(stagingDir, profileDir);
    published = true;
    rmSync(reservationPath, { force: true });
    reservationCreated = false;
    reaper?.commitProfile(profileDir, token);
    return profileDir;
  } catch (error) {
    if (published) rmSync(profileDir, { recursive: true, force: true });
    else if (created) rmSync(stagingDir, { recursive: true, force: true });
    if (reservationCreated) rmSync(reservationPath, { force: true });
    reaper?.untrackProfile(profileDir);
    throw error;
  }
}

export function untrackOwnerEphemeralProfile(profileDir: string): void {
  activeReaper?.untrackProfile(profileDir);
}

interface TrackedSessionArtifact {
  path: string;
  rootPath: string;
  token: string;
  ownerToken: string;
}

const trackedSessionArtifacts = new Map<string, TrackedSessionArtifact>();

function writeExclusivePrivateFile(path: string, contents: string, onCreated?: () => void): void {
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  onCreated?.();
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("unsafe artifact signature");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("artifact signature owner mismatch");
    }
    writeFileSync(descriptor, contents, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
}

function trackedArtifactMatches(record: TrackedSessionArtifact): boolean {
  return artifactSignatureMatches(
    {
      path: record.path,
      root_path: record.rootPath,
      token: record.token,
      state: "ready",
    },
    record.ownerToken,
  );
}

export function trackOwnerSessionArtifact(
  artifactDir: string,
  operations: {
    commitArtifact?: (reaper: OwnerProcessReaper, path: string, token: string) => void;
  } = {},
): string {
  const requestedPath = resolve(artifactDir);
  if (process.platform !== "linux") {
    ensurePrivateDir(requestedPath);
    return requestedPath;
  }
  const existing = trackedSessionArtifacts.get(requestedPath);
  if (existing !== undefined) {
    if (!trackedArtifactMatches(existing)) {
      throw new Error("session artifact ownership changed");
    }
    return existing.path;
  }
  if (existsSync(requestedPath)) throw new Error("session artifact path already exists");
  const parent = dirname(requestedPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!privateDirectoryMatches(parent)) throw new Error("unsafe session artifact parent");
  const reaper = ensureOwnerProcessReaper();
  if (reaper === null) throw new Error("owner process reaper unavailable for session artifact");
  const token = randomUUID();
  const rootPath = join(parent, `.trusty-squire-owner-${token}`);
  const path = join(rootPath, basename(requestedPath));
  const reservationPath = join(
    dirname(reaper.manifestPath),
    `${ARTIFACT_RESERVATION_PREFIX}${token}.json`,
  );
  reaper.reserveArtifact(path, rootPath, reservationPath, token);
  let reservationCreated = false;
  let rootCreated = false;
  let leafCreated = false;
  try {
    writeExclusivePrivateFile(
      reservationPath,
      `${JSON.stringify({
        version: 1,
        token,
        path,
        root_path: rootPath,
        owner_token: reaper.token,
      })}\n`,
      () => {
        reservationCreated = true;
      },
    );
    mkdirSync(rootPath, { mode: 0o700 });
    rootCreated = true;
    if (!privateDirectoryMatches(rootPath)) throw new Error("unsafe artifact owner directory");
    writeExclusivePrivateFile(
      join(rootPath, OWNER_ARTIFACT_ROOT_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token, path: rootPath, owner_token: reaper.token })}\n`,
    );
    mkdirSync(path, { mode: 0o700 });
    leafCreated = true;
    if (!privateDirectoryMatches(path) || dirname(realpathSync(path)) !== realpathSync(rootPath)) {
      throw new Error("unsafe session artifact directory");
    }
    writeExclusivePrivateFile(
      join(path, OWNER_ARTIFACT_SIGNATURE_FILE),
      `${JSON.stringify({
        version: 1,
        token,
        path,
        root_path: rootPath,
        owner_token: reaper.token,
      })}\n`,
    );
    rmSync(reservationPath, { force: true });
    reservationCreated = false;
    (operations.commitArtifact ?? ((ownerReaper, ownedPath, artifactToken) => {
      ownerReaper.commitArtifact(ownedPath, artifactToken);
    }))(reaper, path, token);
    trackedSessionArtifacts.set(requestedPath, {
      path,
      rootPath,
      token,
      ownerToken: reaper.token,
    });
    return path;
  } catch (error) {
    const record: OwnerArtifactRecord = {
      path,
      root_path: rootPath,
      token,
      state: "pending",
      reservation_path: reservationPath,
    };
    if (rootCreated || leafCreated) {
      cleanTrackedArtifacts(
        {
          version: 5,
          token: reaper.token,
          owner: { pid: process.pid, start_time: "rollback" },
          resources: [],
          launches: [],
          profiles: [],
          helpers: [],
          artifacts: [record],
        },
      );
    } else if (reservationCreated) {
      removeTrackedPath(rmSync, reservationPath, { force: true });
    }
    if (ownerArtifactState(record, reaper.token) === "stale") {
      try {
        reaper.untrackArtifact(path);
      } catch {}
    }
    throw error;
  }
}

export function removeOwnerSessionArtifact(artifactDir: string): void {
  const requestedPath = resolve(artifactDir);
  if (process.platform !== "linux") {
    rmSync(requestedPath, { recursive: true, force: true });
    return;
  }
  const tracked = trackedSessionArtifacts.get(requestedPath);
  if (tracked === undefined) return;
  if (!trackedArtifactMatches(tracked)) throw new Error("session artifact ownership changed");
  rmSync(tracked.path, { recursive: true, force: true });
  const record: OwnerArtifactRecord = {
    path: tracked.path,
    root_path: tracked.rootPath,
    token: tracked.token,
    state: "ready",
  };
  if (!artifactRootSignatureMatches(record, tracked.ownerToken)) {
    throw new Error("session artifact owner changed");
  }
  rmSync(tracked.rootPath, { recursive: true, force: true });
  trackedSessionArtifacts.delete(requestedPath);
  activeReaper?.untrackArtifact(tracked.path);
}

export function untrackOwnerSessionArtifact(artifactDir: string): void {
  removeOwnerSessionArtifact(artifactDir);
}

const trackedHelperProcesses = new WeakMap<ChildProcess, OwnerHelperRecord>();

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
      if (birth !== null) {
        record = { ...birth, marker, process_group_id: child.pid };
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
