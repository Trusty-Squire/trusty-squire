import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

// Manual real-target proof. Run from the repo with xvfb-run -a node apps/mcp/scripts/google-viewer-live-proof.mjs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(root);
const proofHome = await mkdtemp(resolve(tmpdir(), "squire-google-viewer-proof-"));
process.env.HOME = proofHome;
process.env.XDG_CONFIG_HOME = resolve(proofHome, "config");
process.env.TRUSTY_SQUIRE_PROFILE_DIR = resolve(proofHome, "profile");
const require = createRequire(resolve("apps/mcp/package.json"));
const { chromium } = require("playwright");
const local = (p) => import(pathToFileURL(resolve("apps/mcp/dist/bot", p)));
const { BrowserController } = await local("browser.js");
const { startHarnessProvisionSession, paymentSession, finishProvisionSession, observe } =
  await local("provision-session.js");
const { shareOperateSession, stopOperateShareGateway } = await local("live-share.js");
const evidence = resolve("data/google-viewer-popup");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
let sessionId;
const facts = [];
const note = (s) => {
  facts.push(s);
  console.log(s);
};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const product = await context.newPage();
  const controller = BrowserController.fromHarnessPage(product);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: "https://x.com/i/flow/login",
    initialObservation: "drive",
  });
  sessionId = started.session_id;
  note("Patched dist session opened: " + product.url());
  const shared = await shareOperateSession(paymentSession(sessionId), async (port) => ({
    url: `http://127.0.0.1:${port}`,
    close: async () => {},
  }));
  const viewer = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  await viewer.goto(shared.url);
  await viewer.waitForFunction(() => document.querySelector("canvas")?.width === 1280);
  let google;
  const end = Date.now() + 30000;
  while (Date.now() < end && !google) {
    for (const frame of product.frames()) {
      const candidate = frame
        .getByRole("button", { name: /Continue with Google|Sign in with Google/i })
        .first();
      if (await candidate.isVisible().catch(() => false)) {
        google = candidate;
        break;
      }
    }
    if (!google) await new Promise((r) => setTimeout(r, 250));
  }
  if (!google) {
    await viewer.screenshot({ path: resolve(evidence, "real-x-unavailable.png") });
    throw new Error(
      "Real X Google button was not visible: " +
        (await product.locator("body").innerText()).slice(0, 1000),
    );
  }
  const click = async (locator) => {
    const box = await locator.boundingBox();
    const canvas = await viewer.locator("canvas").boundingBox();
    const size = await viewer
      .locator("canvas")
      .evaluate((c) => ({ width: c.width, height: c.height }));
    if (!box || !canvas) throw new Error("Visible input bounds missing");
    await viewer.mouse.click(
      canvas.x + ((box.x + box.width / 2) / size.width) * canvas.width,
      canvas.y + ((box.y + box.height / 2) / size.height) * canvas.height,
    );
  };
  await viewer.screenshot({ path: resolve(evidence, "real-x-before.png") });
  const opened = product.waitForEvent("popup", { timeout: 15000 });
  await click(google);
  const popup = await opened;
  await popup.waitForURL("https://accounts.google.com/**", { timeout: 20000 });
  const activeDeadline = Date.now() + 10000;
  while (controller.page !== popup && Date.now() < activeDeadline)
    await new Promise((r) => setTimeout(r, 100));
  if (controller.page !== popup)
    throw new Error("Patched controller did not follow real Google popup");
  const email = popup
    .locator("input#identifierId, input[type=email], input[autocomplete=username]")
    .first();
  await email.waitFor({ state: "visible", timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
  await viewer.screenshot({ path: resolve(evidence, "real-google-signin.png") });
  await click(email);
  await viewer.keyboard.type("viewer-proof@example.com");
  await popup.waitForFunction(
    () =>
      document.querySelector("input#identifierId, input[type=email], input[autocomplete=username]")
        ?.value === "viewer-proof@example.com",
  );
  await new Promise((r) => setTimeout(r, 1000));
  await viewer.screenshot({ path: resolve(evidence, "real-google-typed.png") });
  const observation = await observe(sessionId, "compact");
  if (!observation.url.startsWith("https://accounts.google.com/"))
    throw new Error("Observation did not follow Google");
  note(
    "Viewer canvas opened real Google; email click and typing reached its input; observe reports accounts.google.com. No form submitted.",
  );
  await popup.close();
  const returnDeadline = Date.now() + 10000;
  while (controller.page !== product && Date.now() < returnDeadline)
    await new Promise((r) => setTimeout(r, 100));
  if (controller.page !== product)
    throw new Error("Viewer did not return to X after real popup closed");
  await new Promise((r) => setTimeout(r, 1200));
  await viewer.screenshot({ path: resolve(evidence, "real-x-returned.png") });
  note("Closing real Google popup returned patched viewer to X: " + product.url());
  await writeFile(resolve(evidence, "real-proof.txt"), facts.join("\n") + "\n");
} catch (e) {
  note("FAIL: " + e.message);
  await writeFile("/tmp/jellybean-google-live-failure.txt", facts.join("\n"));
  process.exitCode = 1;
} finally {
  if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
  await stopOperateShareGateway();
  await browser.close();
}
