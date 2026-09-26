import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProfileOperationGuard, processBirthIdentityState } from "../profile.js";
import {
  OperatorBrowserProcessWatchdog,
  OperatorBrowserWatchdog,
  OPERATOR_BROWSER_MARKER_ENV,
  createOperatorBrowserMarker,
  dispatchOperatorBrowserProcessTermination,
  isOperatorChromiumCommand,
  operatorBrowserProcessCommandState,
  operatorBrowserProcessMarkerState,
  operatorBrowserMarkerStartedAt,
  type OperatorBrowserProcessRecord,
  type OperatorBrowserWatchdogReason,
} from "../operator-browser-watchdog.js";

describe("operator browser process watchdog", () => {
  it("never grants process signals for an unregistered live-browser marker", async () => {
    await expect(
      dispatchOperatorBrowserProcessTermination("v1:1:unregistered-login", {
        kind: "max_lifetime",
        lifetime_ms: 30_000,
        timeout_ms: 30_000,
      }),
    ).resolves.toBe(false);
  });

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

  it("terminates once even when session teardown refuses an overrun", async () => {
    const marker = createOperatorBrowserMarker(1_000, "overrun");
    let alive = true;
    const record = {
      pid: 207,
      parentPid: 1,
      processGroupId: 207,
      startTime: 46,
      cpuTicks: 0,
      marker,
    };
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") alive = false;
    });
    const onTerminate = vi.fn(async () => false);
    const watchdog = new OperatorBrowserProcessWatchdog({
      readProcesses: () => (alive ? [record] : []),
      processMatches: () => alive,
      kill,
      onTerminate,
      maxLifetimeMs: 10_000,
    });

    expect(await watchdog.check(11_000)).toHaveLength(1);
    await vi.waitFor(() => expect(onTerminate).toHaveBeenCalledOnce());
    expect(await watchdog.check(12_000)).toEqual([]);
    await vi.waitFor(() => expect(alive).toBe(false), { timeout: 3_000 });
    expect(await watchdog.check(12_000)).toEqual([]);
    expect(onTerminate).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-207, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-207, "SIGKILL");
  });

  it.skipIf(process.platform !== "linux")(
    "kills a SIGTERM-resistant process group and frees its operation lease",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ts-watchdog-"));
      const profile = join(root, "profile");
      const marker = createOperatorBrowserMarker(1_000, "resistant");
      const lockPath = join(
        root,
        `trusty-squire-profile-${createHash("sha256").update(profile).digest("hex").slice(0, 24)}.lock`,
      );
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
           process.on("SIGTERM", () => {});
           const stat = fs.readFileSync("/proc/self/stat", "utf8");
           const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
           fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({host:${JSON.stringify(hostname())},pid:process.pid,start_time:start,token:"resistant"}));
           process.stdout.write("ready\\n");
           setInterval(() => {}, 1000);`,
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, [OPERATOR_BROWSER_MARKER_ENV]: marker },
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once("data", () => resolve());
          child.once("error", reject);
          child.once("exit", () => reject(new Error("child exited before ready")));
        });
        const startTime = JSON.parse(readFileSync(lockPath, "utf8")).start_time as string;
        const record = {
          pid: child.pid!,
          parentPid: process.pid,
          processGroupId: child.pid!,
          startTime: Number(startTime),
          cpuTicks: 0,
          marker,
        };
        const alive = () =>
          processBirthIdentityState({ pid: child.pid!, start_time: startTime }) === "matching";
        const watchdog = new OperatorBrowserProcessWatchdog({
          readProcesses: () => (alive() ? [record] : []),
          processMatches: (pid, birth, expectedMarker) => {
            const found = operatorBrowserProcessMarkerState(pid);
            return (
              pid === child.pid &&
              birth === Number(startTime) &&
              alive() &&
              found.state === "present" &&
              found.marker === expectedMarker
            );
          },
          onTerminate: async () => false,
          maxLifetimeMs: 10_000,
        });
        expect(() => acquireProfileOperationGuard(profile, root)).toThrow();
        expect(await watchdog.check(11_000)).toHaveLength(1);
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const nextSession = acquireProfileOperationGuard(profile, root);
        nextSession.release();
        expect(await watchdog.check(12_000)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.pid !== undefined) child.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
    7_000,
  );

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

  it("never ends a continuously active session at a process lifetime threshold", async () => {
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
    expect(watchdog.check(31_000)).toBeNull();
    await Promise.resolve();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("refuses process-watchdog teardown while a live session action is active", async () => {
    let processTerminate:
      | ((reason: OperatorBrowserWatchdogReason) => boolean | void | Promise<boolean | void>)
      | undefined;
    const terminate = vi.fn();
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
      expect(watchdog.check(30_000)).toBeNull();
      const permitted = await Promise.resolve(
        processTerminate?.({
          kind: "max_lifetime",
          lifetime_ms: 30_000,
          timeout_ms: 30_000,
        }),
      );
      expect(permitted).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
    } finally {
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
    expect(isOperatorChromiumCommand("/opt/google/chrome/chrome --type=renderer\0")).toBe(true);
  });

  it("uses executable identity for rewritten titles and preserves ambiguous matches", () => {
    expect(
      operatorBrowserProcessCommandState(42, {
        readCommand: () => "Chrome Helper (Renderer)\0",
        readExecutable: () => "/opt/google/chrome/chrome",
      }),
    ).toBe("matching");
    expect(
      operatorBrowserProcessCommandState(42, {
        readCommand: () => "Browser Helper (Renderer)\0",
        readExecutable: () => {
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        },
      }),
    ).toBe("unknown");
  });
});
