import { z } from "zod";
import { assertPaired, type Tool } from "./index.js";

const inputSchema = z.object({});

const DESCRIPTION = `List the user's active subscriptions across all services. Useful
when the user asks "what am I paying for?" or to find an existing
subscription before provisioning a duplicate.

BEHAVIOR:
- Returns subscriptions in any non-cancelled state
- Includes service, plan, project_name, monthly cost (if any),
  and the run_id that created the subscription
- Idempotency means a re-provision of the same service+project_name
  returns the existing subscription rather than creating a new one;
  use this tool to check what's already in place first`;

export const listSubscriptionsTool: Tool<z.infer<typeof inputSchema>> = {
  name: "list_subscriptions",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: { type: "object", properties: {} },
  async handler(_args, api) {
    assertPaired(api);
    return api.listSubscriptions();
  },
};
