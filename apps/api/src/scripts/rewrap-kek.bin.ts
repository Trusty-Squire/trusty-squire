// Entrypoint for the KEK re-wrap migration. Unconditional top-level
// execution (the repo's bin.ts pattern); logic lives in the pure module.

import { main } from "./rewrap-kek.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[rewrap-kek] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
