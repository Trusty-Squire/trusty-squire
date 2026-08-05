import { chromium } from "playwright";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isAllowedTopLevelUrl, shouldBlockTopLevelNavigation } from "./replay-capture-support.mjs";

const config = JSON.parse(process.env.REPLAY_CAPTURE_BROWSER_CONFIG ?? "null");
if (
  config === null ||
  typeof config !== "object" ||
  typeof config.start_url !== "string" ||
  !Array.isArray(config.allowed_hosts) ||
  !config.allowed_hosts.every((host) => typeof host === "string")
) {
  throw new Error("invalid replay capture browser configuration");
}
if (!isAllowedTopLevelUrl(config.start_url, config.allowed_hosts)) {
  throw new Error("replay capture start URL is outside the allowlist");
}

const tools = [
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
let generation = 0;
let references = new Map();

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
  const body = await page
    .locator("body")
    .ariaSnapshot({ timeout: 5000 })
    .catch(async () => page.locator("body").innerText({ timeout: 5000 }));
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
  const controls = page.locator(
    'a[href]:visible,button:visible,input:visible,select:visible,textarea:visible,[role="button"]:visible,[role="link"]:visible,[role="checkbox"]:visible,[role="radio"]:visible,[role="option"]:visible,[role="menuitem"]:visible,[contenteditable="true"]:visible',
  );
  const count = Math.min(await controls.count(), 250);
  const descriptions = [];
  for (let index = 0; index < count; index += 1) {
    const handle = await controls.nth(index).elementHandle();
    if (handle === null) continue;
    const details = await handle.evaluate((element) => {
      const html = element;
      const labels = "labels" in html && html.labels ? [...html.labels] : [];
      const label =
        element.getAttribute("aria-label") ||
        labels.map((item) => item.textContent ?? "").join(" ") ||
        element.getAttribute("placeholder") ||
        element.textContent ||
        element.getAttribute("name") ||
        element.getAttribute("type") ||
        element.tagName;
      const value = "value" in html ? String(html.value ?? "") : "";
      const href = element instanceof HTMLAnchorElement ? element.href : "";
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        type: element.getAttribute("type") ?? "",
        label: label.replace(/\s+/g, " ").trim().slice(0, 200),
        value: value.slice(0, 240),
        href,
        target: element.getAttribute("target") ?? "",
        disabled: "disabled" in html && Boolean(html.disabled),
      };
    });
    const ref = `@r${generation}:${index + 1}`;
    references.set(ref, { handle, details });
    descriptions.push(`${ref} ${JSON.stringify(details)}`);
  }
  const rendered = [
    `RootWebArea ${JSON.stringify(title)} url=${JSON.stringify(url)}`,
    body.slice(0, 180_000),
    "controls:",
    ...descriptions,
  ].join("\n");
  return { ok: true, current_url: url, snapshot: rendered, checkout_totals: checkoutTotals };
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
    await page.goto(config.start_url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return snapshot();
  }
  if (!opened || page === undefined) throw new Error("browser_open must be called first");
  if (name === "browser_snapshot") return snapshot();
  if (name === "browser_click") {
    const target = assertRef(args.ref);
    assertClickIsAllowed(target);
    await target.handle.click({ timeout: 10_000 });
    return snapshot();
  }
  if (name === "browser_fill") {
    const target = assertRef(args.ref);
    if (typeof args.text !== "string" || args.text.length < 1 || args.text.length > 240) {
      throw new Error("invalid fill text");
    }
    await target.handle.fill(args.text, { timeout: 10_000 });
    return snapshot();
  }
  if (name === "browser_select") {
    const target = assertRef(args.ref);
    if (typeof args.label !== "string" || args.label.length < 1 || args.label.length > 120) {
      throw new Error("invalid option label");
    }
    await target.handle.selectOption({ label: args.label }, { timeout: 10_000 });
    return snapshot();
  }
  if (name === "browser_press") {
    const allowed = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!allowed.includes(args.key)) throw new Error("submitting key is blocked");
    await page.keyboard.press(args.key);
    return snapshot();
  }
  if (name === "browser_scroll") {
    if (args.direction !== "up" && args.direction !== "down") {
      throw new Error("invalid scroll direction");
    }
    await page.mouse.wheel(0, args.direction === "down" ? 700 : -700);
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
  throw new Error(`unknown browser tool: ${name}`);
}

async function closeBrowser() {
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
