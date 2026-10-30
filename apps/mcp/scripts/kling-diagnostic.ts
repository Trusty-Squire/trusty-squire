// Manual isolated-browser diagnostic. Stops before account selection.
// Run with isolated HOME, XDG_CONFIG_HOME, TRUSTY_SQUIRE_PROFILE_DIR;
// optionally set KLING_DIAGNOSTIC_CHROME to a local Chrome executable.
import { chromium } from "playwright";
import { BrowserController } from "../src/bot/browser.js";
import { clickScreenshot } from "../src/bot/screenshot-click.js";
const browser = await chromium.launch({
  executablePath: process.env.KLING_DIAGNOSTIC_CHROME,
  headless: true,
  args: ["--site-per-process"],
});
try {
  const page = await browser.newPage();
  await page.addInitScript({ content: "window.__name = window.__name || function(f){return f;};" });
  await page.goto("https://kling.ai/app", { waitUntil: "domcontentloaded" });
  console.log("PAGE", page.url(), await page.locator("body").innerText());
  await page.getByText("Sign In", { exact: true }).first().click();
  await page.getByText("Continue with Google", { exact: true }).first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  console.log(
    "TARGETS",
    JSON.stringify(
      (await cdp.send("Target.getTargets")).targetInfos.map((t) => ({
        id: t.targetId,
        type: t.type,
        url: t.url,
      })),
    ),
  );
  const controller = BrowserController.fromHarnessPage(page);
  const capture = await controller.extractBrowserUseObservation();
  console.log("OMISSIONS", JSON.stringify(capture.omissions));
  console.log(
    "GOOGLE",
    JSON.stringify(capture.elements.filter((e) => JSON.stringify(e).includes("Google"))),
  );
  const box = await page.getByText("Continue with Google", { exact: true }).first().boundingBox();
  const shot = await controller.captureOperatorScreenshot();
  console.log("BINDING", shot.clickBinding);
  if (box && shot.clickBinding)
    try {
      await clickScreenshot(
        page,
        {
          screenshot_id: shot.clickBinding.screenshot_id,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        },
        () => {},
      );
      console.log("CLICK dispatched");
    } catch (e) {
      console.log("CLICK", e instanceof Error ? e.stack : e);
    }
  console.log(
    "PAGES",
    page
      .context()
      .pages()
      .map((p) => p.url()),
  );
} finally {
  await browser.close();
}
