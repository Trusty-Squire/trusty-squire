// Entrypoint for the read-only vault decryption health check. Unconditional
// top-level execution (the repo's bin.ts pattern); the logic lives in the
// pure module so tests/imports don't open a DB.

import { main } from "./vault-decrypt-check.js";

main().catch((err: unknown) => {
  console.error("[decrypt-check] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
