import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({
  reference: z.string().min(1),
});

const DESCRIPTION = `Permanently delete a credential from the vault. Irreversible.`;

export const deleteCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "delete_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["reference"],
    properties: { reference: { type: "string" } },
  },
  annotations: { destructiveHint: true },
  async handler(args, api) {
    assertApi(api);
    const res = await api.deleteCredential(args.reference);
    return { deleted_at: res.deleted_at };
  },
};
