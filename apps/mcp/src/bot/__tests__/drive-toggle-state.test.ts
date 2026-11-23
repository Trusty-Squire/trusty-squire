// Real-browser regression for toggle state. Perch account settings
// (squire-1.1.61 L69432-L69438) has a "Toggle Starter Data Program" button
// with aria-pressed="false": its row carried no state, so the drive could not
// tell whether the program was on, and stalled at 0.14.

import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";
import { driveTargetSets, elementState } from "../operate-drive.js";

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

describe("toggle state reaches the row", () => {
  it.skipIf(!available)(
    "states on and off for pressed buttons, switches and checkboxes",
    async () => {
      if (browser === undefined) throw new Error("Chromium unavailable");
      const page = await browser.newPage();
      try {
        await page.goto(
          `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
        <div role="dialog" aria-label="Settings"><h2>Privacy</h2>
          <button type="button" aria-pressed="false" aria-label="Toggle Starter Data Program"></button>
          <button type="button" aria-pressed="true">Bold</button>
          <button type="button" role="switch" aria-checked="false">Dark mode</button>
          <label><input type="checkbox" role="switch" checked> Email updates</label>
          <label><input type="checkbox"> Remember me</label>
          <button type="button">Save</button>
        </div>`)}`,
        );
        const snapshot = await captureFrameSnapshot(page, [], 0, false);
        if (snapshot === null) throw new Error("no snapshot");
        const rows = driveRowsFromSnapshot(snapshot);
        const facts = (label: string) => rows.find((row) => row[2]?.startsWith(label))?.[2] ?? "";
        expect(facts("Toggle Starter Data Program")).toMatch(/(?:^|\|)s=u(?:\||$)/);
        expect(facts("Bold")).toMatch(/(?:^|\|)s=c(?:\||$)/);
        expect(facts("Dark mode")).toMatch(/(?:^|\|)s=u(?:\||$)/);
        expect(facts("Email updates")).toMatch(/(?:^|\|)s=c(?:\||$)/);
        expect(facts("Remember me")).toMatch(/(?:^|\|)s=u(?:\||$)/);
        expect(facts("Save")).not.toMatch(/(?:^|\|)s=/);
        // The decider's element list says the program is off.
        const url = page.url();
        const toggle = driveTargetSets(rows, {}, false, [], url).CLICK.find((candidate) =>
          candidate.row[2]?.startsWith("Toggle Starter Data Program"),
        );
        expect(toggle).toBeDefined();
        expect(elementState(toggle!).checked).toBe(false);
      } finally {
        await page.close();
      }
    },
  );
});
