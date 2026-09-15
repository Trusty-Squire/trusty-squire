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
  waitForProfileFree,
} from "../profile.js";
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

/** On-demand broker entrypoint; retains custody while clients own sessions. */
export async function runBrokerDaemon(): Promise<void> {
  const path = resolveBrokerSocket();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  }
  const guard = createSessionGuard();
  const session = await guard.bind();
  if (session?.account_id === undefined || session.agent_session_token === undefined)
    throw new Error("Broker requires an enrolled account; run connect first");
  setServingAccountId(session.account_id);
  const cellId = createHash("sha256")
    .update(JSON.stringify([session.account_id, profilePathIdentity(CHROME_PROFILE_DIR)]))
    .digest("hex");
  const electionRoot = brokerElectionRoot(CHROME_PROFILE_DIR);
  await mkdir(electionRoot, { recursive: true, mode: 0o700 });
  const runtime = new BrokerRuntime(session.account_id);
  installBrokerBrowserCustody(runtime);
  setSelfManagedChromeTerminationSignalExitEnabled(false);
  startOwnerProcessReaper();
  // Broker election is anchored beside the canonical profile, independent of
  // each client's socket path or TMPDIR. Retain it through plain-login maintenance.
  const profileElection = acquireProfileOperationGuard(CHROME_PROFILE_DIR, electionRoot);
  runtime.claimProfile();
  const operator = new OperatorBroker({
    accountId: session.account_id,
    agentSessionToken: session.agent_session_token,
    apiBaseUrl: session.api_base_url,
    registryBaseUrl: process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai",
  });
  const connected = new Set<string>();
  let closing = false;
  let listenerClosed = false;
  let maintenanceOwner: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const idleTimeout = brokerIdleTimeoutMs();
  const drained = (): boolean => {
    const inventory = operator.authority.inventory();
    return inventory.sessions === 0 && inventory.admitting === 0 && inventory.closing === 0;
  };
  const restoreMaintenance = async (): Promise<void> => {
    const refreshed = await guard.bind();
    if (refreshed === null) throw new Error("Enrolled account session is missing");
    operator.refreshCredentials(refreshed);
    runtime.resume();
    runtime.claimProfile();
    maintenanceOwner = undefined;
  };
  const releaseMaintenanceLease = async (clientId: string): Promise<void> => {
    if (maintenanceOwner !== clientId) return;
    if (await waitForProfileFree(CHROME_PROFILE_DIR, { deadlineMs: 0 })) await restoreMaintenance();
    else maintenanceOwner = undefined;
  };
  const listener = await listenBroker(path, {
    authenticate: async (token, agentId) => await operator.authenticate(token, agentId),
    connected: async (principal, params) => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      // Maintenance is a connect-only concern: the plain-login window drains the
      // shared browser and holds the lease until this connection closes.
      if (params.maintain === true && maintenanceOwner !== undefined)
        throw new BrokerRefusal("maintenance", "Identity maintenance is already owned");
      connected.add(principal.clientId);
      if (params.maintain !== true) return;
      maintenanceOwner = principal.clientId;
      // Never start closing the shared browser while a session still owns it:
      // the plain-login owner retries once the sessions have ended.
      if (!drained() || !(await runtime.close())) return { maintenance: "draining" };
      return { maintenance: "ready" };
    },
    call: async (principal, method, params, id) => {
      const execute = async (registeredSignal?: AbortSignal): Promise<unknown> => {
        connected.add(principal.clientId);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (closing)
          throw new BrokerRefusal(
            "broker_lost",
            "Broker is shutting down; no operator command was dispatched",
          );
        // A session-less close is the lease boundary (formerly client_close):
        // resume the connect-scoped maintenance window before the socket goes.
        if (method === "close" && typeof params.sessionId !== "string") {
          await releaseMaintenanceLease(principal.clientId);
          return { closed: true };
        }
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
      connected.delete(principal.clientId);
      await releaseMaintenanceLease(principal.clientId);
      scheduleShutdownIfIdle();
    },
  });
  function scheduleShutdownIfIdle(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (closing || connected.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void shutdown();
    }, idleTimeout);
    idleTimer.unref();
  }
  const shutdown = async (): Promise<void> => {
    if (closing || connected.size > 0 || !drained()) return;
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
