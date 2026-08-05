import { createHash } from "node:crypto";
import { delimiter, dirname, resolve } from "node:path";
import { homedir } from "node:os";

export const CAPTURE_POLICY = "read-only-playwright-mcp-v3";

export function endStatesMatch(actual, expected) {
  return (
    actual.total_cents === expected.total_cents &&
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

export function isEndState(value) {
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

export function allowedHostsFor(startUrl) {
  const hostname = new URL(startUrl).hostname.toLowerCase();
  const bare = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  return [...new Set([bare, `www.${bare}`])];
}

export function isAllowedTopLevelUrl(url, allowedHosts) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function shouldBlockTopLevelNavigation(request, allowedHosts) {
  return (
    request.isNavigationRequest &&
    request.isMainFrame &&
    !isAllowedTopLevelUrl(request.url, allowedHosts)
  );
}

export function currentUrlFromSnapshot(snapshot) {
  const match = snapshot.match(/RootWebArea[^\n]*\burl="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("browser snapshot is missing its top-level URL");
  return match[1];
}

function textFromResult(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromResult).filter(Boolean).join("\n");
  if (value === null || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (value.content !== undefined) return textFromResult(value.content);
  if (value.result !== undefined) return textFromResult(value.result);
  return "";
}

function completedBrowserCalls(events) {
  const unexpected = events.filter(
    (event) =>
      event.type === "item.started" &&
      ["command_execution", "web_search", "file_change"].includes(event.item?.type),
  );
  if (unexpected.length > 0) throw new Error("capture driver invoked a non-browser tool");

  return events.flatMap((event) => {
    if (event.type !== "item.completed" || event.item?.type !== "mcp_tool_call") return [];
    const server = event.item.server ?? event.item.server_name;
    const tool = event.item.tool ?? event.item.name;
    if (server !== "replay_browser" || typeof tool !== "string") {
      throw new Error("capture driver invoked an unapproved MCP tool");
    }
    const text = textFromResult(event.item.result ?? event.item.output ?? event.item.content);
    if (text.length === 0) {
      throw new Error(
        `${tool}: browser tool returned no observation (${JSON.stringify({ result: event.item.result, error: event.item.error, status: event.item.status }).slice(0, 2000)})`,
      );
    }
    const result = JSON.parse(text);
    if (typeof result === "object" && result !== null && result.ok === false) return [];
    if (
      typeof result !== "object" ||
      result === null ||
      result.ok !== true ||
      typeof result.current_url !== "string" ||
      typeof result.snapshot !== "string" ||
      !Array.isArray(result.checkout_totals) ||
      !result.checkout_totals.every(
        (total) =>
          typeof total === "object" &&
          total !== null &&
          total.label === "Total" &&
          typeof total.amount === "string",
      )
    ) {
      throw new Error(`${tool}: browser tool returned an invalid observation`);
    }
    return [
      {
        tool,
        current_url: result.current_url,
        snapshot: result.snapshot,
        checkout_totals: result.checkout_totals,
      },
    ];
  });
}

function evidenceContainsMoney(evidence, cents) {
  const dollars = Math.floor(cents / 100);
  const alternatives = [...new Set([String(dollars), dollars.toLocaleString("en-US")])]
    .map((value) => value.replaceAll(",", "\\,"))
    .join("|");
  const fractional = cents % 100;
  const decimal = fractional === 0 ? "(?:\\.00)?" : `\\.${String(fractional).padStart(2, "0")}`;
  return new RegExp(`\\$\\s?(?:${alternatives})${decimal}(?![\\d.])`).test(evidence);
}

function moneyToCents(value) {
  const match = value.match(/^\$\s*(\d[\d,]*)(?:\.(\d{2}))?$/);
  if (match === null) return undefined;
  return Number((match[1] ?? "0").replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

function labeledCheckoutTotal(call) {
  const totals = [
    ...new Set(
      call.checkout_totals
        .filter((observation) => observation.label === "Total")
        .map((observation) => moneyToCents(observation.amount))
        .filter((value) => value !== undefined),
    ),
  ];
  return totals.length === 1 ? totals[0] : undefined;
}

export function validateGroundedCapture(events, endState, task) {
  const calls = completedBrowserCalls(events);
  if (calls.length === 0 || calls[0]?.tool !== "browser_open") {
    throw new Error(`${task.task_id}: capture did not begin with the constrained browser`);
  }

  if (!isEndState(endState))
    throw new Error(`${task.task_id}: driver returned an invalid end state`);
  if (!endStatesMatch(endState, task.expected_end_state)) {
    throw new Error(
      `${task.task_id}: observed end state does not exactly match ground truth (${JSON.stringify(endState)})`,
    );
  }

  const startUrl =
    task.bucket === "repeat"
      ? `https://whitejade.xyz/cart/${encodeURIComponent(task.params.product_variant_id)}:1`
      : task.entry_url;
  const allowedHosts = allowedHostsFor(startUrl);
  for (const call of calls) {
    if (!isAllowedTopLevelUrl(call.current_url, allowedHosts)) {
      throw new Error(`${task.task_id}: browser left the task domain`);
    }
  }

  const expectedTitles = task.expected_end_state.line_items.map((item) =>
    item.title_contains.toLowerCase(),
  );
  const observationHasExpectedTitles = (call) => {
    const snapshot = call.snapshot.toLowerCase();
    return expectedTitles.every((title) => snapshot.includes(title));
  };
  const reachedExpectedState = calls.some((call) => {
    const url = new URL(call.current_url);
    if (task.expected_end_state.reached === "checkout_review") {
      const emailValue = `"value":"replay-eval+${task.task_id}@trustysquire.ai"`;
      const reviewMarker =
        call.snapshot.includes(emailValue) &&
        /"value":"123 Test St(?:reet)?(?:[",])/i.test(call.snapshot) &&
        call.snapshot.includes('"value":"10001"') &&
        /payment|pay\s*now|billing address|review order/i.test(call.snapshot);
      return (
        url.pathname.includes("/checkouts/") &&
        reviewMarker &&
        observationHasExpectedTitles(call) &&
        labeledCheckoutTotal(call) === task.expected_end_state.total_cents
      );
    }
    return (
      url.pathname.includes("/products/") &&
      observationHasExpectedTitles(call) &&
      evidenceContainsMoney(call.snapshot, task.expected_end_state.total_cents)
    );
  });
  if (!reachedExpectedState) {
    throw new Error(`${task.task_id}: no single browser observation proves the expected end state`);
  }

  const evidence = calls
    .map((call) =>
      JSON.stringify({ snapshot: call.snapshot, checkout_totals: call.checkout_totals }),
    )
    .join("\n");

  return {
    browser_observations: calls.length,
    evidence_sha256: createHash("sha256").update(evidence).digest("hex"),
    capture_policy: CAPTURE_POLICY,
  };
}

export function buildCaptureEnvironment(source) {
  const codeHome = source.CODEX_HOME ?? resolve(homedir(), ".codex");
  const environment = {
    CODEX_HOME: codeHome,
    HOME: homedir(),
    LANG: source.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (typeof source[key] === "string" && source[key].length > 0) environment[key] = source[key];
  }
  return environment;
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function buildCodexArguments({
  model,
  mcpServerPath,
  browserConfig,
  disabledMcpServers = [],
}) {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "skill_search",
    "--disable",
    "multi_agent",
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "-c",
    `mcp_servers.replay_browser.command=${tomlString(process.execPath)}`,
    "-c",
    `mcp_servers.replay_browser.args=[${tomlString(mcpServerPath)}]`,
    "-c",
    `mcp_servers.replay_browser.env.REPLAY_CAPTURE_BROWSER_CONFIG=${tomlString(JSON.stringify(browserConfig))}`,
    "-c",
    "mcp_servers.replay_browser.startup_timeout_sec=30",
    "-c",
    'approval_policy="never"',
    "-c",
    "mcp_servers.replay_browser.enabled=true",
    "-c",
    "mcp_servers.replay_browser.required=true",
    "-c",
    'mcp_servers.replay_browser.default_tools_approval_mode="approve"',
    "-c",
    'mcp_servers.replay_browser.enabled_tools=["browser_open","browser_snapshot","browser_click","browser_fill","browser_select","browser_press","browser_scroll","browser_wait"]',
    ...disabledMcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-m",
    model,
    "-",
  ];
}
