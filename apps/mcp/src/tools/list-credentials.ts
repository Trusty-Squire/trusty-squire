import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({});

const DESCRIPTION = `List the credentials already stored in the user's vault for this account.

WHEN TO CALL THIS TOOL:
- BEFORE provisioning a service — check whether the account already has
  a usable key for it, so you reuse the existing key instead of signing
  up for a duplicate
- At the start of a task, to see what API keys are already available
- Whenever you need a service's key and aren't sure it exists yet

BEHAVIOR:
- Returns metadata only — service, key name, type, age, and a vault
  \`reference\` — never the secret values themselves
- The raw secret is never returned to you; to *use* a key, call
  use_credential with its \`reference\` (the server injects it)
- Scoped to the user's account; only this account's credentials list`;

export const listCredentialsTool: Tool<z.infer<typeof inputSchema>> = {
  name: "list_credentials",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {},
  },
  async handler(_args, api) {
    assertApi(api);
    const res = await api.listCredentials();
    return { credentials: res.credentials };
  },
};
