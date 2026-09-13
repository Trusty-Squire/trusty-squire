import { randomUUID } from "node:crypto";
import type { ApiClient } from "../api-client.js";
import { buildToolRegistry, findTool } from "../tools/index.js";
import { withOperatorRequestContext } from "../bot/request-cancellation.js";
import { withProvisionSessionCall } from "../bot/provision-session.js";
import type { OperatorForwarder } from "../bot/broker/forwarder.js";

/** In-memory handler adapter for MCP wire tests. Production always uses IPC;
 * physical custody and durable dispatch are tested by the broker suites. */
export function operatorHandlerForwarder(api: ApiClient): Pick<OperatorForwarder, "invoke"> {
  return {
    invoke: async (
      name,
      args,
      requestId = randomUUID(),
      _recovery,
      signal = new AbortController().signal,
    ) => {
      const tool = findTool(name, buildToolRegistry());
      if (!tool) throw new Error(`unknown tool ${name}`);
      const invoke = async () =>
        await withOperatorRequestContext(
          signal ?? new AbortController().signal,
          async () => await tool.handler(args, api, { signal, notifyUser: async () => undefined }),
          undefined,
          { operationId: requestId },
        );
      return typeof args.session_id === "string" && name !== "operate_finish"
        ? await withProvisionSessionCall(args.session_id, invoke, signal)
        : await invoke();
    },
  };
}
