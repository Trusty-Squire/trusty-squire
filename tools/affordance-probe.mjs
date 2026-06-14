// Affordance probe — the GROUND TRUTH for "what does this signup page actually
// offer." Loads a service's signup URL in a real browser and reports the page's
// affordances directly, so capability/wall claims ("github-only", "needs a
// card", "anti-bot wall", "no signup form") become READS off this output, never
// inferences from a bot failure or a config field.
//
// Why this exists: false-wall claims (e.g. "fly.io is GitHub-only" — it offers
// Google) get someone to ABANDON a servable service on an unverified say-so.
// This makes the claim checkable. Emit JSON; pipe it into the wall ledger as the
// dated evidence a `needs-manual`/unservable label must carry.
//
// THIN CLI: the load+classify primitive lives in the bot module
// (apps/mcp/src/bot/affordance-probe.ts → probeAffordances). This file only
// resolves targets, drives the browser lifecycle, and emits JSON. Build the mcp
// package first (`pnpm -F @trusty-squire/mcp build`) so the dist import resolves.
//
// Usage:
//   node tools/affordance-probe.mjs <slug>              # url from discovery-candidates.yaml
//   node tools/affordance-probe.mjs <slug> <signupUrl>  # explicit url
//   node tools/affordance-probe.mjs targets.json        # [{slug,url}, ...]
import { readFileSync } from "node:fs";
import { BrowserController } from "../apps/mcp/dist/bot/browser.js";
import { probeAffordances } from "../apps/mcp/dist/bot/affordance-probe.js";

function urlFromYaml(slug) {
  // Cheap line scan — avoids a yaml dep; the file is one-entry-per-line.
  const txt = readFileSync("tools/discovery-candidates.yaml", "utf8");
  const re = new RegExp(`slug:\\s*${slug}\\b[^\\n]*?signup_url:\\s*(\\S+)`);
  const m = re.exec(txt) || new RegExp(`signup_url:\\s*(\\S+)[^\\n]*slug:\\s*${slug}\\b`).exec(txt);
  return m ? m[1].replace(/[,}]+$/, "") : null;
}

function resolveTargets() {
  const a = process.argv[2];
  if (!a) { console.error("usage: affordance-probe <slug> [url] | <targets.json>"); process.exit(1); }
  if (a.endsWith(".json")) return JSON.parse(readFileSync(a, "utf8"));
  const url = process.argv[3] || urlFromYaml(a);
  if (!url) { console.error(`no url for slug '${a}' (pass it explicitly or add to discovery-candidates.yaml)`); process.exit(1); }
  return [{ slug: a, url }];
}

const targets = resolveTargets();
const browser = new BrowserController({});
await browser.start();
const results = [];
for (const t of targets) {
  const out = { slug: t.slug, url: t.url, probed_at: new Date().toISOString() };
  try {
    const affordances = await probeAffordances(browser, t.url);
    Object.assign(out, affordances, { ok: true });
  } catch (e) {
    Object.assign(out, { ok: false, error: String(e?.message || e).slice(0, 120) });
  }
  results.push(out);
  const verdict = !out.ok
    ? `ERROR ${out.error}`
    : `providers=[${out.providers.join(",") || "none"}] email=${out.has_email_signup} card=${out.card_gate} interstitial=${out.interstitial}`;
  console.error(`[probe] ${out.slug.padEnd(16)} ${verdict}`);
}
await browser.close().catch(() => {});
// Machine-readable evidence to stdout (stderr carried the human summary).
console.log(JSON.stringify(results, null, 2));
