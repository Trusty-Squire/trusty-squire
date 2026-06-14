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
// Usage:
//   node tools/affordance-probe.mjs <slug>              # url from discovery-candidates.yaml
//   node tools/affordance-probe.mjs <slug> <signupUrl>  # explicit url
//   node tools/affordance-probe.mjs targets.json        # [{slug,url}, ...]
import { readFileSync } from "node:fs";
import { BrowserController, classifyInterstitialText } from "../apps/mcp/dist/bot/browser.js";
import { findOAuthButton } from "../apps/mcp/dist/bot/agent.js";
import { OAUTH_PROVIDERS } from "../apps/mcp/dist/bot/oauth-providers.js";

const PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS); // e.g. google, github

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

// Pure: classify a page's interactive inventory + text into affordances.
// Exported-style so the logic is inspectable; the DOM read happens in probeOne.
function classifyAffordances(inventory, text) {
  const providers = PROVIDER_IDS.filter((p) => findOAuthButton(inventory, p) !== null);
  const isField = (el, ...types) =>
    el.tag === "input" && (types.includes(el.type) || types.some((t) => (el.name ?? "").toLowerCase().includes(t)));
  const has_email = inventory.some((el) => isField(el, "email") || /email/i.test(el.name ?? el.placeholder ?? ""));
  const has_password = inventory.some((el) => isField(el, "password"));
  const card_field = inventory.some(
    (el) => el.tag === "input" && /card|cc-?number|cardnumber|cvc|cvv/i.test(`${el.name} ${el.placeholder} ${el.ariaLabel}`),
  );
  const card_text = /\b(credit card|payment method|card number|billing (information|details))\b/i.test(text);
  const { onInterstitial, verificationPassed } = classifyInterstitialText(text);
  return {
    providers,
    has_email_signup: has_email && has_password,
    has_email_field: has_email,
    card_gate: card_field || card_text,
    interstitial: onInterstitial && !verificationPassed,
  };
}

async function probeOne(browser, t) {
  const out = { slug: t.slug, url: t.url, probed_at: new Date().toISOString() };
  try {
    await browser.goto(t.url);
    await browser.wait?.(3);
    const [inventory, text] = await Promise.all([
      browser.extractInteractiveElements(),
      browser.extractText().then((s) => s.slice(0, 6000)).catch(() => ""),
    ]);
    Object.assign(out, classifyAffordances(inventory, text), {
      final_url: browser.currentUrl?.() ?? t.url,
      inventory_size: inventory.length,
      ok: true,
    });
  } catch (e) {
    Object.assign(out, { ok: false, error: String(e?.message || e).slice(0, 120) });
  }
  return out;
}

const targets = resolveTargets();
const browser = new BrowserController({});
await browser.start();
const results = [];
for (const t of targets) {
  const r = await probeOne(browser, t);
  results.push(r);
  const verdict = !r.ok
    ? `ERROR ${r.error}`
    : `providers=[${r.providers.join(",") || "none"}] email=${r.has_email_signup} card=${r.card_gate} interstitial=${r.interstitial}`;
  console.error(`[probe] ${r.slug.padEnd(16)} ${verdict}`);
}
await browser.close().catch(() => {});
// Machine-readable evidence to stdout (stderr carried the human summary).
console.log(JSON.stringify(results, null, 2));
