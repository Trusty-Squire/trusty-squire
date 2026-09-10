// Run with Node against built artifacts and an isolated HOME/config. --source-root selects the checkout
// under measurement; use the same script and fixtures for both revisions.
import { chromium } from "playwright";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--source-root") || !args.includes("--out"))
  throw new Error("Expected --source-root <checkout> --out <json>");
const root = resolve(option("--source-root"));
const { BrowserController } = await import(
  pathToFileURL(resolve(root, "apps/mcp/dist/bot/browser.js")).href
);
const { startHarnessProvisionSession, observe, observeQuery, finishProvisionSession } =
  await import(pathToFileURL(resolve(root, "apps/mcp/dist/bot/provision-session.js")).href);
const fixtures = [
  {
    name: "settings",
    labels: ["Create API key", "Key name", "Update password"],
    html: `<main><h1>Account settings</h1><nav><a href="#">Projects</a></nav><form aria-label="API keys"><label>Key name<input></label><button>Create API key</button></form><form><label>New password<input type="password"></label><button>Update password</button></form></main>`,
  },
  {
    name: "key-table",
    labels: ["Create API key", "Copy key", "Revoke key"],
    html: `<main><h1>API keys</h1><button>Create API key</button><table>${Array.from({ length: 80 }, (_, index) => `<tr><td>Fixture key ${index}</td><td><button aria-label="Copy key ${index}">Copy key</button><button aria-label="Revoke key ${index}">Revoke key</button></td></tr>`).join("")}</table></main>`,
  },
];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
const percentile = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
try {
  for (const fixture of fixtures) {
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture.html }),
    );
    const page = await context.newPage();
    await page.goto(`https://performance.test/${fixture.name}`);
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: page.url(),
      observationFormat: "browser-use-dom",
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const measurements = { full: [], query: [] };
    const bytes = { full: [], query: [] };
    const cpuBefore = process.cpuUsage();
    let recall;
    let retainedDom = started.dom ?? "";
    const recallEvidence = [];
    try {
      for (let iteration = -5; iteration < 30; iteration++) {
        for (const mode of ["full", "query"]) {
          const before = performance.now();
          const result =
            mode === "full"
              ? await observe(started.session_id, "full")
              : await observeQuery(started.session_id, "");
          const elapsed = performance.now() - before;
          const serialized = JSON.stringify(result);
          if (iteration >= 0) {
            measurements[mode].push(elapsed);
            bytes[mode].push(Buffer.byteLength(serialized));
          }
          if (mode === "full") {
            if (typeof result.dom === "string") retainedDom = result.dom;
            recall = fixture.labels.every((label) => retainedDom.includes(label));
          }
        }
      }
      // Query output is paged; prove recall with exact-name queries as well.
      const queryRecall = [];
      for (const label of fixture.labels) {
        const result = await observeQuery(started.session_id, label);
        const alias = "@" + label.toLowerCase().replace(/\s+/g, "-");
        const role = label === "Key name" ? "t" : "b";
        queryRecall.push(
          (result.safe_table ?? []).some(
            (row) =>
              row[1] === role &&
              (row[2]?.split("|")[0] === alias || row[2]?.split("|")[0]?.startsWith(alias + "-")),
          ),
        );
        recallEvidence.push({ label, result });
      }
      const metrics = await cdp.send("Performance.getMetrics");
      results.push({
        fixture: fixture.name,
        warmups: 5,
        samples: 30,
        p95_ms: { full: percentile(measurements.full), query: percentile(measurements.query) },
        mean_bytes: Object.fromEntries(
          Object.entries(bytes).map(([key, values]) => [
            key,
            values.reduce((a, b) => a + b, 0) / values.length,
          ]),
        ),
        labeled_control_recall: recall && queryRecall.every(Boolean),
        recall_evidence: { retained_dom: retainedDom, queries: recallEvidence },
        process_cpu_microseconds: process.cpuUsage(cpuBefore),
        process_memory_bytes: process.memoryUsage(),
        browser_metrics: Object.fromEntries(
          metrics.metrics
            .filter(({ name }) =>
              ["TaskDuration", "JSHeapUsedSize", "JSHeapTotalSize"].includes(name),
            )
            .map(({ name, value }) => [name, value]),
        ),
      });
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
if (args.includes("--baseline")) {
  const baseline = JSON.parse(await readFile(option("--baseline"), "utf8"));
  for (const result of results) {
    const previous = baseline.results.find((item) => item.fixture === result.fixture);
    if (previous === undefined) throw new Error("Baseline fixture is missing");
    result.p95_ratio = Object.fromEntries(
      Object.entries(result.p95_ms).map(([mode, value]) => [mode, value / previous.p95_ms[mode]]),
    );
  }
}
await writeFile(
  option("--out"),
  JSON.stringify({ source_root: root, measured_at: new Date().toISOString(), results }, null, 2) +
    "\n",
);
if (
  results.some(
    (result) =>
      !result.labeled_control_recall ||
      Object.values(result.p95_ms).some((ms) => ms > 2_000) ||
      Object.values(result.p95_ratio ?? {}).some((ratio) => ratio > 1.2),
  )
)
  throw new Error(
    "Observation latency, relative performance, or control recall gate failed; inspect evidence",
  );
