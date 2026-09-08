import { spawn } from "node:child_process";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  acquireProfileOperationGuard,
  processBirthIdentity,
  processBirthIdentityState,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  waitForProfileFree,
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

export function brokerEnvironment(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const brokerEnv = { ...env };
  delete brokerEnv.TRUSTY_SQUIRE_FORWARDER_CREDENTIAL;
  return { ...brokerEnv, TRUSTY_SQUIRE_BROKER_SOCKET: path };
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
  const lease = acquireProfileOperationGuard(profileDir);
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
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    try {
      return await BrokerClient.connect(path, token, lineageCredential);
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BrokerRefusal(
    "broker_unavailable",
    "Broker did not become available within 10 seconds; no operator command was dispatched",
  );
}
