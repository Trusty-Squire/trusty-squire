import { performance } from "node:perf_hooks";
import { endStatesMatch } from "./corpus.js";
import { mutateHar, type HarFile } from "./har-mutate.js";
import { buildHarnessReport } from "./metrics.js";
import type {
  ColdBaselineProvenance,
  CostSample,
  DriftMutationName,
  DriftObservation,
  ExpectedEndState,
  HarnessReport,
  ShoppingTaskRecord,
  TaskObservation,
} from "./types.js";

export const DRIFT_MUTATIONS = [
  "rename-button",
  "swap-testid",
  "remove-field",
  "change-price",
  "out-of-stock",
  "overlay",
] as const satisfies readonly DriftMutationName[];

export interface ColdBaselineDriverResult {
  turns: number;
  tokens: number;
  end_state: ExpectedEndState;
}

export interface ColdBaselineDriver {
  name: string;
  model: string;
  drive(task: ShoppingTaskRecord): Promise<ColdBaselineDriverResult>;
}

export interface ColdBaselineCaptureOptions {
  recordedAt?: string;
  now?: () => number;
}

export interface DriftReplayInput {
  task: ShoppingTaskRecord;
  mutation: DriftMutationName;
  har: HarFile;
}

export interface DriftReplayResult {
  guard_action: DriftObservation["guard_action"];
  end_state: ExpectedEndState;
  /** The production checkout verifier result when a money mutation exposes a total. */
  total_verify_oracle?: "clean" | "abort";
  price_guard_causal?: boolean;
  /** A harness/browser/rescue exception, never an observed payment escape. */
  infrastructure_failure?: string;
}

export type DriftReplayAdapter = (input: DriftReplayInput) => Promise<DriftReplayResult>;

function assertMeasuredCost(taskId: string, cost: CostSample): void {
  if (
    !Number.isFinite(cost.turns) ||
    cost.turns < 0 ||
    !Number.isFinite(cost.tokens) ||
    cost.tokens < 0 ||
    !Number.isFinite(cost.wall_clock_ms) ||
    cost.wall_clock_ms < 0
  ) {
    throw new Error(`${taskId}: cold driver returned invalid turns or tokens`);
  }
}

export async function recordAllColdBaseline(
  tasks: ShoppingTaskRecord[],
  driver: ColdBaselineDriver,
  options: ColdBaselineCaptureOptions = {},
): Promise<TaskObservation[]> {
  if (driver.name.trim().length === 0) throw new Error("cold driver name is required");
  if (driver.model.trim().length === 0) throw new Error("cold driver model is required");
  const now = options.now ?? performance.now.bind(performance);
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const provenance: ColdBaselineProvenance = {
    source: "driver",
    driver: driver.name,
    model: driver.model,
    recorded_at: recordedAt,
  };
  const observations: TaskObservation[] = [];
  for (const task of tasks.filter((candidate) => candidate.capture.status === "captured")) {
    const started = now();
    const result = await driver.drive(task);
    const cold = {
      turns: result.turns,
      tokens: result.tokens,
      wall_clock_ms: Math.round(Math.max(0, now() - started)),
    };
    assertMeasuredCost(task.task_id, cold);
    const endStateMatches = endStatesMatch(result.end_state, task.expected_end_state);
    observations.push({
      task_id: task.task_id,
      bucket: task.bucket,
      cold,
      cold_recording: {
        task_id: task.task_id,
        ...cold,
        end_state: result.end_state,
        end_state_matches: endStateMatches,
        provenance,
      },
      recipe_applied: false,
      end_state_matches: endStateMatches,
      fallbacks: 0,
      total_steps: 0,
    });
  }
  return observations;
}

export function readFrozenAllColdBaseline(tasks: ShoppingTaskRecord[]): TaskObservation[] {
  return tasks
    .filter((task) => task.capture.status === "captured")
    .map((task) => {
      const cold = {
        turns: task.cold_baseline.turns,
        tokens: task.cold_baseline.tokens,
        wall_clock_ms: task.cold_baseline.wall_clock_ms,
      };
      const endStateMatches = endStatesMatch(task.cold_baseline.end_state, task.expected_end_state);
      return {
        task_id: task.task_id,
        bucket: task.bucket,
        cold,
        cold_recording: {
          task_id: task.task_id,
          ...cold,
          end_state: task.cold_baseline.end_state,
          end_state_matches: endStateMatches,
          provenance: task.cold_baseline.provenance,
        },
        recipe_applied: false,
        end_state_matches: endStateMatches,
        fallbacks: 0,
        total_steps: 0,
      } satisfies TaskObservation;
    });
}

export async function runAllColdHarness(
  tasks: ShoppingTaskRecord[],
  drift: DriftObservation[],
  driver: ColdBaselineDriver,
  options: ColdBaselineCaptureOptions & { generatedAt?: string } = {},
): Promise<HarnessReport> {
  const recordedAt = options.recordedAt ?? options.generatedAt;
  const observations = await recordAllColdBaseline(tasks, driver, {
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  for (const observation of observations) {
    if (!observation.end_state_matches) {
      throw new Error(`${observation.task_id}: cold baseline did not reach its expected end state`);
    }
  }
  return buildHarnessReport(observations, drift, {
    mode: "all-cold-baseline",
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
}

export function runFrozenAllColdHarness(
  tasks: ShoppingTaskRecord[],
  drift: DriftObservation[],
  generatedAt?: string,
): HarnessReport {
  const observations = readFrozenAllColdBaseline(tasks);
  for (const observation of observations) {
    if (!observation.end_state_matches) {
      throw new Error(`${observation.task_id}: frozen cold baseline has the wrong end state`);
    }
  }
  return buildHarnessReport(observations, drift, {
    mode: "all-cold-baseline",
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
}

export async function runDriftBattery(
  tasks: ShoppingTaskRecord[],
  loadHar: (task: ShoppingTaskRecord) => HarFile | Promise<HarFile>,
  replay: DriftReplayAdapter,
): Promise<DriftObservation[]> {
  const observations: DriftObservation[] = [];
  for (const task of tasks) {
    const sourceHar = await loadHar(task);
    for (const mutation of DRIFT_MUTATIONS) {
      const mutated = mutateHar(sourceHar, mutation, {
        expectedTotalCents: task.expected_end_state.total_cents,
        ...(task.params.product_price_cents === undefined
          ? {}
          : { displayedPriceCents: task.params.product_price_cents }),
      });
      if (mutated.replacements === 0) {
        throw new Error(`${task.task_id}: ${mutation} did not mutate a HAR response`);
      }
      const result = await replay({ task, mutation, har: mutated.har });
      const moneyAffecting = mutation === "change-price";
      observations.push({
        task_id: task.task_id,
        mutation,
        money_affecting: moneyAffecting,
        guard_action: result.guard_action,
        ...(moneyAffecting
          ? {
              ...(result.total_verify_oracle === undefined
                ? {}
                : { total_verify_oracle: result.total_verify_oracle }),
              price_guard_causal: result.price_guard_causal === true,
            }
          : {}),
        end_state_matches: endStatesMatch(result.end_state, task.expected_end_state),
        ...(result.infrastructure_failure === undefined
          ? {}
          : { infrastructure_failure: result.infrastructure_failure }),
      });
    }
  }
  return observations;
}

export function unavailableDriftBattery(
  task: ShoppingTaskRecord,
  reason: string,
): DriftObservation[] {
  return DRIFT_MUTATIONS.map((mutation) => ({
    task_id: task.task_id,
    mutation,
    money_affecting: mutation === "change-price",
    guard_action: "fallback",
    ...(mutation === "change-price" ? { price_guard_causal: false } : {}),
    end_state_matches: false,
    infrastructure_failure: reason,
  }));
}

export function totalVerifyGuard(
  expectedTotalCents: number,
  observedTotalCents: number,
): "clean" | "abort" {
  return expectedTotalCents === observedTotalCents ? "clean" : "abort";
}

export function moneyDriftObservation(
  task: ShoppingTaskRecord,
  observedTotalCents: number,
  observedGuardAction: DriftObservation["guard_action"],
): DriftObservation {
  return {
    task_id: task.task_id,
    mutation: "change-price",
    money_affecting: true,
    guard_action: observedGuardAction,
    total_verify_oracle: totalVerifyGuard(task.expected_end_state.total_cents, observedTotalCents),
    price_guard_causal: observedTotalCents !== task.expected_end_state.total_cents,
    end_state_matches: observedTotalCents === task.expected_end_state.total_cents,
  };
}
