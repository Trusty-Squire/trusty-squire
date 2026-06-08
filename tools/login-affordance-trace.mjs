// Triage the auth methods each blocked service offers — Google (bypasses the
// GitHub-2FA wall) vs GitHub-only (insurmountable for an autonomous bot).
import { BrowserController } from "../apps/mcp/dist/bot/browser.js";
import { writeFileSync } from "node:fs";

const TARGETS = [
  ["railway", "https://railway.com/login"],
  ["planetscale", "https://auth.planetscale.com/sign-in"],
  ["replicate", "https://replicate.com/signin"],
  ["kinde", "https://app.kinde.com/"],
  ["imagekit", "https://imagekit.io/dashboard/login"],
];

const browser = new BrowserController({});
await browser.start();
const out = [];
for (const [svc, url] of TARGETS) {
  try {
    await browser.goto(url);
    await browser.wait(6);
    const landed = browser.currentUrl();
    const inv = await browser.extractInteractiveElements();
    const auth = inv
      .filter((e) => e.visible)
      .map((e) => `${e.visibleText ?? ""} ${e.ariaLabel ?? ""} ${e.iconLabel ?? ""}`.trim())
      .filter((t) => /google|github|gitlab|microsoft|sso|email|password|continue|sign|log ?in/i.test(t))
      .map((t) => t.slice(0, 50));
    out.push({ svc, landed, auth: [...new Set(auth)] });
    console.error(`[${svc}] ${landed}`);
    console.error(`   auth: ${JSON.stringify([...new Set(auth)])}`);
  } catch (err) {
    out.push({ svc, error: String(err) });
    console.error(`[${svc}] ERROR ${err}`);
  }
}
writeFileSync("/tmp/login-affordances.json", JSON.stringify(out, null, 2));
await browser.close();
