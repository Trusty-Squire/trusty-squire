import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({
  subscription_id: z.string().min(1),
});

const DESCRIPTION = `Cancel one of the user's subscriptions. The user has pre-authorized
cancellation in their spending policy (default confidence: low) so
this completes without an approval prompt.

WHEN TO CALL THIS TOOL:
- The user explicitly asks to cancel a service
- A migration / consolidation makes a subscription redundant

BEHAVIOR:
- Initiates the adapter's cancel flow asynchronously
- Returns 202 immediately; poll list_subscriptions to confirm
- Idempotent on subscription_id
- In v0 the cancel flow is wired but the runtime's flow selector
  doesn't pick the cancel flow yet — see chunk 11+ roadmap`;

export const cancelTool: Tool<z.infer<typeof inputSchema>> = {
  name: "cancel",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["subscription_id"],
    properties: { subscription_id: { type: "string" } },
  },
  async handler(args, api) {
    assertApi(api);
    return api.cancelSubscription(args.subscription_id);
  },
};
