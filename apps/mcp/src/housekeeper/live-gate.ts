// live-gate.ts — autonomous-fix-loop Phase 2 (docs/DESIGN-autonomous-fix-loop.md).
//
// THE ORACLE. A candidate fix commits only if, run LIVE:
//   1. the cluster it targets now extracts a working key on ≥M distinct
//      services (it actually fixed the bug, generally — not a one-service hack), AND
//   2. a held-out CANARY of known-good services did NOT regress (the fix didn't
//      break things it wasn't aiming at — the silent-collapse tripwire).
//
// Unlike the offline eval (frozen DOM, planner-step assertion), this asserts the
// UNFAKEABLE outcome: a real API key came out of a real signup. You cannot spoof
// it, overfit it, or mislabel it — which is why it's the gate and the offline
// corpus is only the fast inner filter.
//
// Pure orchestration over an injected LiveRunner (the real impl drives discover;
// tests fake it), so the gate logic is unit-tested with zero browsers.

// Run ONE service live; report whether it produced a working credential.
export type LiveRunner = (service: string) => Promise<{ green: boolean }>;

export interface LiveGateInput {
  /** The cluster's services (the fix targets these). */
  cluster: readonly string[];
  /** Held-out known-good services the fix never trains on. */
  canary: readonly string[];
  /** Canary greens measured BEFORE the fix (the no-regression baseline). */
  baselineCanaryGreen: number;
  /** Minimum distinct cluster services that must now extract a key (anti-overfit). */
  minClusterMove: number;
}

export interface LiveGateVerdict {
  clusterGreen: number;
  clusterTotal: number;
  canaryGreen: number;
  canaryTotal: number;
  /** The fix moved ≥M cluster services. */
  clusterMoved: boolean;
  /** The canary didn't regress below its pre-fix baseline. */
  canaryHeld: boolean;
  /** COMMIT iff both: the cluster moved AND the canary held. */
  passed: boolean;
  reason: string;
}

async function countGreen(
  run: LiveRunner,
  services: readonly string[],
): Promise<number> {
  // Sequential by default — the caller owns concurrency (a gate run shares the
  // drain's bounded pool). Each result is independent; a thrown run counts as
  // not-green (a fix that crashes the bot is not a pass).
  let green = 0;
  for (const s of services) {
    try {
      if ((await run(s)).green) green += 1;
    } catch {
      // a crash is a non-green outcome, not a gate error
    }
  }
  return green;
}

export async function runLiveGate(
  run: LiveRunner,
  input: LiveGateInput,
): Promise<LiveGateVerdict> {
  const clusterGreen = await countGreen(run, input.cluster);
  const canaryGreen = await countGreen(run, input.canary);

  const clusterMoved = clusterGreen >= input.minClusterMove;
  // "Held" = didn't drop below baseline (the generalization guard). A canary
  // that was already flaky doesn't block a good fix; only a real regression does.
  const canaryHeld = canaryGreen >= input.baselineCanaryGreen;
  const passed = clusterMoved && canaryHeld;

  const reason = passed
    ? `commit: ${clusterGreen}/${input.cluster.length} cluster green (≥${input.minClusterMove}) and canary held ${canaryGreen}/${input.canary.length} (≥${input.baselineCanaryGreen})`
    : !clusterMoved
      ? `reject: only ${clusterGreen}/${input.cluster.length} cluster green (<${input.minClusterMove}) — fix didn't generalize`
      : `reject: canary regressed ${canaryGreen} < baseline ${input.baselineCanaryGreen} — fix broke a known-good service`;

  return {
    clusterGreen,
    clusterTotal: input.cluster.length,
    canaryGreen,
    canaryTotal: input.canary.length,
    clusterMoved,
    canaryHeld,
    passed,
    reason,
  };
}

// Measure the canary baseline BEFORE proposing a fix (the pre-fix known-good
// rate the gate must not drop below). Same runner, just the canary set.
export async function measureCanaryBaseline(
  run: LiveRunner,
  canary: readonly string[],
): Promise<number> {
  return countGreen(run, canary);
}
