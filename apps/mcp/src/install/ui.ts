// Rich-CLI helpers for the install/login/logout flow. Wraps chalk +
// ora + boxen behind a tiny API so the cli.ts call sites read like
// plain console output. All helpers gracefully degrade in non-TTY
// contexts:
//   - chalk.level is 0 → colour codes pass-through as plain text.
//   - ora detects !isTTY and renders a single line per "spinner"
//     transition (no escape sequences, no redraw).
//   - boxen still emits, but as plain ASCII art that scales to width.
//
// The MCP `server` command's stderr goes to the host agent's MCP log,
// which expects plain text. Bin.ts dispatches "server" before any of
// these helpers see argv, so this module is install-CLI-only by
// construction.

import boxen from "boxen";
import chalk from "chalk";
import ora, { type Ora } from "ora";

// Current terminal width (or 80 as a sane default for non-TTY pipes).
// Used to size boxen and any width-aware separators. boxen reads this
// internally too — passed explicitly so our overlays use the same
// value the CLI feels at print time.
export function termWidth(): number {
  return process.stdout.columns ?? 80;
}

// Bright cyan "▸" prefix — used to mark each top-level install step.
// Cyan (not blue) so it stays readable on both dark and light terminal
// themes; "▸" (not "→") because it renders consistently across
// monospace fonts that don't have wide-arrow glyphs.
export function step(label: string): void {
  console.warn(chalk.cyan("▸") + " " + label);
}

// Green-on-bold ✓. The mark a user wants to see after each long-
// running step finishes.
export function success(label: string): void {
  console.warn(chalk.green.bold("✓") + " " + label);
}

// Amber "⚠" — used for the ASN warning + post-install caveats. Amber
// rather than red so it doesn't read as "the install FAILED."
export function warn(label: string): void {
  console.warn(chalk.yellow("⚠") + " " + label);
}

// Red "✗" — for actual errors that abort the flow.
export function fail(label: string): void {
  console.warn(chalk.red.bold("✗") + " " + label);
}

// Plain "ℹ" prefix for informational lines that aren't a step.
export function info(label: string): void {
  console.warn(chalk.gray("ℹ") + " " + label);
}

// Render a boxed section. Used for the ASN warning and the VNC banner
// — the two pieces of output that need visual separation from the
// scrolling step list. boxen handles terminal width / wrapping.
export interface PanelOpts {
  title?: string;
  color?: "cyan" | "yellow" | "green" | "red" | "gray";
  align?: "left" | "center";
}
export function panel(body: string, opts: PanelOpts = {}): void {
  const borderColor = opts.color ?? "cyan";
  // boxen pads + draws box at the actual terminal width minus a margin,
  // so it reflows on resize. We pass `width` explicitly when the
  // terminal is narrower than 80 cols — boxen's default `Math.min(...)`
  // sometimes picks a width that wraps awkwardly.
  console.warn(
    boxen(body, {
      ...(opts.title !== undefined ? { title: opts.title, titleAlignment: "left" } : {}),
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor,
      ...(opts.align !== undefined ? { textAlignment: opts.align } : {}),
      width: Math.min(termWidth() - 2, 78),
    }),
  );
}

// Run an async task with a spinner. The spinner shows `start`; on
// success it converts to a green ✓ + `done` (or `start` if `done`
// isn't given); on failure it converts to a red ✗ + the error message.
// In non-TTY (e.g. piped output) ora prints each transition as its
// own line — same information, no escape sequences.
export async function withSpinner<T>(opts: {
  start: string;
  done?: string;
  fail?: (err: unknown) => string;
  task: () => Promise<T>;
}): Promise<T> {
  const spinner: Ora = ora({ text: opts.start, color: "cyan" }).start();
  try {
    const result = await opts.task();
    spinner.succeed(opts.done ?? opts.start);
    return result;
  } catch (err) {
    spinner.fail(
      opts.fail !== undefined
        ? opts.fail(err)
        : err instanceof Error
          ? err.message
          : String(err),
    );
    throw err;
  }
}

// Bold-bright headline. Used once at the very top of `install` so the
// user knows where they are.
export function heading(text: string): void {
  console.warn("");
  console.warn(chalk.bold.cyan(text));
  console.warn("");
}

// Italic gray hint line. Used under the heading and as the parting
// "Try it now…" suggestion.
export function hint(text: string): void {
  console.warn(chalk.dim(text));
}

// Plain emphasized URL — slightly underlined so terminals that
// recognize URL escape codes still let the user click. chalk's
// .underline is widely supported.
export function url(text: string): string {
  return chalk.cyan.underline(text);
}

// Plain key term — used inline in sentences. Slight bold so commands
// like `npx @trusty-squire/mcp install` stand out from prose.
export function code(text: string): string {
  return chalk.bold.white(text);
}
