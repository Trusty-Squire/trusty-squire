import { z } from "zod";
import type { Tool } from "./index.js";

const inputSchema = z.object({
  reference: z.string().min(1),
  purpose: z.string().min(1).max(200),
});

const DESCRIPTION = `Retrieve a credential the user previously authorized for this account.
Returns the secret value so you can plug it into your code's env vars
or pass it to a request.

WHEN TO CALL THIS TOOL:
- After provision() succeeded and you need the resulting API key
- When the user has authorized a credential and you need its value
- Every time you need to make an outbound call to a SaaS API on behalf
  of the user

BEHAVIOR:
- Logs an audit event recording the purpose string — be specific
  ("calling Resend send-email API") so the user can review later
- Rate-limited per (account, agent_session) — don't poll
- Credentials are scoped to the user's account; cross-account access is rejected`;

export const getCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "get_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["reference", "purpose"],
    properties: {
      reference: { type: "string" },
      purpose: { type: "string", maxLength: 200 },
    },
  },
  async handler(args, api) {
    const res = await api.getCredential(args.reference, args.purpose);
    return {
      value: res.value,
      reference: res.reference,
      retrieved_at: res.retrieved_at,
    };
  },
};
