import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import type { Tool } from "./index.js";

const inputSchema = z.object({
  run_id: z.string().min(1),
  timeout_seconds: z.number().int().positive().max(600).default(120),
  poll_interval_seconds: z.number().int().positive().max(30).default(2),
});

const DESCRIPTION = `Wait for a run that's in pending_approval to be granted or denied by the user.
Returns the final status once the run leaves PENDING_APPROVAL or the timeout elapses.

WHEN TO CALL THIS TOOL:
- After provision() returns status="pending_approval"
- When you want to block until the user clicks the approval link

BEHAVIOR:
- Polls the run every poll_interval_seconds (default 2s)
- Returns once the run leaves PENDING_APPROVAL or timeout_seconds elapses
- Does NOT auto-grant; only the user can grant via the approval URL`;

export const waitForApprovalTool: Tool<z.infer<typeof inputSchema>> = {
  name: "wait_for_approval",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["run_id"],
    properties: {
      run_id: { type: "string" },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 120 },
      poll_interval_seconds: { type: "integer", minimum: 1, maximum: 30, default: 2 },
    },
  },
  async handler(args, api) {
    return waitForApprovalImpl(args, api);
  },
};

export async function waitForApprovalImpl(
  args: z.infer<typeof inputSchema>,
  api: ApiClient,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ status: string; run_state: string; run_id: string; reason?: string }> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + args.timeout_seconds * 1000;

  while (true) {
    const run = await api.getRun(args.run_id);
    if (run.state !== "PENDING_APPROVAL") {
      return {
        status: terminalDescription(run.state),
        run_state: run.state,
        run_id: run.id,
        ...(run.failure_reason !== null ? { reason: run.failure_reason } : {}),
      };
    }
    if (now() >= deadline) {
      return {
        status: "timeout",
        run_state: run.state,
        run_id: run.id,
        reason: "wait_for_approval_timed_out",
      };
    }
    await sleep(args.poll_interval_seconds * 1000);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalDescription(state: string): string {
  switch (state) {
    case "PROVISIONING":
    case "ADAPTER_EXECUTING":
    case "CRED_EXTRACTED":
    case "VAULT_WRITTEN":
      return "granted";
    case "COMPLETE":
      return "active";
    case "REJECTED":
      return "denied";
    case "FAILED":
      return "failed";
    default:
      return state.toLowerCase();
  }
}
