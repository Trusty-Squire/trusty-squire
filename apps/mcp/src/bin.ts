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
import { runSkillCli } from "./skill-cli/cli.js";
import { runVerifierWorkerCli } from "./verifier-worker/cli.js";
import { VERSION } from "./version.js";

const argv = process.argv.slice(2);

// Check for version flags early, before dispatching to subcommands.
// Supports: --version, -v, -V, and "version" as a positional.
// Must NOT interfere with `server` or `skill` subcommands.
const isVersionFlag =
  argv[0] === "version" ||
  argv[0] === "--version" ||
  argv[0] === "-v" ||
  argv[0] === "-V";

if (isVersionFlag) {
  console.log(VERSION);
  process.exit(0);
}

const isServer = argv[0] === "server";
const isSkill = argv[0] === "skill";
const isVerifier = argv[0] === "verifier-worker";

async function dispatch(): Promise<number> {
  if (isServer) {
    await runServer();
    // runServer is a stdio loop that runs until the host agent kills
    // it — never returns. If it does return, treat as success.
    return 0;
  }
  if (isSkill) {
    // skill CLI returns its own exit code (T30 error taxonomy).
    return await runSkillCli(argv.slice(1));
  }
  if (isVerifier) {
    // verifier-worker — closed-loop strategy Phase 3. Runs the
    // pending-review + freshness sweep against the registry.
    return await runVerifierWorkerCli(argv.slice(1));
  }
  await runCli(argv);
  return 0;
}

dispatch()
  .then((code) => {
    // The install/login/logout CLI commands DO return — and we force
    // an exit afterwards: the headless install rig spawns several
    // long-running processes (Xvfb, x11vnc, websockify, cloudflared,
    // Chrome), and even after teardown SIGTERMs them, Node's event
    // loop can stay alive a beat longer waiting for the kernel to
    // actually reap them. Without this exit the CLI appears to hang
    // after printing "You're done."
    //
    // The `server` branch never reaches here (the stdio loop blocks
    // forever); `skill` returns its own code via T30 taxonomy.
    if (!isServer) process.exit(code);
  })
  .catch((err: unknown) => {
    // stderr lands in the host agent's MCP log; keep it useful.
    if (err instanceof MissingSessionError) {
      console.error(err.message);
    } else {
      const surface = isServer ? "server" : isSkill ? "skill" : "cli";
      console.error(
        `[trusty-squire] ${surface} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    process.exit(1);
  });
