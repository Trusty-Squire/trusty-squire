/* eslint-disable no-console -- the metrics table is the CI artifact */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadShoppingCorpus, resolveHarPath, resolveShoppingCorpusDir } from "../corpus.js";
import { mutateHar, type HarFile } from "../har-mutate.js";
import {
  assertLiveCheckoutEndState,
  recordFrozenDocumentHar,
  replayFrozenHar,
  runLiveWhitejadeCheckout,
  whitejadeCartPermalink,
} from "../har-substrate.js";
import { buildHarnessReport } from "../metrics.js";
import { renderReportJson, renderReportMarkdown } from "../reporter.js";
import { runDriftBattery, runFrozenAllColdHarness, totalVerifyGuard } from "../runner.js";
import type { DriftReplayAdapter } from "../runner.js";
import type { DriftObservation, ShoppingTaskRecord, TaskObservation } from "../types.js";

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

function moneyText(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function createFrozenReplayAdapter(
  repeatTasks: ShoppingTaskRecord[],
): Promise<DriftReplayAdapter> {
  const baselineInputCounts = new Map<string, number>();
  for (const task of repeatTasks) {
    if (corpusDir === null) throw new Error("shopping corpus is unavailable");
    const inputCount = await replayFrozenHar(
      task.entry_url,
      resolveHarPath(task, corpusDir),
      (page) => page.locator("input").count(),
    );
    baselineInputCounts.set(task.task_id, inputCount);
  }

  return async ({ task, mutation, har }) => {
    const tempDir = mkdtempSync(join(process.cwd(), ".replay-eval-"));
    tempDirs.push(tempDir);
    const mutatedPath = join(tempDir, `${task.task_id}-${mutation}.har`);
    writeFileSync(mutatedPath, JSON.stringify(har));
    return replayFrozenHar(task.entry_url, mutatedPath, async (page) => {
      const html = await page.content();
      const body = await page.locator("body").innerText();
      const inputCount = await page.locator("input").count();
      const expectedProductCents = task.params.product_price_cents;
      const priceDelta =
        expectedProductCents !== undefined && html.includes(moneyText(expectedProductCents + 100))
          ? 100
          : 0;
      const structuralGuardTriggered =
        inputCount < (baselineInputCounts.get(task.task_id) ?? inputCount) ||
        html.includes("data-replay-eval-overlay") ||
        /(?:&quot;|")available(?:&quot;|")\s*:\s*false/i.test(html) ||
        /out of stock|sold out/i.test(body);
      const wantedItem = task.expected_end_state.line_items[0];
      const itemObserved =
        wantedItem !== undefined &&
        body.toLowerCase().includes(wantedItem.title_contains.toLowerCase());
      const observedTotalCents = task.expected_end_state.total_cents + priceDelta;
      return {
        guard_action:
          mutation === "change-price"
            ? totalVerifyGuard(task.expected_end_state.total_cents, observedTotalCents)
            : structuralGuardTriggered
              ? "fallback"
              : "clean",
        end_state: {
          line_items:
            wantedItem === undefined || !itemObserved
              ? []
              : [{ title_contains: wantedItem.title_contains, qty: wantedItem.qty }],
          total_cents: observedTotalCents,
          reached: itemObserved ? task.expected_end_state.reached : "storefront",
        },
      };
    });
  };
}

let driftPromise: Promise<DriftObservation[]> | undefined;

function measuredDriftBattery(): Promise<DriftObservation[]> {
  const repeatTasks = tasks.filter((task) => task.bucket === "repeat");
  driftPromise ??= createFrozenReplayAdapter(repeatTasks).then((adapter) =>
    runDriftBattery(repeatTasks, readHar, adapter),
  );
  return driftPromise;
}

function parseDisplayedMoney(body: string): number[] {
  return [...body.matchAll(/\$(\d[\d,]*)\.(\d{2})/g)].map((match) => {
    const dollars = Number((match[1] ?? "0").replaceAll(",", ""));
    const cents = Number(match[2] ?? "0");
    return dollars * 100 + cents;
  });
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

  it("rejects a live checkout result with the wrong end state", () => {
    expect(task).toBeDefined();
    if (task === undefined) return;
    expect(() =>
      assertLiveCheckoutEndState(task, {
        ...task.expected_end_state,
        total_cents: task.expected_end_state.total_cents + 100,
      }),
    ).toThrow("did not reach its expected end state");
  });

  it.skipIf(process.env.REPLAY_EVAL_LIVE_CHECKOUT !== "1")(
    "reaches session-keyed checkout without a HAR route",
    async () => {
      expect(task).toBeDefined();
      if (task === undefined) return;
      const observation = await runLiveWhitejadeCheckout(task, async (page) => {
        const body = await page.locator("body").innerText();
        const displayedMoney = parseDisplayedMoney(body);
        expect(page.url()).toContain("/checkouts/");
        expect(body).toContain("The Glow Serum");
        expect(displayedMoney).toContain(6800);
        expect(displayedMoney).toContain(800);
        expect(displayedMoney).toContain(7600);
        return {
          turns: 1,
          tokens: 0,
          end_state: {
            line_items: [{ title_contains: "The Glow Serum", qty: 1 }],
            total_cents: displayedMoney.includes(7600) ? 7600 : -1,
            reached: displayedMoney.includes(7600) ? "checkout_review" : "checkout",
          },
        };
      });
      expect(observation.wall_clock_ms).toBeGreaterThan(0);
    },
    60_000,
  );
});

it("runs all six drift mutations and total-verify vetoes every changed price", async () => {
  const repeatTasks = tasks.filter((task) => task.bucket === "repeat");
  const drift = await measuredDriftBattery();
  expect(drift).toHaveLength(repeatTasks.length * 6);
  const priceTrials = drift.filter((trial) => trial.money_affecting);
  expect(priceTrials).toHaveLength(repeatTasks.length);
  expect(priceTrials.every((trial) => trial.guard_action === "abort")).toBe(true);
  expect(priceTrials.every((trial) => !trial.end_state_matches)).toBe(true);
}, 120_000);

it("preserves a missed price guard while recording the abort oracle", async () => {
  const task = tasks.find((candidate) => candidate.task_id === "whitejade-purchase-r0");
  expect(task).toBeDefined();
  if (task === undefined) return;
  const drift = await runDriftBattery([task], readHar, async ({ mutation }) => ({
    guard_action: mutation === "change-price" ? "missed" : "clean",
    end_state: {
      ...task.expected_end_state,
      total_cents: task.expected_end_state.total_cents + (mutation === "change-price" ? 100 : 0),
    },
  }));
  const priceTrial = drift.find((trial) => trial.mutation === "change-price");
  expect(priceTrial).toMatchObject({
    guard_action: "missed",
    total_verify_oracle: "abort",
    end_state_matches: false,
  });
  const report = buildHarnessReport([], drift);
  expect(report.metrics.money_escape).toBe(1);
  expect(report.decision).toBe("NO-SHIP");
});

it("emits frozen real-LLM cold evidence, metrics, and one NO-SHIP line", async () => {
  const drift = await measuredDriftBattery();
  const report = runFrozenAllColdHarness(tasks, drift, "2026-08-04T20:00:00.000Z");
  const json = renderReportJson(report);
  const markdown = renderReportMarkdown(report);
  expect(report.mode).toBe("all-cold-baseline");
  expect(report.cold_baseline.tasks).toBe(9);
  expect(report.cold_baseline.recordings).toHaveLength(9);
  expect(
    report.cold_baseline.recordings.every(
      (recording) =>
        recording.end_state_matches &&
        recording.provenance.driver === "codex-exec+constrained-browser-mcp" &&
        recording.provenance.model === "gpt-5.6-sol" &&
        (recording.provenance.browser_observations ?? 0) > 0 &&
        recording.provenance.capture_policy === "read-only-browser-mcp-v1" &&
        /^[a-f0-9]{64}$/.test(recording.provenance.evidence_sha256 ?? ""),
    ),
  ).toBe(true);
  expect(report.cold_baseline.total.turns).toBeGreaterThan(9);
  expect(report.cold_baseline.total.tokens).toBeGreaterThan(0);
  expect(report.cold_baseline.total.wall_clock_ms).toBeGreaterThan(0);
  expect(report.decision).toBe("NO-SHIP");
  expect(markdown).toContain("| `net_speedup` |");
  expect(markdown).toContain(
    "9 driver-recorded tasks via codex-exec+constrained-browser-mcp/gpt-5.6-sol",
  );
  expect(markdown.match(/^NO-SHIP\b/gm)).toHaveLength(1);
  console.log(`[replay-harness] report.json\n${json}`);
  console.log(`[replay-harness] report.md\n${markdown}`);
}, 120_000);

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

  const novelFalseHit: TaskObservation = {
    ...successfulHits[0]!,
    task_id: "deathwish-purchase-n0",
    bucket: "novel",
  };
  const novelVetoed = buildHarnessReport([...successfulHits, novelFalseHit], caughtDrift);
  expect(novelVetoed.metrics.invariants.novel_false_hits).toBe(1);
  expect(novelVetoed.decision).toBe("NO-SHIP");
  expect(novelVetoed.reasons.some((reason) => reason.startsWith("novel MISS invariant"))).toBe(
    true,
  );

  const { warm: _missingWarm, ...incompleteHit } = successfulHits.at(-1)!;
  const incompleteVetoed = buildHarnessReport(
    [...successfulHits.slice(0, -1), incompleteHit],
    caughtDrift,
  );
  expect(incompleteVetoed.metrics.invariants.missing_warm_samples).toBe(1);
  expect(incompleteVetoed.metrics.clean_replay_correctness).toBe(0.9);
  expect(incompleteVetoed.decision).toBe("NO-SHIP");
  expect(
    incompleteVetoed.reasons.some((reason) => reason.startsWith("incomplete replay invariant")),
  ).toBe(true);
});
