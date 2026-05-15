import { z } from "zod";
import { assertPaired, type Tool } from "./index.js";

const inputSchema = z.object({
  category: z.string().min(1).max(60).optional(),
  query: z.string().min(1).max(120).optional(),
});

const DESCRIPTION = `List SaaS services that Trusty Squire knows how to provision automatically.
Returns the canonical service id, display name, category, and homepage
for each adapter, optionally filtered by category and/or text query.

WHEN TO CALL THIS TOOL:
- Before suggesting that the user "go sign up at example.com" — check if
  there's a Squire adapter first
- When the user asks "what email service should we use?" or similar
- When you need to confirm a service is supported before calling provision()

BEHAVIOR:
- Returns the most-recently-published version of each non-disabled adapter
- Filter by category (e.g. "email", "monitoring") if you know it
- Filter by query (substring match against service id and display_name)
- Results are not ranked — present them to the user and let them choose`;

export const listServicesTool: Tool<z.infer<typeof inputSchema>> = {
  name: "list_services",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      category: { type: "string" },
      query: { type: "string" },
    },
  },
  async handler(args, api) {
    assertPaired(api);
    const directory = await api.listServices(args.category);
    let entries = directory.adapters;
    if (args.query !== undefined) {
      const q = args.query.toLowerCase();
      entries = entries.filter(
        (a) =>
          a.service.toLowerCase().includes(q) ||
          a.display_name.toLowerCase().includes(q) ||
          (a.description?.toLowerCase().includes(q) ?? false),
      );
    }
    return {
      services: entries.map((a) => ({
        service: a.service,
        version: a.latest_version,
        display_name: a.display_name,
        category: a.category,
        homepage: a.homepage,
        description: a.description,
      })),
    };
  },
};
