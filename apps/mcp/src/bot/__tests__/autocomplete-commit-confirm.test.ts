// Tests for BrowserController.confirmAutocompleteCommitted (3.1's "did it
// commit" positive-confirmation check) against a REAL Chromium page — the
// same-selector-value check alone was already covered by the mocked
// operate-session-flow suite, but the nearby-element scan it was broadened
// to (gate-decision.md, round 1) can only be proven against real DOM: does
// it correctly find a genuine value-display element, and does it correctly
// IGNORE a still-open, never-really-clicked suggestion popup's own option
// text (gate-decision-2.md finding confirm-commit-false-positive-from-open-
// popup) — the exact false-positive the hard "never assume success"
// constraint exists to prevent.
//
// Synthetic fixtures only — no real credentials, no network.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";

let browser: Browser;

async function pageFor(html: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.setContent(html);
  const ctrl = new BrowserController({ humanize: false });
  // Same private-field injection pattern as phone-country-widget.test.ts —
  // start() does profile/network setup unsuitable for a unit test; run the
  // REAL methods against a directly-launched page instead.
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

describe("confirmAutocompleteCommitted — real Chromium fixtures", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("confirms from a genuine nearby value-display element (react-select-style: search input stays empty)", async () => {
    const { ctrl, page } = await pageFor(`
      <div class="control">
        <input id="search" value="">
        <div class="single-value">Wireless Mouse</div>
      </div>
    `);
    try {
      expect(await ctrl.confirmAutocompleteCommitted("#search", "Wireless Mouse")).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);

  it("does NOT confirm from a still-open, un-really-clicked suggestion popup's own option text", async () => {
    // The popup and its option carry the SAME tracking markers
    // detectTypeSuggestionPopup/commitTypeSuggestion set — simulating a
    // commitTypeSuggestion click that didn't actually register with the
    // widget, leaving the popup open with the option's text unchanged.
    // Without excluding tracked-popup markers, the option's own text
    // (which trivially equals pickedOptionText, since that's where it came
    // from) would satisfy the nearby-element scan every time.
    const { ctrl, page } = await pageFor(`
      <div class="control">
        <input id="search" value="Wireless">
        <div role="listbox" data-ts-select-popup="1">
          <div role="option" data-ts-select-option-tier="0">Wireless Mouse</div>
        </div>
      </div>
    `);
    try {
      expect(await ctrl.confirmAutocompleteCommitted("#search", "Wireless Mouse")).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it("still confirms a genuine value-display element even after a tracked popup is present elsewhere nearby", async () => {
    // The popup is still open (not yet dismissed by the caller's finally),
    // but the widget ALSO already rendered its own committed-value display
    // outside the tracked popup — the exclusion must not blind the scan to
    // a real signal just because a stale popup marker exists nearby too.
    const { ctrl, page } = await pageFor(`
      <div class="control">
        <input id="search" value="">
        <div class="single-value">Wireless Mouse</div>
        <div role="listbox" data-ts-select-popup="1">
          <div role="option" data-ts-select-option-tier="0">Wireless Keyboard</div>
        </div>
      </div>
    `);
    try {
      expect(await ctrl.confirmAutocompleteCommitted("#search", "Wireless Mouse")).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not confirm when nothing on the page matches (a genuine miss)", async () => {
    const { ctrl, page } = await pageFor(`
      <div class="control">
        <input id="search" value="Wireless">
      </div>
    `);
    try {
      expect(await ctrl.confirmAutocompleteCommitted("#search", "Wireless Mouse")).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);
});
