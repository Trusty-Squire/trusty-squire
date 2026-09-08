import { publishEndpointOwner } from "./discovery.js";
import { DispatchJournal } from "./dispatch-journal.js";
import { lstat, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { brokerAdmissionMode } from "./qualification.js";
import { BrokerRefusal } from "./scheduler.js";
import { listenBroker } from "./transport.js";

/** Explicit foreground service entrypoint. A supervisor may retain the broker;
 * ordinary clients cannot stop it while another connection owns sessions. */
export async function runBrokerDaemon(): Promise<void> {
  const path = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  if (path === undefined)
    throw new Error("TRUSTY_SQUIRE_BROKER_SOCKET must name a private local socket");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error("Broker socket directory must be owned by this user with mode 0700");
  }
  const guard = createSessionGuard();
  const session = await guard.bind();
  if (session?.account_id === undefined || session.agent_session_token === undefined)
    throw new Error("Broker requires an enrolled account; run connect first");
  if ((await brokerAdmissionMode(CHROME_PROFILE_DIR, session.account_id)) === "single")
    throw new Error("Broker concurrency requires explicit operator enablement after real-auth qualification");
  setServingAccountId(session.account_id);
  const cellId = createHash("sha256")
    .update(JSON.stringify([session.account_id, profilePathIdentity(CHROME_PROFILE_DIR)]))
    .digest("hex");
  const runtime = new BrokerRuntime(session.account_id);
  installBrokerBrowserCustody(runtime);
  setSelfManagedChromeTerminationSignalExitEnabled(false);
  startOwnerProcessReaper();
  // Broker election is anchored beside the canonical profile, independent of
  // each client's socket path or TMPDIR. Retain it through plain-login maintenance.
  const electionRoot = join(
    dirname(profilePathIdentity(CHROME_PROFILE_DIR)),
    ".trusty-squire-broker-leases",
  );
  await mkdir(electionRoot, { recursive: true, mode: 0o700 });
  const election = acquireProfileOperationGuard(CHROME_PROFILE_DIR, electionRoot);
  runtime.claimProfile();
  const journal = new DispatchJournal(
    join(profilePathIdentity(CHROME_PROFILE_DIR), "trusty-squire-broker-dispatch.jsonl"),
  );
  await journal.assertReconciled();
  const operator = new OperatorBroker(
    {
      accountId: session.account_id,
      agentSessionToken: session.agent_session_token,
      apiBaseUrl: session.api_base_url,
      registryBaseUrl: process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai",
    },
    cellId,
    journal,
  );
  const connected = new Set<string>();
  let closing = false;
  let listenerClosed = false;
  let cleanupRunning = false;
  let maintenanceOwner: string | undefined;
  let maintenanceReady = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const restoreMaintenance = async () => {
    const refreshed = await guard.bind();
    if (refreshed === null) throw new Error("Enrolled account session is missing");
    operator.refreshCredentials(refreshed);
    runtime.resume();
    runtime.claimProfile();
    operator.authority.rotateEpoch();
    maintenanceOwner = undefined;
    maintenanceReady = false;
  };
  const listener = await listenBroker(path, {
    authenticate: async (token, agentId, lineageCredential) =>
      await operator.authenticate(token, agentId, lineageCredential),
    connected: async (principal) => {
      await operator.connected(principal);
      connected.add(principal.clientId);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    },
    call: async (principal, method, params, id) => {
      if (closing) throw new Error("Broker is draining");
      connected.add(principal.clientId);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      const report = await guard.inspect();
      if (report.problem !== null) throw new Error(report.problem.message);
      if (method === "recover") return await operator.recover(principal, params);
      if (method === "reclaim") return await operator.reclaim(principal);
      if (method === "acknowledge") {
        if (typeof params.requestId !== "string")
          throw new Error("A broker acknowledgement requires its request ID");
        await operator.acknowledge(principal, params.requestId);
        return {};
      }
      if (
        (await journal.hasOutstanding(undefined, principal.forwarderId)) &&
        !(
          method === "tool" &&
          (await operator.canContinuePaymentStatus(principal, params))
        )
      )
        throw new BrokerRefusal(
          "outcome_unknown",
          "Prior mutation outcome awaits reconciliation; reconnect without replaying it",
        );
      if (method === "maintenance") {
        if (maintenanceOwner !== undefined && maintenanceOwner !== principal.clientId)
          throw new Error("Identity maintenance is already owned");
        maintenanceOwner = principal.clientId;
        const inventory = operator.authority.inventory();
        const ready =
          inventory.active === 0 &&
          inventory.quarantined === 0 &&
          inventory.admitting === 0 &&
          (await runtime.close());
        maintenanceReady = ready;
        return { state: ready ? "ready" : "draining", ...inventory };
      }
      if (method === "resume") {
        if (maintenanceOwner !== principal.clientId)
          throw new Error("Identity maintenance is not owned by this client");
        if (!(await waitForProfileFree(CHROME_PROFILE_DIR, { deadlineMs: 0 })))
          throw new Error("Plain login browser is still open");
        await restoreMaintenance();
        return { state: "resumed" };
      }
      if (
        maintenanceOwner !== undefined &&
        (params.name === "operate_start" ||
          (params.name === "operate_recipe_run" &&
            (params.args as Record<string, unknown> | undefined)?.session_id === undefined))
      )
        throw new Error("Identity maintenance is draining; retry after connect completes");
      if (runtime.browserLost()) {
        operator.authority.fenceRuntime();
        await operator.authority.retryQuarantined();
        const inventory = operator.authority.inventory();
        if (inventory.active === 0 && inventory.quarantined === 0 && inventory.admitting === 0) {
          await journal.assertReconciled();
          if (!(await runtime.close())) throw new Error("Old browser cleanup is not proven");
          runtime.resume();
          runtime.claimProfile();
          operator.authority.rotateEpoch();
        } else
          throw new Error(
            "browser_lost: old session outcomes remain in custody; do not replay mutations",
          );
      }
      return await operator.call(principal, method, params, id);
    },
    disconnect: async (principal) => {
      await operator.disconnect(principal);
      connected.delete(principal.clientId);
      if (maintenanceOwner === principal.clientId && !maintenanceReady)
        maintenanceOwner = undefined;
      if (
        maintenanceOwner === principal.clientId &&
        (await waitForProfileFree(CHROME_PROFILE_DIR, { deadlineMs: 0 }))
      )
        await restoreMaintenance();
      if (connected.size === 0)
        idleTimer = setTimeout(() => {
          void shutdown();
        }, 1000);
    },
  });
  await publishEndpointOwner(path);
  const shutdown = async (explicitDrain = false) => {
    if (closing || (!explicitDrain && connected.size !== 0)) return;
    const inventory = operator.authority.inventory();
    if (inventory.active > 0 || inventory.quarantined > 0 || inventory.admitting > 0) return;
    closing = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (!listenerClosed) {
      listenerClosed = true;
      await listener.close();
    }
    if (!(await runtime.close())) {
      process.stderr.write("[browser-broker] cleanup unproven; retaining physical custody\n");
      closing = false;
      return;
    }
    await unlink(`${path}.owner.json`).catch(() => undefined);
    election.release();
    process.exit(0);
  };
  const requestDrain = async () => {
    if (!listenerClosed) {
      listenerClosed = true;
      await listener.close();
    }
    await shutdown(true);
  };
  const reap = setInterval(() => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    void operator.authority
      .retryQuarantined()
      .then(async () => {
        if (
          maintenanceOwner !== undefined &&
          !connected.has(maintenanceOwner) &&
          maintenanceReady &&
          (await waitForProfileFree(CHROME_PROFILE_DIR, { deadlineMs: 0 }))
        ) {
          await restoreMaintenance();
        }
        if (connected.size === 0) await shutdown();
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `[browser-broker] cleanup retained: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        cleanupRunning = false;
      });
  }, 5000);
  // This timer keeps quarantined payment/outcome custody alive after sockets close.
  process.once("SIGINT", () => {
    void requestDrain();
  });
  process.once("SIGTERM", () => {
    void requestDrain();
  });
  process.once("exit", () => clearInterval(reap));
  process.stderr.write(`[browser-broker] listening cell=${cellId} pid=${process.pid}\n`);
}
