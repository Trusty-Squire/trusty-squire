import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { currentProfileDir, ProfileBusyError, profilePathIdentity } from "../profile.js";
import { BrokerClient, brokerSpeaksLegacyWire } from "./transport.js";
import { readBrokerAccountBinding } from "./account-binding.js";
import { BrokerRefusal } from "./refusal.js";
import { sharedMcpSocketPath } from "./mcp-socket-path.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

export function defaultBrokerSocket(profileDir = currentProfileDir()): string {
  const key = createHash("sha256").update(profilePathIdentity(profileDir)).digest("hex").slice(0, 32);
  return join("/tmp", `trusty-squire-broker-${process.getuid?.() ?? "local"}-${key}`, "broker.sock");
}

export function brokerSocketPath(profileDir = currentProfileDir()): string {
  return process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim() || defaultBrokerSocket(profileDir);
}

export function resolveBrokerSocket(profileDir = currentProfileDir()): string {
  const path = brokerSocketPath(profileDir);
  if (path !== defaultBrokerSocket(profileDir)) return path;
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  return path;
}

export function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "broker_lost";
}

export function isBrowserContentionRefusal(error: unknown): boolean {
  return error instanceof BrokerRefusal &&
    (error.code === "broker_unavailable" || error.code === "profile_busy");
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export async function liveUnixSocket(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/** Upgrade only: identify the old daemon from its live Unix listener, rather
 * than reading any of its four recorded ownership files. */
function legacyBrokerPid(path: string): number | null {
  if (process.platform === "win32") return null;
  try {
    const pids = execFileSync("lsof", ["-a", "-t", "-U", "--", path], { encoding: "utf8" })
      .trim().split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    for (const pid of pids) {
      if (pid === process.pid) continue;
      if (process.platform === "linux") {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!argv.includes("broker")) continue;
      }
      return pid;
    }
  } catch { /* no old listener */ }
  return null;
}

async function reclaimLegacyBroker(path: string, options: BrokerConnectOptions, error: unknown): Promise<boolean> {
  if (!(error instanceof BrokerRefusal) || error.code !== "unauthorized") return false;
  const prior = options.agentSessionToken !== undefined &&
    await brokerSpeaksLegacyWire(path, options.agentSessionToken);
  const bound = options.accountId !== undefined &&
    await readBrokerAccountBinding(profilePathIdentity(currentProfileDir())) === options.accountId;
  if (!prior && !bound) return false;
  const pid = legacyBrokerPid(path);
  if (pid === null) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return true; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (legacyBrokerPid(path) !== pid) return true;
    await sleep(100);
  }
  throw new BrokerRefusal("broker_unavailable", `Older broker pid ${pid} did not release its listener`);
}

async function waitForBroker(path: string, failure?: () => Error | undefined): Promise<BrokerClient> {
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const launchFailure = failure?.();
    if (launchFailure !== undefined) throw launchFailure;
    try { return await BrokerClient.connect(path); }
    catch (error) { if (!isUnavailable(error)) throw error; }
    await sleep(BROKER_CONNECT_POLL_MS);
  }
  throw new BrokerRefusal("broker_unavailable", "Broker did not become available within 10 seconds; no operator command was dispatched");
}

export function brokerEnvironment(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...env, TRUSTY_SQUIRE_BROKER_SOCKET: path };
}

export interface ManagedBrokerUnit {
  id: string;
  activeState: string;
  execStart: string;
  environment: Record<string, string>;
}

function execStartArgv(execStart: string): string[] {
  const listed = /argv\[\]=([^;]*)/.exec(execStart)?.[1] ?? "";
  return listed.trim().split(/\s+/).filter(Boolean);
}

function parseEnvironment(line: string): Record<string, string> {
  const body = line.startsWith("Environment=") ? line.slice("Environment=".length) : line;
  const environment: Record<string, string> = {};
  for (const part of body.split(" ")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    environment[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return environment;
}

function isBrokerUnit(unit: ManagedBrokerUnit): boolean {
  if (unit.id.replace(/\.service$/, "").startsWith("trusty-squire-broker")) return true;
  return execStartArgv(unit.execStart).some((arg) => arg === "broker" || arg === "--squire-broker");
}

function unitProfileDir(unit: ManagedBrokerUnit): string {
  const configured = unit.environment.TRUSTY_SQUIRE_PROFILE_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : join(homedir(), ".trusty-squire", "chrome-profile");
}

function unitServesProfile(unit: ManagedBrokerUnit, profileDir: string): boolean {
  return isBrokerUnit(unit) &&
    profilePathIdentity(unitProfileDir(unit)) === profilePathIdentity(profileDir);
}

function unitIsLive(unit: ManagedBrokerUnit): boolean {
  return unit.activeState === "active" ||
    unit.activeState === "activating" ||
    unit.activeState === "reloading";
}

/** True when discovery must wait for this unit instead of launching on demand. */
export function unitDefersOnDemandLaunch(unit: ManagedBrokerUnit, profileDir: string): boolean {
  return unitServesProfile(unit, profileDir) && unitIsLive(unit);
}

/** Parse `systemctl --user show --type=service` property blocks. */
export function parseManagedBrokerShow(stdout: string): ManagedBrokerUnit[] {
  const units: ManagedBrokerUnit[] = [];
  let current: Partial<ManagedBrokerUnit> & { environment?: Record<string, string> } = {};
  const take = () => {
    if (current.id === undefined) return;
    units.push({
      id: current.id,
      activeState: current.activeState ?? "inactive",
      execStart: current.execStart ?? "",
      environment: current.environment ?? {},
    });
    current = {};
  };
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      take();
      continue;
    }
    if (line.startsWith("Id=")) current.id = line.slice(3);
    else if (line.startsWith("ActiveState=")) current.activeState = line.slice(12);
    else if (line.startsWith("ExecStart=")) current.execStart = line.slice(10);
    else if (line.startsWith("Environment=")) current.environment = parseEnvironment(line);
  }
  take();
  return units;
}

/** The live managed unit serving this profile, or null when none does. */
export function liveManagedBrokerUnit(
  profileDir = currentProfileDir(),
): ManagedBrokerUnit | null {
  if (process.platform !== "linux") return null;
  try {
    const stdout = execFileSync("systemctl", [
      "--user",
      "show",
      "--type=service",
      "--all",
      "--no-pager",
      "-p", "Id",
      "-p", "ActiveState",
      "-p", "Environment",
      "-p", "ExecStart",
    ], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    return (
      parseManagedBrokerShow(stdout).find(
        (unit) => unitServesProfile(unit, profileDir) && unitIsLive(unit),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** The socket a live managed unit bound, when it configured one explicitly.
 * A unit may serve this profile on a non-default endpoint (Beeline sets
 * `TRUSTY_SQUIRE_BROKER_SOCKET`); clients deriving the profile's default path
 * must reach the owner's actual listener instead of waiting on a stranger. */
export function managedBrokerUnitSocketPath(unit: ManagedBrokerUnit | null): string | null {
  const configured = unit?.environment.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  return configured !== undefined && configured.length > 0 ? configured : null;
}

export function managedBrokerUnitIsLive(profileDir = currentProfileDir()): boolean {
  return liveManagedBrokerUnit(profileDir) !== null;
}

function launchUnlessManaged(
  path: string,
  unit: ManagedBrokerUnit | null = liveManagedBrokerUnit(),
): (() => Error | undefined) | undefined {
  // A systemd user unit that already owns this profile will reclaim the socket
  // itself. Launching a detached competitor wins the kernel lock and the unit
  // restart-loops (relay reconnect after #982).
  return unit !== null ? undefined : launchBrokerDaemon(path);
}

export interface BrokerConnectOptions {
  accountId?: string | undefined;
  agentSessionToken?: string | undefined;
}

function launchBrokerDaemon(path: string): () => Error | undefined {
  // Launches may race. Each daemon claims the same kernel SQLite lock before it
  // touches Chrome or the socket; losers exit while clients attach to winner.
  const logPath = join(dirname(path), "broker.log");
  let logFd: number | undefined;
  try { logFd = openSync(logPath, "a", 0o600); } catch { logFd = undefined; }
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../bin.js", import.meta.url)), "broker"], {
    detached: true,
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
    env: brokerEnvironment(process.env, path),
  });
  if (logFd !== undefined) closeSync(logFd);
  let failure: Error | undefined;
  child.once("error", (error) => { failure = error; });
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== null) return; // Another elected daemon may be serving.
    if (code !== 0 && code !== null) return;
    failure = new BrokerRefusal("broker_unavailable", `Broker exited before attachment (${signal ?? code})`);
  });
  child.unref();
  return () => failure;
}

export async function connectOrLaunchBroker(path: string, options: BrokerConnectOptions = {}): Promise<BrokerClient> {
  try { return await BrokerClient.connect(path); }
  catch (error) {
    if (!isUnavailable(error) && !(await reclaimLegacyBroker(path, options, error))) throw error;
  }
  // A live managed unit that owns this profile may listen on a configured
  // endpoint other than the profile-derived default (`TRUSTY_SQUIRE_BROKER_SOCKET`).
  // `connect` runs without that env, so reach the unit's actual listener rather
  // than waiting on a socket nobody binds.
  const unit = liveManagedBrokerUnit();
  const waitPath = managedBrokerUnitSocketPath(unit) ?? path;
  const failure = launchUnlessManaged(path, unit);
  try { return await waitForBroker(waitPath, failure); }
  catch (error) {
    if (error instanceof ProfileBusyError) return await waitForBroker(waitPath);
    throw error;
  }
}

/** Start the elected broker if needed, then wait for its shared MCP socket.
 * Does not open a wire session — a probe connection would start last-close grace. */
export async function ensureSharedMcp(path = sharedMcpSocketPath()): Promise<void> {
  if (await liveUnixSocket(path)) return;
  const wire = resolveBrokerSocket();
  const failure = (await liveUnixSocket(wire)) ? undefined : launchUnlessManaged(wire);
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const launchFailure = failure?.();
    if (launchFailure !== undefined) throw launchFailure;
    if (await liveUnixSocket(path)) return;
    await sleep(BROKER_CONNECT_POLL_MS);
  }
  throw new BrokerRefusal(
    "broker_unavailable",
    "Shared MCP socket did not become available within 10 seconds",
  );
}
