import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

const inputSchema = z.object({
  request_id: z.string().min(1),
});

const DESCRIPTION = `Long-poll the broker for a pending access-request's status.`;

export const pollCredentialAccessTool: Tool<z.infer<typeof inputSchema>> = {
  name: "poll_credential_access",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["request_id"],
    properties: { request_id: { type: "string" } },
  },
  annotations: { readOnlyHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const res = await api.pollCredentialAccess(args.request_id);
    return {
      status: res.status,
      ...(res.value !== undefined ? { value: res.value } : {}),
      ...(res.denied_reason !== undefined ? { denied_reason: res.denied_reason } : {}),
    };
  },
};
