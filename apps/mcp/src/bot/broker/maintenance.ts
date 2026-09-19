import { lstat } from "node:fs/promises";
import { createSessionGuard } from "../../session-guard.js";
import { currentProfileDir, profilePathIdentity } from "../profile.js";
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
 * no `maintenance`/`resume` client operations on the wire.
 *
 * Only a connect that genuinely needs the login ceremony gets here — an
 * already-connected install is settled from reads before this is called — so a
 * browser another session still owns is reported at once rather than waited on.
 *
 * The endpoint is derived from the profile path, which is read live
 * (`currentProfileDir`) because connect re-points `TRUSTY_SQUIRE_PROFILE_DIR`
 * at its target's recorded profile first. That is the single source of truth
 * the reclaim helpers read too; resolving it anywhere else addresses one
 * profile's broker while terminating another's. */
export async function withBrokerMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const profileDir = currentProfileDir();
  const path = resolveBrokerSocket(profileDir);
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
    // operation bare exactly like the no-socket path. Stale-credential reclaim
    // only ever signals a broker on a profile bound to this same account, and
    // one with attached clients throws rather than being killed.
    // Unidentifiable residents are left alone and the original error
    // propagates.
    if (await reclaimPriorContractBrokerIfPresent(path, session.agent_session_token, error)) {
      return await operation();
    }
    if (await reclaimStaleCredentialBrokerIfPresent(path, session.account_id, error)) {
      return await operation();
    }
    throw error;
  }
  if (client.welcome?.maintenance !== "ready") {
    // Live sessions still own the shared browser. Drop the connection without
    // claiming the window — the daemon only arms its post-maintenance
    // credential refresh once a drain actually happened.
    await client.close();
    throw new BrokerRefusal(
      "maintenance",
      `A Trusty Squire session is still using the shared browser for ` +
        `${profilePathIdentity(profileDir)}; finish it and retry. ` +
        `No operator command was dispatched`,
    );
  }
  try {
    return await operation();
  } finally {
    // close{} ends the connection and resumes the maintenance window.
    await client.release().catch(() => undefined);
  }
}
