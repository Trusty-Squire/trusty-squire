import { lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createSessionGuard } from "../../session-guard.js";
import { BrokerClient } from "./transport.js";
import { BrokerRefusal } from "./scheduler.js";
import { reclaimDeadBrokerEndpoint } from "./discovery.js";

/** Connect retains the maintenance connection throughout the existing plain,
 * no-CDP login lifecycle. It never opens a second automated browser. */
export async function withBrokerMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const path = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  if (
    path === undefined ||
    !(await lstat(path).then(
      () => true,
      () => false,
    ))
  )
    return await operation();
  const session = await createSessionGuard().bind();
  if (session?.agent_session_token === undefined)
    throw new BrokerRefusal("unauthorized", "Broker maintenance requires the enrolled account");
  let client: BrokerClient;
  try {
    client = await BrokerClient.connect(
      path,
      session.agent_session_token,
      randomBytes(32).toString("base64url"),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ECONNREFUSED" && code !== "broker_lost") throw error;
    await reclaimDeadBrokerEndpoint(path);
    return await operation();
  }
  let ready = false;
  try {
    const deadline = Date.now() + 120000;
    do {
      const result = (await client.call("maintenance", {})) as { state: string };
      if (result.state === "ready") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    if (!ready)
      throw new BrokerRefusal(
        "maintenance",
        "Active workflows or payment outcomes still own the browser; finish them before reconnecting",
      );
    return await operation();
  } finally {
    if (ready) await client.call("resume", {}).catch(() => undefined);
    await client.close();
  }
}
