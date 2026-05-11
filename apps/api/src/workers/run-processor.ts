// BullMQ worker that drives runs forward by calling executeOneStep.
//
// Spec: same process as API for v0, concurrency 4. Each job carries
// a run_id; on completion we re-enqueue with a short delay if the
// run isn't yet terminal and isn't awaiting external input
// (PENDING_APPROVAL). The state machine's `isTerminal` plus the
// PENDING_APPROVAL gate handles the loop.

import {
  executeOneStep,
  isTerminal,
  type ExecutorConfig,
} from "@trusty-squire/runtime";

export interface RunJobData {
  run_id: string;
}

export interface RunProcessorDeps {
  executor: ExecutorConfig;
  // BullMQ types intentionally pulled in lazily by the consumer —
  // chunk-10 tests inject a fake queue to avoid Redis.
  enqueueFollowUp: (runId: string, delayMs: number) => Promise<void>;
  logger?: { info: (msg: string, ctx?: unknown) => void; error: (err: unknown, msg: string) => void };
}

export async function processRunJob(
  data: RunJobData,
  deps: RunProcessorDeps,
): Promise<{ next_state: string; rescheduled: boolean }> {
  const run = await executeOneStep(deps.executor, data.run_id);
  const shouldContinue =
    !isTerminal(run.state) &&
    run.state !== "PENDING_APPROVAL" &&
    run.state !== "MANDATE_VALIDATED";

  if (shouldContinue) {
    await deps.enqueueFollowUp(data.run_id, 100);
  }
  deps.logger?.info("run_job_processed", {
    run_id: data.run_id,
    next_state: run.state,
    rescheduled: shouldContinue,
  });
  return { next_state: run.state, rescheduled: shouldContinue };
}
