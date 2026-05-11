// Compensator — walks a run's side effects in LIFO order and fires the
// reverse action for each. Failures are logged and non-fatal: the goal
// is to undo as much as possible, not to block the run from reaching
// FAILED.
//
// Per spec:
//   - LIFO order (most recent reversed first)
//   - Per-effect retry: 1s, 4s, 16s exponential backoff
//   - Non-reversible side effects → tagged for human review, others continue
//   - Per-credential idempotency key: `${run.id}.compensate.${side_effect.id}`
//   - Outcomes collected into the compensation_completed event payload

import { transition } from "./state-machine.js";
import { executeReverseHttp, ReverseHttpError } from "./step-executors/reverse-http.js";
import type {
  CompensationResult,
  CompensationResults,
  Run,
  SideEffect,
} from "./types.js";
import type { RunStore } from "./run-store.js";
import type { VaultClient } from "./vault-client.js";

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

export interface CompensateOptions {
  fetch?: typeof fetch;
  // Pluggable so tests don't actually wait 21 seconds on a triple retry.
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  // Pluggable for tests; defaults to console.warn.
  logger?: (message: string, context: Record<string, unknown>) => void;
}

export async function compensate(
  runStore: RunStore,
  vault: VaultClient,
  runId: string,
  options: CompensateOptions = {},
): Promise<Run> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.logger ?? defaultLogger;

  // Snapshot run state at compensation start. The audit-only
  // compensation_started transition records the entry; the snapshot
  // we drive from is whatever was loaded here.
  const initial = await runStore.loadRun(runId);
  if (initial.state !== "COMPENSATING") {
    throw new Error(`Cannot compensate run in state ${initial.state} (need COMPENSATING)`);
  }
  await runStore.applyTransition(
    runId,
    transition(initial, { kind: "compensation_started" }, now()),
  );

  // LIFO — undo the most recent effect first.
  const orderedEffects = [...initial.side_effects].reverse();
  const results: CompensationResult[] = [];

  for (const effect of orderedEffects) {
    if (!effect.reversible) {
      log("compensation_skip_non_reversible", { run_id: runId, side_effect_id: effect.id });
      results.push({
        side_effect_id: effect.id,
        outcome: "skipped_non_reversible",
      });
      continue;
    }

    const outcome = await tryReverseWithBackoff(effect, vault, runId, options, sleep, log);
    results.push(outcome);
  }

  const after = await runStore.loadRun(runId);
  const compensationResults: CompensationResults = { per_effect: results };
  return runStore.applyTransition(
    runId,
    transition(after, { kind: "compensation_completed", results: compensationResults }, now()),
  );
}

async function tryReverseWithBackoff(
  effect: SideEffect,
  vault: VaultClient,
  runId: string,
  options: CompensateOptions,
  sleep: (ms: number) => Promise<void>,
  log: (message: string, context: Record<string, unknown>) => void,
): Promise<CompensationResult> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await executeReverseAction(effect, vault, runId, options);
      return {
        side_effect_id: effect.id,
        outcome: "succeeded",
        attempts: attempt,
      };
    } catch (err) {
      lastErr = err;
      log("compensation_attempt_failed", {
        run_id: runId,
        side_effect_id: effect.id,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      // Spec: 1s, 4s, 16s. Retry sequence sleeps BETWEEN attempts; we
      // skip the sleep after the final attempt because we're done.
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      }
    }
  }

  log("compensation_gave_up", {
    run_id: runId,
    side_effect_id: effect.id,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  return {
    side_effect_id: effect.id,
    outcome: "failed",
    attempts: RETRY_DELAYS_MS.length,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

async function executeReverseAction(
  effect: SideEffect,
  vault: VaultClient,
  runId: string,
  options: CompensateOptions,
): Promise<void> {
  const reverse = effect.reverse_action;
  switch (reverse.kind) {
    case "http_request":
      await executeReverseHttp(reverse, {
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        idempotencyKey: `${runId}.compensate.${effect.id}`,
        vault,
      });
      return;
    case "vault_delete":
      await vault.delete(reverse.reference_template);
      return;
    case "stripe_refund":
      // Stripe integration is a separate chunk; surface as failure
      // rather than silently succeeding (which would let charges leak).
      throw new NotImplementedError(
        `stripe_refund not yet implemented (charge: ${reverse.charge_id_template})`,
      );
    case "noop":
      // Documented intentional no-op — typical for non-reversible
      // operations the adapter author chose to mark explicitly.
      return;
  }
}

// ── Defaults ─────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLogger(message: string, context: Record<string, unknown>): void {
  console.warn(`[compensator] ${message}`, context);
}

export { ReverseHttpError };
