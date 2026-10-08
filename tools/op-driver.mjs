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
  rememberRecipe,
  verifyPostcondition,
} from "../apps/mcp/dist/bot/provision-session.js";
import {
  readRecipe,
  renderOperatorRecipeHint,
  recipeEntryUrl,
  fillTemplate,
} from "../apps/mcp/dist/bot/operator-recipe.js";

const PORT = Number(process.env.OP_PORT || 8731);
const startUrl = process.argv[2];
const allowed = (process.argv[3] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const requireLive = process.argv[4] === "live";
let sid = null;

const compact = (o) => ({
  url: o.url,
  needs_user: o.needs_user,
  guidance: o.guidance ? String(o.guidance).slice(0, 600) : undefined,
  text: String(o.text || "").slice(0, 2200),
  elements: (o.elements || []).slice(0, 400).map((e) => ({
    ref: e.ref,
    tag: e.tag,
    role: e.role,
    type: e.type,
    label: e.label,
    href: e.href,
    value: e.value,
    checked: e.checked,
  })),
});

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

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
        // Extraction keeps only a Copy-click value; nothing is picked by shape.
        const full = ex.credentials?.api_key;
        if (!full) return send(200, { sealed: false, slot: null, blocked_reason: ex.error });
        const handle = stashSecretSlot(sid, body.into_slot, full);
        return send(200, { sealed: true, slot: handle });
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
      // operate_act { kind: "extract", into_slot } path would have produced.
      const handle = stashSecretSlot(sid, body.slot, body.value);
      return send(200, { sealed: true, slot: handle });
    }
    if (req.url === "/remember") {
      const r = await rememberRecipe(sid, {
        name: body.name,
        goal: body.goal,
        postcondition: body.postcondition,
      });
      return send(200, r);
    }
    if (req.url === "/verify") {
      const recipe = await readRecipe(body.name);
      const r = await verifyPostcondition(sid, recipe.postcondition);
      return send(200, r);
    }
    if (req.url === "/ping") return send(200, { ok: true, sid });
    return send(404, { error: "unknown route" });
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
});

// `use:<recipe-name>` launch mode: start with the saved recipe's rail injected
// as the hint (proves operate_recipe_run). Templates filled from OP_PARAMS (JSON env).
async function startOptions() {
  if (startUrl.startsWith("use:")) {
    const recipe = await readRecipe(startUrl.slice(4));
    const entry = recipeEntryUrl(recipe);
    if (entry === null) throw new Error(`recipe has no goto entry`);
    const params = JSON.parse(process.env.OP_PARAMS || "{}");
    const { url, missing } = fillTemplate(entry, params);
    if (missing.length) throw new Error(`recipe needs params: ${missing.join(", ")}`);
    return {
      serviceUrl: url,
      ...(recipe.allowed_hosts.length ? { extraAllowedHosts: recipe.allowed_hosts } : {}),
      hint: renderOperatorRecipeHint(recipe),
      ...(requireLive ? { requireLiveIdentity: true } : {}),
    };
  }
  return {
    serviceUrl: startUrl,
    ...(allowed.length ? { extraAllowedHosts: allowed } : {}),
    ...(requireLive ? { requireLiveIdentity: true } : {}),
  };
}

try {
  const obs = await startProvisionSession(await startOptions());
  sid = obs.session_id;
  server.listen(PORT, "127.0.0.1", () => {
    console.log("OP_DRIVER_READY sid=" + sid + " port=" + PORT);
    console.log("LANDING " + JSON.stringify(compact(obs)));
  });
} catch (e) {
  console.error("DRIVER_FATAL", (e && e.stack) || e);
  process.exit(1);
}
