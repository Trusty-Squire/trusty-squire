#!/usr/bin/env node
// The only file with a shebang + top-level execution. Everything else is a pure
// module (mirrors apps/mcp's bin discipline).

import { runHousekeeperCli } from "./cli.js";

runHousekeeperCli(process.argv.slice(2)).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`housekeeper: ${msg}\n`);
  process.exitCode = 1;
});
