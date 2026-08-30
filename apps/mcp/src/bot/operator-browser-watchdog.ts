import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export const DEFAULT_OPERATOR_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
export const DEFAULT_OPERATOR_BROWSER_MAX_LIFETIME_MS = 30 * 60 * 1_000;
export const DEFAULT_OPERATOR_BROWSER_WATCHDOG_INTERVAL_MS = 5_000;
export const DEFAULT_OPERATOR_BROWSER_CPU_CEILING_PERCENT = 200;
export const DEFAULT_OPERATOR_BROWSER_CPU_CONSECUTIVE_SAMPLES = 3;
export const LINUX_PROCESS_TICKS_PER_SECOND = 100;
export const OPERATOR_BROWSER_MARKER_ENV = "TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER";

export interface ProcessCpuRecord {
  pid: number;
  parentPid: number;
  cpuTicks: number;
}

export interface OperatorBrowserProcessRecord extends ProcessCpuRecord {
  startTime: number;
  marker: string;
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
  processMarker: () => string | null;
  onTerminate: (
    reason: OperatorBrowserWatchdogReason,
  ) => boolean | void | Promise<boolean | void>;
  now?: () => number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  intervalMs?: number;
  registerProcessWatchdog?: (
    marker: string,
    onTerminate: (
      reason: OperatorBrowserWatchdogReason,
    ) => boolean | void | Promise<boolean | void>,
  ) => () => void;
}

export interface OperatorBrowserProcessWatchdogOptions {
  readProcesses?: () => OperatorBrowserProcessRecord[];
  processMatches?: (pid: number, startTime: number, marker: string) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  onTerminate?: (
    marker: string,
    reason: OperatorBrowserWatchdogReason,
  ) => boolean | void | Promise<boolean | void>;
  now?: () => number;
  intervalMs?: number;
  maxLifetimeMs?: number;
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
      "TRUSTY_SQUIRE_SESSION_IDLE_TIMEOUT_MS",
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

export function createOperatorBrowserMarker(
  startedAt = Date.now(),
  nonce: string = randomUUID(),
): string {
  return `v1:${Math.floor(startedAt)}:${nonce}`;
}

export function operatorBrowserMarkerStartedAt(marker: string): number | null {
  const match = /^v1:(\d+):[A-Za-z0-9_-]+$/.exec(marker);
  if (match === null) return null;
  const startedAt = Number(match[1]);
  return Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : null;
}

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

function parseProcessStat(pid: number): {
  parentPid: number;
  cpuTicks: number;
  startTime: number;
} | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const parentPid = Number(fields[1]);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const startTime = Number(fields[19]);
    if (
      !Number.isSafeInteger(parentPid) ||
      !Number.isFinite(utime) ||
      !Number.isFinite(stime) ||
      !Number.isSafeInteger(startTime)
    ) {
      return null;
    }
    return { parentPid, cpuTicks: utime + stime, startTime };
  } catch {
    return null;
  }
}

export function isOperatorChromiumCommand(command: string): boolean {
  const executable = command.split("\0", 1)[0] ?? "";
  return /(?:^|\/)(?:chrome|google-chrome(?:-stable)?|chromium(?:-browser)?|chrome-headless-shell|headless_shell|chrome_crashpad_handler|chromium_crashpad_handler)$/i.test(
    executable,
  );
}

export function operatorBrowserProcessMarker(pid: number): string | null {
  try {
    const prefix = `${OPERATOR_BROWSER_MARKER_ENV}=`;
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    }
  } catch {
    return null;
  }
  return null;
}

function readOperatorBrowserProcess(pid: number): OperatorBrowserProcessRecord | null {
  try {
    if (!isOperatorChromiumCommand(readFileSync(`/proc/${pid}/cmdline`, "utf8"))) return null;
  } catch {
    return null;
  }
  const marker = operatorBrowserProcessMarker(pid);
  if (marker === null || operatorBrowserMarkerStartedAt(marker) === null) return null;
  const stat = parseProcessStat(pid);
  return stat === null ? null : { pid, marker, ...stat };
}

export function operatorBrowserProcessMatchesMarker(pid: number, marker: string): boolean {
  if (process.platform !== "linux") return false;
  return readOperatorBrowserProcess(pid)?.marker === marker;
}

export function linuxOperatorBrowserProcesses(): OperatorBrowserProcessRecord[] {
  if (process.platform !== "linux") return [];
  try {
    return readdirSync("/proc").flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      const record = readOperatorBrowserProcess(Number(entry));
      return record === null ? [] : [record];
    });
  } catch {
    return [];
  }
}

interface MarkerCpuState {
  at: number;
  processes: Map<string, number>;
  breachCount: number;
}

export class OperatorBrowserProcessWatchdog {
  private readonly readProcesses: () => OperatorBrowserProcessRecord[];
  private readonly processMatches: (pid: number, startTime: number, marker: string) => boolean;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => unknown;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxLifetimeMs: number;
  private readonly cpuCeilingPercent: number;
  private readonly cpuConsecutiveSamples: number;
  private readonly ticksPerSecond: number;
  private readonly samples = new Map<string, MarkerCpuState>();
  private readonly terminating = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: OperatorBrowserProcessWatchdogOptions = {}) {
    const config = operatorBrowserWatchdogConfig();
    this.readProcesses = options.readProcesses ?? linuxOperatorBrowserProcesses;
    this.processMatches =
      options.processMatches ??
      ((pid, startTime, marker) => {
        const current = readOperatorBrowserProcess(pid);
        return current?.startTime === startTime && current.marker === marker;
      });
    this.kill = options.kill ?? process.kill;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? config.intervalMs;
    this.maxLifetimeMs = options.maxLifetimeMs ?? config.maxLifetimeMs;
    this.cpuCeilingPercent = options.cpuCeilingPercent ?? config.cpuCeilingPercent;
    this.cpuConsecutiveSamples = options.cpuConsecutiveSamples ?? config.cpuConsecutiveSamples;
    this.ticksPerSecond = options.ticksPerSecond ?? LINUX_PROCESS_TICKS_PER_SECOND;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async check(now = this.now()): Promise<OperatorBrowserWatchdogReason[]> {
    const processes = this.readProcesses();
    const groups = new Map<string, OperatorBrowserProcessRecord[]>();
    for (const record of processes) {
      const group = groups.get(record.marker) ?? [];
      group.push(record);
      groups.set(record.marker, group);
    }
    for (const marker of [...this.samples.keys()]) {
      if (!groups.has(marker)) this.samples.delete(marker);
    }
    const reasons: OperatorBrowserWatchdogReason[] = [];
    for (const [marker, records] of groups) {
      if (this.terminating.has(marker)) continue;
      const startedAt = operatorBrowserMarkerStartedAt(marker);
      if (startedAt === null) continue;
      const lifetimeMs = now - startedAt;
      if (lifetimeMs >= this.maxLifetimeMs) {
        const reason: OperatorBrowserWatchdogReason = {
          kind: "max_lifetime",
          lifetime_ms: lifetimeMs,
          timeout_ms: this.maxLifetimeMs,
        };
        reasons.push(reason);
        void this.terminate(marker, records, reason);
        continue;
      }
      const previous = this.samples.get(marker);
      const currentProcesses = new Map(
        records.map((record) => [`${record.pid}:${record.startTime}`, record.cpuTicks]),
      );
      let cpuPercent: number | null = null;
      if (previous !== undefined && now > previous.at) {
        let ticks = 0;
        for (const [identity, currentTicks] of currentProcesses) {
          const previousTicks = previous.processes.get(identity);
          if (previousTicks !== undefined && currentTicks >= previousTicks) {
            ticks += currentTicks - previousTicks;
          } else if (previousTicks === undefined && currentTicks >= 0) {
            ticks += currentTicks;
          }
        }
        cpuPercent = (ticks * 100_000) / ((now - previous.at) * this.ticksPerSecond);
      }
      const breachCount =
        cpuPercent !== null && cpuPercent > this.cpuCeilingPercent
          ? (previous?.breachCount ?? 0) + 1
          : 0;
      this.samples.set(marker, { at: now, processes: currentProcesses, breachCount });
      if (cpuPercent === null || breachCount < this.cpuConsecutiveSamples) continue;
      const reason: OperatorBrowserWatchdogReason = {
        kind: "cpu_budget_exceeded",
        cpu_percent: Math.round(cpuPercent),
        ceiling_percent: this.cpuCeilingPercent,
        consecutive_samples: breachCount,
      };
      reasons.push(reason);
      void this.terminate(marker, records, reason);
    }
    return reasons;
  }

  private async terminate(
    marker: string,
    records: readonly OperatorBrowserProcessRecord[],
    reason: OperatorBrowserWatchdogReason,
  ): Promise<void> {
    this.terminating.add(marker);
    process.stderr.write(
      `[operator] process watchdog terminate marker=${marker} reason=${JSON.stringify(reason)}\n`,
    );
    let maySignal = true;
    if (this.options.onTerminate !== undefined) {
      try {
        maySignal = (await this.options.onTerminate(marker, reason)) !== false;
      } catch (error) {
        maySignal = false;
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[operator] process watchdog teardown failed: ${detail}\n`);
      }
    }
    if (!maySignal) {
      this.terminating.delete(marker);
      return;
    }
    const current = this.readProcesses().filter((record) => record.marker === marker);
    const candidates = current.length > 0 ? current : records;
    for (const record of candidates) {
      if (!this.processMatches(record.pid, record.startTime, marker)) continue;
      try {
        this.kill(record.pid, "SIGKILL");
      } catch {
        continue;
      }
    }
    this.samples.delete(marker);
    this.terminating.delete(marker);
  }
}

const processTerminationCallbacks = new Map<
  string,
  (reason: OperatorBrowserWatchdogReason) => boolean | void | Promise<boolean | void>
>();
let globalProcessWatchdog: OperatorBrowserProcessWatchdog | null = null;

export async function dispatchOperatorBrowserProcessTermination(
  marker: string,
  reason: OperatorBrowserWatchdogReason,
): Promise<boolean> {
  const callback = processTerminationCallbacks.get(marker);
  return callback !== undefined && (await callback(reason)) !== false;
}

export function startGlobalOperatorBrowserProcessWatchdog(): void {
  if (process.platform !== "linux" || globalProcessWatchdog !== null) return;
  globalProcessWatchdog = new OperatorBrowserProcessWatchdog({
    onTerminate: dispatchOperatorBrowserProcessTermination,
  });
  globalProcessWatchdog.start();
}

export function registerOperatorBrowserProcessWatchdog(
  marker: string,
  onTerminate: (reason: OperatorBrowserWatchdogReason) => boolean | void | Promise<boolean | void>,
): () => void {
  startGlobalOperatorBrowserProcessWatchdog();
  processTerminationCallbacks.set(marker, onTerminate);
  return () => {
    if (processTerminationCallbacks.get(marker) === onTerminate) {
      processTerminationCallbacks.delete(marker);
    }
  };
}

export class OperatorBrowserWatchdog {
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private unregisterProcessWatchdog: (() => void) | null = null;
  private terminated = false;
  private terminationPromise: Promise<boolean> | null = null;

  constructor(private readonly options: OperatorBrowserWatchdogOptions) {
    const config = operatorBrowserWatchdogConfig();
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? config.idleTimeoutMs;
    this.intervalMs = options.intervalMs ?? config.intervalMs;
  }

  start(): void {
    if (this.unregisterProcessWatchdog === null) {
      const marker = this.options.processMarker();
      if (marker !== null) {
        this.unregisterProcessWatchdog = (
        this.options.registerProcessWatchdog ?? registerOperatorBrowserProcessWatchdog
        )(marker, async (reason) => {
          if (this.options.hasActiveCall()) return false;
          const idleMs = this.now() - this.options.lastActivityAt();
          if (idleMs < this.idleTimeoutMs) return false;
          return await this.terminateAndWait({
            kind: "idle_timeout",
            idle_ms: idleMs,
            timeout_ms: this.idleTimeoutMs,
          });
        });
      }
    }
    if (this.timer !== null || this.terminated) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.unregisterProcessWatchdog?.();
    this.unregisterProcessWatchdog = null;
  }

  check(now = this.now()): OperatorBrowserWatchdogReason | null {
    if (this.terminated) return null;
    if (this.options.hasActiveCall()) return null;
    const idleMs = now - this.options.lastActivityAt();
    if (idleMs < this.idleTimeoutMs) return null;
    return this.terminate({
      kind: "idle_timeout",
      idle_ms: idleMs,
      timeout_ms: this.idleTimeoutMs,
    });
  }

  private terminate(reason: OperatorBrowserWatchdogReason): OperatorBrowserWatchdogReason {
    if (this.terminated) return reason;
    void this.beginTermination(reason);
    return reason;
  }

  private async terminateAndWait(reason: OperatorBrowserWatchdogReason): Promise<boolean> {
    return await this.beginTermination(reason);
  }

  private beginTermination(reason: OperatorBrowserWatchdogReason): Promise<boolean> {
    if (this.terminationPromise !== null) return this.terminationPromise;
    this.terminationPromise = (async () => {
      const accepted = (await this.options.onTerminate(reason)) !== false;
      if (accepted) {
        this.terminated = true;
        this.stop();
      } else {
        this.terminationPromise = null;
      }
      return accepted;
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[operator] browser watchdog teardown failed: ${detail}\n`);
      this.terminationPromise = null;
      return false;
    });
    return this.terminationPromise;
  }
}
