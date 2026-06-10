import { describe, it, expect, vi } from "vitest";
import {
  clusterFailures,
  firstOutOfBoundsPath,
  runFixAgent,
  WallError,
  type FixProposal,
  type GateRunner,
} from "../fix-agent.js";
import { ReleaseFenceError } from "../release-guard.js";
import type { FixBatch, FixBatchFailure } from "../fix-batch.js";
import type { EvalGateResult } from "../../bot/eval-gate.js";
import type { FailureStats } from "../../bot/failure-stats.js";

// ── fixtures ─────────────────────────────────────────────────────────

const EMPTY_STATS = { totalRuns: 0, totalPasses: 0, overallPassRate: 0, stageHistogram: {}, perService: [], passRateVariance: 0 } as unknown as FailureStats;

function failure(p: Partial<FixBatchFailure>): FixBatchFailure {
  return {
    service: "svc",
    run_id: "r1",
    failure_stage: "planner_loop",
    terminal_round: 0,
    capture_refs: ["/cap/svc-r1-r0.json"],
    signature: "sig-aaaa",
    reproduce_count: 1,
    ...p,
  };
}

function batch(failures: FixBatchFailure[]): FixBatch {
  return {
    batch_id: "b1",
    bot_version: "0.9.0",
    generated_at: "2026-06-09T00:00:00.000Z",
    stats: EMPTY_STATS,
    failures,
  };
}

function gate(opts: { regressPassed: boolean; holdout: number; empty?: boolean }): EvalGateResult {
  return {
    regress: { passed: opts.regressPassed ? 10 : 8, total: 10, failures: opts.regressPassed ? [] : [{ id: "c1", service: "x", detail: "broke" }] },
    targetTune: { passed: 5, total: 10, failures: [] },
    targetHoldout: { passed: opts.holdout, total: 10, failures: [] },
    regressPassed: opts.regressPassed,
    emptyRegress: opts.empty ?? false,
  };
}

// A gate that returns a scripted sequence (first call = baseline).
function scriptedGate(seq: EvalGateResult[]): GateRunner {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)]!;
}

function proposal(touched: string[]): FixProposal {
  return {
    summary: "fix the thing",
    touched_paths: touched,
    apply: vi.fn(async () => undefined),
    revert: vi.fn(async () => undefined),
  };
}

const ALLOWED = ["apps/mcp/src/bot/agent.ts", "apps/mcp/src/bot/"];

// ── clustering ───────────────────────────────────────────────────────

describe("clusterFailures", () => {
  it("collapses failures sharing stage+signature across services into one cluster", () => {
    const clusters = clusterFailures(
      batch([
        failure({ service: "groq", signature: "sig-x" }),
        failure({ service: "meili", signature: "sig-x" }),
        failure({ service: "kinde", signature: "sig-y" }),
      ]),
    );
    expect(clusters).toHaveLength(2);
    const shared = clusters.find((c) => c.signature === "sig-x")!;
    expect(shared.services.sort()).toEqual(["groq", "meili"]);
  });

  it("separates same-signature but different-stage failures", () => {
    const clusters = clusterFailures(
      batch([
        failure({ signature: "sig-x", failure_stage: "extract" }),
        failure({ signature: "sig-x", failure_stage: "planner_loop" }),
      ]),
    );
    expect(clusters).toHaveLength(2);
  });
});

// ── path fence ───────────────────────────────────────────────────────

describe("firstOutOfBoundsPath", () => {
  it("passes paths under an allowed prefix", () => {
    expect(firstOutOfBoundsPath(["apps/mcp/src/bot/agent.ts"], ALLOWED)).toBeNull();
  });
  it("flags a path outside the allowed set", () => {
    expect(firstOutOfBoundsPath(["apps/mcp/src/bot/form-fill.ts", "apps/api/x.ts"], ["apps/mcp/src/bot/form-fill.ts"])).toBe("apps/api/x.ts");
  });
  it("forbids corpus/eval even when nominally allowed", () => {
    expect(firstOutOfBoundsPath(["apps/mcp/corpus/eval/regress/x.json"], ["apps/mcp/corpus/"])).toBe("apps/mcp/corpus/eval/regress/x.json");
  });
});

// ── orchestration ────────────────────────────────────────────────────

describe("runFixAgent", () => {
  const base = {
    branch: "staging",
    currentVersion: "0.9.0",
    allowedPaths: ALLOWED,
  };

  it("commits a fix that turns the gate green and bumps the rc", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: true, holdout: 5 })]),
      commit,
      log: () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed).toHaveLength(1);
    expect(res.committed[0]!.version).toBe("0.9.1-rc.1");
    expect(prop.apply).toHaveBeenCalledOnce();
    expect(prop.revert).not.toHaveBeenCalled();
  });

  it("iterates on a red gate then commits when green; reverts the failed attempt", async () => {
    const commit = vi.fn(async () => undefined);
    const p1 = proposal(["apps/mcp/src/bot/agent.ts"]);
    const p2 = proposal(["apps/mcp/src/bot/agent.ts"]);
    const props = [p1, p2];
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async (_c, attempt) => props[attempt - 1]!,
      gate: scriptedGate([
        gate({ regressPassed: true, holdout: 5 }), // baseline
        gate({ regressPassed: false, holdout: 5 }), // attempt 1 red
        gate({ regressPassed: true, holdout: 5 }), // attempt 2 green
      ]),
      commit,
      log: () => undefined,
    });
    expect(p1.revert).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed).toHaveLength(1);
  });

  it("parks a cluster as a wall-candidate after K red attempts", async () => {
    const commit = vi.fn(async () => undefined);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: false, holdout: 5 })]),
      commit,
      maxAttemptsPerCluster: 3,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(res.walls).toHaveLength(1);
    expect(res.walls[0]!.attempts).toBe(3);
    expect(res.walls[0]!.reason).toMatch(/no articulable infra reason/);
  });

  it("records a genuine wall with the proposer's concrete reason", async () => {
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => {
        throw new WallError("phone verification required — no virtual number beats it");
      },
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      commit: async () => undefined,
      log: () => undefined,
    });
    expect(res.walls).toHaveLength(1);
    expect(res.walls[0]!.reason).toMatch(/phone verification required/);
  });

  it("parks (does not apply or commit) a fix that touches an out-of-bounds path", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/form-fill-planner.ts"]); // ungated surface
    const res = await runFixAgent({
      ...base,
      // posture (a): only agent.ts (the gated planner) is in-bounds.
      allowedPaths: ["apps/mcp/src/bot/agent.ts"],
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      commit,
      log: () => undefined,
    });
    expect(prop.apply).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(res.parked).toHaveLength(1);
    expect(res.parked[0]!.reason).toMatch(/out-of-bounds/);
  });

  it("hard-stops on main before doing any work", async () => {
    const gateFn = vi.fn(scriptedGate([gate({ regressPassed: true, holdout: 5 })]));
    await expect(
      runFixAgent({
        ...base,
        branch: "main",
        batch: batch([failure({})]),
        propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
        gate: gateFn,
        commit: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ReleaseFenceError);
    expect(gateFn).not.toHaveBeenCalled();
  });

  it("refuses to commit against an empty (meaningless) regress gate", async () => {
    const commit = vi.fn(async () => undefined);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5, empty: true })]),
      commit,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(res.committed).toHaveLength(0);
  });

  it("bumps the rc per committed cluster", async () => {
    const versions: string[] = [];
    await runFixAgent({
      ...base,
      batch: batch([
        failure({ service: "a", signature: "sig-1" }),
        failure({ service: "b", signature: "sig-2" }),
      ]),
      propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      commit: async ({ version }) => {
        versions.push(version);
      },
      log: () => undefined,
    });
    expect(versions).toEqual(["0.9.1-rc.1", "0.9.1-rc.2"]);
  });
});
