import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  currentProfileDir,
  ensureProfileDeviceAnchor,
  profileDeviceAnchor,
  profileDeviceIdentity,
  profilePathIdentity,
} from "../profile.js";
import { BrokerClient } from "./transport.js";
import { readBrokerAccountBinding } from "./account-binding.js";
import { BrokerRefusal } from "./refusal.js";
import { sharedMcpSocketPath } from "./mcp-socket-path.js";
import {
  readBrokerUnitMarkerAsync,
  readBrokerUnitMarkerSync,
  type ManagedBrokerMarker,
} from "./managed-marker.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;

export function defaultBrokerSocket(profileDir = currentProfileDir()): string {
  // Socket names derive from the profile DEVICE identity (parent dev/ino plus
  // the profile directory name), never the path string: two paths to one
  // physical profile yield one endpoint, and a replaced profile directory
  // keeps the same endpoint.
  const identity = createHash("sha256")
    .update(profileDeviceIdentity(profileDir))
    .digest("hex")
    .slice(0, 32);
  return join(
    "/tmp",
    `trusty-squire-broker-${process.getuid?.() ?? "local"}-${identity}`,
    "broker.sock",
  );
}

export function brokerSocketPath(profileDir = currentProfileDir()): string {
  const configured = process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  if (configured) return configured;
  // A managed-broker marker is authoritative: the unit's declared socket wins
  // even over a live own-path socket, so a stray broker is never
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
  return (
    error instanceof BrokerRefusal &&
    (error.code === "broker_unavailable" || error.code === "profile_busy")
  );
}

export async function liveUnixSocket(path: string, signal?: AbortSignal): Promise<boolean> {
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

/** Service startup may race a client. Only connection attempts are retried. */
async function waitForBroker<T>(
  attempt: (remainingMs: number) => Promise<T | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  let delay = 100;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await attempt(deadline - Date.now());
    if (result !== undefined) return result;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(delay, Math.max(0, deadline - Date.now())),
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    delay = Math.min(delay * 2, 1_000);
  }
  throw new BrokerRefusal(
    "broker_unavailable",
    "Trusty Squire broker not running: socket unavailable after 10 seconds. Start or repair the broker user service, or re-run connect to install it; no operator command was dispatched",
  );
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
  const parts = body.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? [];
  for (const raw of parts) {
    const part = raw
      .replace(/^"|"$/g, "")
      .replace(
        /\\x([0-9a-fA-F]{2})|\\(.)/g,
        (_match, hex: string | undefined, escaped: string | undefined) =>
          hex
            ? String.fromCharCode(parseInt(hex, 16))
            : escaped === "n"
              ? "\n"
              : escaped === "r"
                ? "\r"
                : (escaped ?? ""),
      );
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
    : join(unit.environment.HOME?.trim() || homedir(), ".trusty-squire", "chrome-profile");
}

export function unitServesProfile(unit: ManagedBrokerUnit, profileDir: string): boolean {
  // Compare the DEVICE identity (parent dev/ino plus name), never the path
  // string: a client that reaches the profile through an alias must still
  // recognise the service and its configured socket.
  return (
    isBrokerUnit(unit) &&
    profileDeviceIdentity(unitProfileDir(unit)) === profileDeviceIdentity(profileDir)
  );
}

function unitIsLive(unit: ManagedBrokerUnit): boolean {
  return (
    unit.activeState === "active" ||
    unit.activeState === "activating" ||
    unit.activeState === "reloading"
  );
}

/** Whether this live service serves the requested physical profile. */
export function unitServesLiveProfile(unit: ManagedBrokerUnit, profileDir: string): boolean {
  return unitServesProfile(unit, profileDir) && unitIsLive(unit);
}

/** The live broker unit that owns this profile, if any. */
export function findLiveManagedBrokerUnit(
  units: readonly ManagedBrokerUnit[],
  profileDir: string,
): ManagedBrokerUnit | undefined {
  return units.find((unit) => unitServesLiveProfile(unit, profileDir));
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

/** The socket a live managed broker unit for this profile was configured with. */
export function managedBrokerUnitSocket(profileDir = currentProfileDir()): string | undefined {
  const unit = readSystemctlUnits(profileDir);
  return unit.state === "live" ? unit.socket : undefined;
}

/** systemctl answer for this profile. A failure is deliberately "unknown",
 * NOT "no unit": inside bwrap sandboxes `systemctl --user` fails, and a
 * client still resolves the marker or derived endpoint. No result permits
 * client-side startup. */
export type ManagedUnitState =
  | { state: "live"; socket?: string | undefined; unit: ManagedBrokerUnit }
  | { state: "absent" }
  | { state: "unknown" };

export function readSystemctlUnits(profileDir: string): ManagedUnitState {
  if (process.platform !== "linux") return { state: "absent" };
  try {
    const stdout = execFileSync(
      "systemctl",
      [
        "--user",
        "show",
        "--type=service",
        "--all",
        "--no-pager",
        "-p",
        "Id",
        "-p",
        "ActiveState",
        "-p",
        "Environment",
        "-p",
        "ExecStart",
      ],
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
    );
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

/** Refuse to join a socket bound to a DIFFERENT account. An unbound profile
 * (declared `null`) is unclaimed, not foreign: the first account-acting
 * acquire claims it (`runtime.ts` bindAccount), so refusing an enrolled client
 * there would make a fresh unit or a --force-relogin profile unjoinable. Only
 * a declared, different binding is a mismatch. */
async function assertJoinAccount(
  profileDir: string,
  declared: string | null,
  options: BrokerConnectOptions,
  what: string,
): Promise<void> {
  if (declared === null) return;
  const clientBinding =
    options.accountId ?? (await readBrokerAccountBinding(profilePathIdentity(profileDir)));
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
async function verifyManagedBrokerJoin(
  profileDir: string,
  marker: ManagedBrokerMarker,
  options: BrokerConnectOptions,
): Promise<void> {
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

/** Resolve and verify the service's endpoint, even when its socket is down. */
export async function brokerConnectionTarget(
  profileDir: string,
  path: string,
  options: BrokerConnectOptions = {},
): Promise<{ socket: string }> {
  const markerRead = await readBrokerUnitMarkerAsync(profileDir);
  if (markerRead.kind === "valid") {
    await verifyManagedBrokerJoin(profileDir, markerRead.marker, options);
    return { socket: markerRead.marker.socket };
  }
  if (markerRead.kind === "invalid") return { socket: path };
  const unit = readSystemctlUnits(profileDir);
  if (unit.state === "live") {
    await verifyManagedBrokerUnitJoin(profileDir, unit.unit, options);
    return { socket: unit.socket ?? path };
  }
  return { socket: path };
}

export interface BrokerConnectOptions {
  accountId?: string | undefined;
}

export async function connectBroker(
  path: string,
  options: BrokerConnectOptions = {},
): Promise<BrokerClient> {
  const profileDir = currentProfileDir();
  ensureProfileDeviceAnchor(profileDir);
  const { socket } = await brokerConnectionTarget(profileDir, path, options);
  return await waitForBroker(async (remainingMs) => {
    try {
      return await BrokerClient.connect(socket, {
        handshakeTimeoutMs: Math.min(remainingMs, 5_000),
      });
    } catch (error) {
      if (isUnavailable(error)) return undefined;
      if (error instanceof BrokerRefusal && error.code === "unauthorized") {
        throw new BrokerRefusal(
          error.code,
          `${error.message}. Upgrade and restart the broker user service; clients cannot replace a resident broker`,
        );
      }
      throw error;
    }
  });
}

/** Wait for the service's MCP listener without opening a wire session. */
export async function ensureSharedMcp(
  path = sharedMcpSocketPath(),
  signal?: AbortSignal,
): Promise<void> {
  const profileDir = currentProfileDir();
  ensureProfileDeviceAnchor(profileDir);
  await brokerConnectionTarget(profileDir, resolveBrokerSocket(profileDir));
  await waitForBroker(
    async () => ((await liveUnixSocket(path, signal)) ? true : undefined),
    signal,
  );
}
