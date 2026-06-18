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

import {
  checkFixAgentCommand,
  resolveFixAgentCommand,
  runFixMode,
} from "./fix.js";
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

function liveGateConcurrencyFromEnv(): number {
  const raw = Number(process.env.TRUSTY_SQUIRE_LIVE_GATE_CONCURRENCY ?? "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function formatOwnerCounts(routed: readonly { owner: FailureOwner }[]): string {
  const counts = new Map<FailureOwner, number>();
  for (const owner of OWNER_ORDER) counts.set(owner, 0);
  for (const r of routed) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  return OWNER_ORDER.map((owner) => `${owner}=${counts.get(owner) ?? 0}`).join(" ");
}

export async function runAutoloop(opts: {
  log?: (line: string) => void;
  maxLaps?: number;
  agent?: string;
}): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(`[autoloop] ${l}`));
  const repoRoot = process.cwd();
  const maxLaps = opts.maxLaps ?? (Number(process.env.AUTOLOOP_MAX_LAPS ?? "6") || 6);
  const cliCommand = resolveFixAgentCommand(opts.agent);
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

  const runner = discoverLiveRunner({ repoRoot, log });
  const build = makeDistBuilder({ repoRoot });

  // The canary baseline — measured ONCE, live, before any fix. The live gate
  // rejects any fix that drops the canary below this. Measured against the
  // CURRENT (pre-loop) code, so it reflects reality at the start of the run.
  log(
    `measuring canary baseline (live, concurrency=${liveGateConcurrency}): ${canary.join(", ")}…`,
  );
  const baselineCanaryGreen = await measureCanaryBaseline(
    runner,
    canary,
    liveGateConcurrency,
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

  const liveGate = makeLiveGate({
    repoRoot,
    canary,
    baselineCanaryGreen,
    minClusterMove,
    concurrency: liveGateConcurrency,
    runner,
    build,
    log,
  });

  let totalCommitted = 0;
  for (let lap = 1; lap <= maxLaps; lap++) {
    log(`========== LAP ${lap}/${maxLaps} ==========`);
    const result = await runFixMode({
      // Wide window: the autoloop fixes the accumulated ledger backlog, not
      // just the last 24h.
      sinceMs: Date.now() - SIXTY_DAYS_MS,
      liveGate,
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
    const exhaustedFixes = (result?.walls ?? []).some((w) =>
      w.reason.includes("no fix both held the gate"),
    );
    totalCommitted += committed;
    log(`LAP ${lap}: committed=${committed} walls=${walls} parked=${parked} owners(${ownerCounts})`);
    for (const c of result?.committed ?? []) {
      log(`  ✅ ${c.cluster_id} → ${c.version}: ${c.summary}`);
    }
    if (committed === 0) {
      if (proposerBlocked) {
        log(`STOPPED at lap ${lap}: proposer failed; not converged.`);
      } else if (exhaustedFixes) {
        log(`STOPPED at lap ${lap}: fixable clusters exhausted without a passing candidate; not converged.`);
      } else {
        log(`CONVERGED at lap ${lap}: no commit-worthy fixable clusters remained.`);
      }
      break;
    }
  }
  log(`========== AUTOLOOP DONE — ${totalCommitted} fix(es) committed total ==========`);
}
