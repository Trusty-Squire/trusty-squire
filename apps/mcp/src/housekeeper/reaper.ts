// reaper.ts — kill stale sibling housekeeper processes at startup.
//
// Why this exists (the failure withSignupLock's watchdog did NOT catch).
// The signup-lock watchdog is IN-PROCESS and self-policing: a run that hangs
// inside `withSignupLock(runSession)` hard-exits itself after WATCHDOG_MS. That
// covers one failure shape and one only. It does NOT catch:
//   • a process running a dist built BEFORE the watchdog landed (it has no
//     watchdog to fire — MEASURED 2026-06-12: three --service= discover runs on
//     the CF cluster sat alive 6h+, each pinning a Chrome + Xvfb + a proxy
//     connection, skewing every concurrent verify replay's timing);
//   • a hang OUTSIDE the lock window — browser teardown (close() can wedge a
//     headed Chrome), auto-promote, telemetry — where the watchdog is already
//     cleared;
//   • a blocked event loop, where no timer (watchdog included) can fire.
// In all three the zombie is NOT holding the signup lock, so the lock's
// acquire-time reclaim never targets it either. Nothing reaps it.
//
// The lesson: self-policing is the wrong layer. A FRESH run (on the current
// dist) is the only actor guaranteed able to act, so it reaps stale siblings
// at startup. Dist-independent, covers every hang location. Linux /proc only —
// the housekeeper runs exclusively on the operator's Linux box.

import { readFileSync, readdirSync } from "node:fs";

// A single-service / discover run caps its signup at 600s + OAuth + email polls
// + teardown; 25min is comfortably above a legit run and well below the 6h
// zombies we saw. A --mode=heal pass (verify sweep + discover over the whole
// queue) legitimately runs much longer, so it gets a loose 4h ceiling — still
// an absolute backstop (no heal --once has ever approached it).
const SINGLE_RUN_CEILING_S = 25 * 60;
const HEAL_CEILING_S = 4 * 60 * 60;

interface ProcInfo {
  pid: number;
  pgid: number;
  ageS: number;
  cmdline: string;
}

type HousekeeperRunKind = "single" | "long";

export interface HousekeeperRunClass {
  kind: HousekeeperRunKind;
  ceilingS: number;
}

// Clock ticks per second (almost always 100 on Linux); used to convert
// /proc/<pid>/stat starttime into wall-clock age. Hardcoded — SC_CLK_TCK isn't
// exposed to Node, and 100 has been the Linux default for decades.
const CLK_TCK = 100;

function uptimeSeconds(): number | null {
  try {
    return parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0]!);
  } catch {
    return null;
  }
}

// Read self's process-group id from /proc/self/stat (field 5, pgrp) so we never
// kill our own group. The stat line is "pid (comm) state ppid pgrp ..." — comm
// can contain spaces/parens, so split on the LAST ')' to find the fields.
function ownPgid(): number {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // after = [state, ppid, pgrp, ...]
    return Number(after[2]);
  } catch {
    return -1;
  }
}

function readProc(pid: number, uptime: number): ProcInfo | null {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (cmdline.length === 0) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgid = Number(after[2]);
    const starttime = Number(after[19]); // field 22 overall; index 19 after the comm split
    if (!Number.isFinite(starttime)) return null;
    const ageS = uptime - starttime / CLK_TCK;
    return { pid, pgid, ageS, cmdline };
  } catch {
    return null; // process vanished mid-scan, or not ours to read
  }
}

function hasNodeRuntime(cmdline: string): boolean {
  return /(^|\s)(node|[^/\s]*\/node)(\s|$)/.test(cmdline);
}

function hasHousekeeperEntrypoint(cmdline: string): boolean {
  return /\bbin\.js\s+housekeeper\b/.test(cmdline) || /\bhousekeeper\s+--mode=/.test(cmdline);
}

function isLongRunningHousekeeper(cmdline: string): boolean {
  return /\bhousekeeper\s+autoloop\b/.test(cmdline) || /--mode=heal\b/.test(cmdline);
}

// Exported for tests. Classifies the process once, then every kill decision uses
// the same result. This avoids the previous drift where `isHousekeeper()` and
// `ceilingFor()` each had their own regex idea of what a housekeeper run was.
export function classifyHousekeeperRun(cmdline: string): HousekeeperRunClass | null {
  if (!hasNodeRuntime(cmdline)) return null;
  if (!hasHousekeeperEntrypoint(cmdline)) return null;
  const longRunning = isLongRunningHousekeeper(cmdline);
  return {
    kind: longRunning ? "long" : "single",
    ceilingS: longRunning ? HEAL_CEILING_S : SINGLE_RUN_CEILING_S,
  };
}

// Exported for tests. A housekeeper invocation is a node process whose argv
// runs the bundled CLI in housekeeper mode.
export function isHousekeeper(cmdline: string): boolean {
  return classifyHousekeeperRun(cmdline) !== null;
}

// Exported for tests. A full heal pass and autoloop legitimately run for hours;
// a single service / discover run does not.
export function ceilingFor(cmdline: string): number {
  return classifyHousekeeperRun(cmdline)?.ceilingS ?? SINGLE_RUN_CEILING_S;
}

export interface ReapResult {
  scanned: number;
  reaped: Array<{ pid: number; ageS: number; cmdline: string }>;
}

// Scan /proc for other housekeeper processes older than their mode's ceiling
// and SIGKILL their process groups (taking the leaked Chrome/Xvfb children with
// them). Never touches self, self's group, or a non-housekeeper process. Pure
// best-effort: every failure is swallowed so a reaper hiccup can never block the
// run it precedes.
export function reapStaleHousekeepers(
  log: (msg: string) => void = (m) => console.error(m),
): ReapResult {
  const result: ReapResult = { scanned: 0, reaped: [] };
  if (process.platform !== "linux") return result;
  const uptime = uptimeSeconds();
  if (uptime === null) return result;
  const self = process.pid;
  const myPgid = ownPgid();

  let pids: number[];
  try {
    pids = readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return result;
  }

  for (const pid of pids) {
    if (pid === self) continue;
    const info = readProc(pid, uptime);
    if (info === null) continue;
    const housekeeper = classifyHousekeeperRun(info.cmdline);
    if (housekeeper === null) continue;
    result.scanned++;
    if (info.ageS <= housekeeper.ceilingS) continue;
    // Never kill our own group (would suicide the live run).
    if (myPgid > 0 && info.pgid === myPgid) continue;
    const mins = Math.round(info.ageS / 60);
    try {
      // Kill the whole group so the run's Chrome + Xvfb die with the node.
      if (info.pgid > 0) {
        process.kill(-info.pgid, "SIGKILL");
      } else {
        process.kill(info.pid, "SIGKILL");
      }
      result.reaped.push({ pid: info.pid, ageS: info.ageS, cmdline: info.cmdline });
      log(
        `[housekeeper] reaped stale sibling pid=${info.pid} (alive ${mins}min, ` +
          `> ${Math.round(housekeeper.ceilingS / 60)}min ${housekeeper.kind} ceiling): ${info.cmdline.slice(0, 80)}`,
      );
    } catch {
      // already gone, or EPERM (not ours) — skip
    }
  }
  if (result.reaped.length > 0) {
    log(`[housekeeper] reaper: killed ${result.reaped.length} stale sibling run(s) before starting`);
  }
  return result;
}
