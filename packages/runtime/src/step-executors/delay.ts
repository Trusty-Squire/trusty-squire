// delay — bounded wait. Anything beyond 60 seconds belongs in a
// scheduler-driven flow, not a synchronous step (which would tie up
// the worker process). Over-limit is a capability violation.

import type { DelayStepDef } from "@trusty-squire/adapter-sdk";
import {
  type BaseStepCtx,
  makeError,
  newStepRecord,
  nowIso,
} from "./_helpers.js";
import type { Run, StepError, StepRecord } from "../types.js";

const MAX_SECONDS = 60;

export interface DelayContext extends BaseStepCtx {
  sleep?: (ms: number) => Promise<void>;
}

export type DelayResult =
  | { kind: "success"; step: StepRecord; new_side_effects: never[] }
  | { kind: "failure"; step: StepRecord; error: StepError };

export async function executeDelay(
  stepDef: DelayStepDef,
  _run: Run,
  ctx: DelayContext,
): Promise<DelayResult> {
  const startedAt = nowIso(ctx);
  const requestRecord = { seconds: stepDef.seconds };

  if (!Number.isFinite(stepDef.seconds) || stepDef.seconds < 0) {
    return {
      kind: "failure",
      step: newStepRecord(
        ctx,
        stepDef.id,
        stepDef.type,
        startedAt,
        nowIso(ctx),
        "failure",
        requestRecord,
        null,
      ),
      error: makeError(`DELAY_INVALID: ${stepDef.seconds}`, { capability_violation: true }, {
        code: "DELAY_INVALID",
        attempted: stepDef.seconds,
      }),
    };
  }

  if (stepDef.seconds > MAX_SECONDS) {
    return {
      kind: "failure",
      step: newStepRecord(
        ctx,
        stepDef.id,
        stepDef.type,
        startedAt,
        nowIso(ctx),
        "failure",
        requestRecord,
        null,
      ),
      error: makeError(
        `DELAY_TOO_LONG: requested ${stepDef.seconds}s, max ${MAX_SECONDS}s`,
        { capability_violation: true },
        { code: "DELAY_TOO_LONG", declared_max: MAX_SECONDS, attempted: stepDef.seconds },
      ),
    };
  }

  const ms = Math.round(stepDef.seconds * 1000);
  const sleep = ctx.sleep ?? defaultSleep;
  await sleep(ms);

  return {
    kind: "success",
    step: newStepRecord(
      ctx,
      stepDef.id,
      stepDef.type,
      startedAt,
      nowIso(ctx),
      "success",
      requestRecord,
      { slept_ms: ms },
    ),
    new_side_effects: [],
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
