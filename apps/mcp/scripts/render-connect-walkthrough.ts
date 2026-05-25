// Walkthrough renderer — produces the canonical visual output of
// `mcp connect` for README artifacts. Calls the same ui.ts helpers
// the real flow uses, so the rendered screencap matches production
// 1:1 (no drift between docs and reality).
//
// Usage (typically via freeze):
//   FORCE_COLOR=3 pnpm tsx scripts/render-connect-walkthrough.ts > /tmp/walk.ansi
//   freeze /tmp/walk.ansi --output apps/mcp/assets/connect-walkthrough.svg \
//     --background "#0d0d10" --window --theme "monokai"

import * as ui from "../src/install/ui.js";
import chalk from "chalk";

// Force a TTY-ish render so OSC 8 wraps and chalk emits truecolor.
// freeze runs us under a controlled pipe and we still want the wine
// to land. chalk.level=3 = truecolor (16M colors) — without this it
// downgrades hex to nearest 256-color, which turns wine #cf3a52
// into #d75f87.
chalk.level = 3;
process.stdout.isTTY = true;
process.stderr.isTTY = true;

function pause() {
  // No real pause in the rendered SVG; this is just a marker for the
  // human reader of this script.
}

// ── connect flow, faithful reproduction ──────────────────────────
ui.heading("Trusty Squire");
ui.hint("Setting up this machine.");
pause();

ui.success("Network detected");
ui.success("Machine token issued");
pause();

console.warn("");
console.warn(
  "You need to connect your Google and/or GitHub OAuth accounts to use Trusty Squire.",
);
ui.section(1, 2, "Connect Google");
ui.panel(
  `Open this URL to sign in and confirm:\n\n  ${ui.link(
    "https://vnc.trustysquire.ai/?p=k7m2x8q9p4r",
  )}`,
  { color: "wine", title: "sign in" },
);

ui.success("Session saved (keytar)");
ui.success("Wrote Cursor MCP config at ~/Library/.../mcp.json");
pause();

console.warn("");
ui.hint(
  "Some services are GitHub-only (Railway, Vercel, parts of Cloudflare).",
);
ui.section(2, 2, "Connect GitHub");
// Show the prompt with a sample answer
console.warn(`Add GitHub? [Y/n] ${chalk.bold("y")}`);
console.warn("Opening browser for GitHub sign-in…");
ui.success("GitHub session added.");
pause();

ui.divider();
ui.panel(
  `Squire on duty. Restart Cursor to pick up the new tools.\n\n` +
    `Try it — ask your agent: ${ui.code(`"sign me up for Resend"`)}`,
  { color: "wine" },
);
