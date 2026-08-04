import { endStatesMatch } from "./corpus.js";
import { buildHarnessReport } from "./metrics.js";
import type {
  DriftObservation,
  HarnessReport,
  ShoppingTaskRecord,
  TaskObservation,
} from "./types.js";

export function recordAllColdBaseline(tasks: ShoppingTaskRecord[]): TaskObservation[] {
  return tasks
    .filter((task) => task.capture.status === "captured")
    .map((task) => ({
      task_id: task.task_id,
      bucket: task.bucket,
      cold: {
        turns: task.cold_baseline.turns,
        tokens: task.cold_baseline.tokens,
        wall_clock_ms: task.cold_baseline.wall_clock_ms,
      },
      recipe_applied: false,
      end_state_matches: endStatesMatch(task.cold_baseline.end_state, task.expected_end_state),
      fallbacks: 0,
      total_steps: 0,
    }));
}

export function runAllColdHarness(
  tasks: ShoppingTaskRecord[],
  drift: DriftObservation[],
  generatedAt?: string,
): HarnessReport {
  const observations = recordAllColdBaseline(tasks);
  for (const observation of observations) {
    if (!observation.end_state_matches) {
      throw new Error(`${observation.task_id}: cold baseline did not reach its expected end state`);
    }
  }
  return buildHarnessReport(observations, drift, {
    mode: "all-cold-baseline",
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
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
): DriftObservation {
  const guardAction = totalVerifyGuard(task.expected_end_state.total_cents, observedTotalCents);
  return {
    task_id: task.task_id,
    mutation: "change-price",
    money_affecting: true,
    guard_action: guardAction,
    end_state_matches: observedTotalCents === task.expected_end_state.total_cents,
  };
}
