// Rich-CLI helpers for the install/login/logout flow. Mirrors the
// product design system (docs/DESIGN.md) in terminal terms:
// dark-first, ruthless simplicity, ONE accent (wine #cf3a52),
// semantic colors for status, terse voice.
//
// All helpers gracefully degrade in non-TTY contexts:
//   - chalk auto-detects color support; .hex() falls back to nearest
//     256-color, then 16-color, then plain text.
//   - progress prints durable lines on stderr, including in piped logs.
//   - panels use the same light linework as clack's note primitive.
//   - OSC 8 hyperlink wrapping is gated on isTTY — pipes / logs get
//     plain text, no garbage escape codes.
//
// The MCP `server` command's stderr goes to the host agent's MCP log,
// which expects plain text. Bin.ts dispatches "server" before any of
// these helpers see argv, so this module is install-CLI only by
// construction.

import chalk from "chalk";

// Wine — the single brand accent from the PWA design system. Used on
// links, primary CTAs, focus, and at most one focal figure per view.
// On 256-color terminals chalk maps this to the nearest red; on 24-bit
// (modern macOS Terminal / iTerm2 / Alacritty / kitty / gnome-terminal
// / Windows Terminal) it renders exact.
const WINE = "#cf3a52";

// Inline accent (wine). Use for keywords, numbers, anything the eye
// should land on. Keep usage rare — the accent's job is contrast.
export function accent(text: string): string {
  return chalk.hex(WINE)(text);
}

export function accentBold(text: string): string {
  return chalk.hex(WINE).bold(text);
}

// Current terminal width (or 80 as a sane default for non-TTY pipes).
export function termWidth(): number {
  return process.stdout.columns ?? 80;
}

// Wine "▸" prefix — top-level step in a flow. The mark anchors the
// eye to the start of each step; the wine carries the brand.
export function step(label: string): void {
  console.warn(accent("▸") + " " + label);
}

// Bold green ✓ — the unmistakable "this finished cleanly" mark.
// Semantic, not brand: stays green so the user reads it as success
// regardless of theme or terminal palette.
export function success(label: string): void {
  console.warn(chalk.green.bold("✓") + " " + label);
}

// Amber ⚠ — non-fatal caveat (ASN warning, post-install advisory).
// Yellow, not red, so it doesn't read as "the install FAILED."
export function warn(label: string): void {
  console.warn(chalk.yellow("⚠") + " " + label);
}

// Red ✗ — an actual error that abort the flow.
export function fail(label: string): void {
  console.warn(chalk.red.bold("✗") + " " + label);
}

// Dim ℹ — secondary informational line. Sits visually under the
// step prefix without competing for attention.
export function info(label: string): void {
  console.warn(chalk.dim("ℹ") + " " + label);
}

// Hairline divider — dim em-dash run across the terminal width.
// Used between major sections (preflight → steps → outro) to give
// the eye a stopping point without adding ornament.
export function divider(): void {
  const w = Math.max(20, termWidth() - 2);
  console.warn(chalk.dim("─".repeat(w)));
}

// Render a clack-style note on stderr so --json keeps stdout machine-only.
// Default border is wine; pass color: 'dim' for an inert/contextual
// panel.
export interface PanelOpts {
  title?: string;
  // 'wine' = brand accent (default — focal panels)
  // 'dim'  = hairline only (contextual / advisory panels)
  // semantic: 'yellow' / 'red' for warn / fail
  color?: "wine" | "dim" | "yellow" | "red";
  align?: "left" | "center";
}
export function panel(body: string, opts: PanelOpts = {}): void {
  const lines = body.split("\n");
  console.warn([`┌  ${opts.title ?? ""}`, ...lines.map((line) => `│  ${line}`), "└"].join("\n"));
}

// Durable clack-style progress lines keep long broker and network waits
// visible even in a log or when a terminal does not support redraws.
export async function withSpinner<T>(opts: {
  start: string;
  done?: string;
  fail?: (err: unknown) => string;
  task: () => Promise<T>;
}): Promise<T> {
  step(opts.start);
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed += 3;
    info(`${opts.start}… ${elapsed}s`);
  }, 3_000);
  try {
    const result = await opts.task();
    success(opts.done ?? opts.start);
    return result;
  } catch (err) {
    fail(
      opts.fail !== undefined ? opts.fail(err) : err instanceof Error ? err.message : String(err),
    );
    throw err;
  } finally {
    clearInterval(ticker);
  }
}

// Top-line heading. Bold wine — the brand presence per the design
// system's "logo + voice" carry rule. One blank line above, one
// below, so the heading floats clear of the surrounding text.
export function heading(text: string): void {
  console.warn("");
  console.warn(accentBold(text));
  console.warn("");
}

// Numbered section header — Linear-style. Use for multi-step flows:
// `section(1, 2, "Account")` → " 1/2 · Account" with the number in
// wine. Reads cleaner than the prior "▸ Step 1/2 — Account" form
// without losing the step locator.
export function section(n: number, total: number, label: string): void {
  console.warn("");
  console.warn(`${accentBold(`${n}/${total}`)} · ${chalk.bold(label)}`);
}

// Italic-dim hint line — sits at half-attention. Use for the
// `Pass --force-relogin if…` tail and the parting `Try it now…`.
export function hint(text: string): void {
  console.warn(chalk.dim(text));
}

// OSC 8 hyperlink. Modern terminals (iTerm2, gnome-terminal,
// Windows Terminal, kitty, Alacritty since 0.11, vscode integrated
// terminal) render `label` as cmd/ctrl-clickable; legacy terminals
// strip the escape codes and just print `label`. On a non-TTY
// (pipe / log file) we skip the escapes entirely and print the
// raw URL — copy-paste in logs is fine.
export function link(url: string, label?: string): string {
  const text = label ?? url;
  if (!process.stdout.isTTY) {
    // For non-TTY consumers (CI logs, pipes), printing the raw URL is
    // strictly more useful than an underlined label.
    return label !== undefined ? `${label} (${url})` : url;
  }
  // OSC 8 sequence: \x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\
  // The label is still wine-underlined so terminals that DON'T
  // honor OSC 8 (e.g. raw xterm) still visually signal a link.
  const styled = chalk.hex(WINE).underline(text);
  return `\x1b]8;;${url}\x1b\\${styled}\x1b]8;;\x1b\\`;
}

// Plain key term — used inline in prose. Bold white so commands
// like `npx @trusty-squire/mcp connect` stand out from surrounding
// text without competing with the wine accent.
export function code(text: string): string {
  return chalk.bold.white(text);
}
