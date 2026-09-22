import type { ApiClient } from "../api-client.js";
import { join } from "node:path";
import { OperatorBroker } from "../bot/broker/operator.js";
import { OperatorForwarder } from "../bot/broker/forwarder.js";
import { listenBroker } from "../bot/broker/transport.js";
import { buildToolRegistry } from "../tools/index.js";
import type { SessionGuard } from "../session-guard.js";

/** Real IPC + broker dispatch, with a caller-owned browser/session and vault API. */
export async function fixtureBrokerForwarder(
  root: string,
  api: ApiClient,
  internalSessionId: string,
) {
  const broker = new OperatorBroker({
    registryBaseUrl: "http://unused.test",
    apiFactory: () => api,
  });
  Object.defineProperty(broker, "tools", {
    value: buildToolRegistry().map((tool) =>
      tool.name === "operate_start"
        ? { ...tool, handler: async () => ({ session_id: internalSessionId }) }
        : tool,
    ),
  });
  const socket = join(root, "broker.sock");
  const listener = await listenBroker(socket, {
    call: async (principal, method, args, requestId) =>
      await broker.call(principal, method, args, requestId),
    disconnect: async (principal, explicit) => await broker.disconnect(principal, explicit),
  });
  const forwarder = new OperatorForwarder(socket, {
    bind: async () => ({
      account_id: "account",
      agent_session_token: "token",
      api_base_url: "http://unused.test",
    }),
  } as unknown as SessionGuard);
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
