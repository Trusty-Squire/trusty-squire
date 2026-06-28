// op-probe.mjs — drive the OPERATE substrate (provision-session) directly, the
// exact code path Codex's operate_* tools use, and dump observations + extract.
// Lets us reproduce an operate-path failure and snapshot the stuck DOM without
// an LLM planner. Usage:
//   node tools/op-probe.mjs <startUrl> [gotoUrl ...]
// Reuses the bot's persistent Chrome profile, so it lands as the bot identity.
import {
  startProvisionSession,
  act,
  extractCredentials,
  finishProvisionSession,
} from "../apps/mcp/dist/bot/provision-session.js";

const startUrl = process.argv[2];
const gotoUrls = process.argv.slice(3);
if (!startUrl) {
  console.error("usage: node tools/op-probe.mjs <startUrl> [gotoUrl ...]");
  process.exit(1);
}

function dump(label, o) {
  console.log(`\n========== ${label} ==========`);
  console.log("url:", o.url);
  if (o.needs_user) console.log("NEEDS_USER:", JSON.stringify(o.needs_user));
  if (o.guidance) console.log("guidance:", String(o.guidance).slice(0, 400));
  console.log("--- text (first 2500) ---");
  console.log(String(o.text || "").slice(0, 2500));
  const els = o.elements || [];
  console.log(`--- elements (${els.length}, first 90) ---`);
  for (const e of els.slice(0, 90)) {
    console.log("  " + JSON.stringify(e).slice(0, 200));
  }
}

let sid;
try {
  const obs = await startProvisionSession({ serviceUrl: startUrl, extraAllowedHosts: [] });
  sid = obs.session_id;
  dump("start " + startUrl, obs);
  if (obs.needs_user) { process.exit(0); }
  for (const u of gotoUrls) {
    const o = await act(sid, { kind: "goto", url: u });
    dump("goto " + u, o);
  }
  console.log("\n========== extractCredentials ==========");
  try {
    const ex = await extractCredentials(sid);
    console.log(JSON.stringify(ex, null, 2));
  } catch (e) {
    console.log("extract threw:", String(e && e.message || e));
  }
} catch (e) {
  console.error("FATAL:", e && e.stack || e);
} finally {
  try { if (sid) await finishProvisionSession(sid); } catch {}
  process.exit(0);
}
