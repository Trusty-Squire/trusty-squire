// Real-browser regression for identically labeled controls. Pollinations /keys
// (squire-1.1.61 L1) renders one card per key, each with an icon-only "Edit
// secret key" and "Delete secret key" whose names carry no key name, and the
// cards are plain divs, not table rows or list items. The drive must still say
// which key each button belongs to.

import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let browser: Browser | undefined;

beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

async function rowsOf(html: string): Promise<Array<[string, string, string?]>> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const page = await browser.newPage();
  try {
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const snapshot = await captureFrameSnapshot(page, [], 0, false);
    if (snapshot === null) throw new Error("no snapshot");
    return driveRowsFromSnapshot(snapshot);
  } finally {
    await page.close();
  }
}

const card = (name: string, prefix: string, created: string) => `
  <div class="surface">
    <div class="header">
      <span class="sr-only">Secret key</span><span class="title">${name}</span>
      <span class="actions">
        <button type="button" title="Edit secret key" aria-label="Edit secret key">✎</button>
        <button type="button" title="Delete secret key" aria-label="Delete secret key">✕</button>
      </span>
    </div>
    <div><code>${prefix}…</code></div>
    <div><span>Created: </span><span>${created}</span> <span>Used: </span><span>never</span></div>
  </div>`;

describe("identically labeled controls carry their row", () => {
  it.skipIf(!available)("names the key card of each Edit and Delete button", async () => {
    const rows = await rowsOf(
      `<!doctype html><meta charset="utf-8"><main><h1>Keys</h1>
       <button type="button">Create</button>
       ${card("grunt-free-pollinations", "sk_8Qm", "2d")}
       ${card("Default", "sk_Zt4", "9d")}
       </main>`,
    );
    const facts = (label: string) =>
      rows.filter((row) => row[2]?.startsWith(`${label}|`)).map((row) => row[2]);
    expect(facts("Edit secret key")).toEqual([
      "Edit secret key|ctx=grunt-free-pollinations sk_8Qm… 2d",
      "Edit secret key|ctx=Default sk_Zt4… 9d",
    ]);
    expect(facts("Delete secret key")).toEqual([
      "Delete secret key|ctx=grunt-free-pollinations sk_8Qm… 2d",
      "Delete secret key|ctx=Default sk_Zt4… 9d",
    ]);
    // A control without a twin is unchanged.
    expect(rows.find((row) => row[2] === "Create")).toBeDefined();
  });

  it.skipIf(!available)("leaves twins alone when their rows read the same", async () => {
    const rows = await rowsOf(
      `<!doctype html><meta charset="utf-8"><main>
       <div><p>Key</p><button type="button">Copy</button></div>
       <div><p>Key</p><button type="button">Copy</button></div></main>`,
    );
    expect(rows.filter((row) => row[2] === "Copy")).toHaveLength(2);
  });
});
