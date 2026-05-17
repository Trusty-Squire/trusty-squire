#!/usr/bin/env node
// The one and only entrypoint for @trusty-squire/mcp.
//
// A single bin (`mcp`, matching the package's unscoped name) means
// `npx @trusty-squire/mcp <subcommand>` is never ambiguous about which
// executable to run — npx can only auto-pick a bin when there is one,
// or one named for the package. Subcommands:
//   server                          — start the MCP stdio server (host agents)
//   install | pair | login | logout — the setup CLI (humans)
//
// This file is *only* ever a process entrypoint: it has no exports and
// runs unconditionally. The old `import.meta.url === file://argv[1]`
// "am I main?" guard — duplicated in cli.ts and server.ts, and wrong in
// both when launched via a bin symlink — is gone by construction.
import process from "node:process";
import { MissingSessionError } from "./api-client.js";
import { runCli } from "./install/cli.js";
import { runServer } from "./server.js";

const argv = process.argv.slice(2);
const isServer = argv[0] === "server";

(isServer ? runServer() : runCli(argv)).catch((err: unknown) => {
  // stderr lands in the host agent's MCP log; keep it useful.
  if (err instanceof MissingSessionError) {
    console.error(err.message);
  } else {
    console.error(
      `[trusty-squire] ${isServer ? "server" : "cli"} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  process.exit(1);
});
