import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureProfileDeviceAnchor,
  isPidAlive,
  processBirthIdentity,
  processBirthIdentityState,
  profileDeviceIdentity,
  profileOperationLockPath,
  profilePathIdentity,
  profileProcessIdentity,
  readLockHolder,
} from "../profile.js";
import { readBrokerUnitMarkerSync } from "./managed-marker.js";

const START_WAIT_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const CHROME_REAP_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

export class OnDemandBrokerStartError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "OnDemandBrokerStartError";
  }
}

export interface OnDemandStartResult {
  ok: boolean;
  message?: string;
}

export interface SpawnedBroker {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  unref?: () => void;
}

export interface OnDemandBrokerDeps {
  managerAvailable?: () => boolean;
  liveSocket?: (path: string) => Promise<boolean>;
  spawnBroker?: (options: {
    entry: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
  }) => SpawnedBroker;
  reapOrphanedChrome?: (profileDir: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeSocket(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise((resolve) => {
    const probe = createConnection(path);
    const finish = (live: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      probe.destroy();
      resolve(live);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 500);
    signal?.addEventListener("abort", abort, { once: true });
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  });
}

function identityDigest(profileDir: string): string {
  return createHash("sha256").update(profileDeviceIdentity(profileDir)).digest("hex").slice(0, 24);
}

export function onDemandStartLockPath(profileDir: string): string {
  ensureProfileDeviceAnchor(profileDir);
  const parent = dirname(profilePathIdentity(profileDir));
  return join(parent, `.trusty-squire-broker-on-demand-${identityDigest(profileDir)}.lock`);
}

function startResultPath(lockPath: string): string {
  return `${lockPath}.result`;
}

function onDemandLogPath(profileDir: string): string {
  ensureProfileDeviceAnchor(profileDir);
  const parent = dirname(profilePathIdentity(profileDir));
  return join(parent, `.trusty-squire-broker-on-demand-${identityDigest(profileDir)}.log`);
}

function writeStartResult(lockPath: string, result: OnDemandStartResult): void {
  writeFileSync(startResultPath(lockPath), `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

function isStartResult(value: unknown): value is OnDemandStartResult {
  if (value === null || typeof value !== "object" || !("ok" in value)) return false;
  const ok = Reflect.get(value, "ok");
  if (typeof ok !== "boolean") return false;
  const message = Reflect.get(value, "message");
  return message === undefined || typeof message === "string";
}

function readStartResult(lockPath: string): OnDemandStartResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(startResultPath(lockPath), "utf8"));
    return isStartResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLockHolderPid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isLiveSystemdUserState(text: string): boolean {
  const line = text.split("\n")[0]?.trim() ?? "";
  return /^(running|degraded|maintenance|initializing|starting|stopping)$/.test(line);
}

/** True when this environment has a working systemd user manager or launchd GUI domain. */
export function userServiceManagerAvailable(): boolean {
  if (process.platform === "linux") {
    try {
      const stdout = execFileSync("systemctl", ["--user", "is-system-running"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return isLiveSystemdUserState(stdout);
    } catch (error) {
      const result = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
        code?: string;
      };
      if (result.code === "ENOENT") return false;
      return isLiveSystemdUserState(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) return false;
    try {
      execFileSync("launchctl", ["print", `gui/${uid}`], {
        timeout: 5_000,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** A client may start a broker only when no user manager exists and no unit marker owns the profile. */
export function onDemandStartEligible(
  profileDir: string,
  managerAvailable = userServiceManagerAvailable,
): boolean {
  if (managerAvailable()) return false;
  return readBrokerUnitMarkerSync(profileDir).kind === "absent";
}

function brokerCommandMatches(pid: number): boolean {
  try {
    const command =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ")
        : execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 3_000,
          });
    return (
      /(?:^|\s)(?:broker|--squire-broker)(?:\s|$)/.test(command) ||
      /broker[^\s]*daemon\.(?:ts|js)(?:\s|$)/.test(command)
    );
  } catch {
    return false;
  }
}

function brokerServesProfile(pid: number, profileDir: string): boolean {
  if (process.platform !== "linux") return true;
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const value = (key: string) =>
      entries.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
    const home = value("HOME") || process.env.HOME || "";
    const claimedProfile =
      value("TRUSTY_SQUIRE_PROFILE_DIR") || join(home, ".trusty-squire", "chrome-profile");
    return profilePathIdentity(claimedProfile) === profilePathIdentity(profileDir);
  } catch {
    return false;
  }
}

/** The live broker holding this profile's SQLite write lock, if any. */
export function liveBrokerPidHoldingProfile(profileDir: string): number | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  let output: string;
  try {
    output = execFileSync(
      "lsof",
      ["-w", "-a", "-Fpl", "-u", String(uid), "--", profileOperationLockPath(profileDir)],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
  let pid = 0;
  const holders = new Set<number>();
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("l") && /[wW]/.test(line.slice(1)) && Number.isSafeInteger(pid) && pid > 0)
      holders.add(pid);
  }
  if (holders.size !== 1) return null;
  const holder = [...holders][0]!;
  if (!brokerCommandMatches(holder) || !brokerServesProfile(holder, profileDir)) return null;
  return holder;
}

function chromeHoldsProfile(pid: number, profileDir: string): boolean {
  if (process.platform === "linux") return profileProcessIdentity(pid, profileDir) !== null;
  try {
    const command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const profile = profilePathIdentity(profileDir);
    return (
      [
        `--user-data-dir=${profile}`,
        `--user-data-dir="${profile}"`,
        `--user-data-dir='${profile}'`,
      ].some((argument) => {
        const offset = command.indexOf(argument);
        return (
          offset >= 0 &&
          (offset === 0 || /\s/.test(command[offset - 1]!)) &&
          (offset + argument.length === command.length ||
            /\s/.test(command[offset + argument.length]!))
        );
      }) && /(?:Chrome|Chromium|chrome|chromium)/.test(command)
    );
  } catch {
    return false;
  }
}

async function waitUntil(released: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (released()) return true;
    await sleep(100);
  }
  return released();
}

/**
 * SIGINT a Chrome whose SingletonLock is live only when no broker still owns
 * this profile. Never signals a live broker's Chrome or another profile.
 */
export async function reapOrphanedProfileChrome(
  profileDir: string,
  options: {
    wireSocket?: string;
    liveSocket?: (path: string) => Promise<boolean>;
    brokerPid?: (profileDir: string) => number | null;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<void> {
  const liveSocket = options.liveSocket ?? probeSocket;
  const brokerPid = options.brokerPid ?? liveBrokerPidHoldingProfile;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  if (options.wireSocket !== undefined && (await liveSocket(options.wireSocket))) return;
  if (brokerPid(profileDir) !== null) return;
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname() || holder.stale) return;
  const identity = processBirthIdentity(holder.pid);
  if (identity === null) return;
  if (!chromeHoldsProfile(holder.pid, profileDir)) return;
  const stillOwned = () => {
    const current = readLockHolder(profileDir);
    return (
      current?.host === hostname() &&
      current.pid === holder.pid &&
      !current.stale &&
      processBirthIdentityState(identity) === "matching"
    );
  };
  if (!stillOwned()) return;
  try {
    kill(holder.pid, "SIGINT");
  } catch {
    return;
  }
  if (await waitUntil(() => !stillOwned(), CHROME_REAP_WAIT_MS)) return;
  if (stillOwned()) {
    try {
      kill(holder.pid, "SIGKILL");
    } catch {
      return;
    }
  }
  await waitUntil(() => !stillOwned(), CHROME_REAP_WAIT_MS);
}

function defaultSpawnBroker(options: {
  entry: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): SpawnedBroker {
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(options.logPath, "w", 0o600);
  try {
    const child = spawn(process.execPath, [options.entry, "broker"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: options.env,
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

function brokerEntryPath(): string {
  return fileURLToPath(new URL("../../bin.js", import.meta.url));
}

function spawnEnv(profileDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TRUSTY_SQUIRE_BROKER_UNIT;
  delete env.INVOCATION_ID;
  env.TRUSTY_SQUIRE_PROFILE_DIR = profilePathIdentity(profileDir);
  return env;
}

function childRunning(child: SpawnedBroker): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function stopSpawnedChild(child: SpawnedBroker): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !childRunning(child)) return;
  try {
    process.kill(pid, "SIGINT");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && childRunning(child)) await sleep(50);
  if (childRunning(child)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8").trim();
  } catch {
    return "";
  }
}

function startFailure(logPath: string, fallback: string): OnDemandBrokerStartError {
  const output = readLog(logPath);
  const detail = output.length > 0 ? output.slice(-4_000) : fallback;
  return new OnDemandBrokerStartError(
    `Trusty Squire broker failed to start: ${detail}. No retry was attempted`,
    output,
  );
}

async function acquireStartLock(
  lockPath: string,
  deps: Required<Pick<OnDemandBrokerDeps, "sleep" | "now">>,
): Promise<{ waited: boolean; release: () => void }> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = deps.now() + LOCK_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } catch {
        closeSync(fd);
        throw new Error("Could not write on-demand broker start lock");
      }
      closeSync(fd);
      return {
        waited,
        release: () => {
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      waited = true;
      const holder = readLockHolderPid(lockPath);
      if (holder !== null && holder !== process.pid && !isPidAlive(holder)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* racing another waiter */
        }
        continue;
      }
      if (deps.now() >= deadline) {
        throw new OnDemandBrokerStartError(
          "Trusty Squire broker failed to start: timed out waiting for another start attempt. No retry was attempted",
          "",
        );
      }
      await deps.sleep(LOCK_POLL_MS);
    }
  }
}

export interface OnDemandSockets {
  wire: string;
  mcp: string;
}

async function socketsLive(
  sockets: OnDemandSockets,
  liveSocket: (path: string) => Promise<boolean>,
): Promise<boolean> {
  return (await liveSocket(sockets.wire)) && (await liveSocket(sockets.mcp));
}

async function startOnce(
  profileDir: string,
  sockets: OnDemandSockets,
  deps: OnDemandBrokerDeps,
  signal?: AbortSignal,
): Promise<void> {
  const liveSocket = deps.liveSocket ?? probeSocket;
  const spawnBroker = deps.spawnBroker ?? defaultSpawnBroker;
  const reap =
    deps.reapOrphanedChrome ??
    ((dir: string) =>
      reapOrphanedProfileChrome(dir, { wireSocket: sockets.wire, liveSocket }));
  const wait = deps.sleep ?? sleep;
  signal?.throwIfAborted();
  await reap(profileDir);
  signal?.throwIfAborted();
  const logPath = onDemandLogPath(profileDir);
  if (existsSync(logPath)) {
    try {
      unlinkSync(logPath);
    } catch {
      /* start will truncate via "w" */
    }
  }
  const child = spawnBroker({
    entry: brokerEntryPath(),
    env: spawnEnv(profileDir),
    logPath,
  });
  const deadline = (deps.now ?? Date.now)() + START_WAIT_MS;
  let exitDetail = "";
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, sig) => {
      exitDetail = `exit code=${code ?? "none"} signal=${sig ?? "none"}`;
      resolve();
    });
    child.once("error", (error) => {
      exitDetail = error instanceof Error ? error.message : String(error);
      resolve();
    });
  });
  try {
    while ((deps.now ?? Date.now)() < deadline) {
      signal?.throwIfAborted();
      if (await socketsLive(sockets, liveSocket)) return;
      if (!childRunning(child) && exitDetail.length > 0) throw startFailure(logPath, exitDetail);
      await Promise.race([wait(100), exited.then(() => undefined)]);
      if (!childRunning(child)) {
        if (await socketsLive(sockets, liveSocket)) return;
        throw startFailure(logPath, exitDetail || "process exited before listening");
      }
    }
    if (await socketsLive(sockets, liveSocket)) return;
    throw startFailure(logPath, "socket unavailable after 10 seconds");
  } catch (error) {
    await stopSpawnedChild(child);
    throw error;
  }
}

/**
 * When no user service manager exists, start the broker at most once for this
 * call. Concurrent callers wait on the lock. A failed attempt is not retried.
 * Does not run when a systemd/launchd manager is present or a unit marker owns
 * the profile.
 */
export async function ensureOnDemandBroker(
  profileDir: string,
  sockets: OnDemandSockets,
  options: { signal?: AbortSignal | undefined; deps?: OnDemandBrokerDeps | undefined } = {},
): Promise<void> {
  const deps = options.deps ?? {};
  const managerAvailable = deps.managerAvailable ?? userServiceManagerAvailable;
  const liveSocket = deps.liveSocket ?? probeSocket;
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  if (await socketsLive(sockets, liveSocket)) return;
  if (!onDemandStartEligible(profileDir, managerAvailable)) return;
  const lockPath = onDemandStartLockPath(profileDir);
  const lock = await acquireStartLock(lockPath, { sleep: wait, now });
  try {
    if (await socketsLive(sockets, liveSocket)) {
      writeStartResult(lockPath, { ok: true });
      return;
    }
    if (lock.waited) {
      const result = readStartResult(lockPath);
      if (result?.ok === true) return;
      throw new OnDemandBrokerStartError(
        result?.message ??
          "Trusty Squire broker failed to start: the in-flight attempt did not come up. No retry was attempted",
        result?.message ?? "",
      );
    }
    try {
      await startOnce(profileDir, sockets, deps, options.signal);
      writeStartResult(lockPath, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStartResult(lockPath, { ok: false, message });
      throw error;
    }
  } finally {
    lock.release();
  }
}
