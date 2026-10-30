// R1 manual real-site navigation proof. Build apps/mcp first, then run with
// R1_BROWSER_EXECUTABLE if its driver's bundled Chromium is unavailable.
// Only the Google admission probe is synthetic; signup/provider pages are live.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "r1-oauth-home-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
process.env.TRUSTY_SQUIRE_PROFILE_DIR = join(sandbox, "profile");
const { getChromium } = await import("../dist/bot/browser-process-runtime.js");
const { BrowserController } = await import("../dist/bot/browser.js");
const { operateLoginTool } = await import("../dist/tools/provision-drive.js");
const {
  startHarnessProvisionSession,
  finishProvisionSession,
  preparePublicOAuthLoginTarget,
  withPreparedOAuthLoginTarget,
} = await import("../dist/bot/provision-session.js");

let browser;
let sessionId;
try {
  browser = await getChromium().launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.R1_BROWSER_EXECUTABLE
      ? { executablePath: process.env.R1_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: "SID", value: "synthetic-r1-admission", domain: ".google.com", path: "/" },
  ]);
  await context.route("https://myaccount.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button aria-label="Google Account: Operator (operator@example.com)"></button>',
    }),
  );
  const signup = "https://elevenlabs.io/app/sign-up";
  const ownerPage = await context.newPage();
  await ownerPage.goto(signup);
  const owner = BrowserController.fromHarnessPage(ownerPage);
  const controller = await BrowserController.attachSessionPage(owner);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: signup,
    format: "compact",
  });
  sessionId = started.session_id;
  const ref = started.safe_table?.find((row) => row[2]?.includes("sign-up-with-google"))?.[0];
  if (!ref) throw new Error("R1: Google signup control was not observed");
  const prepared = preparePublicOAuthLoginTarget(sessionId, ref);
  if (!prepared) throw new Error("R1: prepared target was unavailable");
  const result = await withPreparedOAuthLoginTarget(prepared, () =>
    operateLoginTool.handler(
      {
        action: "oauth",
        session_id: sessionId,
        provider: "google",
        ref,
      },
      {},
    ),
  );
  const destination = new URL(result.url);
  const proof = {
    reproduction: "R1",
    admission: "synthetic Google identity; isolated unsigned-in browser",
    destination: destination.origin + destination.pathname,
    oauth: result.oauth?.state,
  };
  console.log(JSON.stringify(proof));
  if (destination.hostname !== "accounts.google.com")
    throw new Error("R1: signup did not reach Google sign-in");
} finally {
  if (sessionId) await finishProvisionSession(sessionId);
  await browser?.close();
  await rm(sandbox, { recursive: true, force: true });
}
