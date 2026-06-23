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
export type LiveRunAttempt = {
  /** 1-based attempt number for this service within a best-of-N live check. */
  attempt: number;
  /** Maximum attempts the oracle will make for this service. */
  maxAttempts: number;
};

export interface LiveRunResult {
  green: boolean;
  /** Whether this red outcome is worth retrying with a fresh identity. */
  retryable?: boolean;
}

export type LiveRunner = (
  service: string,
  attempt?: LiveRunAttempt,
) => Promise<LiveRunResult>;

export interface LiveGateInput {
  /** The cluster's services (the fix targets these). */
  cluster: readonly string[];
  /** Held-out known-good services the fix never trains on. */
  canary: readonly string[];
  /** Canary greens measured BEFORE the fix (the no-regression baseline). */
  baselineCanaryGreen: number;
  /** Minimum distinct cluster services that must now extract a key (anti-overfit). */
  minClusterMove: number;
  /** Maximum live service runs in flight. Defaults to 1. */
  concurrency?: number;
  /** Per-service best-of-N attempts. Defaults to 1; autoloop defaults this to 3. */
  maxAttempts?: number;
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

function normalizeConcurrency(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function normalizeMaxAttempts(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

async function runBestOf(
  run: LiveRunner,
  service: string,
  maxAttempts: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run(service, { attempt, maxAttempts });
      if (result.green) return true;
      if (result.retryable !== true) return false;
    } catch {
      // a crash is a non-green attempt, not a gate error
    }
  }
  return false;
}

async function countGreen(
  run: LiveRunner,
  services: readonly string[],
  concurrency: number = 1,
  maxAttempts: number = 1,
): Promise<number> {
  // Sequential by default. When enabled, concurrency is bounded because each
  // service run may consume a browser, identity, proxy slot, and signup quota.
  let green = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizeConcurrency(concurrency), services.length) },
    async () => {
      for (;;) {
        const i = next++;
        const service = services[i];
        if (service === undefined) return;
        if (await runBestOf(run, service, maxAttempts)) green += 1;
      }
    }
  );
  await Promise.all(workers);
  return green;
}

type LiveGateTask = { group: "cluster" | "canary"; service: string };

async function countGateGroups(
  run: LiveRunner,
  tasks: readonly LiveGateTask[],
  concurrency: number,
  maxAttempts: number,
): Promise<{ clusterGreen: number; canaryGreen: number }> {
  let clusterGreen = 0;
  let canaryGreen = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizeConcurrency(concurrency), tasks.length) },
    async () => {
      for (;;) {
        const i = next++;
        const task = tasks[i];
        if (task === undefined) return;
        if (await runBestOf(run, task.service, maxAttempts)) {
          if (task.group === "cluster") clusterGreen += 1;
          else canaryGreen += 1;
        }
      }
    }
  );
  await Promise.all(workers);
  return { clusterGreen, canaryGreen };
}

export async function runLiveGate(
  run: LiveRunner,
  input: LiveGateInput,
): Promise<LiveGateVerdict> {
  const concurrency = normalizeConcurrency(input.concurrency);
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
  const { clusterGreen, canaryGreen } = await countGateGroups(
    run,
    [
      ...input.cluster.map((service) => ({ group: "cluster" as const, service })),
      ...input.canary.map((service) => ({ group: "canary" as const, service })),
    ],
    concurrency,
    maxAttempts,
  );

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
  concurrency?: number,
  maxAttempts?: number,
): Promise<number> {
  return countGreen(
    run,
    canary,
    normalizeConcurrency(concurrency),
    normalizeMaxAttempts(maxAttempts),
  );
}
