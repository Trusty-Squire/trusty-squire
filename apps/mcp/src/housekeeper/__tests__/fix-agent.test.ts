import { describe, it, expect, vi } from "vitest";
import {
  clusterFailures,
  firstOutOfBoundsPath,
  NoChangeProposalError,
  runFixAgent,
  sameAction,
  WallError,
  type ClusterReplay,
  type FixProposal,
  type GateRunner,
} from "../fix-agent.js";
import { ReleaseFenceError } from "../release-guard.js";
import type { FixBatch, FixBatchFailure } from "../fix-batch.js";
import type { EvalGateResult } from "../../bot/eval-gate.js";
import type { PostVerifyStep } from "../../bot/agent.js";
import type { FailureStats } from "../../bot/failure-stats.js";

// ── fixtures ─────────────────────────────────────────────────────────

const EMPTY_STATS = { totalRuns: 0, totalPasses: 0, overallPassRate: 0, stageHistogram: {}, perService: [], passRateVariance: 0 } as unknown as FailureStats;

// The action the planner was stuck on (captured), and the action a working fix
// makes it pick instead.
const STUCK: PostVerifyStep = { kind: "click", selector: "#stuck", reason: "stuck" };
const MOVED: PostVerifyStep = { kind: "click", selector: "#fixed", reason: "fixed" };

// Replays: a fix that unsticks the page returns a different action; a no-op fix
// returns the same stuck action.
const replayMoved: ClusterReplay = async () => MOVED;
const replayStuck: ClusterReplay = async () => STUCK;

function failure(p: Partial<FixBatchFailure>): FixBatchFailure {
  return {
    service: "svc",
    run_id: "r1",
    failure_stage: "planner_loop",
    terminal_round: 0,
    capture_refs: ["/cap/svc-r1-r0.json"],
    signature: "sig-aaaa",
    reproduce_count: 1,
    // a verifiable captured page by default
    terminal_capture_ref: "/cap/svc-r1-r0.json",
    terminal_page: { url: "https://svc.com/x", inventory: [], observed: STUCK },
    ...p,
  };
}

// A failure with no captured terminal page (the unverifiable case).
function unverifiableFailure(p: Partial<FixBatchFailure> = {}): FixBatchFailure {
  const f = failure(p);
  delete f.terminal_page;
  delete f.terminal_capture_ref;
  return f;
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

// ── sameAction ───────────────────────────────────────────────────────

describe("sameAction", () => {
  it("same kind + same selector is the same action", () => {
    expect(sameAction(STUCK, { kind: "click", selector: "#stuck", reason: "diff prose" })).toBe(true);
  });
  it("different selector means moved", () => {
    expect(sameAction(STUCK, MOVED)).toBe(false);
  });
  it("different kind means moved", () => {
    expect(sameAction(STUCK, { kind: "extract", reason: "x" })).toBe(false);
  });
  it("navigate compares url", () => {
    expect(sameAction({ kind: "navigate", url: "/a", reason: "x" }, { kind: "navigate", url: "/a", reason: "y" })).toBe(true);
    expect(sameAction({ kind: "navigate", url: "/a", reason: "x" }, { kind: "navigate", url: "/b", reason: "y" })).toBe(false);
  });
});

// ── clustering ───────────────────────────────────────────────────────

describe("clusterFailures", () => {
  it("keeps same-shape failures service-local so regressions get live proof per service", () => {
    const clusters = clusterFailures(
      batch([
        failure({ service: "groq", signature: "sig-x" }),
        failure({ service: "render", signature: "sig-x" }),
        failure({ service: "kinde", signature: "sig-x" }),
      ]),
    );
    expect(clusters).toHaveLength(3);
    expect(clusters.map((c) => c.services[0]).sort()).toEqual(["groq", "kinde", "render"]);
    expect(clusters.every((c) => c.pages.length === 1)).toBe(true);
    expect(new Set(clusters.map((c) => c.family_id)).size).toBe(1);
  });

  it("separates same stage+action failures with different page signatures", () => {
    const clusters = clusterFailures(
      batch([
        failure({ service: "groq", signature: "sig-x" }),
        failure({ service: "render", signature: "sig-y" }),
      ]),
    );
    expect(clusters).toHaveLength(2);
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

  it("separates same stage+signature failures with different planner action-kinds", () => {
    // Same page shape + stage, but the planner died on different actions
    // (clicking vs giving up) — likely different fixes, so not one cluster.
    const clusters = clusterFailures(
      batch([
        failure({
          service: "a",
          signature: "sig-x",
          terminal_page: { url: "u", inventory: [], observed: { kind: "click", selector: "#x", reason: "nav" } },
        }),
        failure({
          service: "b",
          signature: "sig-x",
          terminal_page: { url: "u", inventory: [], observed: { kind: "done", reason: "stop" } },
        }),
      ]),
    );
    expect(clusters).toHaveLength(2);
  });

  it("separates same raw action by semantic intent verdict", () => {
    const baseSemantic = {
      schema_version: 1 as const,
      intent: {
        kind: "navigate_to_credential_surface" as const,
        target: "API Keys (#keys)",
        evidence: ["target=API Keys"],
      },
      expected_next_state: "API keys visible",
      forbidden_states: ["docs_page"],
      predicate: {
        kind: "credential_surface_reached",
        description: "keys page reached",
        verdict: "violated" as const,
      },
      likely_failure_bucket: "wrong_product_surface" as const,
    };
    const clusters = clusterFailures(
      batch([
        failure({
          service: "a",
          signature: "sig-x",
          semantic_failure_bucket: "wrong_product_surface",
          semantic_fault_class: "planner_semantic_error",
          terminal_page: {
            url: "u",
            inventory: [],
            observed: STUCK,
            semantic: baseSemantic,
          },
        }),
        failure({
          service: "b",
          signature: "sig-x",
          semantic_failure_bucket: "wrong_product_surface",
          semantic_fault_class: "planner_semantic_error",
          terminal_page: {
            url: "u",
            inventory: [],
            observed: STUCK,
            semantic: {
              ...baseSemantic,
              predicate: { ...baseSemantic.predicate, verdict: "satisfied" },
            },
          },
        }),
      ]),
    );
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.family_id)).size).toBe(2);
  });

  it("omits pages for failures with no captured terminal round", () => {
    const clusters = clusterFailures(
      batch([unverifiableFailure()]),
    );
    expect(clusters[0]!.pages).toHaveLength(0);
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

  it("commits a fix that holds the gate AND unsticks the page; bumps the rc", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed[0]!.version).toBe("0.9.1-rc.1");
    expect(prop.revert).not.toHaveBeenCalled();
  });

  it("commits when offline is green AND the LIVE oracle passes", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      liveGate: async () => ({ passed: true, reason: "2/3 cluster green, canary held" }),
      commit,
      log: () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed).toHaveLength(1);
  });

  it("does NOT commit when offline is green but the LIVE oracle rejects; reverts every attempt", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([
        gate({ regressPassed: true, holdout: 5 }),
        gate({ regressPassed: true, holdout: 5 }),
        gate({ regressPassed: true, holdout: 5 }),
        gate({ regressPassed: true, holdout: 5 }),
      ]),
      replay: replayMoved, // offline says it moved
      liveGate: async () => ({ passed: false, reason: "0/3 cluster green live — fix didn't generalize" }),
      commit,
      maxAttemptsPerCluster: 3,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect((prop.revert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("does NOT commit when the gate is green but the page didn't move; parks after K", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]), // always green
      replay: replayStuck, // fix never changes the action
      commit,
      maxAttemptsPerCluster: 3,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(res.walls).toHaveLength(0);
    expect(res.parked).toHaveLength(1);
    expect(res.parked[0]!.reason).toMatch(/unstuck the page|recapture required|no fix/);
    // reverted every attempt (3)
    expect((prop.revert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("iterates: page stuck on attempt 1, moves on attempt 2 → commits", async () => {
    const commit = vi.fn(async () => undefined);
    let attempt = 0;
    const replay: ClusterReplay = async () => (++attempt >= 2 ? MOVED : STUCK);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]), // always green
      replay,
      commit,
      log: () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed).toHaveLength(1);
  });

  it("parks an unverifiable cluster (no captured page) without proposing or walling", async () => {
    const propose = vi.fn(async () => proposal(["apps/mcp/src/bot/agent.ts"]));
    const res = await runFixAgent({
      ...base,
      batch: batch([unverifiableFailure()]),
      propose,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit: async () => undefined,
      log: () => undefined,
    });
    expect(propose).not.toHaveBeenCalled();
    expect(res.walls).toHaveLength(0);
    expect(res.parked[0]!.reason).toMatch(/no captured page/);
  });

  it("parks a no-change proposer result immediately instead of retrying blindly", async () => {
    const propose = vi.fn(async () => {
      throw new NoChangeProposalError("confused", ".debug/fix-agent/c/attempt-1.json", "no useful edit");
    });
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit: async () => undefined,
      maxAttemptsPerCluster: 3,
      log: () => undefined,
    });
    expect(propose).toHaveBeenCalledOnce();
    expect(res.parked).toHaveLength(1);
    expect(res.parked[0]!.reason).toContain("no-change-confused");
    expect(res.parked[0]!.reason).toContain(".debug/fix-agent/c/attempt-1.json");
  });

  it("iterates on a red gate then commits when green; reverts the failed attempt", async () => {
    const commit = vi.fn(async () => undefined);
    const p1 = proposal(["apps/mcp/src/bot/agent.ts"]);
    const p2 = proposal(["apps/mcp/src/bot/agent.ts"]);
    const props = [p1, p2];
    await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async (_c, attempt) => props[attempt - 1]!,
      gate: scriptedGate([
        gate({ regressPassed: true, holdout: 5 }), // baseline
        gate({ regressPassed: false, holdout: 5 }), // attempt 1 red
        gate({ regressPassed: true, holdout: 5 }), // attempt 2 green
      ]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(p1.revert).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects proposer wall claims and parks instead", async () => {
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => {
        throw new WallError("phone verification required — no virtual number beats it");
      },
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit: async () => undefined,
      log: () => undefined,
    });
    expect(res.walls).toHaveLength(0);
    expect(res.parked[0]!.reason).toMatch(/wall claim rejected|proposer claimed wall/);
  });

  it("parks (does not apply or commit) a fix that touches an out-of-bounds path", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/form-fill-planner.ts"]); // ungated surface
    const res = await runFixAgent({
      ...base,
      allowedPaths: ["apps/mcp/src/bot/agent.ts"],
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(prop.apply).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
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
        replay: replayMoved,
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
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(res.committed).toHaveLength(0);
  });

  it("commits on an empty regress corpus WHEN a live oracle is wired (the live key is the gate)", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      // Empty corpus both at baseline and per-attempt: the offline filter is
      // vacuous, so Guard 1 must defer to the live oracle rather than veto.
      gate: scriptedGate([
        gate({ regressPassed: true, holdout: 5, empty: true }),
        gate({ regressPassed: true, holdout: 5, empty: true }),
      ]),
      replay: replayMoved,
      liveGate: async () => ({ passed: true, reason: "2/3 cluster green live, canary held" }),
      commit,
      log: () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(res.committed).toHaveLength(1);
    expect(prop.revert).not.toHaveBeenCalled();
  });

  it("still blocks on an empty corpus when the live oracle REJECTS (no blind commit)", async () => {
    const commit = vi.fn(async () => undefined);
    const prop = proposal(["apps/mcp/src/bot/agent.ts"]);
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({})]),
      propose: async () => prop,
      gate: scriptedGate([
        gate({ regressPassed: true, holdout: 5, empty: true }),
        gate({ regressPassed: true, holdout: 5, empty: true }),
        gate({ regressPassed: true, holdout: 5, empty: true }),
        gate({ regressPassed: true, holdout: 5, empty: true }),
      ]),
      replay: replayMoved,
      liveGate: async () => ({ passed: false, reason: "0/3 cluster green live" }),
      commit,
      maxAttemptsPerCluster: 3,
      log: () => undefined,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(res.committed).toHaveLength(0);
  });

  it("parks (does NOT crash the lap) when the proposer throws a non-Wall error; keeps committing other clusters", async () => {
    const commit = vi.fn(async () => undefined);
    // Two clusters: the first proposer throws (e.g. rate-limit exhaustion), the
    // second is healthy. The lap must survive the first and still commit the
    // second.
    let call = 0;
    const res = await runFixAgent({
      ...base,
      batch: batch([
        failure({ service: "a", signature: "sig-1", failure_stage: "planner_loop" }),
        failure({ service: "b", signature: "sig-2", failure_stage: "extract" }),
      ]),
      propose: async () => {
        call += 1;
        if (call === 1) throw new Error("Command failed: codex exec … usage limit reached");
        return proposal(["apps/mcp/src/bot/agent.ts"]);
      },
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    // First cluster parked, lap continued, second cluster committed.
    expect(res.parked.some((p) => p.reason.includes("proposer error"))).toBe(true);
    expect(res.committed).toHaveLength(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("router gate: out-of-fence clusters route away WITHOUT spending the coding agent", async () => {
    const propose = vi.fn(async () => proposal(["apps/mcp/src/bot/agent.ts"]));
    const commit = vi.fn(async () => undefined);
    const res = await runFixAgent({
      ...base,
      batch: batch([
        // phone → capability_gap; run_timeout → drain route; oauth_handshake →
        // capability_gap route. None may reach the proposer.
        failure({ service: "p", signature: "s-p", failure_stage: "phone" }),
        failure({ service: "t", signature: "s-t", failure_stage: "run_timeout" }),
        failure({ service: "o", signature: "s-o", failure_stage: "oauth_handshake" }),
      ]),
      propose,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(propose).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(res.walls).toHaveLength(0);
    expect(res.parked.filter((p) => p.reason.startsWith("router-")).length).toBe(3);
    expect(res.routed.map((r) => [r.route, r.owner, r.disposition])).toEqual([
      ["capability_gap", "capability", "needs_capability"],
      ["drain", "retry", "retry_later"],
      ["capability_gap", "capability", "needs_capability"],
    ]);
  });

  it("router gate: in-fence (planner_loop / extract) clusters still reach the coding agent", async () => {
    const propose = vi.fn(async () => proposal(["apps/mcp/src/bot/agent.ts"]));
    const commit = vi.fn(async () => undefined);
    await runFixAgent({
      ...base,
      batch: batch([failure({ failure_stage: "extract" })]),
      propose,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 }), gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit,
      log: () => undefined,
    });
    expect(propose).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("router gate: curated manual facts do not wall in-fence clusters", async () => {
    const propose = vi.fn(async () => proposal(["apps/mcp/src/bot/agent.ts"]));
    const res = await runFixAgent({
      ...base,
      batch: batch([failure({ service: "manual-svc", failure_stage: "planner_loop" })]),
      routerFacts: { "manual-svc": { curatedNeedsManual: true } },
      propose,
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit: async () => undefined,
      log: () => undefined,
    });
    expect(propose).toHaveBeenCalled();
    expect(res.walls).toHaveLength(0);
    expect(res.routed[0]!.owner).toBe("code");
  });

  it("bumps the rc per committed cluster", async () => {
    const versions: string[] = [];
    await runFixAgent({
      ...base,
      // Two distinct clusters under the (stage, action-kind) key → two RC bumps.
      batch: batch([
        failure({ service: "a", signature: "sig-1", failure_stage: "planner_loop" }),
        failure({ service: "b", signature: "sig-2", failure_stage: "extract" }),
      ]),
      propose: async () => proposal(["apps/mcp/src/bot/agent.ts"]),
      gate: scriptedGate([gate({ regressPassed: true, holdout: 5 })]),
      replay: replayMoved,
      commit: async ({ version }) => {
        versions.push(version);
      },
      log: () => undefined,
    });
    expect(versions).toEqual(["0.9.1-rc.1", "0.9.1-rc.2"]);
  });
});
