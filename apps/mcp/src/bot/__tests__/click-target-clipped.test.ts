import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { clickTargetOccluded } from "../act/act.js";

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

// BeatAPI's Create API Key dialog (1.1.47-rc.1 gauntlet, drive-trace L22-L24:
// "Create|a=submit|fm=1|oc=overlay"). Opening the native "Usage restrictions"
// <details> makes the dialog scroll; its Create footer then sits inside the
// viewport but below the dialog's own scroll edge, so the hit lands on the
// backdrop and every Create dispatch was refused as covered.
const dialog = (cover: string): string => `
  <!doctype html><html><body style="margin:0;height:720px">
    <div id="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1"></div>
    <form id="dialog" style="position:fixed;top:100px;left:100px;width:400px;height:300px;overflow:auto;background:white;z-index:2">
      <input aria-label="Key Name" value="grunt">
      <details open>
        <summary>Usage restrictions</summary>
        <div style="height:320px">Allowed models</div>
      </details>
      <button id="create" type="submit">Create</button>
    </form>
    ${cover}
  </body></html>`;

async function open(html: string): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 800, height: 720 } });
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  return page;
}

it("does not call a dialog footer covered when only its scroll box clips it", async () => {
  const page = await open(dialog(""));
  try {
    const box = await page.locator("#create").boundingBox();
    // The precondition the gauntlet hit: in the viewport, past the dialog edge.
    expect(box!.y).toBeGreaterThan(400);
    expect(box!.y + box!.height).toBeLessThan(720);
    expect(await clickTargetOccluded(page, "#create")).toBe(false);
    await page.locator("#create").click({ trial: true, timeout: 2000 });
  } finally {
    await page.close();
  }
});

it("still reports a target that a layer really covers", async () => {
  const page = await open(
    dialog(
      '<div id="banner" style="position:fixed;left:0;right:0;top:0;bottom:0;background:white;z-index:3">Cookies</div>',
    ),
  );
  try {
    expect(await clickTargetOccluded(page, "#create")).toBe(true);
  } finally {
    await page.close();
  }
});
