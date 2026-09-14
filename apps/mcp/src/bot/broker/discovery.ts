import { createHash } from "node:crypto";
import { mkdirSync, lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireProfileOperationGuard,
  ProfileBusyError,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  type ProfileOperationLease,
} from "../profile.js";
import { BrokerClient } from "./transport.js";
import { BrokerRefusal } from "./refusal.js";

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

/** Canonical profile discovery is independent of cwd and each client's TMPDIR. */
export function defaultBrokerSocket(profileDir = CHROME_PROFILE_DIR): string {
  const key = createHash("sha256")
    .update(profilePathIdentity(profileDir))
    .digest("hex")
    .slice(0, 32);
  return join(
    "/tmp",
    `trusty-squire-broker-${process.getuid?.() ?? "local"}-${key}`,
    "broker.sock",
  );
}

export function resolveBrokerSocket(): string {
  const configured = process.env.TRUSTY_SQUIRE_BROKER_SOCKET?.trim();
  if (configured) return configured;
  const path = defaultBrokerSocket();
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  return path;
}

export function brokerElectionRoot(profileDir = CHROME_PROFILE_DIR): string {
  return join(dirname(profilePathIdentity(profileDir)), ".trusty-squire-broker-leases");
}

export function brokerLaunchRoot(profileDir = CHROME_PROFILE_DIR): string {
  return join(brokerElectionRoot(profileDir), "launch");
}

async function prepareBrokerElectionRoot(profileDir: string): Promise<string> {
  const root = brokerElectionRoot(profileDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function brokerElectionIsHeld(profileDir: string): Promise<boolean> {
  const root = await prepareBrokerElectionRoot(profileDir);
  try {
    const lease = acquireProfileOperationGuard(profileDir, root);
    lease.release();
    return false;
  } catch (error) {
    if (error instanceof ProfileBusyError) return true;
    throw error;
  }
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "broker_lost";
}

async function waitForBroker(
  path: string,
  token: string,
  failure?: () => Error | undefined,
): Promise<BrokerClient> {
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const launchFailure = failure?.();
    if (launchFailure !== undefined) throw launchFailure;
    try {
      return await BrokerClient.connect(path, token);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, BROKER_CONNECT_POLL_MS));
  }
  throw new BrokerRefusal(
    "broker_unavailable",
    "Broker did not become available within 10 seconds; no operator command was dispatched",
  );
}

export function brokerEnvironment(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...env, TRUSTY_SQUIRE_BROKER_SOCKET: path };
}


export async function connectOrLaunchBroker(
  path: string,
  token: string,
): Promise<BrokerClient> {
  try {
    return await BrokerClient.connect(path, token);
  } catch (error) {
    // A socket with no live listener is a dead predecessor's orphan; the new
    // broker's own bind reclaims it (probe -> unlink -> bind).
    if (!isUnavailable(error)) throw error;
  }

  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  if (await brokerElectionIsHeld(profileDir)) return await waitForBroker(path, token);
  let launchLease: ProfileOperationLease;
  try {
    const launchRoot = brokerLaunchRoot(profileDir);
    await mkdir(launchRoot, { recursive: true, mode: 0o700 });
    launchLease = acquireProfileOperationGuard(profileDir, launchRoot);
  } catch (error) {
    if (error instanceof ProfileBusyError) return await waitForBroker(path, token);
    throw error;
  }
  try {
    try {
      return await BrokerClient.connect(path, token);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    if (await brokerElectionIsHeld(profileDir)) return await waitForBroker(path, token);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../bin.js", import.meta.url)), "broker"],
      {
        detached: true,
        stdio: "ignore",
        env: brokerEnvironment(process.env, path),
      },
    );
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", (code, signal) => {
      failure = new BrokerRefusal(
        "broker_unavailable",
        `Broker exited before attachment (${signal ?? code}); no operator command was dispatched`,
      );
    });
    child.unref();
    return await waitForBroker(path, token, () => failure);
  } finally {
    launchLease.release();
  }
}
