import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  captureFrameSnapshot,
  driveRowsFromSnapshot,
  snapshotSelectOptions,
} from "../drive-snapshot.js";
import {
  driveTargetSets,
  resumeAction,
  resumeAnswerOptions,
  runOperateDrive,
  type DriveDependencies,
} from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const PRODUCT_URL = "https://ouraring.com/ja/store/rings/oura-ring-4/silver?size=8";
const CART_URL = "https://ouraring.com/ja/cart";
const GOAL = "Buy a Silver Oura Ring 4 in size 8 and proceed to checkout";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

async function openFixture(url: string, html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  const snapshot = await captureFrameSnapshot(page, [], 0, true);
  if (snapshot === null) throw new Error("drive snapshot missing");
  const rows = driveRowsFromSnapshot(snapshot);
  return { context, page, snapshot, rows };
}

describe("drive commerce fixtures", () => {
  it("offers the Oura size radio and below-fold Add to Cart with readable labels", async () => {
    const f = await openFixture(PRODUCT_URL, fixture("oura-product.html"));
    try {
      const sets = driveTargetSets(
        f.rows,
        { size: "8" },
        false,
        [],
        PRODUCT_URL,
        snapshotSelectOptions(f.snapshot),
        undefined,
        [],
        { goal: GOAL },
      );
      expect(sets.CLICK.map((candidate) => candidate.row[2])).toEqual(
        expect.arrayContaining([
          expect.stringContaining("サイズを選択"),
          expect.stringContaining("カートに追加"),
        ]),
      );
      const options = resumeAnswerOptions(f.rows, { size: "8" }, GOAL, false, PRODUCT_URL);
      expect(Object.values(options)).toContain("サイズを選択");
      expect(Object.values(options)).toContain("カートに追加");
      const sizeKey = Object.keys(options).find((key) => options[key] === "サイズを選択");
      expect(sizeKey).toBeDefined();
      expect(
        resumeAction(sizeKey!, f.rows, { size: "8" }, GOAL, undefined, PRODUCT_URL),
      ).toMatchObject({ kind: "act", action: { kind: "click" } });
      const controller = BrowserController.fromHarnessPage(f.page);
      await controller.click({ kind: "selector", selector: "#choose-size", method: "click" });
      expect(await f.page.locator("#choose-size").isChecked()).toBe(true);
      expect(await f.page.locator("#sizes").isVisible()).toBe(true);
      await controller.click({ kind: "selector", selector: "#add", method: "click" });
      expect(await f.page.locator("[data-cy=nav-cart-button]").textContent()).toBe(
        "カート内に商品が1個あります",
      );
    } finally {
      await f.context.close();
    }
  }, 30_000);

  it("offers the cart checkout CTA ahead of cart status text", async () => {
    const f = await openFixture(CART_URL, fixture("oura-cart.html"));
    try {
      const options = resumeAnswerOptions(f.rows, {}, GOAL, false, CART_URL);
      const checkoutKey = Object.keys(options).find(
        (key) => options[key] === "チェックアウトに進む",
      );
      expect(checkoutKey).toBeDefined();
      expect(resumeAction(checkoutKey!, f.rows, {}, GOAL, undefined, CART_URL)).toMatchObject({
        kind: "act",
        action: { kind: "click" },
      });
    } finally {
      await f.context.close();
    }
  }, 30_000);

  it("resumes an invalid-answer handback on the offered checkout link after a sibling is inserted", async () => {
    const f = await openFixture(CART_URL, fixture("oura-cart.html"));
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: BrowserController.fromHarnessPage(f.page),
        serviceUrl: CART_URL,
        format: "compact",
        initialObservation: "drive",
      });
      sessionId = started.session_id;
      const deps: DriveDependencies = {
        askJev: async () => ({
          result: { answers: { operation: { choice: "CLICK", confidence: 0.9 } } },
          attempts: 1,
          elapsedMs: 1,
        }),
        act,
        observe,
        awaitVerification,
        startSession: async () => {
          throw new Error("existing session required");
        },
        injectCard: async () => ({ status: "unused" }),
      };
      const api = {} as ApiClient;
      const handback = await runOperateDrive(
        { session_id: sessionId, goal: GOAL },
        api,
        undefined,
        deps,
      );
      expect(handback.status).toBe("invalid_answer");
      expect(handback.options).not.toHaveProperty("CLICK");
      const key = Object.keys(handback.options ?? {}).find(
        (option) => handback.options?.[option] === "チェックアウトに進む",
      );
      expect(key).toBeDefined();
      await f.page.evaluate(() => {
        const decoy = document.createElement("a");
        decoy.textContent = "チェックアウトに進む";
        decoy.href = "/wrong";
        document.querySelector("main")!.prepend(decoy);
      });
      const resumed = await runOperateDrive(
        { session_id: sessionId, goal: GOAL, answer: key!, max_steps: 1 },
        api,
        undefined,
        deps,
      );
      expect(resumed.status).not.toBe("invalid_answer");
      expect(f.page.url()).toBe("https://ouraring.com/ja/checkout");
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await f.context.close();
    }
  }, 30_000);
});
