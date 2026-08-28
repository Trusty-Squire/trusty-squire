import { describe, expect, it, vi } from "vitest";
import {
  OperatorBrowserProcessWatchdog,
  OperatorBrowserWatchdog,
  createOperatorBrowserMarker,
  isOperatorChromiumCommand,
  operatorBrowserMarkerStartedAt,
  type OperatorBrowserProcessRecord,
  type OperatorBrowserWatchdogReason,
} from "../operator-browser-watchdog.js";

describe("operator browser process watchdog", () => {
  it("meters reparented Chromium siblings as one marked browser", async () => {
    const marker = createOperatorBrowserMarker(1, "session-a");
    let processes: OperatorBrowserProcessRecord[] = [
      { pid: 101, parentPid: 100, startTime: 11, cpuTicks: 0, marker },
      { pid: 102, parentPid: 100, startTime: 12, cpuTicks: 0, marker },
    ];
    const killed: number[] = [];
    const terminate = vi.fn();
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses: () => processes,
      processMatches: () => true,
      kill: (pid) => killed.push(pid),
      onTerminate: terminate,
      maxLifetimeMs: 60_000,
      cpuCeilingPercent: 200,
      cpuConsecutiveSamples: 2,
      ticksPerSecond: 100,
    });

    expect(await watchdog.check(1_000)).toEqual([]);
    processes = [
      { pid: 101, parentPid: 1, startTime: 11, cpuTicks: 750, marker },
      { pid: 102, parentPid: 1, startTime: 12, cpuTicks: 750, marker },
    ];
    expect(await watchdog.check(6_000)).toEqual([]);
    processes = [
      { pid: 101, parentPid: 1, startTime: 11, cpuTicks: 1_500, marker },
      { pid: 102, parentPid: 1, startTime: 12, cpuTicks: 1_500, marker },
    ];
    expect(await watchdog.check(11_000)).toEqual([
      {
        kind: "cpu_budget_exceeded",
        cpu_percent: 300,
        ceiling_percent: 200,
        consecutive_samples: 2,
      },
    ]);
    await vi.waitFor(() => expect(killed).toEqual([101, 102]));
    expect(terminate).toHaveBeenCalledWith(
      marker,
      expect.objectContaining({ kind: "cpu_budget_exceeded", cpu_percent: 300 }),
    );
  });

  it("accounts CPU from marked renderer identities replaced between samples", async () => {
    const marker = createOperatorBrowserMarker(1, "renderer-churn");
    let processes: OperatorBrowserProcessRecord[] = [
      { pid: 301, parentPid: 1, startTime: 31, cpuTicks: 0, marker },
    ];
    const killed: number[] = [];
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses: () => processes,
      processMatches: () => true,
      kill: (pid) => killed.push(pid),
      maxLifetimeMs: 60_000,
      cpuCeilingPercent: 100,
      cpuConsecutiveSamples: 2,
      ticksPerSecond: 100,
    });

    expect(await watchdog.check(1_000)).toEqual([]);
    processes = [{ pid: 302, parentPid: 1, startTime: 32, cpuTicks: 750, marker }];
    expect(await watchdog.check(6_000)).toEqual([]);
    processes = [{ pid: 303, parentPid: 1, startTime: 33, cpuTicks: 750, marker }];
    expect(await watchdog.check(11_000)).toEqual([
      {
        kind: "cpu_budget_exceeded",
        cpu_percent: 150,
        ceiling_percent: 100,
        consecutive_samples: 2,
      },
    ]);
    await vi.waitFor(() => expect(killed).toEqual([303]));
  });

  it("kills a discovered orphan at its marker lifetime without session state", async () => {
    const marker = createOperatorBrowserMarker(1_000, "orphan");
    const killed: number[] = [];
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses: () => [{ pid: 205, parentPid: 1, startTime: 44, cpuTicks: 0, marker }],
      processMatches: (pid, startTime, expectedMarker) =>
        pid === 205 && startTime === 44 && expectedMarker === marker,
      kill: (pid) => killed.push(pid),
      maxLifetimeMs: 10_000,
    });

    expect(await watchdog.check(10_999)).toEqual([]);
    expect(await watchdog.check(11_000)).toEqual([
      { kind: "max_lifetime", lifetime_ms: 10_000, timeout_ms: 10_000 },
    ]);
    await vi.waitFor(() => expect(killed).toEqual([205]));
  });

  it("lets session teardown own marked processes beyond the old process grace", async () => {
    vi.useFakeTimers();
    const marker = createOperatorBrowserMarker(1_000, "active-payment");
    let processes: OperatorBrowserProcessRecord[] = [
      { pid: 206, parentPid: 1, startTime: 45, cpuTicks: 0, marker },
    ];
    const readProcesses = vi.fn(() => processes);
    const kill = vi.fn();
    let releaseSessionTeardown: (() => void) | undefined;
    const sessionTeardown = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseSessionTeardown = resolve;
        }),
    );
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses,
      processMatches: (pid, startTime, expectedMarker) =>
        processes.some(
          (record) =>
            record.pid === pid &&
            record.startTime === startTime &&
            record.marker === expectedMarker,
        ),
      kill,
      onTerminate: sessionTeardown,
      maxLifetimeMs: 10_000,
    });

    try {
      expect(await watchdog.check(11_000)).toEqual([
        { kind: "max_lifetime", lifetime_ms: 10_000, timeout_ms: 10_000 },
      ]);
      await vi.waitFor(() => expect(releaseSessionTeardown).toBeTypeOf("function"));

      await vi.advanceTimersByTimeAsync(7_001);
      expect(kill).not.toHaveBeenCalled();

      processes = [];
      releaseSessionTeardown?.();
      await vi.waitFor(() => expect(readProcesses).toHaveBeenCalledTimes(2));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      releaseSessionTeardown?.();
      vi.useRealTimers();
    }
  });

  it("revalidates process birth and marker identity before signaling", async () => {
    const marker = createOperatorBrowserMarker(1_000, "reused");
    const kill = vi.fn();
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses: () => [{ pid: 205, parentPid: 1, startTime: 44, cpuTicks: 0, marker }],
      processMatches: () => false,
      kill,
      maxLifetimeMs: 10_000,
    });

    await watchdog.check(11_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kill).not.toHaveBeenCalled();
  });

  it("ends an abandoned session even when its browser is quiet", async () => {
    const terminate = vi.fn();
    const watchdog = new OperatorBrowserWatchdog({
      startedAt: 0,
      lastActivityAt: () => 0,
      hasActiveCall: () => false,
      processMarker: () => null,
      onTerminate: terminate,
      idleTimeoutMs: 10_000,
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

  it("ends a continuously active session at maximum lifetime", async () => {
    const terminate = vi.fn();
    const watchdog = new OperatorBrowserWatchdog({
      startedAt: 1_000,
      lastActivityAt: () => 30_999,
      hasActiveCall: () => true,
      processMarker: () => null,
      onTerminate: terminate,
      idleTimeoutMs: 10_000,
      maxLifetimeMs: 30_000,
    });

    expect(watchdog.check(30_999)).toBeNull();
    expect(watchdog.check(31_000)).toEqual({
      kind: "max_lifetime",
      lifetime_ms: 30_000,
      timeout_ms: 30_000,
    });
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("shares session teardown already started by the session watchdog", async () => {
    let processTerminate:
      | ((reason: OperatorBrowserWatchdogReason) => void | Promise<void>)
      | undefined;
    let releaseSessionTeardown: (() => void) | undefined;
    const terminate = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseSessionTeardown = resolve;
        }),
    );
    const watchdog = new OperatorBrowserWatchdog({
      startedAt: 0,
      lastActivityAt: () => 0,
      hasActiveCall: () => true,
      processMarker: () => "v1:1:shared-session",
      onTerminate: terminate,
      maxLifetimeMs: 30_000,
      intervalMs: 60_000,
      registerProcessWatchdog: (_marker, onTerminate) => {
        processTerminate = onTerminate;
        return () => undefined;
      },
    });
    watchdog.start();

    try {
      expect(watchdog.check(30_000)?.kind).toBe("max_lifetime");
      await vi.waitFor(() => expect(releaseSessionTeardown).toBeTypeOf("function"));

      let processTerminationSettled = false;
      const processTermination = Promise.resolve(
        processTerminate?.({
          kind: "max_lifetime",
          lifetime_ms: 30_000,
          timeout_ms: 30_000,
        }),
      ).then(() => {
        processTerminationSettled = true;
      });
      await Promise.resolve();

      expect(processTerminationSettled).toBe(false);
      expect(terminate).toHaveBeenCalledOnce();

      releaseSessionTeardown?.();
      await processTermination;
      expect(processTerminationSettled).toBe(true);
    } finally {
      releaseSessionTeardown?.();
      watchdog.dispose();
    }
  });

  it("encodes a durable launch timestamp in every marker", () => {
    expect(operatorBrowserMarkerStartedAt(createOperatorBrowserMarker(42, "test"))).toBe(42);
    expect(operatorBrowserMarkerStartedAt("invalid")).toBeNull();
  });

  it("recognizes marked Chromium crash handlers as watchdog candidates", () => {
    expect(isOperatorChromiumCommand("/opt/chrome/chrome_crashpad_handler\0--monitor-self")).toBe(
      true,
    );
    expect(
      isOperatorChromiumCommand("/usr/lib/chromium/chromium_crashpad_handler\0--database=/tmp"),
    ).toBe(true);
    expect(isOperatorChromiumCommand("/usr/bin/unrelated_crashpad_handler\0--monitor-self")).toBe(
      false,
    );
  });
});
