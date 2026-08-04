import type { HarnessReport } from "./types.js";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const multiplier = (value: number): string => `${value.toFixed(2)}x`;

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
  ];
  const lines = [
    "# Replay-engine evaluation",
    "",
    `Mode: ${report.mode}; corpus: ${report.corpus.tasks} tasks (${report.corpus.repeat} repeat, ${report.corpus.novel} novel), ${report.corpus.drift_trials} drift trials.`,
    `Cold baseline median: ${report.cold_baseline.median.turns.toFixed(1)} turns, ${report.cold_baseline.median.tokens.toFixed(0)} tokens, ${report.cold_baseline.median.wall_clock_ms.toFixed(0)} ms.`,
    "",
    "| Metric | Value | Threshold |",
    "| --- | ---: | --- |",
    ...rows.map(([metric, value, threshold]) => `| \`${metric}\` | ${value} | ${threshold} |`),
    "",
    report.decision === "SHIP" ? "SHIP" : `NO-SHIP — ${report.reasons.join("; ")}`,
  ];
  return lines.join("\n");
}
