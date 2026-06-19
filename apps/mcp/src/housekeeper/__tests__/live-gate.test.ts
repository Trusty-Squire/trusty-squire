// The live oracle: a fix commits only if the cluster moves ≥M live AND the
// held-out canary doesn't regress. Driven by a fake LiveRunner — no browsers.

import { describe, it, expect } from "vitest";
import {
  runLiveGate,
  measureCanaryBaseline,
  type LiveRunner,
} from "../live-gate.js";

// A fake runner: a set of services that come back green.
const runnerFrom = (greenSet: Set<string>): LiveRunner => async (s) => ({
  green: greenSet.has(s),
});

const CLUSTER = ["a", "b", "c"];
const CANARY = ["ipinfo", "openrouter", "neon"];

describe("runLiveGate — the oracle", () => {
  it("commits when ≥M cluster services go green AND the canary holds", async () => {
    const run = runnerFrom(new Set(["a", "b", "ipinfo", "openrouter", "neon"]));
    const v = await runLiveGate(run, {
      cluster: CLUSTER,
      canary: CANARY,
      baselineCanaryGreen: 3,
      minClusterMove: 2,
    });
    expect(v.passed).toBe(true);
    expect(v.clusterGreen).toBe(2);
    expect(v.canaryHeld).toBe(true);
  });

  it("REJECTS a one-service hack (cluster moved < M) even with the canary intact", async () => {
    const run = runnerFrom(new Set(["a", "ipinfo", "openrouter", "neon"]));
    const v = await runLiveGate(run, {
      cluster: CLUSTER,
      canary: CANARY,
      baselineCanaryGreen: 3,
      minClusterMove: 2,
    });
    expect(v.passed).toBe(false);
    expect(v.clusterMoved).toBe(false);
    expect(v.reason).toMatch(/didn't generalize/);
  });

  it("REJECTS a fix that regresses the canary, even if the cluster moved", async () => {
    // Cluster a+b green (moved ≥2), but a canary service (neon) broke.
    const run = runnerFrom(new Set(["a", "b", "c", "ipinfo", "openrouter"]));
    const v = await runLiveGate(run, {
      cluster: CLUSTER,
      canary: CANARY,
      baselineCanaryGreen: 3, // was 3 before; now only 2 → regressed
      minClusterMove: 2,
    });
    expect(v.passed).toBe(false);
    expect(v.canaryHeld).toBe(false);
    expect(v.reason).toMatch(/canary regressed/);
  });

  it("a flaky canary that was already below 3 doesn't block a good fix", async () => {
    // Baseline canary was 2 (neon flaky); fix keeps it at 2 and moves the cluster.
    const run = runnerFrom(new Set(["a", "b", "ipinfo", "openrouter"]));
    const v = await runLiveGate(run, {
      cluster: CLUSTER,
      canary: CANARY,
      baselineCanaryGreen: 2,
      minClusterMove: 2,
    });
    expect(v.passed).toBe(true);
  });

  it("a crashing run counts as not-green (a fix that throws is not a pass)", async () => {
    const run: LiveRunner = async (s) => {
      if (s === "b") throw new Error("bot crashed");
      return { green: ["a", "ipinfo", "openrouter", "neon"].includes(s) };
    };
    const v = await runLiveGate(run, {
      cluster: CLUSTER,
      canary: CANARY,
      baselineCanaryGreen: 3,
      minClusterMove: 2,
    });
    // only "a" green in the cluster (b threw, c not green) → < 2 → reject
    expect(v.clusterGreen).toBe(1);
    expect(v.passed).toBe(false);
  });

  it("measureCanaryBaseline counts the pre-fix known-good rate", async () => {
    const run = runnerFrom(new Set(["ipinfo", "openrouter"]));
    expect(await measureCanaryBaseline(run, CANARY)).toBe(2);
  });

  it("treats a service as green when any retryable best-of-N attempt succeeds", async () => {
    const seen: string[] = [];
    const run: LiveRunner = async (service, attempt) => {
      seen.push(`${service}:${attempt?.attempt ?? 1}/${attempt?.maxAttempts ?? 1}`);
      return {
        green: service === "a" && attempt?.attempt === 2,
        retryable: attempt?.attempt === 1,
      };
    };

    const v = await runLiveGate(run, {
      cluster: ["a"],
      canary: [],
      baselineCanaryGreen: 0,
      minClusterMove: 1,
      maxAttempts: 3,
    });

    expect(v.passed).toBe(true);
    expect(v.clusterGreen).toBe(1);
    expect(seen).toEqual(["a:1/3", "a:2/3"]);
  });

  it("tries all best-of-N attempts while failures are retryable", async () => {
    const seen: string[] = [];
    const run: LiveRunner = async (service, attempt) => {
      seen.push(`${service}:${attempt?.attempt ?? 1}/${attempt?.maxAttempts ?? 1}`);
      return { green: false, retryable: true };
    };

    const v = await runLiveGate(run, {
      cluster: ["a"],
      canary: [],
      baselineCanaryGreen: 0,
      minClusterMove: 1,
      maxAttempts: 3,
    });

    expect(v.passed).toBe(false);
    expect(v.clusterGreen).toBe(0);
    expect(seen).toEqual(["a:1/3", "a:2/3", "a:3/3"]);
  });

  it("does not retry non-retryable failures", async () => {
    const seen: string[] = [];
    const run: LiveRunner = async (service, attempt) => {
      seen.push(`${service}:${attempt?.attempt ?? 1}/${attempt?.maxAttempts ?? 1}`);
      return { green: false, retryable: false };
    };

    const v = await runLiveGate(run, {
      cluster: ["a"],
      canary: [],
      baselineCanaryGreen: 0,
      minClusterMove: 1,
      maxAttempts: 3,
    });

    expect(v.passed).toBe(false);
    expect(seen).toEqual(["a:1/3"]);
  });

  it("measureCanaryBaseline uses best-of-N attempts", async () => {
    const calls: Record<string, number> = {};
    const run: LiveRunner = async (service) => {
      calls[service] = (calls[service] ?? 0) + 1;
      return {
        green: service === "ipinfo" && calls[service] === 2,
        retryable: true,
      };
    };

    expect(await measureCanaryBaseline(run, ["ipinfo", "neon"], 1, 3)).toBe(1);
    expect(calls).toEqual({ ipinfo: 2, neon: 3 });
  });

  it("bounds live runner concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run: LiveRunner = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { green: true };
    };

    const v = await runLiveGate(run, {
      cluster: ["a", "b", "c", "d"],
      canary: ["e", "f", "g", "h"],
      baselineCanaryGreen: 4,
      minClusterMove: 2,
      concurrency: 2,
    });

    expect(v.passed).toBe(true);
    // The cap is global across cluster + canary services.
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("best-of-N does not multiply concurrent service workers", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run: LiveRunner = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { green: false, retryable: true };
    };

    const v = await runLiveGate(run, {
      cluster: ["a", "b", "c", "d"],
      canary: [],
      baselineCanaryGreen: 0,
      minClusterMove: 1,
      concurrency: 2,
      maxAttempts: 3,
    });

    expect(v.passed).toBe(false);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
