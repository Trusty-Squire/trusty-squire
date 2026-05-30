// Unconditional entrypoint for the one-time credential dedup migration.
//
// This file's only job is to run main() at the top level — no "am I the
// main module?" guard (that guard is wrong under bin symlinks and has
// caused shipped bugs; see CLAUDE.md). The dedup logic + pure helpers live
// in dedup-credentials.ts, which carries no top-level execution so it stays
// importable by tests.
//
//   node apps/api/dist/scripts/dedup-credentials.bin.js            # dry run
//   node apps/api/dist/scripts/dedup-credentials.bin.js --apply    # mutate

import process from "node:process";
import { main } from "./dedup-credentials.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[dedup] failed:", err);
  process.exit(1);
});
