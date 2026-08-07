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

const SENSITIVE_ARTIFACT_NAME =
  /cookie|authorization|(?:^|[-_])(?:token|session|csrf|xsrf)(?:$|[-_])/i;
const SENSITIVE_ARTIFACT_QUERY =
  /^(?:shop_pay_token|checkout_token|token|access_token|refresh_token|session|session_id|auth|authorization|_r|_su_rec|ur_back_url|ur_verify|tracking_unique|tracking_visit)$/i;

function isShopCheckoutUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase() === "shop.app" && /\/checkouts?\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isSensitiveCartRedirect(entry) {
  const request = entry?.request;
  const response = entry?.response;
  if (String(request?.method ?? "").toUpperCase() !== "POST") return false;
  try {
    if (new URL(String(request?.url ?? "")).pathname !== "/cart") return false;
  } catch {
    return false;
  }
  const redirects = [
    response?.redirectURL,
    ...(Array.isArray(response?.headers)
      ? response.headers
          .filter((header) => String(header?.name ?? "").toLowerCase() === "location")
          .map((header) => header?.value)
      : []),
  ];
  return redirects.some((value) => isShopCheckoutUrl(String(value ?? "")));
}

export function sanitizeArtifactUrl(value) {
  try {
    const parsed = new URL(value);
    const checkoutPath = parsed.pathname.match(/\/checkouts?\//i);
    if (checkoutPath?.index !== undefined) {
      parsed.pathname = `${parsed.pathname.slice(0, checkoutPath.index + checkoutPath[0].length)}redacted`;
      parsed.search = "";
      parsed.hash = "";
      return parsed.href;
    }
    for (const name of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_ARTIFACT_QUERY.test(name)) parsed.searchParams.delete(name);
    }
    return parsed.href;
  } catch {
    return value;
  }
}

function sanitizeArtifactText(value) {
  return value
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => sanitizeArtifactUrl(url))
    .replace(
      /((?:shop_pay_token|checkout_token|access_token|refresh_token|session_id|authorization|_su_rec|_r)=)[^&\s"'<>\\]*/gi,
      "$1redacted",
    );
}

function sanitizeHarHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((header) => !SENSITIVE_ARTIFACT_NAME.test(String(header?.name ?? "")))
    .map((header) => ({
      ...header,
      value: sanitizeArtifactText(String(header?.value ?? "")),
    }));
}

export function sanitizeReplayHar(har) {
  if (har === null || typeof har !== "object" || !Array.isArray(har.log?.entries)) {
    throw new Error("invalid HAR artifact");
  }
  har.log.entries = har.log.entries.filter((entry) => !isSensitiveCartRedirect(entry));
  for (const entry of har.log.entries) {
    const request = entry.request ?? {};
    request.url = sanitizeArtifactUrl(String(request.url ?? ""));
    request.headers = sanitizeHarHeaders(request.headers);
    request.cookies = [];
    if (Array.isArray(request.queryString)) {
      request.queryString = request.queryString.filter(
        (parameter) => !SENSITIVE_ARTIFACT_QUERY.test(String(parameter?.name ?? "")),
      );
    }
    if (request.postData !== undefined) {
      if (typeof request.postData.text === "string") {
        request.postData.text = sanitizeArtifactText(request.postData.text);
      }
      if (Array.isArray(request.postData.params)) {
        request.postData.params = request.postData.params.filter(
          (parameter) => !SENSITIVE_ARTIFACT_NAME.test(String(parameter?.name ?? "")),
        );
      }
    }
    entry.request = request;

    const response = entry.response ?? {};
    response.headers = sanitizeHarHeaders(response.headers);
    response.cookies = [];
    response.redirectURL = sanitizeArtifactUrl(String(response.redirectURL ?? ""));
    if (typeof response.content?.text === "string") {
      response.content.text = sanitizeArtifactText(response.content.text);
    }
    entry.response = response;
  }
  return har;
}

export function buildGroundingDiagnostic(task, observations, final, reason) {
  const expectedTitles = task.expected_end_state.line_items.map((item) => item.title_contains);
  return {
    schema_version: 1,
    task_id: task.task_id,
    status: "grounding_failed",
    reason,
    final_agent_message_sha256: createHash("sha256").update(final).digest("hex"),
    observations: observations.map((observation) => ({
      tool: observation.tool,
      url: sanitizeArtifactUrl(observation.current_url),
      checkout_totals: observation.checkout_totals,
      captured_line_items: expectedTitles.filter((title) =>
        observation.snapshot.toLowerCase().includes(title.toLowerCase()),
      ),
      snapshot_sha256: createHash("sha256").update(observation.snapshot).digest("hex"),
    })),
  };
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

/**
 * Failure diagnostics retain the actual constrained-browser observations.  The
 * success path still hashes evidence; this returns no invented interpretation
 * and is used only to explain a rejected grounding attempt.
 */
export function captureBrowserObservations(events) {
  return completedBrowserCalls(events);
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

  const startUrl = task.entry_url;
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
  const reachedExpectedState = (() => {
    if (task.expected_end_state.reached !== "checkout_review") {
      return calls.some((call) => {
        const url = new URL(call.current_url);
        return (
          url.pathname.includes("/products/") &&
          observationHasExpectedTitles(call) &&
          evidenceContainsMoney(call.snapshot, task.expected_end_state.total_cents)
        );
      });
    }
    // Shopify initially renders the subtotal as a labeled Total, then updates
    // shipping and the final total after address/method resolution.  A title
    // can disappear from the later compact snapshot, so prove checkout review
    // over the sequence: item evidence and review form evidence may precede the
    // *final* labeled total, but the final total itself must be exact.
    const checkoutCalls = calls.filter((call) =>
      new URL(call.current_url).pathname.includes("/checkouts/"),
    );
    const emailValue = `"value":"replay-eval+${task.task_id}@trustysquire.ai"`;
    const reviewObserved = checkoutCalls.some(
      (call) =>
        call.snapshot.includes(emailValue) &&
        /"value":"123 Test St(?:reet)?(?:[",])/i.test(call.snapshot) &&
        call.snapshot.includes('"value":"10001"') &&
        /payment|pay\s*now|billing address|review order/i.test(call.snapshot),
    );
    const itemObserved = checkoutCalls.some(observationHasExpectedTitles);
    const labeledTotals = checkoutCalls
      .map(labeledCheckoutTotal)
      .filter((total) => total !== undefined);
    const settledTotal = labeledTotals.at(-1);
    return (
      reviewObserved &&
      itemObserved &&
      settledTotal === task.expected_end_state.total_cents
    );
  })();
  if (!reachedExpectedState) {
    throw new Error(`${task.task_id}: checkout review sequence did not prove the expected end state`);
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
    `mcp_servers.replay_browser.args=[${tomlString("--import=tsx")},${tomlString(mcpServerPath)}]`,
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
    'mcp_servers.replay_browser.enabled_tools=["browser_open","browser_snapshot","browser_click","browser_fill","browser_select","browser_press","browser_scroll","browser_wait","browser_finalize_recipe"]',
    ...disabledMcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-m",
    model,
    "-",
  ];
}
