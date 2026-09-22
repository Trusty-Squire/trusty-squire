// Real-browser regression for the drive's pre-act row digest.
//
// The digest is the drive's early exit: it asks whether the page changed
// between the snapshot that produced a decision and the act. A navigation can
// redraw a control in place — same node, same role, still enabled — and change
// only what it says, turning a link that read one thing into a link that reads
// another. Role, disabled and checked alone cannot see that; the accessible
// label is the part that catches it. The label must also be normalised the way
// the act-time identity comparison already compares it (whitespace collapsed,
// trimmed, case-folded) so a benign re-spelling does not churn the digest into
// a wasted re-decide.

import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveControlDigest } from "../drive-act.js";
import { captureFrameSnapshot } from "../drive-snapshot.js";

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

async function snapshotPage(html: string): Promise<Page> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const page = await browser.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  await captureFrameSnapshot(page, [], 0, false);
  return page;
}

describe("drive row digest", () => {
  it.skipIf(!available)(
    "changes when the same node, role and enabled state change their text",
    async () => {
      const page = await snapshotPage(
        `<!doctype html><meta charset="utf-8"><title>digest</title>
         <main><a id="go" href="/checkout">View cart</a></main>`,
      );
      const before = await driveControlDigest(page);
      expect(before).toContain("view cart");
      // Same node, same role, still enabled: only the visible text changes.
      await page.evaluate(() => {
        const link = document.querySelector("#go");
        if (link === null) throw new Error("link missing");
        (window as unknown as { __digestNode?: Element }).__digestNode = link;
        link.textContent = "Continue to payment";
      });
      const after = await driveControlDigest(page);
      expect(after).not.toBe(before);
      expect(after).toContain("continue to payment");
      // The node the changed digest describes is still the snapshot's node.
      const same = await page.evaluate(() => {
        const node = (window as unknown as { __digestNode?: Element }).__digestNode;
        return node === document.querySelector("#go") && node.isConnected;
      });
      expect(same).toBe(true);
    },
  );

  it.skipIf(!available)(
    "ignores a whitespace or casing re-spelling of the same label",
    async () => {
      const page = await snapshotPage(
        `<!doctype html><meta charset="utf-8"><title>digest</title>
         <main><a id="go" href="/checkout">View cart</a></main>`,
      );
      const before = await driveControlDigest(page);
      await page.evaluate(() => {
        document.querySelector("#go")!.textContent = "  view    CART ";
      });
      expect(await driveControlDigest(page)).toBe(before);
    },
  );

  it.skipIf(!available)(
    "changes when a link's accessible name changes through aria-label",
    async () => {
      const page = await snapshotPage(
        `<!doctype html><meta charset="utf-8"><title>digest</title>
         <main><a id="go" href="/checkout" aria-label="View cart">x</a></main>`,
      );
      const before = await driveControlDigest(page);
      await page.evaluate(() => {
        document.querySelector("#go")!.setAttribute("aria-label", "Checkout now");
      });
      const after = await driveControlDigest(page);
      expect(after).not.toBe(before);
      expect(after).toContain("checkout now");
    },
  );

  it.skipIf(!available)(
    "ignores a countdown or live counter ticking on an unchanged control",
    async () => {
      // The decision this digest guards takes seconds, so a control that counts
      // down on its own ("Resend code in 29s") changes on every step. With
      // pre-act re-decides unbounded, a digest that moved on each tick would
      // spend the whole step budget re-deciding and never act.
      const page = await snapshotPage(
        `<!doctype html><meta charset="utf-8"><title>digest</title>
         <main><button id="resend">Resend code in 29s</button></main>`,
      );
      const before = await driveControlDigest(page);
      await page.evaluate(() => {
        document.querySelector("#resend")!.textContent = "Resend code in 28s";
      });
      expect(await driveControlDigest(page)).toBe(before);
      expect(before).toContain("resend code in #s");
    },
  );

  it.skipIf(!available)("is stable across repeated reads of an unchanged page", async () => {
    const controls = Array.from(
      { length: 120 },
      (_, i) => `<a href="/n${i}">Link ${i}</a><button>Button ${i}</button>`,
    ).join("");
    const page = await snapshotPage(
      `<!doctype html><meta charset="utf-8"><title>digest</title><main>${controls}</main>`,
    );
    expect(await driveControlDigest(page)).toBe(await driveControlDigest(page));
  });
});
