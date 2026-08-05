import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { currentUrlFromSnapshot, isAllowedTopLevelUrl } from "./replay-capture-support.mjs";

const config = JSON.parse(process.env.REPLAY_CAPTURE_BROWSER_CONFIG ?? "null");
if (
  config === null ||
  typeof config !== "object" ||
  typeof config.chrome_entry !== "string" ||
  typeof config.session !== "string" ||
  typeof config.start_url !== "string" ||
  !Array.isArray(config.allowed_hosts)
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
      properties: { ref: { type: "string", pattern: "^@[A-Za-z0-9:_-]+$" } },
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
        ref: { type: "string", pattern: "^@[A-Za-z0-9:_-]+$" },
        text: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["ref", "text"],
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

let opened = false;
let lastSnapshot = "";

function chromeEnvironment() {
  return {
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    CHROME_DEVTOOLS_AXI_SESSION: config.session,
  };
}

function runChrome(args) {
  const result = spawnSync(process.execPath, [config.chrome_entry, ...args], {
    encoding: "utf8",
    env: chromeEnvironment(),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `browser command exited ${result.status}`);
  }
  return result.stdout;
}

function snapshotAfter(args) {
  const output = runChrome(args);
  const snapshot = args[0] === "snapshot" ? output : runChrome(["snapshot"]);
  const currentUrl = currentUrlFromSnapshot(snapshot);
  if (!isAllowedTopLevelUrl(currentUrl, config.allowed_hosts)) {
    throw new Error(`top-level navigation blocked: ${currentUrl}`);
  }
  lastSnapshot = snapshot;
  return { ok: true, current_url: currentUrl, snapshot };
}

function assertObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value;
}

function assertRef(value) {
  if (typeof value !== "string" || !/^@[A-Za-z0-9:_-]+$/.test(value)) {
    throw new Error("invalid browser reference");
  }
  return value;
}

function assertClickIsAllowed(ref) {
  const uid = ref.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = lastSnapshot.match(new RegExp(`uid=${uid}[^\\n]*`))?.[0] ?? "";
  if (/pay now|place order|complete order|submit order|buy now/i.test(target)) {
    throw new Error("final order control is blocked");
  }
  const targetUrl = target.match(/\burl="([^"]+)"/)?.[1];
  if (targetUrl !== undefined && !isAllowedTopLevelUrl(targetUrl, config.allowed_hosts)) {
    throw new Error("cross-domain navigation is blocked");
  }
}

function commandFor(name, rawArguments) {
  const args = assertObject(rawArguments ?? {});
  if (name === "browser_open") {
    if (opened) throw new Error("browser_open may only be called once");
    opened = true;
    return ["open", config.start_url];
  }
  if (!opened) throw new Error("browser_open must be called first");
  if (name === "browser_snapshot") return ["snapshot"];
  if (name === "browser_click") {
    const ref = assertRef(args.ref);
    assertClickIsAllowed(ref);
    return ["click", ref];
  }
  if (name === "browser_fill") {
    const ref = assertRef(args.ref);
    if (typeof args.text !== "string" || args.text.length < 1 || args.text.length > 240) {
      throw new Error("invalid fill text");
    }
    return ["fill", ref, args.text];
  }
  if (name === "browser_press") {
    const allowed = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!allowed.includes(args.key)) throw new Error("submitting key is blocked");
    return ["press", args.key];
  }
  if (name === "browser_scroll") {
    if (args.direction !== "up" && args.direction !== "down") {
      throw new Error("invalid scroll direction");
    }
    return ["scroll", args.direction];
  }
  if (name === "browser_wait") {
    if (
      !(
        (Number.isInteger(args.value) && args.value >= 1 && args.value <= 5000) ||
        (typeof args.value === "string" && args.value.length >= 1 && args.value.length <= 120)
      )
    ) {
      throw new Error("invalid wait value");
    }
    return ["wait", String(args.value)];
  }
  throw new Error(`unknown browser tool: ${name}`);
}

const server = new Server(
  { name: "replay-capture-browser", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = snapshotAfter(commandFor(request.params.name, request.params.arguments));
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

await server.connect(new StdioServerTransport());
