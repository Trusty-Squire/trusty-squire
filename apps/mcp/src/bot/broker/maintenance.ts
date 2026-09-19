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

/** How long connect waits for a broker whose browser is still owned by live
 * sessions. The daemon answers `draining` — it never closes a browser another
 * session owns — and the plain-login owner retries until those sessions end.
 * This is that retry, at the same 120 s bound the original maintenance loop
 * used. Internal timing only: never a tool parameter. */
export const MAINTENANCE_DRAIN_WAIT_MS = 120_000;

const MAINTENANCE_DRAIN_RETRY_MS = 500;

export function maintenanceDrainWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.TRUSTY_SQUIRE_MAINTENANCE_DRAIN_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : MAINTENANCE_DRAIN_WAIT_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A broker that answered `draining` is not a failure — it is a broker with
 * live sessions that has not closed their browser yet. Every other refusal
 * (an unreadable resident, a lost connection) is fatal here. */
function isRetryableDrain(error: unknown): boolean {
  return error instanceof BrokerRefusal && error.code === "maintenance";
}

/** Connect retains the maintenance window throughout the existing plain,
 * no-CDP login lifecycle. It never opens a second automated browser.
 *
 * Maintenance is a connect-only concern: `connect { maintain: true }` drains
 * the shared browser, and `close{}` (the lease boundary) resumes it. There are
 * no `maintenance`/`resume` client operations on the wire.
 *
 * `profileDir` is the profile the caller is about to guard, and it is
 * load-bearing: the broker endpoint is derived from the profile path, so
 * resolving it from anywhere else addresses a different profile's broker than
 * the one about to be guarded. Omitted, it falls back to the live
 * `TRUSTY_SQUIRE_PROFILE_DIR` (`currentProfileDir`), never the launch-time
 * constant. */
export async function withBrokerMaintenance<T>(
  operation: () => Promise<T>,
  options: { profileDir?: string } = {},
): Promise<T> {
  const profileDir = options.profileDir ?? currentProfileDir();
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
  const deadline = Date.now() + maintenanceDrainWaitMs();
  for (;;) {
    let client: BrokerClient | undefined;
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
      // A concurrent maintenance owner (another connect, or the previous
      // attempt's connection the daemon has not yet reaped) is transient.
      if (!isRetryableDrain(error)) throw error;
    }
    if (client !== undefined && client.welcome?.maintenance === "ready") {
      try {
        return await operation();
      } finally {
        // close{} ends the connection and resumes the maintenance window.
        await client.release().catch(() => undefined);
      }
    }
    // Live sessions still own the shared browser. Drop this connection without
    // claiming the window — the daemon only arms its post-maintenance
    // credential refresh once a drain actually happened — and retry until
    // those sessions end or the deadline passes.
    if (client !== undefined) await client.close().catch(() => undefined);
    if (Date.now() >= deadline) {
      throw new BrokerRefusal(
        "maintenance",
        `A Trusty Squire session is still using the shared browser for ` +
          `${profilePathIdentity(profileDir)}; finish it and retry. ` +
          `No operator command was dispatched`,
      );
    }
    await sleep(MAINTENANCE_DRAIN_RETRY_MS);
  }
}
