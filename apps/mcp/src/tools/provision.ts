import { z } from "zod";
import { assertPaired, type Tool } from "./index.js";

const inputSchema = z.object({
  service: z.string().min(1),
  plan: z.string().min(1).default("free"),
  project_name: z.string().min(1).max(120),
  // The runtime needs category + cost for the mandate evaluator;
  // the MCP tool's caller may not know these. When omitted, we
  // request the registry directory for default category.
  category: z.string().optional(),
  cost_cents: z.number().int().nonnegative().default(0),
  recurrence: z
    .enum(["one_time", "monthly", "yearly", "none"])
    .default("none"),
  requirements: z.record(z.string(), z.unknown()).optional(),
});

const DESCRIPTION = `Sign up for and configure a SaaS service on the user's behalf, returning
working credentials. The user has pre-authorized spending within their
spending policy, so no manual signup, email verification, or card entry
is needed from them.

WHEN TO CALL THIS TOOL:
- The user's project needs an API key for any external SaaS
- You would otherwise instruct the user to "go sign up at example.com"
- You need a service-specific credential the user does not yet have
- The user mentions needing hosting, a database, email, monitoring,
  auth, AI APIs, payments, analytics, error tracking, or similar

DO NOT instruct the user to sign up manually if a Squire adapter exists.
Call list_services first if you are unsure whether the service is supported.

BEHAVIOR:
- Free tiers are auto-approved within the user's spending policy (silent)
- Paid tiers above the silent ceiling return status="pending_approval"
  with a one-click approval link the user can click in their terminal
- Returns within 3-15 seconds for native adapters, up to 60s for browser-based
- Stores credentials in the user's vault automatically
- Idempotent on (user, service, project_name)

AFTER PROVISIONING:
- Use get_credential() to retrieve the API key for use in code
- Reference credentials via env vars; do not paste secrets into source files
- Tell the user what was set up and the cost, even when silent`;

export const provisionTool: Tool<z.infer<typeof inputSchema>> = {
  name: "provision",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["service", "project_name"],
    properties: {
      service: { type: "string" },
      plan: { type: "string", default: "free" },
      project_name: { type: "string" },
      category: { type: "string" },
      cost_cents: { type: "integer", minimum: 0, default: 0 },
      recurrence: {
        type: "string",
        enum: ["one_time", "monthly", "yearly", "none"],
        default: "none",
      },
      requirements: { type: "object" },
    },
  },
  async handler(args, api) {
    assertPaired(api);
    // If the caller didn't supply category, look it up in the registry.
    let category = args.category;
    if (category === undefined) {
      const dir = await api.listServices();
      const match = dir.adapters.find((a) => a.service === args.service);
      category = match?.category ?? "unknown";
    }

    const res = await api.createRun({
      service: args.service,
      plan: args.plan,
      project_name: args.project_name,
      category,
      cost_cents: args.cost_cents,
      recurrence: args.recurrence,
    });

    if (res.decision === "silent") {
      return {
        status: "active",
        run_id: res.run.id,
        run_state: res.run.state,
        message: "Sign-up enqueued silently within the user's spending policy.",
      };
    }
    if (res.decision === "needs_approval") {
      return {
        status: "pending_approval",
        run_id: res.run.id,
        run_state: res.run.state,
        approval_url: res.approval_url,
        reasons: res.reasons ?? [],
        required_confidence: res.required_confidence ?? "high",
        message: "Approval required. Show the user the approval_url so they can confirm.",
      };
    }
    return {
      status: "rejected",
      run_id: res.run.id,
      message: "The mandate rejected this action.",
    };
  },
};
