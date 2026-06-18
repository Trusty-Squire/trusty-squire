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

import { runFixMode } from "./fix.js";
import {
  discoverLiveRunner,
  makeDistBuilder,
  makeLiveGate,
} from "../fix-agent-runtime.js";
import { measureCanaryBaseline } from "../live-gate.js";

const DEFAULT_CANARY = ["ipinfo", "clickhouse-cloud", "instant-db", "langfuse"];
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

export async function runAutoloop(opts: {
  log?: (line: string) => void;
  maxLaps?: number;
}): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(`[autoloop] ${l}`));
  const repoRoot = process.cwd();
  const maxLaps = opts.maxLaps ?? (Number(process.env.AUTOLOOP_MAX_LAPS ?? "6") || 6);

  const canary = (process.env.TRUSTY_SQUIRE_FIX_CANARY ?? DEFAULT_CANARY.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const minClusterMove = Number(process.env.TRUSTY_SQUIRE_FIX_MIN_MOVE ?? "2") || 2;

  const runner = discoverLiveRunner({ repoRoot, log });
  const build = makeDistBuilder({ repoRoot });

  // The canary baseline — measured ONCE, live, before any fix. The live gate
  // rejects any fix that drops the canary below this. Measured against the
  // CURRENT (pre-loop) code, so it reflects reality at the start of the run.
  log(`measuring canary baseline (live): ${canary.join(", ")}…`);
  const baselineCanaryGreen = await measureCanaryBaseline(runner, canary);
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
    });
    const committed = result?.committed.length ?? 0;
    const walls = result?.walls.length ?? 0;
    const parked = result?.parked.length ?? 0;
    totalCommitted += committed;
    log(`LAP ${lap}: committed=${committed} walls=${walls} parked=${parked}`);
    for (const c of result?.committed ?? []) {
      log(`  ✅ ${c.cluster_id} → ${c.version}: ${c.summary}`);
    }
    if (committed === 0) {
      log(`CONVERGED at lap ${lap}: a full lap committed nothing.`);
      break;
    }
  }
  log(`========== AUTOLOOP DONE — ${totalCommitted} fix(es) committed total ==========`);
}
