import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
      const controller = await BrowserController.attachSessionPage(owner, { humanize: false });
      const page = controller.activePage();
      if (page === null) throw new Error("No session page");
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://picker.test/form",
        format: "compact",
      });
      sessionId = started.session_id;
      const evidenceDir = process.env.PICKER_TEST_EVIDENCE_DIR;
      const evidencePrefix = `${mode}-${screenshot ? "coordinate" : "ref"}`;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: join(evidenceDir, `${evidencePrefix}-before.png`) });
      }
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
      if (evidenceDir) {
        await writeFile(
          join(evidenceDir, `${evidencePrefix}-picker.png`),
          Buffer.from(shot.image.data_base64, "base64"),
        );
      }
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
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `${evidencePrefix}-after.png`) });
        await writeFile(
          join(evidenceDir, `${evidencePrefix}-responses.json`),
          JSON.stringify(
            {
              fixture:
                "Local reproduction of a readonly country field with a click-triggered picker; not the live JAF site",
              mode,
              input: screenshot ? "screenshot coordinates" : "element reference",
              started,
              opened: clicked,
              selected,
              returned,
              countryValue: await page.locator("#select_country_name_pc").inputValue(),
            },
            null,
            2,
          ),
        );
      }
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

it("reports a picker window closed during the click as dispatched and returns to the opener", async () => {
  // The production pattern: clicking a picker option runs the picker's own
  // handler (record the selection, window.close()) and the picker window is
  // torn down while the click dispatch is still completing — then the click
  // tool reported `action_failed: page.click: Target page, context or browser
  // has been closed` instead of success, and the documented close-picker
  // recovery never ran (~1/40 locally, 12/60 on a slower runner).
  //
  // The natural race cannot be forced deterministically: a renderer-side
  // window.close() handshake waits for the renderer, so it can never beat the
  // input ack that the same DOM task queues (measured: every renderer-side
  // close variant — mousedown/onclick close, busy-wait stalls, an exposed
  // binding calling page.close() mid-click — resolved the click, and the
  // teardown that does beat the ack needs a renderer-killing crash, whose
  // target is not "closed"). The fixture therefore reproduces the exact
  // failure signature deterministically by tearing the picker window down
  // from the browser side the moment the tracked click has installed its
  // dispatch listener (the __trustySquireClickDispatch marker), while
  // Playwright's click is still inside its multi-frame actionability phase.
  // page.click then rejects with the same TargetClosedError the production
  // race produces, for a click whose dispatch listener was installed on a
  // now-closed picker window. The picker's own handler still records the
  // selection before any close, so the branch where the input does win the
  // timing behaves like the real self-close too. Without the fix the click
  // surfaces as action_failed with no close-picker recovery; with it the
  // dispatch is reported and the post-click observation returns to the
  // opener.
  const context = await browser.newContext();
  let sessionId: string | undefined;
  try {
    await context.route("https://picker.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/picker"
            ? `<!doctype html><title>Choose country</title>
               <button id="country" onclick="pick()">Canada</button>
               <script>function pick() { window.opener.document.querySelector('#select_country_name_pc').value = 'Canada'; window.close(); }</script>`
            : form("popup"),
      }),
    );
    const sibling = await context.newPage();
    const owner = BrowserController.fromHarnessPage(sibling);
    const controller = await BrowserController.attachSessionPage(owner, { humanize: false });
    const page = controller.activePage();
    if (page === null) throw new Error("No session page");
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: "https://picker.test/form",
      format: "compact",
    });
    sessionId = started.session_id;
    await operateClickTool.handler({ session_id: sessionId, ref: ref(started, "@select") }, null);
    expect(controller.currentUrl()).toBe("https://picker.test/picker");
    const pickerPage = controller.activePage();
    if (pickerPage === null) throw new Error("No picker page");
    const opened = await observe(sessionId, "compact");
    const clickAttempt = operateClickTool
      .handler({ session_id: sessionId, ref: ref(opened, "@canada"), format: "full" }, null)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // Tear the picker window down as soon as the dispatch listener is in.
    let tornDown = false;
    const deadline = Date.now() + 15_000;
    while (!tornDown && Date.now() < deadline) {
      const installed = await pickerPage
        .evaluate(
          () =>
            (window as { __trustySquireClickDispatch?: { token: string } })
              .__trustySquireClickDispatch !== undefined,
        )
        .catch(() => null);
      if (installed === null) break; // picker page went away on its own
      if (installed) {
        await pickerPage.close().catch(() => {});
        tornDown = true;
        break;
      }
    }
    const selected = await clickAttempt;
    expect(tornDown).toBe(true);
    if (!selected.ok) throw selected.error;
    // The closed picker window must not surface as action_failed: the
    // observation follows the documented close-picker recovery to the opener.
    expect(selected.value).toMatchObject({ url: "https://picker.test/form" });
    expect(controller.activePage()).toBe(page);
    expect((await captureScreenshot(sessionId)).url).toBe("https://picker.test/form");
    await finishProvisionSession(sessionId);
    sessionId = undefined;
    expect(sibling.isClosed()).toBe(false);
    await owner.close();
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await context.close();
  }
}, 30_000);

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
