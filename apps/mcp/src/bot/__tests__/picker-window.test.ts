import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import {
  captureScreenshot,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { operateClickTool } from "../../tools/provision-drive.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const option = `<button id="country" onclick="choose()">Canada</button>`;
const form = (mode: string) => `<!doctype html><title>Country of issue</title>
<label>Country of issue <input id="select_country_name_pc" placeholder="Select the country name" readonly></label>
<input id="select" type="button" value="Select" onclick="openPicker()">
<script>
function openPicker() {
  ${
    mode === "popup"
      ? `window.open('/picker', 'country-picker', 'width=500,height=400');`
      : `
  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-label', 'Choose country');
  modal.style = 'position:fixed;inset:0;background:white;z-index:10';
  modal.innerHTML = ${JSON.stringify(option)};
  document.body.append(modal);`
  }
}
function choose() { document.querySelector('#select_country_name_pc').value = 'Canada'; document.querySelector('[role=dialog]').remove(); }
</script>`;

function ref(response: unknown, name: string): string {
  if (
    typeof response !== "object" ||
    response === null ||
    !("safe_table" in response) ||
    !Array.isArray(response.safe_table)
  ) {
    throw new Error(`Missing control table: ${JSON.stringify(response)}`);
  }
  const row = response.safe_table.find(
    (row: unknown) => Array.isArray(row) && row[2]?.split("|")[0] === name,
  );
  if (!row || typeof row[0] !== "string")
    throw new Error(`Missing ${name}: ${JSON.stringify(response)}`);
  return row[0];
}

it.each([
  { mode: "popup", screenshot: false },
  { mode: "modal", screenshot: false },
  { mode: "popup", screenshot: true },
  { mode: "modal", screenshot: true },
])(
  "sets a readonly country through $mode picker (screenshot=$screenshot)",
  async ({ mode, screenshot }) => {
    const context = await browser.newContext();
    let sessionId: string | undefined;
    try {
      await context.route("https://picker.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            new URL(route.request().url()).pathname === "/picker"
              ? `<!doctype html><title>Choose country</title>${option}<script>function choose() { window.opener.document.querySelector('#select_country_name_pc').value = 'Canada'; window.close(); }</script>`
              : form(mode),
        }),
      );
      const sibling = await context.newPage();
      const owner = BrowserController.fromHarnessPage(sibling);
      const controller = await BrowserController.attachSatellite(owner, { humanize: false });
      const page = controller.activePage();
      if (page === null) throw new Error("No session page");
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://picker.test/form",
        observationFormat: "browser-use-dom",
        format: "compact",
      });
      sessionId = started.session_id;
      const before = await page.locator("body").innerHTML();
      const clicked = await operateClickTool.handler(
        { session_id: sessionId, ref: ref(started, "@select") },
        null,
      );
      if (mode === "popup") {
        expect(await page.locator("body").innerHTML()).toBe(before);
        expect(controller.activePage()).not.toBe(page);
        expect(controller.currentUrl()).toBe("https://picker.test/picker");
      } else {
        expect(controller.activePage()).toBe(page);
        expect(await page.locator("[role=dialog]").isVisible()).toBe(true);
      }
      expect(await page.locator("#select_country_name_pc").getAttribute("readonly")).not.toBeNull();
      const shot = await captureScreenshot(sessionId);
      expect(shot.url).toBe(
        mode === "popup" ? "https://picker.test/picker" : "https://picker.test/form",
      );
      expect(Buffer.from(shot.image.data_base64, "base64").length).toBeGreaterThan(100);
      const pickerPage = controller.activePage();
      if (pickerPage === null) throw new Error("No picker page");
      const box = await pickerPage.locator("#country").boundingBox();
      if (box === null || !shot.click_binding) throw new Error("Missing screenshot target");
      const selected = await operateClickTool.handler(
        {
          session_id: sessionId,
          ...(screenshot
            ? {
                screenshot: {
                  screenshot_id: shot.click_binding.screenshot_id,
                  x: box.x + box.width / 2,
                  y: box.y + box.height / 2,
                },
              }
            : { ref: ref(clicked, "@canada") }),
          format: "full",
        },
        null,
      );
      expect(selected).toMatchObject({ url: "https://picker.test/form" });
      expect(selected).toHaveProperty("dom", expect.stringContaining("Canada"));
      expect(await page.locator("#select_country_name_pc").inputValue()).toBe("Canada");
      const returned = await observe(sessionId, "full");
      expect(returned.url).toBe("https://picker.test/form");
      expect(controller.activePage()).toBe(page);
      expect((await captureScreenshot(sessionId)).url).toBe("https://picker.test/form");
      // Finish must close a picker left open, as well as its form, without
      // closing another session's page in the shared context.
      const fresh = await observe(sessionId, "compact");
      await operateClickTool.handler({ session_id: sessionId, ref: ref(fresh, "@select") }, null);
      const family = context.pages().filter((candidate) => candidate !== sibling);
      await finishProvisionSession(sessionId);
      sessionId = undefined;
      expect(family.every((candidate) => candidate.isClosed())).toBe(true);
      expect(sibling.isClosed()).toBe(false);
      await owner.close();
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  },
  30_000,
);

it("returns to creation-time ancestors without adopting a sibling or foreign page", async () => {
  const context = await browser.newContext();
  try {
    const root = await context.newPage();
    const controller = BrowserController.fromHarnessPage(root);
    const open = async (parent: Page) => {
      const next = parent.waitForEvent("popup");
      await parent.evaluate(() => window.open("about:blank"));
      return await next;
    };
    const picker = await open(root);
    const nested = await open(picker);
    await nested.setContent("<p>Nested picker</p>");
    // A nonblank URL avoids the blank-document adoption grace period.
    await nested.goto("data:text/html,Nested picker");
    await controller.adoptOpenedTab();
    const sibling = await open(root);
    const foreign = await context.newPage();
    await nested.close();
    expect(controller.returnFromClosedPopup(nested)).toBe(picker);
    expect(controller.returnFromClosedPopup(nested)).toBe(picker);
    expect(controller.activePage()).not.toBe(sibling);
    await picker.close();
    expect(controller.returnFromClosedPopup(picker)).toBe(root);
    await root.close();
    expect(controller.returnFromClosedPopup(root)).toBeNull();
    expect(controller.activePage()).not.toBe(foreign);
    await controller.close();
  } finally {
    await context.close();
  }
});
