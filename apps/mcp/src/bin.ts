#!/usr/bin/env node
// The one and only entrypoint for @trusty-squire/mcp.
//
// A single bin (`mcp`, matching the package's unscoped name) means
// `npx @trusty-squire/mcp <subcommand>` is never ambiguous about which
// executable to run — npx can only auto-pick a bin when there is one,
// or one named for the package. Subcommands:
//   server                          — start the MCP stdio server (host agents)
//   connect | settings | login | logout — the setup CLI (humans)
//
// This file is *only* ever a process entrypoint: it has no exports and
// runs unconditionally. The old `import.meta.url === file://argv[1]`
// "am I main?" guard — duplicated in cli.ts and server.ts, and wrong in
// both when launched via a bin symlink — is gone by construction.
import process from "node:process";
import { MissingSessionError } from "./api-client.js";
import { runCli } from "./install/cli.js";
import { runServer } from "./server.js";
import { runSkillCli } from "./skill-cli/cli.js";
import { VERSION } from "./version.js";

const argv = process.argv.slice(2);

// Check for version flags early, before dispatching to subcommands.
// Supports: --version, -v, -V, and "version" as a positional.
// Must NOT interfere with `server` or `skill` subcommands.
const isVersionFlag =
  argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V";

if (isVersionFlag) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const isServer = argv[0] === "server";
const isSkill = argv[0] === "skill";
// NB: the `housekeeper` subcommand moved to its own operator-only package
// (@trusty-squire/housekeeper, the `ts-housekeeper` bin). `mcp housekeeper`
// no longer exists here; the systemd timer invokes ts-housekeeper directly.

async function dispatch(): Promise<number> {
  if (isServer) {
    await runServer();
    // runServer force-exits when its client disconnects or it receives a
    // termination signal. A return here is therefore only a normal startup
    // path with no active stdio loop left to keep alive.
    return 0;
  }
  if (isSkill) {
    // skill CLI returns its own exit code (T30 error taxonomy).
    return await runSkillCli(argv.slice(1));
  }
  await runCli(argv);
  return 0;
}

dispatch()
  .then((code) => {
    // The install/login/logout CLI commands DO return — and we force
    // an exit afterwards: Chrome can keep Node's event loop alive briefly
    // after teardown, and Node's event
    // loop can stay alive a beat longer waiting for the kernel to
    // actually reap them. Without this exit the CLI appears to hang
    // after printing "You're done."
    //
    // The `server` branch exits from runServer's disconnect/signal shutdown
    // path; `skill` returns its own code via T30 taxonomy.
    if (!isServer) process.exit(code);
  })
  .catch((err: unknown) => {
    // stderr lands in the host agent's MCP log; keep it useful.
    if (err instanceof MissingSessionError) {
      console.error(err.message);
    } else {
      const surface = isServer ? "server" : isSkill ? "skill" : "cli";
      console.error(
        `[trusty-squire] ${surface} failed: ` + (err instanceof Error ? err.message : String(err)),
      );
    }
    process.exit(1);
  });
