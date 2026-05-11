import { z } from "zod";
import type { Tool } from "./index.js";

const inputSchema = z.object({
  reference: z.string().min(1),
});

const DESCRIPTION = `Rotate a vault-stored credential (e.g. when the user suspects a leak).
The adapter's rotate flow generates a fresh credential, stores it in
the vault under the same reference, and revokes the old value at the
service.

WHEN TO CALL THIS TOOL:
- The user explicitly asks "rotate the X key"
- A credential leak has been confirmed
- Compliance policy requires periodic rotation and the rotation due
  date has passed

BEHAVIOR:
- Default confidence requirement is medium (not high) — rotation is a
  privileged operation but doesn't authorize new spending
- In v0 the rotate flow is partially wired; the rotate adapter step
  exists but the runtime's flow selector doesn't pick the rotate flow
  yet — see chunk 11+ roadmap. This tool currently returns 202.`;

export const rotateCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "rotate_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["reference"],
    properties: { reference: { type: "string" } },
  },
  async handler(args, _api) {
    // v0 stub. The endpoint doesn't exist on apps/api yet — the chunk-11
    // spec lists rotate as a future improvement. We return a clear
    // not-implemented body so the coding agent can surface this to
    // the user rather than acting on a false success.
    return {
      status: "not_implemented",
      reference: args.reference,
      message:
        "Credential rotation is a v0 stub. The cancel + rotate flow selectors arrive in a later chunk. Track progress at /v1/usage.",
    };
  },
};
