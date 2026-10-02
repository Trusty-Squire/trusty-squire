import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  currentProfileDir,
  ensureProfileDeviceAnchor,
  ProfileBusyError,
  profileDeviceAnchor,
  profileDeviceIdentity,
  profilePathIdentity,
} from "../profile.js";
import { BrokerClient, brokerSpeaksLegacyWire } from "./transport.js";
import { readBrokerAccountBinding } from "./account-binding.js";
import { BrokerRefusal } from "./refusal.js";
import { sharedMcpSocketPath } from "./mcp-socket-path.js";
import {
  readBrokerUnitMarkerAsync,
  readBrokerUnitMarkerSync,
  type ManagedBrokerMarker,
} from "./managed-marker.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

export function defaultBrokerSocket(profileDir = currentProfileDir()): string {
  // Socket names derive from the profile DEVICE identity (parent dev/ino plus
  // the profile directory name), never the path string: two paths to one
  // physical profile yield one endpoint, and a replaced profile directory
  // keeps the same endpoint.
  const identity = createHash("sha256")
    .update(profileDeviceIdentity(profileDir))
    .digest("hex")
    .slice(0, 32);
  return join("/tmp", `trusty-squire-broker-${process.getuid?.() ?? "local"}-${identity}`, "broker.sock");
}

export function brokerSocketPath(profileDir = currentProfileDir()): string {
  const configured = process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  if (configured) return configured;
  // A managed-broker marker is authoritative: the unit's declared socket wins
  // even over a live own-path socket, so a stray on-demand broker is never
  // joined while the unit owns the profile.
  const marker = readBrokerUnitMarkerSync(profileDir);
  if (marker.kind === "valid") return marker.marker.socket;
  const fallback = defaultBrokerSocket(profileDir);
  // A broker run as a systemd user unit (Beeline's trusty-squire-broker.service)
  // may listen on its own configured socket. A caller without that env, such as
  // `connect` from a shell, must still reach the broker that owns the profile.
  if (existsSync(fallback)) return fallback;
  return managedBrokerUnitSocket(profileDir) ?? fallback;
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
  // Compare the DEVICE identity (parent dev/ino plus name), never the path
  // string: a client that reaches the profile through an alias must still
  // recognise the live unit, or it would spawn a competitor it cannot win
  // against and end in broker_unavailable.
  return isBrokerUnit(unit) &&
    profileDeviceIdentity(unitProfileDir(unit)) === profileDeviceIdentity(profileDir);
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

/** The live broker unit that owns this profile, if any. */
export function findLiveManagedBrokerUnit(
  units: readonly ManagedBrokerUnit[],
  profileDir: string,
): ManagedBrokerUnit | undefined {
  return units.find((unit) => unitDefersOnDemandLaunch(unit, profileDir));
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

export function managedBrokerUnitIsLive(profileDir = currentProfileDir()): boolean {
  return readSystemctlUnits(profileDir).state === "live";
}

/** The socket a live managed broker unit for this profile was configured with. */
export function managedBrokerUnitSocket(profileDir = currentProfileDir()): string | undefined {
  const unit = readSystemctlUnits(profileDir);
  return unit.state === "live" ? unit.socket : undefined;
}

/** systemctl answer for this profile. A failure is deliberately "unknown",
 * NOT "no unit": inside bwrap sandboxes `systemctl --user` fails, and a
 * client that mistakes that for "no unit" spawns a competitor (the bug this
 * module exists to prevent). The spawn gate evaluates it marker-aware. */
export type ManagedUnitState =
  | { state: "live"; socket?: string | undefined; unit: ManagedBrokerUnit }
  | { state: "absent" }
  | { state: "unknown" };

export function readSystemctlUnits(profileDir: string): ManagedUnitState {
  if (process.platform !== "linux") return { state: "absent" };
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
    const unit = findLiveManagedBrokerUnit(parseManagedBrokerShow(stdout), profileDir);
    if (unit === undefined) return { state: "absent" };
    const socket = unit.environment.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
    return {
      state: "live",
      socket: socket !== undefined && socket.length > 0 ? socket : undefined,
      unit,
    };
  } catch {
    return { state: "unknown" };
  }
}

/** Refuse to join a socket that declares a different physical profile
 * (Required change 3): never join, never launch. The declared anchor is
 * compared against the client's own derived device anchor. */
function assertJoinProfile(
  profileDir: string,
  declared: { dev: number; ino: number; name: string },
  what: string,
): void {
  const anchor = profileDeviceAnchor(profileDir);
  if (
    anchor === null ||
    anchor.dev !== declared.dev ||
    anchor.ino !== declared.ino ||
    anchor.name !== declared.name
  ) {
    throw new BrokerRefusal(
      "profile_mismatch",
      `Refusing to join the ${what}: it serves profile ${declared.name} (` +
        `${declared.dev}:${declared.ino}), not this profile (${anchor === null ? "unknown" : `${anchor.dev}:${anchor.ino}:${anchor.name}`})`,
    );
  }
}

/** Refuse to join a socket bound to a different account. Strict equality,
 * fail-closed: a socket bound to an account and a silent client is a
 * mismatch, not a pass. */
async function assertJoinAccount(
  profileDir: string,
  declared: string | null,
  options: BrokerConnectOptions,
  what: string,
): Promise<void> {
  const clientBinding = options.accountId ?? (await readBrokerAccountBinding(profilePathIdentity(profileDir)));
  if (clientBinding !== declared) {
    throw new BrokerRefusal(
      "account_mismatch",
      `Refusing to join the ${what}: it is bound to account ` +
        `${declared ?? "none"}, but this client acts for ` +
        `${clientBinding ?? "none"}`,
    );
  }
}

/** The marker IS the declared identity; verify it before joining (Required
 * change 3). */
async function verifyManagedBrokerJoin(profileDir: string, marker: ManagedBrokerMarker, options: BrokerConnectOptions): Promise<void> {
  assertJoinProfile(profileDir, marker.profile, "managed broker socket");
  await assertJoinAccount(profileDir, marker.accountBinding, options, "managed broker socket");
}

/** A live managed unit's socket is not the client's own: verify its declared
 * profile and the profile's account binding before joining (Required change 3).
 * The unit declares no account itself, so the binding is the profile's own
 * record, read through the unit's profile directory. */
async function verifyManagedBrokerUnitJoin(
  profileDir: string,
  unit: ManagedBrokerUnit,
  options: BrokerConnectOptions,
): Promise<void> {
  const unitProfile = unitProfileDir(unit);
  assertJoinProfile(
    profileDir,
    profileDeviceAnchor(unitProfile) ?? { dev: -1, ino: -1, name: "" },
    "managed broker unit",
  );
  await assertJoinAccount(
    profileDir,
    await readBrokerAccountBinding(profilePathIdentity(unitProfile)),
    options,
    "managed broker unit",
  );
}

/** The spawn gate, marker-aware. Decides what a client may do when the target
 * broker is not reachable:
 *   - a marker file EXISTS (valid or not): never spawn. Wait for the marker's
 *     declared socket (bounded) and broker_unavailable on timeout; a marker
 *     with no socket never reopens spawning.
 *   - no marker: a live managed unit defers (wait, no spawn); systemctl
 *     failure ("unknown") and "no unit" both may spawn on demand. */
export type BrokerLaunchDecision =
  | { kind: "spawn" }
  | { kind: "wait"; socket: string };

export async function brokerLaunchDecision(
  profileDir: string,
  path: string,
  options: BrokerConnectOptions = {},
): Promise<BrokerLaunchDecision> {
  const markerRead = await readBrokerUnitMarkerAsync(profileDir);
  if (markerRead.kind !== "absent") {
    if (markerRead.kind === "valid") {
      const target = markerRead.marker.socket;
      if (target !== defaultBrokerSocket(profileDir)) {
        await verifyManagedBrokerJoin(profileDir, markerRead.marker, options);
      }
      return { kind: "wait", socket: target };
    }
    // Present but invalid marker: fail closed, wait bounded, never spawn.
    return { kind: "wait", socket: path };
  }
  const unit = readSystemctlUnits(profileDir);
  if (unit.state === "live") {
    // The unit's socket is not the client's own: verify the declared profile
    // and account binding before waiting on it, so a foreign unit is refused
    // (never joined, never launched).
    await verifyManagedBrokerUnitJoin(profileDir, unit.unit, options);
    return { kind: "wait", socket: unit.socket ?? path };
  }
  return { kind: "spawn" };
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
  // Provision the profile's private parent so the device identity used to
  // derive the own socket is stable from the very first call.
  const profileDir = currentProfileDir();
  ensureProfileDeviceAnchor(profileDir);
  // The spawn/join gate runs BEFORE any connect: it decides whether a client
  // may launch at all (marker/unit/systemctl state) and refuses a foreign
  // managed socket before it is joined.
  const decision = await brokerLaunchDecision(profileDir, path, options);
  const target = decision.kind === "wait" ? decision.socket : path;
  try { return await BrokerClient.connect(target); }
  catch (error) {
    if (!isUnavailable(error) && !(await reclaimLegacyBroker(target, options, error))) throw error;
  }
  const failure = decision.kind === "spawn" ? launchBrokerDaemon(path) : undefined;
  try { return await waitForBroker(target, failure); }
  catch (error) {
    if (error instanceof ProfileBusyError) return await waitForBroker(target);
    throw error;
  }
}

/** Start the elected broker if needed, then wait for its shared MCP socket.
 * Does not open a wire session — a probe connection would start last-close grace. */
export async function ensureSharedMcp(path = sharedMcpSocketPath()): Promise<void> {
  if (await liveUnixSocket(path)) return;
  const profileDir = currentProfileDir();
  ensureProfileDeviceAnchor(profileDir);
  const wire = resolveBrokerSocket(profileDir);
  const decision = await brokerLaunchDecision(profileDir, wire);
  const target = decision.kind === "wait" ? decision.socket : wire;
  const failure =
    decision.kind === "spawn" && !(await liveUnixSocket(target))
      ? launchBrokerDaemon(target)
      : undefined;
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
