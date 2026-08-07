import type { HarnessReport, Speedup } from "./types.js";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const multiplier = (value: Speedup): string => `${value === "infinite" ? "∞" : value.toFixed(2)}x`;

export function renderReportJson(report: HarnessReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderReportMarkdown(report: HarnessReport): string {
  const { metrics, thresholds } = report;
  const rows = [
    [
      "speedup_on_hit",
      `turns ${multiplier(metrics.speedup_on_hit.turns)}; tokens ${multiplier(metrics.speedup_on_hit.tokens)}; wall ${multiplier(metrics.speedup_on_hit.wall_clock)}`,
      `median >= ${multiplier(thresholds.net_speedup)} (diagnostic; headline is net)`,
    ],
    ["hit_rate", percent(metrics.hit_rate), "measured"],
    [
      "net_speedup",
      `turns ${multiplier(metrics.net_speedup.turns)}; tokens ${multiplier(metrics.net_speedup.tokens)}; wall ${multiplier(metrics.net_speedup.wall_clock)}`,
      `turns + tokens median >= ${multiplier(thresholds.net_speedup)}`,
    ],
    [
      "clean_replay_correctness",
      percent(metrics.clean_replay_correctness),
      `>= ${percent(thresholds.clean_replay_correctness)}`,
    ],
    ["task_success", percent(metrics.task_success), `>= ${percent(thresholds.task_success)}`],
    ["fallback_rate", percent(metrics.fallback_rate), "reported"],
    ["money_escape", String(metrics.money_escape), `= ${thresholds.money_escape} (veto)`],
    [
      "drift_catch_rate",
      percent(metrics.drift_catch_rate),
      `= ${percent(thresholds.drift_catch_rate)}`,
    ],
    ["recipe_survival", "T+7d n/a; T+30d n/a", "reported by housekeeper"],
    ["novel_false_hits", String(metrics.invariants.novel_false_hits), "= 0 (MISS invariant)"],
    [
      "missing_warm_samples",
      String(metrics.invariants.missing_warm_samples),
      "= 0 (complete observation invariant)",
    ],
    [
      "infrastructure_failures",
      String(metrics.invariants.infrastructure_failures),
      "= 0 (unavailable samples never become escapes)",
    ],
  ];
  const baselineSources = [
    ...new Set(
      report.cold_baseline.recordings.map((recording) => {
        const { driver, model } = recording.provenance;
        return model === undefined ? driver : `${driver}/${model}`;
      }),
    ),
  ];
  const evaluation = report.evaluation;
  const repeatBaseline = evaluation?.cold_baseline_by_bucket.repeat;
  const novelBaseline = evaluation?.cold_baseline_by_bucket.novel;
  const lines = [
    "# Replay-engine evaluation",
    "",
    `Mode: ${report.mode}; corpus: ${report.corpus.tasks} tasks (${report.corpus.repeat} repeat, ${report.corpus.novel} novel), ${report.corpus.drift_trials} drift trials.`,
    ...(repeatBaseline === undefined
      ? []
      : [`Repeat cold baseline median: ${repeatBaseline.turns.toFixed(1)} turns, ${repeatBaseline.tokens.toFixed(0)} tokens, ${repeatBaseline.wall_clock_ms.toFixed(0)} ms.`]),
    ...(novelBaseline === undefined
      ? []
      : [`Novel cold baseline median: ${novelBaseline.turns.toFixed(1)} turns, ${novelBaseline.tokens.toFixed(0)} tokens, ${novelBaseline.wall_clock_ms.toFixed(0)} ms.`]),
    `Cold baseline evidence: ${report.cold_baseline.recordings.length} driver-recorded tasks${baselineSources.length === 0 ? "" : ` via ${baselineSources.join(", ")}`}.`,
    "",
    "| Metric | Value | Threshold |",
    "| --- | ---: | --- |",
    ...rows.map(([metric, value, threshold]) => `| \`${metric}\` | ${value} | ${threshold} |`),
    "",
    report.decision === "SHIP" ? "SHIP" : `NO-SHIP — ${report.reasons.join("; ")}`,
    ...(evaluation === undefined
      ? []
      : [
          "",
          "## Repeat warm outcomes",
          "",
          ...(evaluation.capture_failures.length === 0
            ? []
            : [
                "Trace capture failures:",
                ...evaluation.capture_failures.map((failure) => `- ${failure}`),
                "",
              ]),
          ...(evaluation.invalidated_reasons === undefined || evaluation.invalidated_reasons.length === 0
            ? []
            : [
                "Invalidated measurements:",
                ...evaluation.invalidated_reasons.map((reason) => `- ${reason}`),
                "",
              ]),
          "| Task | Observed vs expected divergence | Fallbacks | §2 verdict | Assessment |",
          "| --- | --- | ---: | --- | --- |",
          ...evaluation.repeat_outcomes.map((outcome) =>
            `| \`${outcome.task_id}\` | ${outcome.divergent_fields.length === 0 ? "none" : outcome.divergent_fields.join("; ")} | ${outcome.fallbacks} | ${outcome.verdict_class} | ${outcome.assessment ?? "—"} |`,
          ),
          "",
          "Clean deterministic replays record zero LLM turns and tokens; fallback rescues record their measured Codex usage before replay resumes.",
        ]),
  ];
  return lines.join("\n");
}
