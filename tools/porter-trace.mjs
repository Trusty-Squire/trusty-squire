// One-off diagnostic: capture porter's RETURNING-USER API-tokens page as the
// operator (existing account) to see the real create-credential affordance,
// vs the fresh-signup path the skill encoded. Mirrors verify's browser setup
// (new BrowserController({}) → env-driven proxy/profile). Run from repo root:
//   set -a; . ~/.config/trusty-squire/harvester.env; set +a
//   node tools/porter-trace.mjs
import { BrowserController } from "../apps/mcp/dist/bot/browser.js";
import { writeFileSync } from "node:fs";

const URLS = [
  "https://dashboard.porter.run/",
  "https://dashboard.porter.run/settings/api-tokens",
  "https://dashboard.porter.run/api-tokens",
];

const browser = new BrowserController({});
await browser.start();
const out = [];
for (const url of URLS) {
  try {
    await browser.goto(url);
    await browser.wait(6); // let the SPA hydrate
    const landed = browser.currentUrl();
    const text = (await browser.extractText().catch(() => "")).slice(0, 400);
    const shot = await browser.screenshot().catch(() => null);
    if (shot) {
      const b64 = shot.replace(/^data:image\/\w+;base64,/, "");
      writeFileSync(`/tmp/porter-${url.replace(/[^a-z0-9]+/gi, "_").slice(-40)}.png`, Buffer.from(b64, "base64"));
    }
    const inv = await browser.extractInteractiveElements();
    const clickable = inv
      .filter((e) => e.visible && (e.tag === "button" || e.tag === "a" || e.role === "button" || e.role === "link"))
      .map((e) => ({
        tag: e.tag,
        role: e.role,
        text: (e.visibleText ?? "").slice(0, 60),
        aria: e.ariaLabel,
        href: e.href ?? null,
      }))
      .filter((e) => e.text || e.aria || e.href);
    out.push({ requested: url, landed, count: inv.length, textHead: text, clickable });
    console.error(`[trace] ${url} → ${landed} (${inv.length} elements, ${clickable.length} clickable)`);
    console.error(`        text: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  } catch (err) {
    out.push({ requested: url, error: String(err) });
    console.error(`[trace] ${url} → ERROR ${err}`);
  }
}
writeFileSync("/tmp/porter-trace.json", JSON.stringify(out, null, 2));
console.error("[trace] wrote /tmp/porter-trace.json");
await browser.close();
