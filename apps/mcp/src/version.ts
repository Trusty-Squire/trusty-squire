// Single source of truth for the package version. Read from
// package.json so it cannot drift from what is actually published —
// the old hardcoded `SERVER_VERSION = "0.1.0"` constant did exactly
// that (stale across three releases).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
