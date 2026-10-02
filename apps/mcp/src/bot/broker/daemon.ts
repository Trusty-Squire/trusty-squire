import { resolveBrokerSocket } from "./discovery.js";
import { lstat, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createSessionGuard, setServingAccountId } from "../../session-guard.js";
import { setSelfManagedChromeTerminationSignalExitEnabled } from "../browser.js";
import {
  acquireProfileOperationGuard,
  ensureProfileDeviceAnchor,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  readLockHolder,
} from "../profile.js";
import { brokerBusyStatus } from "./status.js";
import { installBrokerBrowserCustody } from "./custody.js";
import { BrokerRuntime } from "./runtime.js";
import { stopBrowserScope } from "../browser-scope.js";
import { OperatorBroker } from "./operator.js";
import { BrokerRefusal } from "./refusal.js";
import { listenBroker } from "./transport.js";
import { listenSharedMcp } from "./mcp-socket.js";
import { readBrokerUnitMarkerSync } from "./managed-marker.js";

/**
 * Wire connections that hold a claim on the browser. Status probes are reads
 * and do not count as active clients when explicit shutdown checks drain.
 */
export class BrokerClientRegistry {
  private readonly counting = new Set<string>();
  private readonly probes = new Set<string>();

  admit(clientId: string, probe: boolean): void {
    if (probe) this.probes.add(clientId);
    else this.counting.add(clientId);
  }

  /** Whether this wire client holds a claim during explicit shutdown. */
  counts(clientId: string): boolean {
    return !this.probes.has(clientId);
  }

  touch(clientId: string): void {
    if (this.counts(clientId)) this.counting.add(clientId);
  }

  retire(clientId: string): void {
    this.probes.delete(clientId);
    this.counting.delete(clientId);
  }

  idle(): boolean {
    return this.counting.size === 0;
  }
}

/** A failed cleanup retains custody but must leave a later signal able to retry. */
export function retryableBrokerShutdown(cleanup: () => Promise<boolean>): {
  closing: () => boolean;
  run: () => Promise<void>;
} {
  let closing = false;
  return {
    closing: () => closing,
    run: async () => {
      if (closing) return;
      closing = true;
      try {
        if (!(await cleanup())) closing = false;
      } catch (error) {
        closing = false;
        throw error;
      }
    },
  };
}

/**
 * On-demand broker entrypoint; retains custody while clients own sessions.
 *
 * The daemon requires NO enrollment. It is the machine's shared browser, and
 * the moment a machine most needs it is the moment it is being enrolled — the
 * ceremony has to run somewhere, and an account is exactly what it does not
 * have yet. Account identity arrives with the individual calls that act as an
 * account, so a bare broker serves the ceremony and the operator alike.
 */
/** A broker may start when (a) no managed marker exists, or (b) it was started
 * by the unit that owns the marker (INVOCATION_ID is set by systemd for every
 * unit process; the unit additionally sets TRUSTY_SQUIRE_BROKER_UNIT=1 as an
 * explicit, scrubbed-away-proof flag). Older or foreign clients that exec the
 * new bin have neither and fail closed. */
export function brokerMayStartForMarker(
  markerPresent: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!markerPresent) return true;
  const startedByUnit =
    (env.INVOCATION_ID ?? "").trim().length > 0 || env.TRUSTY_SQUIRE_BROKER_UNIT === "1";
  return startedByUnit;
}

export async function runBrokerDaemon(): Promise<void> {
  // A managed-broker marker means a systemd unit owns this profile. Refuse
  // before touching the socket, the profile lock, or Chrome when this process
  // was not started by that unit.
  const managedMarkerRead = readBrokerUnitMarkerSync(CHROME_PROFILE_DIR);
  if (managedMarkerRead.kind !== "absent" && !brokerMayStartForMarker(true, process.env)) {
    throw new BrokerRefusal(
      "broker_unavailable",
      "A managed broker unit owns this profile; refusing to start a foreign broker",
    );
  }
  // Provision the profile's private parent before anything derives the
  // device identity, so the daemon's socket and lock names are stable from
  // the very first start on a fresh machine.
  ensureProfileDeviceAnchor(CHROME_PROFILE_DIR);
  const path = resolveBrokerSocket();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  }
  const guard = createSessionGuard();
  // Best effort: an enrolled machine publishes its account so the daemon's own
  // tool handlers and the account-session-missing surface keep working. An
  // unenrolled machine publishes nothing and serves anyway.
  const session = await guard.bind().catch(() => null);
  setServingAccountId(session?.account_id ?? null);
  const cellId = createHash("sha256")
    .update(JSON.stringify([session?.account_id ?? null, profilePathIdentity(CHROME_PROFILE_DIR)]))
    .digest("hex");
  // The fd is the broker's sole profile authority. A crash releases it in the
  // kernel; the remaining inode carries no owner record.
  const profileElection = acquireProfileOperationGuard(CHROME_PROFILE_DIR);
  await stopBrowserScope(CHROME_PROFILE_DIR);
  // One-time upgrade cleanup. Old file leases are not consulted by this broker.
  await rm(join(dirname(profilePathIdentity(CHROME_PROFILE_DIR)), ".trusty-squire-broker-leases"), {
    recursive: true, force: true,
  });
  const runtime = new BrokerRuntime();
  installBrokerBrowserCustody(runtime);
  setSelfManagedChromeTerminationSignalExitEnabled(false);
  runtime.claimProfile();
  const operator = new OperatorBroker({
    registryBaseUrl: process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai",
  });
  const clients = new BrokerClientRegistry();
  // The wire listener can accept a connection before the MCP listener finishes
  // starting and the shutdown runner is installed below.
  let shutdown: ReturnType<typeof retryableBrokerShutdown> | undefined;
  let listenerClosed = false;
  // Only the elected SQLite lock holder may remove a dead predecessor's socket.
  // The transport itself simply binds and therefore respects live listeners.
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const listener = await listenBroker(path, {
    connected: async (principal, params) => {
      if (shutdown?.closing()) throw new BrokerRefusal("broker_lost", "Broker is shutting down");
      const probe = params.probe === true;
      clients.admit(principal.clientId, probe);
      if (probe) return;
    },
    call: async (principal, method, params, id) => {
      const execute = async (registeredSignal?: AbortSignal): Promise<unknown> => {
        if (clients.counts(principal.clientId)) {
          clients.touch(principal.clientId);
        }
        if (shutdown?.closing())
          throw new BrokerRefusal(
            "broker_lost",
            "Broker is shutting down; no operator command was dispatched",
          );
        // A session-less close is the lease boundary (formerly client_close):
        // it ends this connection's claim on the broker.
        if (method === "close" && typeof params.sessionId !== "string") {
          return { closed: true };
        }
        // The one place every layer is visible at the same instant.
        if (method === "status")
          return brokerBusyStatus({
            maintenanceOwned: false,
            ...runtime.custodyStatus(),
            profileHolder: readLockHolder(profilePathIdentity(CHROME_PROFILE_DIR)),
          });
        if (method === "command") {
          const busy = operator.busyReadResult(principal, params);
          if (busy !== undefined) return busy;
        }
        const report = await guard.inspect();
        if (report.problem !== null) throw new Error(report.problem.message);
        return await operator.call(principal, method, params, id, registeredSignal);
      };
      // Register before guard inspection or runtime awaits. A dropped connection
      // or an `abort` control frame therefore always sees — and aborts — the
      // actual in-flight request.
      return method === "open" || method === "command"
        ? await operator.withRegisteredRequest(principal, id, execute)
        : await execute();
    },
    abort: (principal, requestId) => operator.cancel(principal, requestId),
    disconnect: async (principal, explicit) => {
      await operator.disconnect(principal, explicit);
      clients.retire(principal.clientId);
    },
  });
  // The MCP listener is a separate surface on the elected broker. It does not
  // participate in profile election, Chrome custody, or the broker wire.
  const mcpListener = await listenSharedMcp(operator);
  shutdown = retryableBrokerShutdown(async (): Promise<boolean> => {
    // A signal is an explicit stop even with live relay clients. Let an
    // in-flight call finish briefly, then abort the rest and close their tabs.
    await new Promise((resolve) => setTimeout(resolve, 750));
    await operator.shutdown();
    if (!(await runtime.close())) {
      process.stderr.write("[browser-broker] cleanup unproven; retaining physical custody\n");
      return false;
    }
    if (!listenerClosed) {
      listenerClosed = true;
      await mcpListener.close();
      await listener.close();
    }
    profileElection.release();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    void shutdown.run();
  });
  process.on("SIGTERM", () => {
    void shutdown.run();
  });
  process.stderr.write(`[browser-broker] listening cell=${cellId} pid=${process.pid}\n`);
}
