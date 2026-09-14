import { lstat } from "node:fs/promises";
import { createSessionGuard } from "../../session-guard.js";
import { BrokerClient } from "./transport.js";
import { BrokerRefusal } from "./refusal.js";
import { resolveBrokerSocket } from "./discovery.js";

/** Connect retains the maintenance connection throughout the existing plain,
 * no-CDP login lifecycle. It never opens a second automated browser. */
export async function withBrokerMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const path = resolveBrokerSocket();
  if (
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
    client = await BrokerClient.connect(path, session.agent_session_token);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ECONNREFUSED" && code !== "broker_lost") throw error;
    // Nothing answers on the socket path: a dead predecessor's orphan. The
    // next broker's bind reclaims it; run the operation without a broker.
    return await operation();
  }
  let ready = false;
  try {
    const result = (await client.call("maintenance", {})) as { state: string };
    ready = result.state === "ready";
    if (!ready)
      throw new BrokerRefusal(
        "maintenance",
        "Active workflows still own the browser; finish them before reconnecting",
      );
    return await operation();
  } finally {
    if (ready) await client.call("resume", {}).catch(() => undefined);
    await client.close();
  }
}
