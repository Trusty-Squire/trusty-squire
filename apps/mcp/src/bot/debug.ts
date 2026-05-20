// Debugging helpers — dumps a screenshot + HTML for each phase so failures
// are forensically reconstructible. Artifacts land in .debug/ (gitignored)
// unless UNIVERSAL_BOT_DEBUG_DIR is set.
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { BrowserController } from "./browser.js";

const DEBUG_DIR = process.env.UNIVERSAL_BOT_DEBUG_DIR ?? ".debug";
let ensured = false;

async function ensureDir(): Promise<void> {
  if (ensured) return;
  await mkdir(DEBUG_DIR, { recursive: true });
  ensured = true;
}

export async function saveDebugSnapshot(
  browser: BrowserController,
  step: string,
): Promise<void> {
  // Non-fatal by contract. Snapshots are forensic debug aids — they
  // must NEVER fail a signup run. Common failure mode: this function
  // is called right after a click that triggers navigation (OAuth
  // redirect, form submit), and page.content() / page.title() throw
  // "Execution context was destroyed" because the page is mid-nav.
  // That would otherwise abort the whole signup. Swallow + log.
  try {
    await ensureDir();
    const state = await browser.getState();
    const timestamp = Date.now();
    const base = `${timestamp}-${step}`;

    await writeFile(join(DEBUG_DIR, `${base}.png`), Buffer.from(state.screenshot, "base64"));
    await writeFile(join(DEBUG_DIR, `${base}.html`), state.html);

    // stderr only — see comment in index.ts. stdout is the MCP JSON-RPC transport.
    console.error(`[Debug] Saved snapshot: ${join(DEBUG_DIR, base)}`);
  } catch (err) {
    console.error(
      `[Debug] Snapshot ${step} skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
