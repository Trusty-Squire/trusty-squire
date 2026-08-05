import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MODEL = process.env.REPLAY_EVAL_CAPTURE_MODEL ?? "gpt-5.6-sol";
const DRIVER = "codex-exec+chrome-devtools-axi";
const CORPUS_DIR = resolve(process.cwd(), "../../corpus/shopping");

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

function endStatesMatch(actual, expected) {
  return (
    actual.reached === expected.reached &&
    actual.line_items.length === expected.line_items.length &&
    expected.line_items.every((wanted) =>
      actual.line_items.some(
        (item) =>
          item.qty === wanted.qty &&
          item.title_contains.toLowerCase().includes(wanted.title_contains.toLowerCase()),
      ),
    )
  );
}

function isEndState(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value.line_items) &&
    value.line_items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.title_contains === "string" &&
        item.title_contains.length > 0 &&
        Number.isInteger(item.qty) &&
        item.qty > 0,
    ) &&
    Number.isInteger(value.total_cents) &&
    value.total_cents >= 0 &&
    typeof value.reached === "string" &&
    value.reached.length > 0
  );
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
    "Use only chrome-devtools-axi through shell commands, one browser command per tool turn. Allowed commands: open, snapshot, click, fill, press, scroll, wait. Do not run any other shell command, read files, use web search, or modify files. Never click Pay now, Place order, Complete order, Submit order, Buy now, or any equivalent final-order control.";
  const outputRules =
    "Return only JSON with task_id, line_items as [{title_contains,qty}], total_cents as an integer, reached, and evidence as an array of observed strings.";
  if (task.bucket === "repeat") {
    return `${browserRules}\nTask ${task.task_id}: buy one ${task.params.product_query}. Open ${initialUrl}. Use guest checkout with synthetic contact replay-eval+${task.task_id}@trustysquire.ai, Replay Evaluation, 123 Test Street, New York, NY 10001, US, 2125550100. Reach the checkout review/payment page, observe line item, quantity, subtotal, shipping, and total, then stop before payment. Do not infer or calculate the total; report the displayed total. Set reached to checkout_review. ${outputRules}`;
  }
  return `${browserRules}\nTask ${task.task_id}: inspect ${task.params.product_query}. Open ${initialUrl}. This novel MISS baseline stops at the product page. Observe the displayed product title and price, use quantity one, and do not add to cart. Set reached to product_page. ${outputRules}`;
}

function captureTask(task) {
  const session = `replay-eval-${process.pid}-${task.task_id.replaceAll(/[^a-z0-9]/gi, "-")}`;
  const started = Date.now();
  try {
    const result = spawnSync(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        "-m",
        MODEL,
        "-",
      ],
      {
        input: promptFor(task),
        encoding: "utf8",
        env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session },
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
      (event) =>
        event.type === "item.started" &&
        ["command_execution", "mcp_tool_call", "web_search"].includes(event.item?.type),
    ).length;
    const parsed = JSON.parse(finalMessage(events));
    if (!isEndState(parsed))
      throw new Error(`${task.task_id}: driver returned an invalid end state`);
    const endState = {
      line_items: parsed.line_items,
      total_cents: parsed.total_cents,
      reached: parsed.reached,
    };
    if (parsed.task_id !== task.task_id || !endStatesMatch(endState, task.expected_end_state)) {
      throw new Error(
        `${task.task_id}: observed end state does not match ground truth (${JSON.stringify(parsed)})`,
      );
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
      },
    };
  } finally {
    spawnSync("chrome-devtools-axi", ["stop"], {
      encoding: "utf8",
      env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session },
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
