import { lstat } from "node:fs/promises";
import { createSessionGuard } from "../../session-guard.js";
import { BrokerClient } from "./transport.js";
import { BrokerRefusal } from "./refusal.js";
import {
  reclaimPriorContractBrokerIfPresent,
  reclaimStaleCredentialBrokerIfPresent,
  resolveBrokerSocket,
} from "./discovery.js";

/** The maintenance connect carries the browser drain inside the handshake:
 * `runtime.close()` quits Chrome gracefully under BROWSER_QUIT_DEADLINE_MS
 * (10 s) plus its forced-close fallback, so the default 5 s handshake deadline
 * would abort a legitimate drain. Give it room without moving the wait back
 * onto the wire. */
export const MAINTENANCE_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Connect retains the maintenance window throughout the existing plain,
 * no-CDP login lifecycle. It never opens a second automated browser.
 *
 * Maintenance is a connect-only concern: `connect { maintain: true }` drains
 * the shared browser, and `close{}` (the lease boundary) resumes it. There are
 * no `maintenance`/`resume` client operations on the wire. */
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
    client = await BrokerClient.connect(path, session.agent_session_token, {
      maintain: true,
      handshakeTimeoutMs: MAINTENANCE_HANDSHAKE_TIMEOUT_MS,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "broker_lost") {
      // Nothing answers on the socket path: a dead predecessor's orphan. The
      // next broker's bind reclaims it; run the operation without a broker.
      return await operation();
    }
    // A live resident that refuses Contract B's maintain connect may be a
    // prior-contract broker still holding the profile, or a same-contract
    // broker whose digest lagged a re-enrollment: reclaim (terminate) it so
    // plain login drains the old broker instead of racing it, then run the
    // operation bare exactly like the no-socket path. A stale-credential
    // broker with attached clients throws rather than being killed.
    // Unidentifiable residents are left alone and the original error
    // propagates.
    if (await reclaimPriorContractBrokerIfPresent(path, session.agent_session_token, error)) {
      return await operation();
    }
    if (await reclaimStaleCredentialBrokerIfPresent(path, session.agent_session_token, error)) {
      return await operation();
    }
    throw error;
  }
  if (client.welcome?.maintenance !== "ready") {
    await client.close();
    throw new BrokerRefusal(
      "maintenance",
      "Active workflows still own the browser; finish them before reconnecting",
    );
  }
  try {
    return await operation();
  } finally {
    // close{} ends the connection and resumes the maintenance window.
    await client.release().catch(() => undefined);
  }
}
