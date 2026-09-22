import { resolveBrokerSocket } from "./discovery.js";
import { brokerElectionRoot } from "./discovery.js";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createSessionGuard, setServingAccountId } from "../../session-guard.js";
import { setSelfManagedChromeTerminationSignalExitEnabled } from "../browser.js";
import { startOwnerProcessReaper } from "../owner-process-reaper.js";
import {
  acquireProfileOperationGuard,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  readLockHolder,
} from "../profile.js";
import { brokerBusyStatus } from "./status.js";
import { installBrokerBrowserCustody } from "./custody.js";
import { BrokerRuntime } from "./runtime.js";
import { OperatorBroker } from "./operator.js";
import { BrokerRefusal } from "./refusal.js";
import { listenBroker } from "./transport.js";

const MIN_BROKER_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 5 * 60_000;

export function brokerIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  return Math.max(MIN_BROKER_IDLE_TIMEOUT_MS, configured);
}

/**
 * Which connections keep the shared Chrome resident. A `status` probe is a
 * read: it must never reset the idle countdown, or a consumer following the
 * probe-before-act pattern on any cadence under the idle bound would pin the
 * browser tree forever.
 */
export class BrokerClientRegistry {
  private readonly counting = new Set<string>();
  private readonly probes = new Set<string>();

  admit(clientId: string, probe: boolean): void {
    if (probe) this.probes.add(clientId);
    else this.counting.add(clientId);
  }

  /** Whether this client's traffic should hold off the idle countdown. */
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

/**
 * On-demand broker entrypoint; retains custody while clients own sessions.
 *
 * The daemon requires NO enrollment. It is the machine's shared browser, and
 * the moment a machine most needs it is the moment it is being enrolled — the
 * ceremony has to run somewhere, and an account is exactly what it does not
 * have yet. Account identity arrives with the individual calls that act as an
 * account, so a bare broker serves the ceremony and the operator alike.
 */
export async function runBrokerDaemon(): Promise<void> {
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
  const electionRoot = brokerElectionRoot(CHROME_PROFILE_DIR);
  await mkdir(electionRoot, { recursive: true, mode: 0o700 });
  const runtime = new BrokerRuntime();
  installBrokerBrowserCustody(runtime);
  setSelfManagedChromeTerminationSignalExitEnabled(false);
  startOwnerProcessReaper();
  // Broker election is anchored beside the canonical profile, independent of
  // each client's socket path or TMPDIR.
  const profileElection = acquireProfileOperationGuard(CHROME_PROFILE_DIR, electionRoot);
  runtime.claimProfile();
  const operator = new OperatorBroker({
    registryBaseUrl: process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai",
  });
  const clients = new BrokerClientRegistry();
  let closing = false;
  let listenerClosed = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const idleTimeout = brokerIdleTimeoutMs();
  const drained = (): boolean => {
    const inventory = operator.authority.inventory();
    return inventory.sessions === 0 && inventory.admitting === 0 && inventory.closing === 0;
  };
  const listener = await listenBroker(path, {
    connected: async (principal, params) => {
      const probe = params.probe === true;
      clients.admit(principal.clientId, probe);
      if (probe) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    },
    call: async (principal, method, params, id) => {
      const execute = async (registeredSignal?: AbortSignal): Promise<unknown> => {
        if (clients.counts(principal.clientId)) {
          clients.touch(principal.clientId);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
        }
        if (closing)
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
      const counted = clients.counts(principal.clientId);
      await operator.disconnect(principal, explicit);
      clients.retire(principal.clientId);
      // A probe never held off the countdown, so its departure must not re-arm one.
      if (!counted) return;
      scheduleShutdownIfIdle();
    },
  });
  function scheduleShutdownIfIdle(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (closing || !clients.idle()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void shutdown();
    }, idleTimeout);
    idleTimer.unref();
  }
  const shutdown = async (): Promise<void> => {
    if (closing || !clients.idle() || !drained()) return;
    closing = true;
    if (!(await runtime.close())) {
      process.stderr.write("[browser-broker] cleanup unproven; retaining physical custody\n");
      closing = false;
      return;
    }
    if (!listenerClosed) {
      listenerClosed = true;
      await listener.close();
    }
    profileElection.release();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.stderr.write(`[browser-broker] listening cell=${cellId} pid=${process.pid}\n`);
}
