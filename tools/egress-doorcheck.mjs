// Egress door-check: load each service's signup page on the CURRENT egress and
// classify whether the door (anti-bot interstitial) blocks us. No signup, no
// identity-pool spend — just "does this IP get past the front door."
//
// Run direct (no proxy env) to measure the datacenter-IP block rate; the
// delta vs a proxy run is the real residential-dependency. Reads URLs from a
// JSON array of {service,url} on argv[2] (defaults to a baked sample).
import { readFileSync } from "node:fs";
import { BrowserController, classifyInterstitialText } from "../apps/mcp/dist/bot/browser.js";

const file = process.argv[2];
const targets = file
  ? JSON.parse(readFileSync(file, "utf8"))
  : [];
if (targets.length === 0) {
  console.error("no targets — pass a JSON file of [{service,url}]");
  process.exit(1);
}

const results = [];
// One browser, sequential gotos — different domains so no cross-clearance.
const browser = new BrowserController({});
await browser.start();
for (const t of targets) {
  let verdict = "ok";
  let detail = "";
  try {
    await browser.goto(t.url); // goto does the normal interstitial clear attempt
    await browser.wait?.(3);
    const text = (await browser.extractText()).slice(0, 4000);
    const { onInterstitial, verificationPassed } = classifyInterstitialText(text);
    if (onInterstitial && !verificationPassed) {
      verdict = "BLOCKED";
      detail = "interstitial did not clear";
    } else if (/access denied|forbidden|error 1020|ip address has been/i.test(text)) {
      verdict = "BLOCKED";
      detail = "access-denied/1020";
    } else {
      verdict = "ok";
    }
  } catch (e) {
    verdict = "error";
    detail = String(e?.message || e).slice(0, 60);
  }
  results.push({ service: t.service, verdict, detail });
  console.error(`[doorcheck] ${t.service.padEnd(14)} ${verdict}${detail ? "  (" + detail + ")" : ""}`);
}
await browser.close().catch(() => {});

const blocked = results.filter((r) => r.verdict === "BLOCKED");
const errored = results.filter((r) => r.verdict === "error");
console.error(`\n[doorcheck] ===== SUMMARY (egress=${process.env.UNIVERSAL_BOT_PROXY_URL ? "PROXY" : "DIRECT"}) =====`);
console.error(`  total=${results.length}  ok=${results.length - blocked.length - errored.length}  BLOCKED=${blocked.length}  error=${errored.length}`);
if (blocked.length) console.error(`  blocked: ${blocked.map((r) => r.service).join(", ")}`);
if (errored.length) console.error(`  errored: ${errored.map((r) => r.service).join(", ")}`);
