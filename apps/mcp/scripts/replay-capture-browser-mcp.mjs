import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isAllowedTopLevelUrl, shouldBlockTopLevelNavigation } from "./replay-capture-support.mjs";
import { BrowserController } from "../src/bot/browser.ts";
import {
  act,
  finishProvisionSession,
  observe,
  rememberRecipe,
  startHarnessProvisionSession,
} from "../src/bot/provision-session.ts";

const config = JSON.parse(process.env.REPLAY_CAPTURE_BROWSER_CONFIG ?? "null");
if (
  config === null ||
  typeof config !== "object" ||
  typeof config.start_url !== "string" ||
  !Array.isArray(config.allowed_hosts) ||
  !config.allowed_hosts.every((host) => typeof host === "string") ||
  typeof config.recipe_dir !== "string" ||
  typeof config.task_id !== "string"
) {
  throw new Error("invalid replay capture browser configuration");
}
if (!isAllowedTopLevelUrl(config.start_url, config.allowed_hosts)) {
  throw new Error("replay capture start URL is outside the allowlist");
}

const tools = [
  {
    name: "browser_finalize_recipe",
    description: "Verify checkout review and persist the native prepared recipe trace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description: "Open the configured task URL and return a browser snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description: "Return the current page snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: "Click a visible element by snapshot reference.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", pattern: "^@r[0-9]+:[0-9]+$" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill",
    description: "Fill a visible field by snapshot reference.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^@r[0-9]+:[0-9]+$" },
        text: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_select",
    description: "Select an option by its visible label.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^@r[0-9]+:[0-9]+$" },
        label: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["ref", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "Press a non-submitting navigation key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { enum: ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current page.",
    inputSchema: {
      type: "object",
      properties: { direction: { enum: ["up", "down"] } },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait",
    description: "Wait briefly for text or page state.",
    inputSchema: {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "integer", minimum: 1, maximum: 5000 },
            { type: "string", minLength: 1, maxLength: 120 },
          ],
        },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
];

let browser;
let context;
let page;
let opened = false;
let finalized = false;
let finalizedRecipe;
let sessionId;
let controller;
let generation = 0;
let references = new Map();
let checkoutItemObserved = false;
let checkoutReviewObserved = false;

function assertObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value;
}

function assertRef(value) {
  if (typeof value !== "string" || !/^@r[0-9]+:[0-9]+$/.test(value)) {
    throw new Error("invalid browser reference");
  }
  const target = references.get(value);
  if (target === undefined) throw new Error("stale browser reference");
  return target;
}

function safeAllowedUrl(url) {
  try {
    return isAllowedTopLevelUrl(url, config.allowed_hosts);
  } catch {
    return false;
  }
}

async function launchBrowser() {
  if (browser !== undefined) return;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  // The constrained MCP runs TypeScript source through tsx.  Recent esbuild
  // output wraps callbacks passed to page.evaluate in `__name(...)`; that
  // helper exists in Node but not in the browser execution world.  Install the
  // identity form before any navigation so production BrowserController
  // evaluators retain their normal browser-side behavior.
  await context.addInitScript(() => {
    globalThis.__name ??= (fn) => fn;
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    let isMainFrame = false;
    try {
      const frame = request.frame();
      isMainFrame = frame === frame.page().mainFrame();
    } catch {
      isMainFrame = request.isNavigationRequest();
    }
    if (
      shouldBlockTopLevelNavigation(
        {
          url: request.url(),
          isNavigationRequest: request.isNavigationRequest(),
          isMainFrame,
        },
        config.allowed_hosts,
      )
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page = await context.newPage();
  context.on("page", (candidate) => {
    if (candidate !== page) void candidate.close();
  });
}

async function snapshot() {
  if (page === undefined) throw new Error("browser_open must be called first");
  generation += 1;
  references = new Map();
  const title = await page.title();
  const url = page.url();
  if (!safeAllowedUrl(url)) throw new Error(`top-level navigation blocked: ${url}`);
  const observation = sessionId === undefined ? undefined : await observe(sessionId, "full");
  const body = observation?.text ?? "";
  const checkoutTotals = await page.locator("body").evaluate((root) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const moneyPattern = /\$\s*\d[\d,]*(?:\.\d{2})?/g;
    const observations = [];
    for (const element of root.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const directText = normalize(
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" "),
      );
      const label = normalize(element.getAttribute("aria-label") ?? directText);
      if (!/^total(?:\s+[A-Z]{3})?$/i.test(label)) continue;
      let container = element;
      for (let depth = 0; depth < 4 && container !== null; depth += 1) {
        const amounts = normalize(container.innerText).match(moneyPattern) ?? [];
        if (amounts.length > 0) {
          for (const amount of amounts) observations.push({ label: "Total", amount });
          break;
        }
        container = container.parentElement;
      }
    }
    return observations.filter(
      (observation, index) =>
        observations.findIndex(
          (candidate) =>
            candidate.label === observation.label && candidate.amount === observation.amount,
        ) === index,
    );
  });
  const controls = (observation?.elements ?? []).slice(0, 250);
  const count = controls.length;
  const descriptions = [];
  for (let index = 0; index < count; index += 1) {
    const element = controls[index];
    const details = {
      ref: element.ref,
      tag: element.tag,
      role: element.role ?? "",
      type: element.type ?? "",
      label: element.label,
      value: element.value ?? "",
      href: element.href ?? "",
      target: "",
      disabled: false,
    };
    const ref = `@r${generation}:${index + 1}`;
    references.set(ref, { details });
    descriptions.push(`${ref} ${JSON.stringify(details)}`);
  }
  const rendered = [
    `RootWebArea ${JSON.stringify(title)} url=${JSON.stringify(url)}`,
    body.slice(0, 180_000),
    "controls:",
    ...descriptions,
  ].join("\n");
  const result = { ok: true, current_url: url, snapshot: rendered, checkout_totals: checkoutTotals };
  await maybeFinalizeCapturedRecipe(result);
  return result;
}

function cents(amount) {
  const match = /^\$\s*(\d[\d,]*)(?:\.(\d{2}))?$/.exec(amount);
  return match === null
    ? undefined
    : Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

async function finalizeCapturedRecipe() {
  if (finalized) return finalizedRecipe;
  const current = await observe(sessionId, "full");
  if (!new URL(current.url).pathname.startsWith("/checkouts/")) {
    throw new Error("recipe capture has not reached checkout review");
  }
  const checkout = await controller.readSettledCheckoutReviewSummary("USD");
  if (checkout === undefined || checkout.amount_cents !== config.expected_total_cents) {
    throw new Error("checkout review did not settle at the expected total");
  }
  finalizedRecipe = await rememberRecipe(sessionId, {
    name: `replay-eval-${config.task_id}`,
    goal: `Reach review for ${config.product_query} without payment`,
    verb: "purchase",
    // Repeat tasks intentionally exercise the production recipe's supported
    // runtime-service-url entry form.  The native trace remains untouched;
    // this binds the requested same-domain product at lookup/replay time.
    entry_mode: "runtime_service_url",
    inputs: config.inputs,
    // The capture gate below has already verified the review sequence and
    // final total.  The local recipe postcondition remains a stable, current
    // page fact rather than depending on a title omitted by checkout's compact
    // late-state rendering.
    postcondition: {
      kind: "execute_capability",
      describe: "checkout review is reached without payment",
      success_signal: { url_contains: "/checkouts/" },
    },
  });
  writeFileSync(config.checkout_file, `${JSON.stringify(checkout, null, 2)}\n`);
  finalized = true;
  return finalizedRecipe;
}

async function maybeFinalizeCapturedRecipe(result) {
  if (config.expected_total_cents === undefined || finalized || !result.current_url.includes("/checkouts/")) {
    return;
  }
  checkoutItemObserved ||= result.snapshot
    .toLowerCase()
    .includes(String(config.expected_title ?? "").toLowerCase());
  checkoutReviewObserved ||=
    result.snapshot.includes(`"value":"replay-eval+${config.task_id}@trustysquire.ai"`) &&
    /"value":"123 Test St(?:reet)?(?:[",])/i.test(result.snapshot) &&
    result.snapshot.includes('"value":"10001"') &&
    /payment|pay\s*now|billing address|review order/i.test(result.snapshot);
  const finalTotal = result.checkout_totals
    .map((total) => cents(total.amount))
    .filter((total) => total !== undefined)
    .at(-1);
  if (
    checkoutItemObserved &&
    checkoutReviewObserved &&
    finalTotal === config.expected_total_cents
  ) {
    await finalizeCapturedRecipe();
  }
}

function provenanceFor(value) {
  if (value === config.inputs?.product_query) return "product_query";
  for (const group of ["address", "contact"]) {
    for (const [field, candidate] of Object.entries(config.inputs?.[group] ?? {})) {
      if (candidate === value) return `${group}.${field}`;
    }
  }
  return undefined;
}

function assertClickIsAllowed(target) {
  const text = `${target.details.label} ${target.details.type} ${target.details.role}`;
  if (
    /pay\s*now|place.*order|complete.*order|submit.*order|buy\s*now|confirm.*(?:order|purchase)|complete.*purchase|purchase\s*now/i.test(
      text,
    )
  ) {
    throw new Error("final order control is blocked");
  }
  if (target.details.href.length > 0 && !safeAllowedUrl(target.details.href)) {
    throw new Error("cross-domain navigation is blocked");
  }
  if (target.details.target.length > 0 && target.details.target.toLowerCase() !== "_self") {
    throw new Error("new-page navigation is blocked");
  }
}

async function runTool(name, rawArguments) {
  const args = assertObject(rawArguments ?? {});
  if (name === "browser_open") {
    if (opened) throw new Error("browser_open may only be called once");
    opened = true;
    await launchBrowser();
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = config.recipe_dir;
    controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: config.start_url,
      extraAllowedHosts: config.allowed_hosts,
    });
    sessionId = started.session_id;
    return snapshot();
  }
  if (!opened || page === undefined) throw new Error("browser_open must be called first");
  if (name === "browser_snapshot") return snapshot();
  if (name === "browser_click") {
    const target = assertRef(args.ref);
    assertClickIsAllowed(target);
    await act(sessionId, { kind: "click", target: target.details.ref }, "none");
    return snapshot();
  }
  if (name === "browser_fill") {
    const target = assertRef(args.ref);
    if (typeof args.text !== "string" || args.text.length < 1 || args.text.length > 240) {
      throw new Error("invalid fill text");
    }
    const provenance = provenanceFor(args.text);
    await act(
      sessionId,
      { kind: "type", target: target.details.ref, text: args.text, ...(provenance === undefined ? {} : { provenance: { hole: provenance } }) },
      "none",
    );
    return snapshot();
  }
  if (name === "browser_select") {
    const target = assertRef(args.ref);
    if (typeof args.label !== "string" || args.label.length < 1 || args.label.length > 120) {
      throw new Error("invalid option label");
    }
    const provenance = provenanceFor(args.label);
    await act(
      sessionId,
      { kind: "select", target: target.details.ref, text: args.label, ...(provenance === undefined ? {} : { provenance: { hole: provenance } }) },
      "none",
    );
    return snapshot();
  }
  if (name === "browser_press") {
    const allowed = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!allowed.includes(args.key)) throw new Error("submitting key is blocked");
    await act(sessionId, { kind: "press", key: args.key }, "none");
    return snapshot();
  }
  if (name === "browser_scroll") {
    if (args.direction !== "up" && args.direction !== "down") {
      throw new Error("invalid scroll direction");
    }
    await act(sessionId, { kind: "scroll", direction: args.direction }, "none");
    return snapshot();
  }
  if (name === "browser_wait") {
    if (Number.isInteger(args.value) && args.value >= 1 && args.value <= 5000) {
      await page.waitForTimeout(args.value);
    } else if (
      typeof args.value === "string" &&
      args.value.length >= 1 &&
      args.value.length <= 120
    ) {
      await page.getByText(args.value, { exact: false }).first().waitFor({ timeout: 5000 });
    } else {
      throw new Error("invalid wait value");
    }
    return snapshot();
  }
  if (name === "browser_finalize_recipe") {
    const saved = await finalizeCapturedRecipe();
    return { ...(await snapshot()), recipe: saved };
  }
  throw new Error(`unknown browser tool: ${name}`);
}

async function closeBrowser() {
  if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
  sessionId = undefined;
  controller = undefined;
  await browser?.close().catch(() => undefined);
  browser = undefined;
  context = undefined;
  page = undefined;
}

const server = new Server(
  { name: "replay-capture-browser", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await runTool(request.params.name, request.params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    // The constrained driver receives the same message as structured tool
    // output; stderr preserves the full stack for capture diagnostics.
    process.stderr.write(
      `[replay-capture-browser] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
    };
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closeBrowser().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

process.stdin.once("close", () => {
  void closeBrowser();
});

await server.connect(new StdioServerTransport());
