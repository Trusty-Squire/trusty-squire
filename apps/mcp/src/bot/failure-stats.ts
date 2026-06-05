// failure-stats.ts — quantify flakiness from run-outcome sidecars
// (docs/DESIGN-planner-navigation-eval.md, B2). DEV SCRIPT, not shipped.
//
// Reads the `<slug>-<runId>.outcome.json` sidecars (A2) from a capture dir and
// prints the "where is the noise" map: a per-stage failure histogram + a
// per-service pass-rate table with variance. Run it after a K×M housekeeper
// batch to see which terminal stage dominates the failures — then attack that
// one (B3), re-running this to measure the drop instead of guessing.
//
//   Run: cd apps/mcp && npx tsx src/bot/failure-stats.ts [captureDir]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveCaptureDir,
  type OnboardingOutcomeFile,
} from "./onboarding-capture.js";
import { ALL_FAILURE_STAGES, type FailureStage } from "./failure-stage.js";

export interface ServiceStat {
  service: string;
  runs: number;
  passes: number;
  passRate: number; // 0..1
}

export interface FailureStats {
  totalRuns: number;
  totalPasses: number;
  overallPassRate: number;
  // failures bucketed by stage (successes counted under "none")
  stageHistogram: Record<FailureStage, number>;
  perService: ServiceStat[]; // sorted ascending by passRate (worst first)
  // population variance of per-service pass rates — the flakiness spread.
  // Low = uniform behavior; high = some services much flakier than others.
  passRateVariance: number;
}

// Pure core — exported for testing. Aggregates a flat list of outcome records.
export function aggregateOutcomes(
  outcomes: readonly OnboardingOutcomeFile[],
): FailureStats {
  const stageHistogram = Object.fromEntries(
    ALL_FAILURE_STAGES.map((s) => [s, 0]),
  ) as Record<FailureStage, number>;

  const byService = new Map<string, { runs: number; passes: number }>();
  let totalPasses = 0;

  for (const o of outcomes) {
    const stage = o.outcome.failure_stage;
    // a never-mapped value (corpus from an older build) lands in "other"
    if (stage in stageHistogram) stageHistogram[stage] += 1;
    else stageHistogram.other += 1;

    const svc = byService.get(o.service) ?? { runs: 0, passes: 0 };
    svc.runs += 1;
    if (o.outcome.ok) {
      svc.passes += 1;
      totalPasses += 1;
    }
    byService.set(o.service, svc);
  }

  const perService: ServiceStat[] = [...byService.entries()]
    .map(([service, s]) => ({
      service,
      runs: s.runs,
      passes: s.passes,
      passRate: s.runs === 0 ? 0 : s.passes / s.runs,
    }))
    .sort((a, b) => a.passRate - b.passRate || a.service.localeCompare(b.service));

  const rates = perService.map((s) => s.passRate);
  const mean = rates.length === 0 ? 0 : rates.reduce((a, b) => a + b, 0) / rates.length;
  const passRateVariance =
    rates.length === 0
      ? 0
      : rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length;

  const totalRuns = outcomes.length;
  return {
    totalRuns,
    totalPasses,
    overallPassRate: totalRuns === 0 ? 0 : totalPasses / totalRuns,
    stageHistogram,
    perService,
    passRateVariance,
  };
}

const OUTCOME_SUFFIX = ".outcome.json";

export function readOutcomes(dir: string): OnboardingOutcomeFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(OUTCOME_SUFFIX));
  } catch {
    return [];
  }
  const out: OnboardingOutcomeFile[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as OnboardingOutcomeFile);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function main(): void {
  const dir = process.argv[2] ?? resolveCaptureDir();
  if (dir === null) {
    console.error("[failure-stats] no capture dir — pass one as argv[2]");
    process.exitCode = 2;
    return;
  }
  const outcomes = readOutcomes(dir);
  const stats = aggregateOutcomes(outcomes);
  if (stats.totalRuns === 0) {
    console.log(`no outcome sidecars in ${dir} (runs predating A2 carry none).`);
    return;
  }

  console.log(
    `\n# ${stats.totalRuns} runs · ${pct(stats.overallPassRate)} pass · ` +
      `per-service variance ${stats.passRateVariance.toFixed(4)}\n`,
  );

  console.log("## failure stages (failures only)");
  const failures = ALL_FAILURE_STAGES.filter((s) => s !== "none").map((s) => ({
    stage: s,
    n: stats.stageHistogram[s],
  }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  for (const r of failures) console.log(`  ${r.stage.padEnd(16)} ${r.n}`);
  if (failures.length === 0) console.log("  (none)");

  console.log("\n## per-service pass rate (worst first)");
  for (const s of stats.perService) {
    console.log(`  ${s.service.padEnd(20)} ${s.passes}/${s.runs}  ${pct(s.passRate)}`);
  }
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
