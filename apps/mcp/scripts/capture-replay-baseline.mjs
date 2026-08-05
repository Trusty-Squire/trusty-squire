import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  allowedHostsFor,
  buildCaptureEnvironment,
  buildCodexArguments,
  isEndState,
  validateGroundedCapture,
} from "./replay-capture-support.mjs";

const MODEL = process.env.REPLAY_EVAL_CAPTURE_MODEL ?? "gpt-5.6-sol";
const DRIVER = "codex-exec+constrained-browser-mcp";
const CORPUS_DIR = resolve(process.cwd(), "../../corpus/shopping");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(SCRIPT_DIR, "replay-capture-browser-mcp.mjs");

function executableEntry(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`${name} is required for replay baseline capture`);
}

const CODEX_ENTRY = executableEntry("codex");
const CHROME_ENTRY = executableEntry("chrome-devtools-axi");

function configuredMcpServers() {
  const codeHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  const configPath = resolve(codeHome, "config.toml");
  if (!existsSync(configPath)) return [];
  const config = parseToml(readFileSync(configPath, "utf8"));
  if (config.mcp_servers === null || typeof config.mcp_servers !== "object") return [];
  return Object.keys(config.mcp_servers).filter((name) => name !== "replay_browser");
}

const DISABLED_MCP_SERVERS = configuredMcpServers();

function taskFiles() {
  const requested = process.argv.indexOf("--task");
  const taskId = requested === -1 ? undefined : process.argv[requested + 1];
  if (requested !== -1 && taskId === undefined) throw new Error("--task requires a task id");
  const tasks = readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json") && name !== "capture-log.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(CORPUS_DIR, name), "utf8")))
    .filter((task) => task.capture?.status === "captured")
    .filter((task) => taskId === undefined || task.task_id === taskId);
  if (taskId !== undefined && tasks.length !== 1) throw new Error(`unknown task: ${taskId}`);
  return tasks;
}

function startUrl(task) {
  if (task.bucket === "repeat") {
    return `https://whitejade.xyz/cart/${encodeURIComponent(task.params.product_variant_id)}:1`;
  }
  return task.entry_url;
}

function finalMessage(events) {
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text);
  const raw = messages.at(-1) ?? "";
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function promptFor(task) {
  const initialUrl = startUrl(task);
  const browserRules =
    "Use only the replay_browser MCP tools. Start with browser_open and use browser snapshots as the sole source of page facts. Never click Pay now, Place order, Complete order, Submit order, Buy now, or any equivalent final-order control.";
  const outputRules =
    "Return only JSON with task_id, line_items as [{title_contains,qty}], total_cents as an integer, and reached.";
  if (task.bucket === "repeat") {
    return `${browserRules}\nTask ${task.task_id}: buy one ${task.params.product_query}. Open ${initialUrl}. Use guest checkout with synthetic contact replay-eval+${task.task_id}@trustysquire.ai, Replay Evaluation, 123 Test Street, New York, NY 10001, US, 2125550100. Reach the checkout review/payment page, observe line item, quantity, subtotal, shipping, and total, then stop before payment. Do not infer or calculate the total; report the displayed total. Set reached to checkout_review. ${outputRules}`;
  }
  return `${browserRules}\nTask ${task.task_id}: inspect ${task.params.product_query}. Open ${initialUrl}. This novel MISS baseline stops at the product page. Observe the displayed product title and price, use quantity one, and do not add to cart. Set reached to product_page. ${outputRules}`;
}

function captureTask(task) {
  const session = `replay-eval-${process.pid}-${task.task_id.replaceAll(/[^a-z0-9]/gi, "-")}`;
  const initialUrl = startUrl(task);
  const browserConfig = {
    chrome_entry: CHROME_ENTRY,
    session,
    start_url: initialUrl,
    allowed_hosts: allowedHostsFor(initialUrl),
  };
  const started = Date.now();
  try {
    const result = spawnSync(
      process.execPath,
      [
        CODEX_ENTRY,
        ...buildCodexArguments({
          model: MODEL,
          mcpServerPath: MCP_SERVER,
          browserConfig,
          disabledMcpServers: DISABLED_MCP_SERVERS,
        }),
      ],
      {
        input: promptFor(task),
        encoding: "utf8",
        env: buildCaptureEnvironment(process.env),
        timeout: 360_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `codex capture exited ${result.status}`);
    }
    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const usage = events.find((event) => event.type === "turn.completed")?.usage;
    if (usage === undefined) throw new Error(`${task.task_id}: missing Codex usage`);
    const toolCalls = events.filter(
      (event) => event.type === "item.started" && event.item?.type === "mcp_tool_call",
    ).length;
    const final = finalMessage(events);
    const parsed = JSON.parse(final);
    if (!isEndState(parsed))
      throw new Error(
        `${task.task_id}: driver returned an invalid end state (${final.slice(0, 1000)}; ${result.stderr.trim().slice(-2000)})`,
      );
    const endState = {
      line_items: parsed.line_items,
      total_cents: parsed.total_cents,
      reached: parsed.reached,
    };
    if (parsed.task_id !== task.task_id)
      throw new Error(`${task.task_id}: driver returned wrong task`);
    const browserEvidence = validateGroundedCapture(events, endState, task);
    return {
      task_id: task.task_id,
      turns: toolCalls + 1,
      tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      wall_clock_ms: Date.now() - started,
      end_state: endState,
      provenance: {
        source: "driver",
        driver: DRIVER,
        model: MODEL,
        recorded_at: new Date().toISOString(),
        ...browserEvidence,
      },
    };
  } finally {
    spawnSync(process.execPath, [CHROME_ENTRY, "stop"], {
      encoding: "utf8",
      env: {
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "C.UTF-8",
        NO_COLOR: "1",
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        CHROME_DEVTOOLS_AXI_SESSION: session,
      },
      timeout: 10_000,
    });
  }
}

const recordings = [];
for (const task of taskFiles()) {
  process.stderr.write(`[replay-capture] ${task.task_id}\n`);
  const recording = captureTask(task);
  recordings.push(recording);
  process.stderr.write(`[replay-record] ${JSON.stringify(recording)}\n`);
}
process.stdout.write(
  `${JSON.stringify({ schema_version: 1, driver: DRIVER, model: MODEL, recordings }, null, 2)}\n`,
);
