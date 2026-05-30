import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({
  reference: z.string().min(1),
  new_value: z.string().min(1).max(8192),
});

const DESCRIPTION = `Rotate a vaulted secret's value in place (same reference, new value).
Subsequent use_credential calls use the new value.`;

export const rotateCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "rotate_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["reference", "new_value"],
    properties: {
      reference: { type: "string" },
      new_value: { type: "string" },
    },
  },
  annotations: { destructiveHint: true },
  async handler(args, api) {
    assertApi(api);
    const res = await api.rotateCredential(args.reference, args.new_value);
    return { rotated_at: res.rotated_at };
  },
};
