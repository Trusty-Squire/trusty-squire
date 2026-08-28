// A session owns its operator browser. This watchdog is a backstop for a host
// that loses interest without sending operate_finish or closing the MCP stdio
// transport: a target page must never be able to keep a Chromium tree alive
// and consuming the machine indefinitely.

import { readdirSync, readFileSync } from "node:fs";

export const DEFAULT_OPERATOR_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_OPERATOR_BROWSER_MAX_LIFETIME_MS = 30 * 60 * 1_000;
export const DEFAULT_OPERATOR_BROWSER_WATCHDOG_INTERVAL_MS = 5_000;
export const DEFAULT_OPERATOR_BROWSER_CPU_CEILING_PERCENT = 200;
export const DEFAULT_OPERATOR_BROWSER_CPU_CONSECUTIVE_SAMPLES = 3;

// Linux /proc CPU times are reported in USER_HZ ticks. Linux distributions
// supported by the MCP use 100 here; callers can override this in tests or on
// an unusual host without changing the safety policy itself.
export const LINUX_PROCESS_TICKS_PER_SECOND = 100;

export interface ProcessCpuRecord {
  pid: number;
  parentPid: number;
  cpuTicks: number;
}

export interface CpuSample {
  at: number;
  ticks: number;
}

export type OperatorBrowserWatchdogReason =
  | {
      kind: "idle_timeout";
      idle_ms: number;
      timeout_ms: number;
    }
  | {
      kind: "max_lifetime";
      lifetime_ms: number;
      timeout_ms: number;
    }
  | {
      kind: "cpu_budget_exceeded";
      cpu_percent: number;
      ceiling_percent: number;
      consecutive_samples: number;
    };

export interface OperatorBrowserWatchdogOptions {
  startedAt: number;
  lastActivityAt: () => number;
  hasActiveCall: () => boolean;
  processId: () => number | null;
  onTerminate: (reason: OperatorBrowserWatchdogReason) => void | Promise<void>;
  now?: () => number;
  readCpuTicks?: (rootPid: number) => number | null;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  intervalMs?: number;
  cpuCeilingPercent?: number;
  cpuConsecutiveSamples?: number;
  ticksPerSecond?: number;
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function operatorBrowserWatchdogConfig(): {
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  intervalMs: number;
  cpuCeilingPercent: number;
  cpuConsecutiveSamples: number;
} {
  return {
    idleTimeoutMs: positiveEnvNumber(
      "TRUSTY_SQUIRE_OPERATOR_SESSION_IDLE_TIMEOUT_MS",
      DEFAULT_OPERATOR_SESSION_IDLE_TIMEOUT_MS,
    ),
    maxLifetimeMs: positiveEnvNumber(
      "TRUSTY_SQUIRE_OPERATOR_BROWSER_MAX_LIFETIME_MS",
      DEFAULT_OPERATOR_BROWSER_MAX_LIFETIME_MS,
    ),
    intervalMs: positiveEnvNumber(
      "TRUSTY_SQUIRE_OPERATOR_BROWSER_WATCHDOG_INTERVAL_MS",
      DEFAULT_OPERATOR_BROWSER_WATCHDOG_INTERVAL_MS,
    ),
    cpuCeilingPercent: positiveEnvNumber(
      "TRUSTY_SQUIRE_OPERATOR_BROWSER_CPU_CEILING_PERCENT",
      DEFAULT_OPERATOR_BROWSER_CPU_CEILING_PERCENT,
    ),
    cpuConsecutiveSamples: Math.max(
      1,
      Math.floor(
        positiveEnvNumber(
          "TRUSTY_SQUIRE_OPERATOR_BROWSER_CPU_CONSECUTIVE_SAMPLES",
          DEFAULT_OPERATOR_BROWSER_CPU_CONSECUTIVE_SAMPLES,
        ),
      ),
    ),
  };
}

/** Sum a root process and every descendant, including Chrome renderers. */
export function processTreeCpuTicks(
  rootPid: number,
  processes: readonly ProcessCpuRecord[],
): number | null {
  const byParent = new Map<number, ProcessCpuRecord[]>();
  const byPid = new Map<number, ProcessCpuRecord>();
  for (const process of processes) {
    byPid.set(process.pid, process);
    const children = byParent.get(process.parentPid) ?? [];
    children.push(process);
    byParent.set(process.parentPid, children);
  }
  if (!byPid.has(rootPid)) return null;

  let ticks = 0;
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const process = byPid.get(pid);
    if (process === undefined) continue;
    ticks += process.cpuTicks;
    for (const child of byParent.get(pid) ?? []) pending.push(child.pid);
  }
  return ticks;
}

function processCpuRecord(pid: number): ProcessCpuRecord | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    // The suffix starts at process-state (field 3). ppid is field 4; utime
    // and stime are 14 and 15. The command field may itself contain spaces or
    // parentheses, hence the lastIndexOf above rather than split(" ").
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const parentPid = Number(fields[1]);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isSafeInteger(parentPid) || !Number.isFinite(utime) || !Number.isFinite(stime)) {
      return null;
    }
    return { pid, parentPid, cpuTicks: utime + stime };
  } catch {
    return null;
  }
}

/** Best-effort Linux process-tree accounting. Unsupported hosts return null. */
export function linuxProcessTreeCpuTicks(rootPid: number): number | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  try {
    const processes: ProcessCpuRecord[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const record = processCpuRecord(pid);
      if (record !== null) processes.push(record);
    }
    return processTreeCpuTicks(rootPid, processes);
  } catch {
    return null;
  }
}

export function cpuPercentBetween(
  previous: CpuSample,
  current: CpuSample,
  ticksPerSecond = LINUX_PROCESS_TICKS_PER_SECOND,
): number | null {
  const elapsedMs = current.at - previous.at;
  const ticks = current.ticks - previous.ticks;
  if (elapsedMs <= 0 || ticks < 0 || ticksPerSecond <= 0) return null;
  return (ticks * 100_000) / (elapsedMs * ticksPerSecond);
}

export class OperatorBrowserWatchdog {
  private readonly now: () => number;
  private readonly readCpuTicks: (rootPid: number) => number | null;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly intervalMs: number;
  private readonly cpuCeilingPercent: number;
  private readonly cpuConsecutiveSamples: number;
  private readonly ticksPerSecond: number;
  private timer: NodeJS.Timeout | null = null;
  private previousCpu: CpuSample | null = null;
  private cpuBreachCount = 0;
  private terminated = false;

  constructor(private readonly options: OperatorBrowserWatchdogOptions) {
    const config = operatorBrowserWatchdogConfig();
    this.now = options.now ?? Date.now;
    this.readCpuTicks = options.readCpuTicks ?? linuxProcessTreeCpuTicks;
    this.idleTimeoutMs = options.idleTimeoutMs ?? config.idleTimeoutMs;
    this.maxLifetimeMs = options.maxLifetimeMs ?? config.maxLifetimeMs;
    this.intervalMs = options.intervalMs ?? config.intervalMs;
    this.cpuCeilingPercent = options.cpuCeilingPercent ?? config.cpuCeilingPercent;
    this.cpuConsecutiveSamples = options.cpuConsecutiveSamples ?? config.cpuConsecutiveSamples;
    this.ticksPerSecond = options.ticksPerSecond ?? LINUX_PROCESS_TICKS_PER_SECOND;
  }

  start(): void {
    if (this.timer !== null || this.terminated) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  check(now = this.now()): OperatorBrowserWatchdogReason | null {
    if (this.terminated) return null;
    const lifetimeMs = now - this.options.startedAt;
    if (lifetimeMs >= this.maxLifetimeMs) {
      return this.terminate({
        kind: "max_lifetime",
        lifetime_ms: lifetimeMs,
        timeout_ms: this.maxLifetimeMs,
      });
    }

    if (!this.options.hasActiveCall()) {
      const idleMs = now - this.options.lastActivityAt();
      if (idleMs >= this.idleTimeoutMs) {
        return this.terminate({
          kind: "idle_timeout",
          idle_ms: idleMs,
          timeout_ms: this.idleTimeoutMs,
        });
      }
    }

    const processId = this.options.processId();
    if (processId === null) return null;
    const ticks = this.readCpuTicks(processId);
    if (ticks === null) return null;
    const current: CpuSample = { at: now, ticks };
    const cpuPercent =
      this.previousCpu === null
        ? null
        : cpuPercentBetween(this.previousCpu, current, this.ticksPerSecond);
    this.previousCpu = current;
    if (cpuPercent === null) return null;

    if (cpuPercent > this.cpuCeilingPercent) this.cpuBreachCount += 1;
    else this.cpuBreachCount = 0;
    if (this.cpuBreachCount < this.cpuConsecutiveSamples) return null;
    return this.terminate({
      kind: "cpu_budget_exceeded",
      cpu_percent: Math.round(cpuPercent),
      ceiling_percent: this.cpuCeilingPercent,
      consecutive_samples: this.cpuBreachCount,
    });
  }

  private terminate(reason: OperatorBrowserWatchdogReason): OperatorBrowserWatchdogReason {
    this.terminated = true;
    this.stop();
    void Promise.resolve(this.options.onTerminate(reason)).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[operator] browser watchdog teardown failed: ${detail}\n`);
    });
    return reason;
  }
}
