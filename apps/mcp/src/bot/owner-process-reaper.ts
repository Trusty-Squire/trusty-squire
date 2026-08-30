import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  operatorBrowserProcessCommandState,
  operatorBrowserProcessMarker,
  operatorBrowserProcessMatchesMarker,
  registerOperatorBrowserLaunchWatchdog,
  type OperatorBrowserLaunchWatchdogRegistration,
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
  version: 4;
  token: string;
  owner: OwnerIdentity;
  resources: ProfileProcessIdentity[];
  launches: OwnerLaunchRecord[];
  profiles: OwnerProfileRecord[];
  helpers: OwnerHelperRecord[];
}

export interface OwnerProcessReaper {
  readonly manifestPath: string;
  track(identity: ProfileProcessIdentity): void;
  untrack(identity: ProfileProcessIdentity): void;
  trackLaunch(marker: string, profileDir: string): void;
  untrackLaunch(marker: string): void;
  reserveProfile(profileDir: string, stagingDir: string, token: string): void;
  commitProfile(profileDir: string, token: string): void;
  untrackProfile(profileDir: string): void;
  reserveHelper(marker: string): void;
  bindHelper(marker: string, identity: OwnerHelperIdentity): void;
  untrackHelper(marker: string): void;
  stop(): void;
}

export const OWNER_PROFILE_SIGNATURE_FILE = ".trusty-squire-owner-profile.json";
export const OWNER_HELPER_MARKER_ENV = "TRUSTY_SQUIRE_OWNER_HELPER_MARKER";
const EPHEMERAL_PROFILE_PREFIX = "trusty-squire-operate-";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
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

function readManifest(path: string): OwnerReaperManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      token?: string;
      owner?: OwnerIdentity;
      resources?: ProfileProcessIdentity[];
      launches?: unknown[];
      profiles?: unknown[];
      helpers?: unknown[];
    };
    if (
      (value.version !== 1 &&
        value.version !== 2 &&
        value.version !== 3 &&
        value.version !== 4) ||
      typeof value.token !== "string" ||
      value.owner === undefined ||
      !Number.isSafeInteger(value.owner.pid) ||
      typeof value.owner.start_time !== "string" ||
      !Array.isArray(value.resources)
    ) {
      return null;
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
    if (
      resources.length !== value.resources.length ||
      normalizedLaunches.some((launch) => !isLaunch(launch)) ||
      profiles.some((profile) => !isProfile(profile)) ||
      helpers.some((helper) => !isHelper(helper))
    ) {
      return null;
    }
    return {
      version: 4,
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
    };
  } catch {
    return null;
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
  return processBirthIdentityState(manifest.owner);
}

function linuxProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const processGroupId = Number(
      stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[2],
    );
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
  } catch {
    return null;
  }
}

function processHasHelperMarker(pid: number, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`${OWNER_HELPER_MARKER_ENV}=${marker}`);
  } catch {
    return false;
  }
}

function helperGroupHasMarker(processGroupId: number, marker: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (linuxProcessGroupId(pid) === processGroupId && processHasHelperMarker(pid, marker)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function exactHelperMarkerProcessIds(marker: string): number[] {
  if (process.platform !== "linux") return [];
  try {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .filter((pid) => processHasHelperMarker(pid, marker));
  } catch {
    return [];
  }
}

export function ownerHelperIdentityState(identity: OwnerHelperRecord): ProcessIdentityState {
  if ("state" in identity) {
    return exactHelperMarkerProcessIds(identity.marker).length > 0 ? "matching" : "stale";
  }
  if (
    identity.process_group_id !== undefined &&
    helperGroupHasMarker(identity.process_group_id, identity.marker)
  ) {
    return "matching";
  }
  const birth = processBirthIdentityState(identity);
  if (birth !== "matching") return birth;
  return processHasHelperMarker(identity.pid, identity.marker) ? "matching" : "stale";
}

function signalOwnerHelper(identity: OwnerHelperRecord, signal: NodeJS.Signals): boolean {
  if (process.platform !== "linux") return false;
  if ("state" in identity) {
    let signalled = false;
    const groups = new Set(
      exactHelperMarkerProcessIds(identity.marker).flatMap((pid) => {
        const groupId = linuxProcessGroupId(pid);
        return groupId === null || !helperGroupHasMarker(groupId, identity.marker) ? [] : [groupId];
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
    groupId !== undefined && helperGroupHasMarker(groupId, identity.marker)
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
    readCommandState?: (pid: number) => ProcessIdentityState;
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
      if ((options.readMarker ?? operatorBrowserProcessMarker)(pid) !== marker) continue;
      const state = (options.readCommandState ?? operatorBrowserProcessCommandState)(pid);
      if (state === "matching") matching.push(pid);
      else if (state === "unknown") unknown = true;
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
  const graceMs = options.graceMs ?? envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const matching = (): number[] =>
    readProcessIds().filter((pid) => processMatches(pid, marker));
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
    matching().length === 0 &&
    (!usesDefaultIdentity || ownerBrowserLaunchState(marker) === "stale")
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

function pendingEmptyStagingProfile(record: OwnerProfileRecord): boolean {
  if (record.state !== "pending" || record.staging_path === undefined) return false;
  const stagingPath = resolve(record.staging_path);
  if (
    dirname(stagingPath) !== resolve(tmpdir()) ||
    !basename(stagingPath).startsWith(".trusty-squire-profile-staging-")
  ) {
    return false;
  }
  try {
    return (
      lstatSync(stagingPath).isDirectory() &&
      !lstatSync(stagingPath).isSymbolicLink() &&
      readdirSync(stagingPath).length === 0
    );
  } catch {
    return false;
  }
}

function ownerProfileState(record: OwnerProfileRecord): ProcessIdentityState {
  const finalExists = existsSync(record.path);
  const stagingExists = record.staging_path !== undefined && existsSync(record.staging_path);
  if (!finalExists && !stagingExists) return "stale";
  if (
    signedEphemeralProfile(record) ||
    signedStagedEphemeralProfile(record) ||
    pendingEmptyStagingProfile(record)
  ) {
    return "matching";
  }
  return "unknown";
}

function cleanTrackedProfiles(manifest: OwnerReaperManifest): void {
  for (const identity of manifest.resources) {
    if (profileProcessIdentityState(identity, identity.user_data_dir) === "stale") {
      clearStaleSingletonLock(identity.user_data_dir);
    }
  }
  for (const profile of manifest.profiles) {
    if (signedEphemeralProfile(profile)) {
      rmSync(profile.path, { recursive: true, force: true });
    }
    if (
      profile.staging_path !== undefined &&
      (signedStagedEphemeralProfile(profile) || pendingEmptyStagingProfile(profile))
    ) {
      rmSync(profile.staging_path, { recursive: true, force: true });
    }
  }
}

function manifestCleanupComplete(manifest: OwnerReaperManifest): boolean {
  return (
    manifest.resources.every(
      (identity) => profileProcessIdentityState(identity, identity.user_data_dir) === "stale",
    ) &&
    manifest.launches.every((launch) => ownerBrowserLaunchState(launch.marker) === "stale") &&
    manifest.helpers.every((helper) => ownerHelperIdentityState(helper) === "stale") &&
    manifest.profiles.every((profile) => ownerProfileState(profile) === "stale")
  );
}

async function reapManifest(path: string, manifest: OwnerReaperManifest): Promise<number> {
  const graceMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  const signalled = signalTrackedResources(manifest, "SIGTERM");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs));
  const latest = readManifest(path) ?? manifest;
  signalTrackedResources(latest, "SIGKILL");
  cleanTrackedProfiles(latest);
  await sweepOperatorProfilePoolOrphans().catch(() => undefined);
  if (manifestCleanupComplete(latest)) rmSync(path, { force: true });
  return signalled;
}

export async function sweepOrphanedOwnerProcesses(rootDir = defaultRootDir()): Promise<number> {
  if (process.platform !== "linux" || !existsSync(rootDir)) return 0;
  let reaped = 0;
  for (const entry of readdirSync(rootDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(rootDir, entry);
    const manifest = readManifest(path);
    if (manifest === null || !shouldReapOwner(ownerState(manifest))) continue;
    reaped += await reapManifest(path, manifest);
  }
  return reaped;
}

export async function runOwnerProcessReaperWorker(manifestPath: string): Promise<void> {
  const pollMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_POLL_MS", DEFAULT_POLL_MS);
  for (;;) {
    const manifest = readManifest(manifestPath);
    if (manifest === null) return;
    if (shouldReapOwner(ownerState(manifest))) {
      await reapManifest(manifestPath, manifest);
      if (!existsSync(manifestPath)) return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

export function startOwnerProcessReaper(
  options: { rootDir?: string; workerPath?: string } = {},
): OwnerProcessReaper | null {
  if (process.platform !== "linux") return null;
  if (activeReaper !== null) return activeReaper;
  const rootDir = resolve(options.rootDir ?? defaultRootDir());
  ensurePrivateDir(rootDir);
  void sweepOrphanedOwnerProcesses(rootDir).catch(() => undefined);
  const owner = processBirthIdentity(process.pid);
  if (owner === null) return null;
  const token = randomUUID();
  const manifestPath = join(rootDir, `${owner.pid}-${token}.json`);
  let manifest: OwnerReaperManifest = {
    version: 4,
    token,
    owner,
    resources: [],
    launches: [],
    profiles: [],
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
  const workerExecArgs = workerPath.endsWith(".ts") ? process.execArgv : [];
  let worker: ChildProcess;
  try {
    worker = spawn(process.execPath, [...workerExecArgs, workerPath, manifestPath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    worker.unref();
  } catch (error) {
    rmSync(manifestPath, { force: true });
    throw error;
  }

  let stopped = false;
  const update = (next: OwnerReaperManifest): void => {
    manifest = next;
    writeManifest(manifestPath, manifest);
  };
  const reaper: OwnerProcessReaper = {
    manifestPath,
    track: (identity) => {
      if (stopped) return;
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
      if (stopped) return;
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
    reserveProfile: (profileDir, stagingDir, profileToken) => {
      if (stopped) return;
      const path = resolve(profileDir);
      const stagingPath = resolve(stagingDir);
      if (
        dirname(path) !== resolve(tmpdir()) ||
        !basename(path).startsWith(EPHEMERAL_PROFILE_PREFIX) ||
        dirname(stagingPath) !== resolve(tmpdir()) ||
        !basename(stagingPath).startsWith(".trusty-squire-profile-staging-")
      )
        return;
      update({
        ...manifest,
        profiles: [
          ...manifest.profiles.filter((entry) => entry.path !== path),
          { path, staging_path: stagingPath, token: profileToken, state: "pending" },
        ],
      });
    },
    commitProfile: (profileDir, profileToken) => {
      if (stopped) return;
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
      if (stopped) return;
      update({
        ...manifest,
        helpers: [
          ...manifest.helpers.filter((entry) => entry.marker !== marker),
          { marker, state: "pending" },
        ],
      });
    },
    bindHelper: (marker, identity) => {
      if (stopped || !manifest.helpers.some((entry) => entry.marker === marker)) return;
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
      for (const launch of manifest.launches) {
        trackedLaunchWatchdogs.get(launch.marker)?.dispose();
        trackedLaunchWatchdogs.delete(launch.marker);
      }
      rmSync(manifestPath, { force: true });
      worker.kill("SIGTERM");
      if (activeReaper === reaper) activeReaper = null;
    },
  };
  activeReaper = reaper;
  return reaper;
}

export function ensureOwnerProcessReaper(): OwnerProcessReaper | null {
  return activeReaper ?? startOwnerProcessReaper();
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
export function trackOwnerBrowserLaunch(marker: string, profileDir: string): void {
  if (!trackedLaunchWatchdogs.has(marker)) {
    trackedLaunchWatchdogs.set(marker, registerOperatorBrowserLaunchWatchdog(marker));
  }
  ensureOwnerProcessReaper()?.trackLaunch(marker, profileDir);
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
    createDirectory?: (path: string) => void;
    writeSignature?: (path: string, contents: string) => void;
    publish?: (stagingPath: string, path: string) => void;
  } = {},
): string {
  const reaper = ensureOwnerProcessReaper();
  if (process.platform === "linux" && reaper === null) {
    throw new Error("owner process reaper unavailable for ephemeral profile");
  }
  const profileDir = resolve(
    operations.path?.() ?? join(tmpdir(), `${EPHEMERAL_PROFILE_PREFIX}${randomUUID()}`),
  );
  const stagingDir = resolve(
    operations.stagingPath?.() ??
      join(tmpdir(), `.trusty-squire-profile-staging-${randomUUID()}`),
  );
  const token = randomUUID();
  reaper?.reserveProfile(profileDir, stagingDir, token);
  let created = false;
  let published = false;
  try {
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
    reaper?.commitProfile(profileDir, token);
    return profileDir;
  } catch (error) {
    if (published) rmSync(profileDir, { recursive: true, force: true });
    else if (created) rmSync(stagingDir, { recursive: true, force: true });
    reaper?.untrackProfile(profileDir);
    throw error;
  }
}

export function untrackOwnerEphemeralProfile(profileDir: string): void {
  activeReaper?.untrackProfile(profileDir);
}

const trackedHelperProcesses = new WeakMap<ChildProcess, OwnerHelperRecord>();

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
        reaper?.bindHelper(marker, record);
      }
    }
    trackedHelperProcesses.set(child, record);
    const releaseIfStale = (): void => {
      setTimeout(() => {
        if (ownerHelperIdentityState(record) !== "stale") return;
        activeReaper?.untrackHelper(marker);
        trackedHelperProcesses.delete(child);
      }, 0).unref();
    };
    child.once("error", releaseIfStale);
    child.once("exit", releaseIfStale);
  }
  return child;
}

export function signalOwnerTrackedHelper(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
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
