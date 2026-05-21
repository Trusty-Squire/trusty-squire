// T30 — Error taxonomy for the skill CLI.
//
// Distinct exit codes per failure class so scripting against the CLI
// is reliable (e.g. CI pipelines can `if skill show ...; rc=$?; case
// $rc in 67) handle_not_found ;;`).
//
// The numbers leave room for future categories (e.g. 70-79 reserved
// for auth/credential issues). 0-2 follow Unix convention; 64-69 use
// sysexits.h-style classes the broader gstack CLIs already share.

export const ExitCode = {
  /** Success. */
  OK: 0,
  /** Generic unexpected failure. */
  GENERIC: 1,
  /** Bad arguments (missing/unknown flag, parse error). */
  ARGS: 2,
  /** Usage problem — unknown subcommand. */
  USAGE: 64,
  /** Config missing (e.g. TRUSTY_SQUIRE_REGISTRY_URL unset). */
  CONFIG: 65,
  /** Registry unreachable, timed out, or 5xx. */
  UNAVAILABLE: 66,
  /** Resource not found (404). */
  NOT_FOUND: 67,
  /** Auth rejected (401/403). */
  FORBIDDEN: 68,
  /** Validation failed (400). */
  VALIDATION: 69,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

/**
 * Thrown by CLI subcommand handlers to signal a graceful exit with a
 * specific exit code. The top-level dispatcher catches these and
 * translates to `process.exit(code)` — no stack traces, no noise.
 *
 * NEVER instantiate with ExitCode.GENERIC + an unknown error; use it
 * to surface known failure classes only. Unhandled errors propagate
 * up to the bin.ts catch-all, which logs the stack and exits 1.
 */
export class CliExit extends Error {
  constructor(
    public readonly code: ExitCodeValue,
    message: string,
  ) {
    super(message);
    this.name = "CliExit";
  }
}
