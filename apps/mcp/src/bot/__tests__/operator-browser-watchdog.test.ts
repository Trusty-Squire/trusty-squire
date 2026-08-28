import { describe, expect, it, vi } from "vitest";
import {
  OperatorBrowserWatchdog,
  cpuPercentBetween,
  processTreeCpuTicks,
} from "../operator-browser-watchdog.js";

describe("operator browser watchdog", () => {
  it("counts Chromium renderer descendants instead of only the browser root", () => {
    // The reported 826% was the aggregate of a Chrome root plus renderer/GPU
    // helpers. A root-only sample would miss the process that is actually hot.
    expect(
      processTreeCpuTicks(100, [
        { pid: 100, parentPid: 1, cpuTicks: 20 },
        { pid: 101, parentPid: 100, cpuTicks: 30 },
        { pid: 102, parentPid: 101, cpuTicks: 50 },
        { pid: 999, parentPid: 1, cpuTicks: 1_000 },
      ]),
    ).toBe(100);
    expect(processTreeCpuTicks(404, [{ pid: 100, parentPid: 1, cpuTicks: 20 }])).toBeNull();
  });

  it("terminates a sustained multi-core Chrome tree before it can run for an hour", async () => {
    const terminate = vi.fn();
    const samples = [0, 1_500, 3_000];
    const watchdog = new OperatorBrowserWatchdog({
      startedAt: 0,
      lastActivityAt: () => 0,
      hasActiveCall: () => false,
      processId: () => 100,
      readCpuTicks: () => samples.shift() ?? null,
      onTerminate: terminate,
      // 1,500 ticks in five seconds at 100 USER_HZ = 300% CPU. Two
      // consecutive samples prove this is not a short rendering burst.
      cpuCeilingPercent: 200,
      cpuConsecutiveSamples: 2,
      idleTimeoutMs: 60_000,
      maxLifetimeMs: 60_000,
    });

    expect(watchdog.check(0)).toBeNull();
    expect(watchdog.check(5_000)).toBeNull();
    expect(watchdog.check(10_000)).toEqual({
      kind: "cpu_budget_exceeded",
      cpu_percent: 300,
      ceiling_percent: 200,
      consecutive_samples: 2,
    });
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cpu_budget_exceeded", cpu_percent: 300 }),
    );
  });

  it("ends an abandoned session even when its process is quiet", async () => {
    const terminate = vi.fn();
    const watchdog = new OperatorBrowserWatchdog({
      startedAt: 0,
      lastActivityAt: () => 0,
      hasActiveCall: () => false,
      processId: () => null,
      onTerminate: terminate,
      idleTimeoutMs: 10_000,
      maxLifetimeMs: 60_000,
    });

    expect(watchdog.check(9_999)).toBeNull();
    expect(watchdog.check(10_000)).toEqual({
      kind: "idle_timeout",
      idle_ms: 10_000,
      timeout_ms: 10_000,
    });
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("uses deltas, so accumulated CPU time cannot false-trigger a fresh browser", () => {
    expect(cpuPercentBetween({ at: 10_000, ticks: 50_000 }, { at: 15_000, ticks: 50_100 })).toBe(
      20,
    );
  });
});
