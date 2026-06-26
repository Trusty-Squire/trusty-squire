// Arg parsing + dispatch for `ts-housekeeper`. The verify loop itself lives in
// scheduler.ts (Phase 3); this is the thin entry that parses flags and config.

import { loadConfig } from "./config.js";

const HELP = `ts-housekeeper — codex-driven registry verify scheduler

Usage:
  ts-housekeeper [--once] [--dry]

  --once   Run a single verify pass and exit (default: loop on the timer).
  --dry    Drive codex + classify outcomes, but do NOT post promote/demote.
  --help   Show this help.

The loop pulls skills from the registry, asks codex (via the @next Trusty
Squire MCP) to reproduce each signup, and reports the boolean outcome. The
registry applies the mechanical rule: one success promotes, >3 real failures
demote.

Env: TRUSTY_SQUIRE_REGISTRY_URL, REGISTRY_ADMIN_BEARER, HOUSEKEEPER_CODEX_CMD,
HOUSEKEEPER_MAX_SKILLS_PER_RUN, HOUSEKEEPER_PROMOTE_MIN_SUCCESSES.
`;

export interface CliArgs {
  once: boolean;
  dry: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  return {
    once: argv.includes("--once"),
    dry: argv.includes("--dry"),
  };
}

export async function runHousekeeperCli(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const args = parseArgs(argv);
  const config = loadConfig();
  // Phase 3 wires runVerify(config, args) here.
  process.stdout.write(
    `housekeeper verify (once=${String(args.once)} dry=${String(args.dry)}) → ` +
      `registry ${config.registryUrl}\n` +
      `[scheduler not yet implemented — Phase 3]\n`,
  );
}
