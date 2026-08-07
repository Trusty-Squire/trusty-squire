import type {
  DriftObservation,
  HarnessMetrics,
  HarnessReport,
  HarnessThresholds,
  Speedup,
  TaskObservation,
} from "./types.js";

export const DEFAULT_THRESHOLDS: HarnessThresholds = {
  net_speedup: 5,
  clean_replay_correctness: 0.9,
  task_success: 0.98,
  drift_catch_rate: 1,
  money_escape: 0,
};

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function speedup(numerator: number, denominator: number): Speedup {
  if (denominator > 0) return numerator / denominator;
  return numerator > 0 ? "infinite" : 0;
}

function netSpeedup(hitRate: number, hitSpeedup: Speedup): Speedup {
  if (hitRate === 0) return 0;
  return hitSpeedup === "infinite" ? "infinite" : hitRate * hitSpeedup;
}

function below(value: Speedup, threshold: number): boolean {
  return value !== "infinite" && value < threshold;
}

function printable(value: Speedup): string {
  return value === "infinite" ? "∞" : value.toFixed(2);
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function median(values: Speedup[]): Speedup {
  const numeric = values.map((value) => (value === "infinite" ? Number.POSITIVE_INFINITY : value));
  const result = medianNumber(numeric);
  return Number.isFinite(result) ? result : "infinite";
}

function speedups(
  hits: TaskObservation[],
  field: "turns" | "tokens" | "wall_clock_ms",
): Speedup[] {
  return hits.map((hit) => speedup(hit.cold[field], hit.warm?.[field] ?? 0));
}

export function computeMetrics(
  tasks: TaskObservation[],
  drift: DriftObservation[],
): HarnessMetrics {
  const realistic = tasks.filter((task) => task.bucket === "repeat");
  const hits = realistic.filter((task) => task.recipe_applied);
  const completeHits = hits.filter((task) => task.warm !== undefined);
  const hitRate = ratio(hits.length, realistic.length);
  const speedupOnHit = {
    turns: median(speedups(completeHits, "turns")),
    tokens: median(speedups(completeHits, "tokens")),
    wall_clock: median(speedups(completeHits, "wall_clock_ms")),
  };
  const totalSteps = completeHits.reduce((sum, hit) => sum + hit.total_steps, 0);
  const fallbacks = completeHits.reduce((sum, hit) => sum + hit.fallbacks, 0);
  const moneyTrials = drift.filter((trial) => trial.money_affecting);
  const observableMoneyTrials = moneyTrials.filter(
    (trial) => trial.infrastructure_failure === undefined,
  );
  const moneyEscapes = observableMoneyTrials.filter(
    (trial) =>
      !trial.end_state_matches &&
      trial.guard_action !== "abort",
  ).length;
  const caughtMoneyDrift = observableMoneyTrials.filter(
    (trial) =>
      trial.guard_action === "abort" &&
      trial.total_verify_oracle === "abort" &&
      trial.price_guard_causal === true,
  ).length;

  return {
    speedup_on_hit: speedupOnHit,
    hit_rate: hitRate,
    net_speedup: {
      turns: netSpeedup(hitRate, speedupOnHit.turns),
      tokens: netSpeedup(hitRate, speedupOnHit.tokens),
      wall_clock: netSpeedup(hitRate, speedupOnHit.wall_clock),
    },
    clean_replay_correctness: ratio(
      hits.filter((hit) => hit.warm !== undefined && hit.end_state_matches && hit.fallbacks === 0)
        .length,
      hits.length,
    ),
    task_success: ratio(
      realistic.filter((task) => task.warm !== undefined && task.end_state_matches).length,
      realistic.length,
    ),
    fallback_rate: ratio(fallbacks, totalSteps),
    money_escape: moneyEscapes,
    drift_catch_rate: ratio(caughtMoneyDrift, moneyTrials.length),
    recipe_survival: { t7d: null, t30d: null },
    invariants: {
      novel_false_hits: tasks.filter((task) => task.bucket === "novel" && task.recipe_applied)
        .length,
      missing_warm_samples: tasks.filter((task) => task.recipe_applied && task.warm === undefined)
        .length,
      infrastructure_failures:
        tasks.filter((task) => task.warm_unavailable_reason !== undefined).length +
        drift.filter((trial) => trial.infrastructure_failure !== undefined).length,
    },
  };
}

export function buildHarnessReport(
  tasks: TaskObservation[],
  drift: DriftObservation[],
  options: {
    generatedAt?: string;
    thresholds?: HarnessThresholds;
    mode?: HarnessReport["mode"];
    evaluation?: HarnessReport["evaluation"];
  } = {},
): HarnessReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const metrics = computeMetrics(tasks, drift);
  const reasons: string[] = [];
  if (below(metrics.net_speedup.turns, thresholds.net_speedup)) {
    reasons.push(
      `net speedup ${printable(metrics.net_speedup.turns)}x < ${thresholds.net_speedup.toFixed(2)}x`,
    );
  }
  if (below(metrics.net_speedup.tokens, thresholds.net_speedup)) {
    reasons.push(
      `net token speedup ${printable(metrics.net_speedup.tokens)}x < ${thresholds.net_speedup.toFixed(2)}x`,
    );
  }
  if (metrics.clean_replay_correctness < thresholds.clean_replay_correctness) {
    reasons.push(
      `clean replay correctness ${(metrics.clean_replay_correctness * 100).toFixed(2)}% < ${(thresholds.clean_replay_correctness * 100).toFixed(2)}%`,
    );
  }
  if (metrics.task_success < thresholds.task_success) {
    reasons.push(
      `task success ${(metrics.task_success * 100).toFixed(2)}% < ${(thresholds.task_success * 100).toFixed(2)}%`,
    );
  }
  if (metrics.money_escape > thresholds.money_escape) {
    reasons.push(`money-path veto: ${metrics.money_escape} escaped wrong outcome(s)`);
  }
  if (metrics.drift_catch_rate < thresholds.drift_catch_rate) {
    reasons.push(
      `drift catch rate ${(metrics.drift_catch_rate * 100).toFixed(2)}% < ${(thresholds.drift_catch_rate * 100).toFixed(2)}%`,
    );
  }
  if (metrics.invariants.novel_false_hits > 0) {
    reasons.push(
      `novel MISS invariant: ${metrics.invariants.novel_false_hits} novel recipe false hit(s)`,
    );
  }
  if (metrics.invariants.missing_warm_samples > 0) {
    reasons.push(
      `incomplete replay invariant: ${metrics.invariants.missing_warm_samples} applied recipe(s) missing warm samples`,
    );
  }
  if (metrics.invariants.infrastructure_failures > 0) {
    reasons.push(
      `infrastructure invariant: ${metrics.invariants.infrastructure_failures} structured infrastructure failure(s)`,
    );
  }
  if ((options.evaluation?.capture_failures.length ?? 0) > 0) {
    reasons.push(
      `capture artifact invariant: ${options.evaluation?.capture_failures.length ?? 0} required repeat capture(s) unavailable`,
    );
  }
  return {
    schema_version: 1,
    mode: options.mode ?? "replay-eval",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    corpus: {
      tasks: tasks.length,
      repeat: tasks.filter((task) => task.bucket === "repeat").length,
      novel: tasks.filter((task) => task.bucket === "novel").length,
      drift_trials: drift.length,
    },
    cold_baseline: {
      tasks: tasks.length,
      median: {
        turns: medianNumber(tasks.map((task) => task.cold.turns)),
        tokens: medianNumber(tasks.map((task) => task.cold.tokens)),
        wall_clock_ms: medianNumber(tasks.map((task) => task.cold.wall_clock_ms)),
      },
      total: {
        turns: tasks.reduce((sum, task) => sum + task.cold.turns, 0),
        tokens: tasks.reduce((sum, task) => sum + task.cold.tokens, 0),
        wall_clock_ms: tasks.reduce((sum, task) => sum + task.cold.wall_clock_ms, 0),
      },
      recordings: tasks.flatMap((task) =>
        task.cold_recording === undefined ? [] : [task.cold_recording],
      ),
    },
    thresholds,
    metrics,
    decision: reasons.length === 0 ? "SHIP" : "NO-SHIP",
    reasons,
    ...(options.evaluation === undefined ? {} : { evaluation: options.evaluation }),
  };
}
