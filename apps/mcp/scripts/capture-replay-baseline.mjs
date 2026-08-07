import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  allowedHostsFor,
  buildGroundingDiagnostic,
  buildCaptureEnvironment,
  buildCodexArguments,
  captureBrowserObservations,
  isEndState,
  validateGroundedCapture,
} from "./replay-capture-support.mjs";

const MODEL = process.env.REPLAY_EVAL_CAPTURE_MODEL ?? "gpt-5.6-sol";
const DRIVER = "codex-exec+constrained-browser-mcp";
const CORPUS_DIR = resolve(process.cwd(), "../../corpus/shopping");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(SCRIPT_DIR, "replay-capture-browser-mcp.mjs");
const TRACE_DIR = resolve(CORPUS_DIR, "traces");

function executableEntry(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`${name} is required for replay baseline capture`);
}

const CODEX_ENTRY = executableEntry("codex");

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
  return task.entry_url;
}

function finalMessage(events) {
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text);
  const raw = messages.at(-1) ?? "";
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function browserToolFailures(events) {
  return events.flatMap((event) => {
    if (event.type !== "item.completed" || event.item?.type !== "mcp_tool_call") return [];
    const raw = event.item.result ?? event.item.output ?? event.item.content;
    const text =
      typeof raw === "string"
        ? raw
        : typeof raw?.text === "string"
          ? raw.text
          : typeof raw?.content?.[0]?.text === "string"
            ? raw.content[0].text
            : "";
    try {
      const parsed = JSON.parse(text);
      return parsed?.ok === false && typeof parsed.error === "string"
        ? [`${event.item.tool ?? event.item.name ?? "browser tool"}: ${parsed.error}`]
        : [];
    } catch {
      return [];
    }
  });
}

function writeGroundingDebugArtifact(task, events, final, reason) {
  const observations = captureBrowserObservations(events);
  const diagnostic = buildGroundingDiagnostic(task, observations, final, reason);
  const debugDir = resolve(TRACE_DIR, "debug");
  mkdirSync(debugDir, { recursive: true });
  const path = resolve(debugDir, `${task.task_id}.grounding-failure.json`);
  writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return path;
}

function promptFor(task) {
  const initialUrl = startUrl(task);
  const browserRules =
    "Use only the replay_browser MCP tools. Start with browser_open and use browser snapshots as the sole source of page facts. Never click Pay now, Place order, Complete order, Submit order, Buy now, or any equivalent final-order control.";
  const outputRules =
    "Return only JSON with task_id, line_items as [{title_contains,qty}], total_cents as an integer, and reached.";
  if (task.bucket === "repeat") {
    return `${browserRules}\nTask ${task.task_id}: buy one ${task.params.product_query}. Open ${initialUrl}. Use guest checkout with synthetic contact replay-eval+${task.task_id}@trustysquire.ai, Replay Evaluation, 123 Test Street, New York, NY 10001, US, 2125550100. Reach the checkout review/payment page, observe line item, quantity, subtotal, shipping, and total, then stop before payment. Do not infer or calculate the total; report the displayed total. Set reached to checkout_review. Once the exact review state is visible, call browser_finalize_recipe exactly once before returning. ${outputRules}`;
  }
  return `${browserRules}\nTask ${task.task_id}: inspect ${task.params.product_query}. Open ${initialUrl}. This novel MISS baseline stops at the product page. If browser_open shows the requested title and its product price, report them immediately without clicking, scrolling, dismissing overlays, or navigating. Use quantity one and do not add to cart. Set reached to product_page. ${outputRules}`;
}

function captureTask(task) {
  const initialUrl = startUrl(task);
  const browserConfig = {
    start_url: initialUrl,
    allowed_hosts: allowedHostsFor(initialUrl),
    task_id: task.task_id,
    product_query: task.params.product_query,
    expected_title: task.expected_end_state.line_items[0]?.title_contains,
    expected_total_cents: task.expected_end_state.total_cents,
    recipe_dir: resolve(TRACE_DIR, `.capture-${task.task_id}`),
    checkout_file: resolve(TRACE_DIR, `.capture-${task.task_id}`, "checkout.json"),
    inputs: {
      product_query: task.params.product_query,
      address: {
        country: "United States",
        region: "New York",
        postal_code: task.params.address.postal_code,
        line1: "123 Test Street",
        city: "New York",
      },
      contact: {
        email: `replay-eval+${task.task_id}@trustysquire.ai`,
        name: "Replay Evaluation",
        first_name: "Replay",
        last_name: "Evaluation",
        phone: "2125550100",
      },
    },
  };
  const started = Date.now();
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
  if (!isEndState(parsed)) {
    const failures = browserToolFailures(events);
    throw new Error(
      `${task.task_id}: driver returned an invalid end state (${final.slice(0, 1000)}; ${[...failures, result.stderr.trim()].filter(Boolean).join("; ").slice(-4000)})`,
    );
  }
  const endState = {
    line_items: parsed.line_items,
    total_cents: parsed.total_cents,
    reached: parsed.reached,
  };
  if (parsed.task_id !== task.task_id)
    throw new Error(`${task.task_id}: driver returned wrong task`);
  let browserEvidence;
  try {
    browserEvidence = validateGroundedCapture(events, endState, task);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const debugPath = writeGroundingDebugArtifact(task, events, final, reason);
    throw new Error(`${reason}; grounding_debug_artifact=${debugPath}`);
  }
  let traceArtifact;
  let checkoutArtifact;
  if (task.bucket === "repeat") {
    const recipePath = resolve(browserConfig.recipe_dir, "purchase--whitejade.xyz.json");
    if (!existsSync(recipePath)) throw new Error(`${task.task_id}: native recipe artifact missing`);
    mkdirSync(TRACE_DIR, { recursive: true });
    traceArtifact = resolve(TRACE_DIR, `${task.task_id}.recipe.json`);
    writeFileSync(traceArtifact, readFileSync(recipePath, "utf8"));
    checkoutArtifact = resolve(TRACE_DIR, `${task.task_id}.checkout.json`);
    writeFileSync(checkoutArtifact, readFileSync(browserConfig.checkout_file, "utf8"));
    const taskFile = resolve(CORPUS_DIR, `${task.task_id}.json`);
    const persistedTask = JSON.parse(readFileSync(taskFile, "utf8"));
    persistedTask.cold_baseline.provenance.trace_artifact =
      `traces/${task.task_id}.recipe.json`;
    persistedTask.cold_baseline.provenance.checkout_artifact =
      `traces/${task.task_id}.checkout.json`;
    writeFileSync(taskFile, `${JSON.stringify(persistedTask, null, 2)}\n`);
  }
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
      ...(traceArtifact === undefined
        ? {}
        : {
            trace_artifact: `traces/${task.task_id}.recipe.json`,
            checkout_artifact: `traces/${task.task_id}.checkout.json`,
          }),
    },
  };
}

const recordings = [];
const failures = [];
for (const task of taskFiles()) {
  process.stderr.write(`[replay-capture] ${task.task_id}\n`);
  try {
    const recording = captureTask(task);
    recordings.push(recording);
    process.stderr.write(`[replay-record] ${JSON.stringify(recording)}\n`);
  } catch (error) {
    const failure = {
      task_id: task.task_id,
      reason: error instanceof Error ? error.message : String(error),
    };
    failures.push(failure);
    // A failed constrained capture is evidence of an unavailable sample, never
    // permission to synthesize a trace or substitute a scripted walk.
    process.stderr.write(`[replay-capture-failure] ${JSON.stringify(failure)}\n`);
  }
}
process.stdout.write(
  `${JSON.stringify({ schema_version: 1, driver: DRIVER, model: MODEL, recordings, failures }, null, 2)}\n`,
);
