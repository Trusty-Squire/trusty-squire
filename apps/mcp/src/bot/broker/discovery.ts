import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { currentProfileDir, ProfileBusyError, profilePathIdentity } from "../profile.js";
import { BrokerClient, brokerSpeaksLegacyWire } from "./transport.js";
import { readBrokerAccountBinding } from "./account-binding.js";
import { BrokerRefusal } from "./refusal.js";

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

/** Upgrade only: identify the old daemon from its live Unix listener, rather
 * than reading any of its four recorded ownership files. */
function legacyBrokerPid(path: string): number | null {
  if (process.platform === "win32") return null;
  try {
    const pids = execFileSync("lsof", ["-t", "-U", "--", path], { encoding: "utf8" })
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

export interface BrokerConnectOptions {
  accountId?: string | undefined;
  agentSessionToken?: string | undefined;
}

export async function connectOrLaunchBroker(path: string, options: BrokerConnectOptions = {}): Promise<BrokerClient> {
  try { return await BrokerClient.connect(path); }
  catch (error) {
    if (!isUnavailable(error) && !(await reclaimLegacyBroker(path, options, error))) throw error;
  }
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
  try { return await waitForBroker(path, () => failure); }
  catch (error) {
    if (error instanceof ProfileBusyError) return await waitForBroker(path);
    throw error;
  }
}
