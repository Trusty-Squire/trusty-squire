import type { ApiClient } from "../api-client.js";
import { join } from "node:path";
import { OperatorBroker } from "../bot/broker/operator.js";
import { OperatorForwarder } from "../bot/broker/forwarder.js";
import { listenBroker } from "../bot/broker/transport.js";
import { buildToolRegistry } from "../tools/index.js";
import type { SessionGuard } from "../session-guard.js";
import type { DispatchJournal } from "../bot/broker/dispatch-journal.js";

/** Real IPC + broker dispatch, with a caller-owned browser/session and vault API. */
export async function fixtureBrokerForwarder(
  root: string,
  api: ApiClient,
  journal: DispatchJournal,
  internalSessionId: string,
) {
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
    journal,
  );
  Object.defineProperty(broker, "tools", {
    value: buildToolRegistry().map((tool) =>
      tool.name === "operate_start"
        ? { ...tool, handler: async () => ({ session_id: internalSessionId }) }
        : tool,
    ),
  });
  const socket = join(root, "broker.sock");
  const listener = await listenBroker(socket, {
    authenticate: async (...args) => await broker.authenticate(...args),
    connected: async (principal) => {
      await broker.connected(principal);
      (broker as unknown as { apis: Map<string, ApiClient> }).apis.set(principal.clientId, api);
    },
    call: async (principal, method, args, requestId) => {
      if (method === "reclaim") return await broker.reclaim(principal);
      if (method === "acknowledge")
        return await broker.acknowledge(principal, String(args.requestId));
      if (method === "confirm_start") return await broker.confirmStartDelivery(principal, args);
      if (
        (await journal.hasOutstanding(undefined, principal.forwarderId)) &&
        !(
          method === "tool" &&
          (args.name === "operate_finish" ||
            (await broker.canReconcileCapture(principal, args)) ||
            (await broker.canContinueAfterCapture(principal, args)))
        )
      )
        throw new Error("Prior mutation outcome awaits reconciliation");
      return await broker.call(principal, method, args, requestId);
    },
    disconnect: async (principal, explicit) => await broker.disconnect(principal, explicit),
  });
  const forwarder = new OperatorForwarder(
    socket,
    {
      bind: async () => ({ agent_session_token: "token" }),
    } as unknown as SessionGuard,
    "a".repeat(43),
  );
  const started = (await forwarder.invoke("operate_start", {
    service_url: "https://example.test",
  })) as { session_id: string };
  return {
    forwarder,
    sessionId: started.session_id,
    close: async () => {
      await forwarder.close();
      await listener.close();
    },
  };
}
