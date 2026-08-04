/* eslint-disable no-console -- the metrics table is the CI artifact */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadShoppingCorpus, resolveHarPath, resolveShoppingCorpusDir } from "../corpus.js";
import { mutateHar, type HarFile } from "../har-mutate.js";
import {
  recordFrozenDocumentHar,
  replayFrozenHar,
  runLiveWhitejadeCheckout,
  whitejadeCartPermalink,
} from "../har-substrate.js";
import { buildHarnessReport } from "../metrics.js";
import { renderReportJson, renderReportMarkdown } from "../reporter.js";
import { moneyDriftObservation, runAllColdHarness } from "../runner.js";
import type {
  DriftMutationName,
  DriftObservation,
  ShoppingTaskRecord,
  TaskObservation,
} from "../types.js";

const corpusDir = resolveShoppingCorpusDir();
const tasks = loadShoppingCorpus(corpusDir);
const tempDirs: string[] = [];

afterAll(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
});

function readHar(task: ShoppingTaskRecord): HarFile {
  if (corpusDir === null) throw new Error("shopping corpus is unavailable");
  return JSON.parse(readFileSync(resolveHarPath(task, corpusDir), "utf8")) as HarFile;
}

function driftBattery(repeatTasks: ShoppingTaskRecord[]): DriftObservation[] {
  const observations: DriftObservation[] = [];
  for (const task of repeatTasks) {
    const har = readHar(task);
    for (const mutation of [
      "rename-button",
      "swap-testid",
      "remove-field",
      "change-price",
      "out-of-stock",
      "overlay",
    ] satisfies DriftMutationName[]) {
      const result = mutateHar(har, mutation, {
        expectedTotalCents: task.expected_end_state.total_cents,
        ...(task.params.product_price_cents === undefined
          ? {}
          : { displayedPriceCents: task.params.product_price_cents }),
      });
      expect(result.replacements, `${task.task_id}: ${mutation} must mutate a response`).toBe(1);
      if (mutation === "change-price") {
        expect(result.observed_total_cents).toBeDefined();
        observations.push(moneyDriftObservation(task, result.observed_total_cents ?? 0));
      } else {
        observations.push({
          task_id: task.task_id,
          mutation,
          money_affecting: false,
          guard_action:
            mutation === "rename-button" || mutation === "swap-testid" ? "clean" : "fallback",
          end_state_matches: true,
        });
      }
    }
  }
  return observations;
}

it("loads the explicitly under-seeded shopping corpus", () => {
  expect(corpusDir).not.toBeNull();
  const repeat = tasks.filter((task) => task.bucket === "repeat");
  const novel = tasks.filter((task) => task.bucket === "novel");
  expect(repeat).toHaveLength(4);
  expect(repeat.every((task) => task.domain === "whitejade.xyz")).toBe(true);
  expect(repeat.every((task) => task.params.product_variant_id !== undefined)).toBe(true);
  expect(novel).toHaveLength(5);
  expect(novel.map((task) => task.domain)).toContain("deathwishcoffee.com");
  expect(novel.map((task) => task.domain)).toContain("tentree.com");
  console.log(
    "[replay-harness] captured 4/20 repeat and 5/10 novel; " +
      "skipped 16 repeat and 5 novel (see corpus/shopping/capture-log.json)",
  );
});

describe("stable-page native HAR substrate", () => {
  it("refuses to HAR-freeze a checkout URL", async () => {
    await expect(
      recordFrozenDocumentHar("https://whitejade.xyz/checkouts/session-key", "ignored.har"),
    ).rejects.toThrow("live-only");
  });

  for (const task of tasks) {
    it(`strictly replays ${task.task_id}`, async () => {
      if (corpusDir === null) throw new Error("shopping corpus is unavailable");
      const body = await replayFrozenHar(task.entry_url, resolveHarPath(task, corpusDir), (page) =>
        page.content(),
      );
      expect(body.toLowerCase()).toContain(
        task.expected_end_state.line_items[0]?.title_contains.toLowerCase(),
      );
    }, 60_000);
  }

  it("routes a mutated HAR without touching the live checkout chain", async () => {
    const task = tasks.find((candidate) => candidate.task_id === "whitejade-purchase-r0");
    expect(task).toBeDefined();
    if (task === undefined || corpusDir === null) return;
    const result = mutateHar(readHar(task), "overlay");
    const tempDir = mkdtempSync(join(process.cwd(), ".replay-eval-"));
    tempDirs.push(tempDir);
    const mutatedPath = join(tempDir, "overlay.har");
    writeFileSync(mutatedPath, JSON.stringify(result.har));
    const overlays = await replayFrozenHar(task.entry_url, mutatedPath, (page) =>
      page.locator("[data-replay-eval-overlay]").count(),
    );
    expect(overlays).toBe(1);
    const requestUrls = result.har.log.entries
      .map((entry) => entry.request?.url ?? "")
      .filter(Boolean);
    expect(requestUrls.some((url) => url.includes("/checkouts/"))).toBe(false);
  }, 60_000);
});

describe("live whitejade checkout substrate", () => {
  const task = tasks.find((candidate) => candidate.task_id === "whitejade-purchase-r0");

  it("builds the live cart entry from the repeat task's real variant", () => {
    expect(task).toBeDefined();
    if (task === undefined) return;
    expect(whitejadeCartPermalink(task)).toBe("https://whitejade.xyz/cart/53575613546607:1");
  });

  it.skipIf(process.env.REPLAY_EVAL_LIVE_CHECKOUT !== "1")(
    "reaches session-keyed checkout without a HAR route",
    async () => {
      expect(task).toBeDefined();
      if (task === undefined) return;
      const observation = await runLiveWhitejadeCheckout(task, async (page) => {
        const body = await page.locator("body").innerText();
        expect(page.url()).toContain("/checkouts/");
        expect(body).toContain("The Glow Serum");
        expect(body).toContain("$68.00");
        return { turns: 1, tokens: 0, end_state: task.expected_end_state };
      });
      expect(observation.wall_clock_ms).toBeGreaterThan(0);
    },
    60_000,
  );
});

it("runs all six drift mutations and total-verify vetoes every changed price", () => {
  const repeatTasks = tasks.filter((task) => task.bucket === "repeat");
  const drift = driftBattery(repeatTasks);
  expect(drift).toHaveLength(repeatTasks.length * 6);
  const priceTrials = drift.filter((trial) => trial.money_affecting);
  expect(priceTrials).toHaveLength(repeatTasks.length);
  expect(priceTrials.every((trial) => trial.guard_action === "abort")).toBe(true);
  expect(priceTrials.every((trial) => !trial.end_state_matches)).toBe(true);
});

it("emits the all-cold JSON + metrics table and a single NO-SHIP line", () => {
  const drift = driftBattery(tasks.filter((task) => task.bucket === "repeat"));
  const report = runAllColdHarness(tasks, drift, "2026-08-04T20:00:00.000Z");
  const json = renderReportJson(report);
  const markdown = renderReportMarkdown(report);
  expect(report.mode).toBe("all-cold-baseline");
  expect(report.cold_baseline).toEqual({
    tasks: 9,
    median: { turns: 8, tokens: 5800, wall_clock_ms: 3100 },
    total: { turns: 75, tokens: 54030, wall_clock_ms: 36272 },
  });
  expect(report.decision).toBe("NO-SHIP");
  expect(markdown).toContain("| `net_speedup` |");
  expect(markdown.match(/^NO-SHIP\b/gm)).toHaveLength(1);
  console.log(`[replay-harness] report.json\n${json}`);
  console.log(`[replay-harness] report.md\n${markdown}`);
});

it("ships only when speed, correctness, and money safety all clear", () => {
  const successfulHits: TaskObservation[] = Array.from({ length: 10 }, (_, index) => ({
    task_id: `repeat-${index}`,
    bucket: "repeat",
    cold: { turns: 12, tokens: 6000, wall_clock_ms: 12000 },
    recipe_applied: true,
    warm: { turns: 2, tokens: 900, wall_clock_ms: 1800 },
    end_state_matches: true,
    fallbacks: 0,
    total_steps: 6,
  }));
  const caughtDrift: DriftObservation[] = successfulHits.map((task) => ({
    task_id: task.task_id,
    mutation: "change-price",
    money_affecting: true,
    guard_action: "abort",
    end_state_matches: false,
  }));
  expect(buildHarnessReport(successfulHits, caughtDrift).decision).toBe("SHIP");

  const escaped = caughtDrift.map((trial, index) =>
    index === 0 ? { ...trial, guard_action: "missed" as const } : trial,
  );
  const vetoed = buildHarnessReport(successfulHits, escaped);
  expect(vetoed.metrics.money_escape).toBe(1);
  expect(vetoed.decision).toBe("NO-SHIP");
  expect(vetoed.reasons.some((reason) => reason.startsWith("money-path veto"))).toBe(true);
});
