import { z } from "zod";
import { assertPaired, type Tool } from "./index.js";

const inputSchema = z.object({});

const DESCRIPTION = `Report the user's current spending vs their mandate budget. Lets the
coding agent answer questions like "how much have I spent on hosting
this month?" or "do I have room in my budget for another paid service?"

BEHAVIOR:
- Returns monthly spend, monthly budget, monthly remaining
- Returns daily spend and the daily silent-max threshold
- All values in cents
- Reflects the currently-active mandate; if the user just amended the
  mandate, the numbers update immediately`;

export const getUsageTool: Tool<z.infer<typeof inputSchema>> = {
  name: "get_usage",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: { type: "object", properties: {} },
  async handler(_args, api) {
    assertPaired(api);
    return api.getUsage();
  },
};
