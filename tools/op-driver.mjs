// op-driver.mjs — persistent SINGLE-SESSION operate driver over localhost HTTP.
// Holds ONE operate session alive so the planner can observe→act→loop across
// separate shell calls (a one-shot script can't keep an interactive browser).
// Single-session means sealed slots survive — the fix for the GCP cross-session
// secret loss. Endpoints mirror the operate_* tools.
//   node tools/op-driver.mjs <startUrl> [allowedHostsCSV] [live]
import http from "node:http";
import {
  startProvisionSession,
  observe,
  act,
  extractCredentials,
  finishProvisionSession,
  stashSecretSlot,
} from "../apps/mcp/dist/bot/provision-session.js";

const PORT = Number(process.env.OP_PORT || 8731);
const startUrl = process.argv[2];
const allowed = (process.argv[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
const requireLive = process.argv[4] === "live";
let sid = null;

const compact = (o) => ({
  url: o.url,
  needs_user: o.needs_user,
  guidance: o.guidance ? String(o.guidance).slice(0, 600) : undefined,
  text: String(o.text || "").slice(0, 2200),
  elements: (o.elements || []).slice(0, 400).map((e) => ({
    ref: e.ref, tag: e.tag, role: e.role, type: e.type,
    label: e.label, href: e.href, value: e.value, checked: e.checked,
  })),
});

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

const looksMasked = (v) =>
  v.includes("•") || v.includes("…") || v.includes("***") || /\.{3,}/.test(v);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const body = await readBody(req);
    if (req.url === "/observe") return send(200, compact(await observe(sid)));
    if (req.url === "/act") return send(200, compact(await act(sid, body.action)));
    if (req.url === "/extract") {
      const ex = await extractCredentials(sid);
      if (body.into_slot) {
        const vals = ex.credentials || {};
        const cands = Object.entries(vals).filter(
          ([k, v]) => !k.endsWith("_truncated") && typeof v === "string" && v.length >= 8 && !looksMasked(v),
        );
        const want = body.secret_label ? norm(body.secret_label) : null;
        // Prefer a candidate whose VALUE matches a caller-supplied shape (e.g.
        // "^GOCSPX-" for a Google client secret) — lets the planner target the
        // right credential without the secret value ever crossing the wire.
        let chosen;
        if (body.value_pattern) {
          const re = new RegExp(body.value_pattern);
          chosen = cands.find(([, v]) => re.test(v));
        }
        if (!chosen && want) chosen = cands.find(([k]) => norm(k).includes(want));
        const full = (chosen ?? cands[0])?.[1];
        if (!full)
          return send(200, {
            sealed: false, slot: null, candidate_count: ex.candidate_count,
            blocked_reason: ex.blocked_reason || "no full unmasked value to seal",
            keys: Object.keys(vals),
          });
        const handle = stashSecretSlot(sid, body.into_slot, full);
        return send(200, { sealed: true, slot: handle, candidate_count: ex.candidate_count });
      }
      return send(200, ex);
    }
    if (req.url === "/finish") {
      const r = await finishProvisionSession(sid);
      sid = null;
      send(200, r);
      setTimeout(() => process.exit(0), 200);
      return;
    }
    if (req.url === "/stash") {
      // Seal a literal value into a session slot (for when a value is visible
      // to the planner but not machine-extractable — e.g. GCP's new client
      // secret lives only in a copy-button aria-label). Mirrors the slot the
      // operate_extract{into_slot} path would have produced.
      const handle = stashSecretSlot(sid, body.slot, body.value);
      return send(200, { sealed: true, slot: handle });
    }
    if (req.url === "/ping") return send(200, { ok: true, sid });
    return send(404, { error: "unknown route" });
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
});

try {
  const obs = await startProvisionSession({
    serviceUrl: startUrl,
    ...(allowed.length ? { extraAllowedHosts: allowed } : {}),
    ...(requireLive ? { requireLiveIdentity: true } : {}),
  });
  sid = obs.session_id;
  server.listen(PORT, "127.0.0.1", () => {
    console.log("OP_DRIVER_READY sid=" + sid + " port=" + PORT);
    console.log("LANDING " + JSON.stringify(compact(obs)));
  });
} catch (e) {
  console.error("DRIVER_FATAL", (e && e.stack) || e);
  process.exit(1);
}
