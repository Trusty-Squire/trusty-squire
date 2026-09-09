import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireProfileOperationGuard,
  ProfileBusyError,
  processBirthIdentity,
  processBirthIdentityState,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  waitForProfileFree,
  type ProfileOperationLease,
} from "../profile.js";
import { BrokerClient } from "./transport.js";
import { BrokerRefusal } from "./scheduler.js";
interface EndpointOwner {
  version: 1;
  pid: number;
  start_time: string;
  profileDir: string;
  inode: number;
  device: number;
}

const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_POLL_MS = 100;

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
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function waitForBroker(
  path: string,
  token: string,
  lineageCredential: string | undefined,
  failure?: () => Error | undefined,
): Promise<BrokerClient> {
  const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const launchFailure = failure?.();
    if (launchFailure !== undefined) throw launchFailure;
    try {
      return await BrokerClient.connect(path, token, lineageCredential);
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
  const brokerEnv = { ...env };
  delete brokerEnv.TRUSTY_SQUIRE_FORWARDER_CREDENTIAL;
  return { ...brokerEnv, TRUSTY_SQUIRE_BROKER_SOCKET: path };
}

export function brokerIsSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true"].includes((env.TRUSTY_SQUIRE_BROKER_SUPERVISED ?? "").toLowerCase());
}

export async function publishEndpointOwner(path: string): Promise<void> {
  const identity = processBirthIdentity(process.pid);
  if (identity === null)
    throw new BrokerRefusal("ownership_unknown", "Cannot establish broker process birth identity");
  const socket = await lstat(path);
  await writeFile(
    `${path}.owner.json`,
    JSON.stringify({
      version: 1,
      ...identity,
      profileDir: profilePathIdentity(CHROME_PROFILE_DIR),
      inode: socket.ino,
      device: socket.dev,
    } satisfies EndpointOwner),
    { mode: 0o600, flag: "wx" },
  );
}

export async function reclaimDeadBrokerEndpoint(path: string): Promise<void> {
  let owner: EndpointOwner;
  try {
    owner = JSON.parse(await readFile(`${path}.owner.json`, "utf8")) as EndpointOwner;
  } catch {
    throw new BrokerRefusal(
      "broker_unavailable",
      "Endpoint ownership is unknown; refusing to remove it",
    );
  }
  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  if (
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.start_time !== "string" ||
    owner.profileDir !== profileDir ||
    processBirthIdentityState(owner) !== "stale"
  ) {
    throw new BrokerRefusal("broker_unavailable", "Endpoint belongs to a live or unproven broker");
  }
  const lease = acquireProfileOperationGuard(
    profileDir,
    await prepareBrokerElectionRoot(profileDir),
  );
  try {
    if (!(await waitForProfileFree(profileDir, { deadlineMs: 0 })))
      throw new BrokerRefusal("profile_busy", "Old browser is still being reaped");
    const socket = await lstat(path).catch(() => null);
    const latest = await readFile(`${path}.owner.json`, "utf8");
    if (JSON.stringify(JSON.parse(latest)) !== JSON.stringify(owner))
      throw new BrokerRefusal("broker_unavailable", "Endpoint ownership changed");
    if (socket !== null && (socket.ino !== owner.inode || socket.dev !== owner.device))
      throw new BrokerRefusal("broker_unavailable", "Endpoint was replaced");
    if (socket !== null) await unlink(path);
    await unlink(`${path}.owner.json`);
  } finally {
    lease.release();
  }
}

export async function connectOrLaunchBroker(
  path: string,
  token: string,
  lineageCredential?: string,
): Promise<BrokerClient> {
  try {
    return await BrokerClient.connect(path, token, lineageCredential);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!isUnavailable(error)) throw error;
    if (brokerIsSupervised())
      throw new BrokerRefusal(
        "broker_unavailable",
        "Supervised broker is unavailable; refusing to create a competing browser owner",
      );
    if (code === "ECONNREFUSED") await reclaimDeadBrokerEndpoint(path);
    // A cleanly stopped broker removes its socket but may have left its owner
    // record if interrupted during final unlink. Reclaim only with birth proof.
    else if (
      await lstat(`${path}.owner.json`).then(
        () => true,
        () => false,
      )
    )
      await reclaimDeadBrokerEndpoint(path);
  }
  const profileDir = profilePathIdentity(CHROME_PROFILE_DIR);
  if (await brokerElectionIsHeld(profileDir))
    return await waitForBroker(path, token, lineageCredential);
  let launchLease: ProfileOperationLease;
  try {
    const launchRoot = brokerLaunchRoot(profileDir);
    await mkdir(launchRoot, { recursive: true, mode: 0o700 });
    launchLease = acquireProfileOperationGuard(profileDir, launchRoot);
  } catch (error) {
    if (error instanceof ProfileBusyError)
      return await waitForBroker(path, token, lineageCredential);
    throw error;
  }
  try {
    try {
      return await BrokerClient.connect(path, token, lineageCredential);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    if (await brokerElectionIsHeld(profileDir))
      return await waitForBroker(path, token, lineageCredential);
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
    child.unref();
    return await waitForBroker(path, token, lineageCredential, () => failure);
  } finally {
    launchLease.release();
  }
}
