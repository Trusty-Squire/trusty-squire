// modes/autoloop.ts — autonomous-fix-loop Phase 3 (docs/DESIGN-autonomous-fix-loop.md).
//
// The conductor. Runs the live-gated fix-agent in a loop until a full lap
// commits nothing (convergence). Each lap:
//   1. read the recent-failure batch (captures the drain/heal produced),
//   2. the fix-agent clusters by root cause, proposes a generalizing fix per
//      cluster (path-fenced to the post-OAuth nav planner), gates it FAST
//      offline, then commits ONLY if the LIVE oracle passes — the cluster
//      extracts working keys on >=M services AND a held-out canary didn't
//      regress (measured once, pre-loop).
//   3. a lap that commits nothing → converged. Walls + parked + capability-gaps
//      are the honest residual (need a new capability, not a re-run).
//
// The offline gate is the cheap inner filter; the live key is the oracle. The
// canary baseline is the silent-collapse tripwire. Operator-only.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkFixAgentCommand,
  resolveFixAgentCommand,
  runFixMode,
} from "./fix.js";
import type { FixCluster, StaleClusterGateResult } from "../fix-agent.js";
import type { FailureOwner } from "../fix-router.js";
import {
  discoverLiveRunner,
  makeDistBuilder,
  makeLiveGate,
} from "../fix-agent-runtime.js";
import { measureCanaryBaseline } from "../live-gate.js";

const DEFAULT_CANARY = ["ipinfo", "clickhouse-cloud", "instant-db", "langfuse"];
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const OWNER_ORDER: FailureOwner[] = ["code", "retry", "capability", "external"];
const RECENT_LOG_LIMIT = 160;

interface AutoloopProgress {
  runId: string;
  phase: string;
  lap?: number;
  maxLaps?: number;
  agent?: string;
  currentCommit?: string;
  recentLogLines: string[];
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: string;
}

export interface AutoloopCrashReport {
  schema_version: 1;
  kind: "autoloop_crash";
  run_id: string;
  timestamp: string;
  cwd: string;
  phase: string;
  lap?: number;
  max_laps?: number;
  agent?: string;
  current_commit?: string;
  pid: number;
  error: SerializedError;
  recent_log_lines: string[];
}

function defaultCrashDir(): string {
  return join(homedir(), ".trusty-squire", "autoloop-crashes");
}

function safeFileSegment(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "autoloop";
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = {
      name: err.name,
      message: err.message,
    };
    if (typeof err.stack === "string") out.stack = err.stack;
    if ("cause" in err && err.cause !== undefined) out.cause = String(err.cause);
    return out;
  }
  return { name: "NonError", message: String(err) };
}

export function writeAutoloopCrashReport(
  progress: AutoloopProgress,
  err: unknown,
  crashDir = defaultCrashDir(),
): string {
  mkdirSync(crashDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const report: AutoloopCrashReport = {
    schema_version: 1,
    kind: "autoloop_crash",
    run_id: progress.runId,
    timestamp,
    cwd: process.cwd(),
    phase: progress.phase,
    ...(progress.lap !== undefined ? { lap: progress.lap } : {}),
    ...(progress.maxLaps !== undefined ? { max_laps: progress.maxLaps } : {}),
    ...(progress.agent !== undefined ? { agent: progress.agent } : {}),
    ...(progress.currentCommit !== undefined ? { current_commit: progress.currentCommit } : {}),
    pid: process.pid,
    error: serializeError(err),
    recent_log_lines: [...progress.recentLogLines],
  };
  const file = join(
    crashDir,
    `${timestamp.replace(/[:.]/g, "-")}-${safeFileSegment(progress.runId)}.json`,
  );
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, body);
  writeFileSync(join(crashDir, "latest.json"), body);
  return file;
}

function liveGateConcurrencyFromEnv(): number {
  const raw = Number(process.env.TRUSTY_SQUIRE_LIVE_GATE_CONCURRENCY ?? "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function liveRetryBudgetFromEnv(): number {
  const raw = Number(process.env.TRUSTY_SQUIRE_LIVE_RETRY_BUDGET ?? "1");
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function legacyBestOfFromEnv(): number | undefined {
  const rawEnv = process.env.TRUSTY_SQUIRE_LIVE_BEST_OF;
  if (rawEnv === undefined) return undefined;
  const raw = Number(rawEnv);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function formatOwnerCounts(routed: readonly { owner: FailureOwner }[]): string {
  const counts = new Map<FailureOwner, number>();
  for (const owner of OWNER_ORDER) counts.set(owner, 0);
  for (const r of routed) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  return OWNER_ORDER.map((owner) => `${owner}=${counts.get(owner) ?? 0}`).join(" ");
}

function currentGitCommit(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function staleReproBudgetFromEnv(): number {
  const raw = Number(process.env.TRUSTY_SQUIRE_STALE_REPRO_BUDGET ?? "4");
  if (!Number.isFinite(raw) || raw < 0) return 4;
  return Math.floor(raw);
}

function staleCommitSummary(cluster: FixCluster, currentCommit: string): string {
  const commits = [...new Set(cluster.failures.map((f) => f.source_commit ?? "legacy"))];
  return `${commits.map((c) => (c === "legacy" ? c : c.slice(0, 8))).join(",")} != ${currentCommit.slice(0, 8)}`;
}

function makeStaleClusterGate(input: {
  currentCommit: string | undefined;
  runner: ReturnType<typeof discoverLiveRunner>;
  log: (line: string) => void;
}): (cluster: FixCluster) => Promise<StaleClusterGateResult> {
  let remaining = staleReproBudgetFromEnv();
  return async (cluster: FixCluster): Promise<StaleClusterGateResult> => {
    const currentCommit = input.currentCommit;
    if (currentCommit === undefined) {
      return { proceed: true, reason: "current git commit unavailable; freshness gate skipped" };
    }
    const stale = cluster.failures.some((f) => f.source_commit !== currentCommit);
    if (!stale) return { proceed: true, reason: "failure captured at current commit" };
    if (remaining <= 0) {
      return {
        proceed: false,
        reason: `stale-deferred: repro budget exhausted for this lap (${staleCommitSummary(cluster, currentCommit)})`,
      };
    }
    remaining -= 1;
    input.log(
      `cluster ${cluster.id}: stale capture commit (${staleCommitSummary(cluster, currentCommit)}) — fresh repro before proposer`,
    );
    const red: string[] = [];
    for (const service of [...new Set(cluster.services)]) {
      try {
        const result = await input.runner(service);
        if (!result.green) red.push(service);
      } catch (err) {
        return {
          proceed: false,
          reason: `stale-repro-error: ${service}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (red.length === 0) {
      return {
        proceed: false,
        reason: "stale-resolved: fresh repro green at current commit; old failure ignored",
      };
    }
    return {
      proceed: false,
      reason: `stale-recaptured: fresh repro still red for ${red.join(", ")}; next lap will use current-commit capture`,
    };
  };
}

export async function runAutoloop(opts: {
  log?: (line: string) => void;
  maxLaps?: number;
  agent?: string;
}): Promise<void> {
  const rawLog = opts.log ?? ((l: string) => console.log(`[autoloop] ${l}`));
  const progress: AutoloopProgress = {
    runId: `autoloop-${process.pid}-${Date.now().toString(36)}`,
    phase: "startup",
    recentLogLines: [],
  };
  const log = (line: string): void => {
    progress.recentLogLines.push(`${new Date().toISOString()} ${line}`);
    if (progress.recentLogLines.length > RECENT_LOG_LIMIT) progress.recentLogLines.shift();
    rawLog(line);
  };
  const repoRoot = process.cwd();
  const maxLaps = opts.maxLaps ?? (Number(process.env.AUTOLOOP_MAX_LAPS ?? "6") || 6);
  progress.maxLaps = maxLaps;
  try {
    const cliCommand = resolveFixAgentCommand(opts.agent);
    progress.agent = cliCommand.label;
    const commandProblem = checkFixAgentCommand(cliCommand.command);
    if (commandProblem !== null) {
      log(`ABORT: ${commandProblem}`);
      return;
    }
    log(`using fix proposer agent=${cliCommand.label}`);

    const canary = (process.env.TRUSTY_SQUIRE_FIX_CANARY ?? DEFAULT_CANARY.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const minClusterMove = Number(process.env.TRUSTY_SQUIRE_FIX_MIN_MOVE ?? "2") || 2;
    const liveGateConcurrency = liveGateConcurrencyFromEnv();
    const liveGateMaxAttempts = legacyBestOfFromEnv() ?? liveRetryBudgetFromEnv() + 1;

    progress.phase = "init-live-runner";
    const runner = discoverLiveRunner({ repoRoot, log });
    const build = makeDistBuilder({ repoRoot });
    const currentCommit = currentGitCommit(repoRoot);
    if (currentCommit !== undefined) {
      progress.currentCommit = currentCommit;
      log(`current commit for freshness gate: ${currentCommit.slice(0, 12)}`);
    } else {
      log("WARN: current commit unavailable — stale-failure freshness gate will be skipped");
    }

    // The canary baseline — measured ONCE, live, before any fix. The live gate
    // rejects any fix that drops the canary below this. Measured against the
    // CURRENT (pre-loop) code, so it reflects reality at the start of the run.
    progress.phase = "canary-baseline";
    log(
      `measuring canary baseline (live, concurrency=${liveGateConcurrency}, retry_budget=${liveGateMaxAttempts - 1}): ${canary.join(", ")}…`,
    );
    const baselineCanaryGreen = await measureCanaryBaseline(
      runner,
      canary,
      liveGateConcurrency,
      liveGateMaxAttempts,
    );
    log(`canary baseline: ${baselineCanaryGreen}/${canary.length} green`);
    if (baselineCanaryGreen === 0) {
      log(
        "ABORT: canary baseline is 0/" +
          canary.length +
          " — the pool or env is broken; a live gate would pass everything. Fix the canary first.",
      );
      return;
    }

    progress.phase = "live-gate-setup";
    const liveGate = makeLiveGate({
      repoRoot,
      canary,
      baselineCanaryGreen,
      minClusterMove,
      concurrency: liveGateConcurrency,
      maxAttempts: liveGateMaxAttempts,
      runner,
      build,
      log,
    });

    let totalCommitted = 0;
    for (let lap = 1; lap <= maxLaps; lap++) {
      progress.lap = lap;
      progress.phase = "fix-pass";
      log(`========== LAP ${lap}/${maxLaps} ==========`);
      const result = await runFixMode({
        // Wide window: the autoloop fixes the accumulated ledger backlog, not
        // just the last 24h.
        sinceMs: Date.now() - SIXTY_DAYS_MS,
        liveGate,
        ...(currentCommit !== undefined ? { currentCommit } : {}),
        staleClusterGate: makeStaleClusterGate({ currentCommit, runner, log }),
        log,
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      });
      const committed = result?.committed.length ?? 0;
      const walls = result?.walls.length ?? 0;
      const parked = result?.parked.length ?? 0;
      const ownerCounts = formatOwnerCounts(result?.routed ?? []);
      const proposerBlocked = (result?.parked ?? []).some((p) =>
        p.reason.startsWith("proposer error:") ||
        p.reason.includes("proposer command not found"),
      );
      const madeFreshnessProgress = (result?.parked ?? []).some(
        (p) => p.reason.startsWith("stale-resolved:") || p.reason.startsWith("stale-recaptured:"),
      );
      const exhaustedFixes = (result?.walls ?? []).some((w) =>
        w.reason.includes("no fix both held the gate"),
      );
      totalCommitted += committed;
      log(`LAP ${lap}: committed=${committed} walls=${walls} parked=${parked} owners(${ownerCounts})`);
      for (const c of result?.committed ?? []) {
        log(`  ✅ ${c.cluster_id} → ${c.version}: ${c.summary}`);
      }
      if (committed === 0) {
        if (madeFreshnessProgress) {
          log("stale failures were reprobed; continuing so current-commit outcomes can replace old evidence.");
          continue;
        } else if (proposerBlocked) {
          log(`STOPPED at lap ${lap}: proposer failed; not converged.`);
        } else if (exhaustedFixes) {
          log(`STOPPED at lap ${lap}: fixable clusters exhausted without a passing candidate; not converged.`);
        } else {
          log(`CONVERGED at lap ${lap}: no commit-worthy fixable clusters remained.`);
        }
        break;
      }
    }
    progress.phase = "done";
    log(`========== AUTOLOOP DONE — ${totalCommitted} fix(es) committed total ==========`);
  } catch (err) {
    try {
      const crashPath = writeAutoloopCrashReport(progress, err);
      log(`CRASH: wrote autoloop crash report: ${crashPath}`);
    } catch (writeErr) {
      log(
        `CRASH: failed to write autoloop crash report: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`,
      );
    }
    throw err;
  }
}
