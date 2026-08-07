/**
 * Refresh the frozen storefront HARs by replaying persisted native recipes
 * against the operator-owned test store.  This deliberately does not invent a
 * browser walk: every action comes from the constrained-capture recipe.  The
 * session-keyed checkout traffic is removed before persistence because the
 * harness hands off to a fresh live, JS-enabled checkout context.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { OperatorRecipeSchema } from "../dist/bot/operator-recipe.js";
import { parseFallbackAction, replayRecipeOnHarnessPage } from "../dist/eval/replay-harness/engine-adapter.js";
import { sanitizeReplayHar } from "./replay-capture-support.mjs";

const root = resolve(import.meta.dirname, "../../..");
const corpus = resolve(root, "corpus/shopping");

function bindings(task) {
  return {
    product_query: task.params.product_query,
    quantity: "1",
    "address.country": "United States",
    "address.postal_code": task.params.address.postal_code,
    "address.region": "New York",
    "address.line1": "123 Test Street",
    "address.city": "New York",
    "contact.email": `replay-eval+${task.task_id}@trustysquire.ai`,
    "contact.name": "Replay Evaluation",
    "contact.first_name": "Replay",
    "contact.last_name": "Evaluation",
    "contact.phone": "2125550100",
  };
}

function checkoutRequest(entry) {
  try {
    return new URL(entry.request?.url ?? "https://invalid.test/").href.includes("/checkout");
  } catch {
    return false;
  }
}

function retainFrozenStorefrontEntry(entry) {
  if (checkoutRequest(entry)) return false;
  try {
    const request = new URL(entry.request?.url ?? "https://invalid.test/");
    if (request.hostname === "cdn.shopify.com") return true;
    if (request.hostname !== "whitejade.xyz" && request.hostname !== "www.whitejade.xyz") return false;
    return (
      request.pathname.startsWith("/products/") ||
      request.pathname.startsWith("/cart") ||
      request.pathname.startsWith("/cdn/shop/")
    );
  } catch {
    return false;
  }
}

async function measuredRescue(input) {
  const prompt = [
    "Return only JSON for one safe browser repair action.",
    "Allowed kinds: click, js_click, type, select, set_phone_country, goto, press, scroll.",
    'For every click, js_click, type, or select, set target to the literal live ref string: {"target":"@e:…"}. Do not wrap it in an object.',
    "Never enter payment, submit an order, request a card, or click a final payment control.",
    `Missed step: ${JSON.stringify({ step_index: input.step_index, reason: input.reason, action: input.action })}`,
    `Bindings: ${JSON.stringify(input.bindings)}`,
    `Live observation: ${JSON.stringify(input.observation)}`,
    "Use a live element ref from the observation for target actions.",
  ].join("\n");
  const child = spawn("codex", ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--disable", "shell_tool", "--disable", "apps", "--disable", "skill_search", "--disable", "multi_agent", "--disable", "hooks", "--disable", "plugins", "-c", 'approval_policy="never"', "-m", process.env.REPLAY_EVAL_WARM_MODEL ?? "gpt-5.6-sol", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(prompt);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exit = await new Promise((resolveExit, reject) => child.once("error", reject).once("close", resolveExit));
  if (exit !== 0) throw new Error(`fallback rescue exited ${exit}: ${stderr.trim()}`);
  const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const raw = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message").map((event) => event.item.text).at(-1);
  const usage = events.find((event) => event.type === "turn.completed")?.usage;
  if (typeof raw !== "string" || usage?.input_tokens === undefined || usage?.output_tokens === undefined) {
    throw new Error("fallback rescue returned no measured action");
  }
  return {
    action: parseFallbackAction(JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))),
    turns: 1,
    tokens: usage.input_tokens + usage.output_tokens,
  };
}

async function recordTask(task) {
  const recipePath = resolve(corpus, task.cold_baseline.provenance.trace_artifact);
  const recipe = OperatorRecipeSchema.parse(JSON.parse(readFileSync(recipePath, "utf8")));
  const harPath = resolve(corpus, task.har);
  const temporary = `${harPath}.recording`;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    recordHar: { path: temporary, content: "embed", mode: "full" },
  });
  await context.route("**/*", async (route) => {
    const kind = route.request().resourceType();
    if (kind === "image" || kind === "media" || kind === "font") await route.abort();
    else await route.continue();
  });
  const page = await context.newPage();
  try {
    const result = await replayRecipeOnHarnessPage({
      page,
      service_url: task.entry_url,
      recipe,
      bindings: bindings(task),
      // The same constrained rescue used by the evaluator supplies any
      // guarded repair; a fixture refresh never scripts a replacement.
      rescue: measuredRescue,
    });
    if (result.status === "fallback_required" || result.status === "unavailable") {
      throw new Error(`${task.task_id}: native recipe did not record cleanly (${result.status})`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  const har = JSON.parse(readFileSync(temporary, "utf8"));
  unlinkSync(temporary);
  har.log.entries = har.log.entries.filter(retainFrozenStorefrontEntry);
  const urls = har.log.entries.map((entry) => entry.request?.url ?? "");
  if (!urls.some((url) => new URL(url).pathname.startsWith("/products/")) ||
      !urls.some((url) => new URL(url).pathname.startsWith("/cart"))) {
    throw new Error(`${task.task_id}: refreshed HAR lacks a replayed storefront/cart boundary`);
  }
  writeFileSync(harPath, `${JSON.stringify(sanitizeReplayHar(har))}\n`);
  process.stderr.write(`[replay-storefront-har] ${task.task_id}: ${har.log.entries.length} entries\n`);
}

const selected = new Set(
  (process.env.REPLAY_HAR_TASK_IDS ?? "whitejade-purchase-r0,whitejade-purchase-r1,whitejade-purchase-r2,whitejade-purchase-r3")
    .split(",")
    .map((taskId) => taskId.trim())
    .filter(Boolean),
);
for (const filename of ["whitejade-purchase-r0.json", "whitejade-purchase-r1.json", "whitejade-purchase-r2.json", "whitejade-purchase-r3.json"]) {
  const task = JSON.parse(readFileSync(resolve(corpus, filename), "utf8"));
  if (!selected.has(task.task_id)) continue;
  await recordTask(task);
}
