import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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

interface OwnerReaperManifest {
  version: 1;
  token: string;
  owner: OwnerIdentity;
  resources: ProfileProcessIdentity[];
}

export interface OwnerProcessReaper {
  readonly manifestPath: string;
  track(identity: ProfileProcessIdentity): void;
  untrack(identity: ProfileProcessIdentity): void;
  stop(): void;
}

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

function readManifest(path: string): OwnerReaperManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerReaperManifest>;
    if (
      value.version !== 1 ||
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
    if (resources.length !== value.resources.length) return null;
    return {
      version: 1,
      token: value.token,
      owner: value.owner,
      resources,
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

function signalTrackedResources(manifest: OwnerReaperManifest, signal: NodeJS.Signals): number {
  let signalled = 0;
  for (const identity of manifest.resources) {
    if (signalProfileProcess(identity, identity.user_data_dir, signal)) signalled += 1;
  }
  return signalled;
}

function cleanTrackedProfiles(manifest: OwnerReaperManifest): void {
  for (const identity of manifest.resources) {
    if (profileProcessIdentityState(identity, identity.user_data_dir) === "stale") {
      clearStaleSingletonLock(identity.user_data_dir);
    }
  }
}

export function sweepOrphanedOwnerProcesses(rootDir = defaultRootDir()): number {
  if (process.platform !== "linux" || !existsSync(rootDir)) return 0;
  let reaped = 0;
  for (const entry of readdirSync(rootDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(rootDir, entry);
    const manifest = readManifest(path);
    if (manifest === null || !shouldReapOwner(ownerState(manifest))) continue;
    reaped += signalTrackedResources(manifest, "SIGKILL");
    cleanTrackedProfiles(manifest);
    rmSync(path, { force: true });
  }
  return reaped;
}

export async function runOwnerProcessReaperWorker(manifestPath: string): Promise<void> {
  const pollMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_POLL_MS", DEFAULT_POLL_MS);
  const termGraceMs = envPositiveMs("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", DEFAULT_TERM_GRACE_MS);
  for (;;) {
    const manifest = readManifest(manifestPath);
    if (manifest === null) return;
    const state = ownerState(manifest);
    if (shouldReapOwner(state)) {
      signalTrackedResources(manifest, "SIGTERM");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, termGraceMs));
      const latest = readManifest(manifestPath) ?? manifest;
      signalTrackedResources(latest, "SIGKILL");
      cleanTrackedProfiles(latest);
      // Ephemeral operator profiles remain owned by the pool. Once their
      // process and owner birth identities are stale, invoke that pool's
      // quarantine/removal rules instead of deleting profile paths here.
      await sweepOperatorProfilePoolOrphans().catch(() => undefined);
      rmSync(manifestPath, { force: true });
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

export function startOwnerProcessReaper(
  options: {
    rootDir?: string;
    workerPath?: string;
  } = {},
): OwnerProcessReaper | null {
  if (process.platform !== "linux") return null;
  activeReaper?.stop();
  const rootDir = resolve(options.rootDir ?? defaultRootDir());
  ensurePrivateDir(rootDir);
  sweepOrphanedOwnerProcesses(rootDir);
  const owner = processBirthIdentity(process.pid);
  if (owner === null) return null;
  const token = randomUUID();
  const manifestPath = join(rootDir, `${owner.pid}-${token}.json`);
  let manifest: OwnerReaperManifest = { version: 1, token, owner, resources: [] };
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
      const resources = manifest.resources.filter((entry) => entry.pid !== identity.pid);
      update({ ...manifest, resources: [...resources, identity] });
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
    stop: () => {
      if (stopped) return;
      stopped = true;
      rmSync(manifestPath, { force: true });
      worker.kill("SIGTERM");
      if (activeReaper === reaper) activeReaper = null;
    },
  };
  activeReaper = reaper;
  return reaper;
}

export function trackOwnerProcess(identity: ProfileProcessIdentity): void {
  activeReaper?.track(identity);
}

export function untrackOwnerProcess(identity: ProfileProcessIdentity): void {
  activeReaper?.untrack(identity);
}
