import { describe, expect, it } from "vitest";
import { buildRouterInput } from "../fix-router-input.js";
import { clusterFailures } from "../fix-agent.js";
import type { FixBatch, FixBatchFailure } from "../fix-batch.js";
import type { FailureStats } from "../../bot/failure-stats.js";

const STATS: FailureStats = {
  totalRuns: 4,
  totalPasses: 1,
  overallPassRate: 1 / 4,
  stageHistogram: {} as FailureStats["stageHistogram"],
  perService: [
    { service: "flaky", runs: 3, passes: 1, passRate: 1 / 3 },
    { service: "dead", runs: 1, passes: 0, passRate: 0 },
    { service: "deterministic", runs: 1, passes: 0, passRate: 0 },
  ],
  passRateVariance: 0,
};

function failure(p: Partial<FixBatchFailure>): FixBatchFailure {
  return {
    service: "flaky",
    run_id: "r1",
    failure_stage: "planner_loop",
    terminal_round: null,
    capture_refs: [],
    signature: "sig",
    reproduce_count: 1,
    ...p,
  };
}

function batch(failures: FixBatchFailure[]): FixBatch {
  return {
    batch_id: "b1",
    bot_version: "0.0.0",
    generated_at: "2026-06-18T00:00:00.000Z",
    stats: STATS,
    failures,
  };
}

describe("buildRouterInput", () => {
  it("derives recent green rate from per-service pass rate", () => {
    const b = batch([failure({ service: "flaky" })]);
    const cluster = clusterFailures(b)[0]!;
    expect(buildRouterInput(cluster, b).recentGreenRate).toBeCloseTo(1 / 3);
  });

  it("uses each service's own green rate now that clusters are service-local", () => {
    const b = batch([
      failure({ service: "flaky", signature: "sig-shared" }),
      failure({ service: "deterministic", signature: "sig-shared" }),
    ]);
    const clusters = clusterFailures(b);
    const byService = new Map(clusters.map((c) => [c.services[0], buildRouterInput(c, b).recentGreenRate]));
    expect(byService.get("flaky")).toBeCloseTo(1 / 3);
    expect(byService.get("deterministic")).toBe(0);
  });

  it("folds explicit service facts into router input", () => {
    const b = batch([failure({ service: "dead" })]);
    const cluster = clusterFailures(b)[0]!;
    const input = buildRouterInput(cluster, b, {
      dead: { dnsAlive: false, curatedNeedsManual: true },
    });
    expect(input.dnsAlive).toBe(false);
    expect(input.curatedNeedsManual).toBe(true);
  });
});
