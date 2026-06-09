// Notifier interface — pluggable fan-out for housekeeper events.
//
// Each notifier receives every batch outcome event. Implementations:
//   - LogNotifier         — stderr lines, always on (debug surface)
//   - TelegramNotifier    — opt-in via --telegram, sends to chat
//   - GitHubIssueNotifier — opt-in via --github-issues, posts/edits/closes issues per service
//
// Failures from individual notifiers don't break the loop — the
// fan-out wrapper in orchestrator.ts catches + logs them.

export type NotifierEvent =
  | {
      kind: "replay_outcome";
      queue: string;
      service: string;
      skill_id: string;
      outcome: "success" | "failure" | "skipped";
      transition: "promoted" | "retired" | "demoted" | "quarantined" | "none";
      reason: string;
    }
  | {
      kind: "discover_outcome";
      queue: string;
      service: string;
      outcome: "ok" | "blocked" | "failed";
      reason: string;
      meta?: {
        distinct_failures?: number;
        top_error_kind?: string;
        most_recent_at?: string | null;
      };
    }
  // T7 — one per-run digest for the self-healing pass, so a sole operator
  // gets an actionable line instead of per-service noise.
  | {
      kind: "heal_digest";
      verified: number;
      demoted: number;
      quarantined: number;
      reskilled: number;
      needs_human: number;
      summary: string;
      // The two objective functions this project optimizes for, reported in
      // every digest so the operator watches them rise over time:
      //   OF#1 — skills in the registry (active count).
      //   OF#2 — discovery success rate (succeeded / attempted) this pass.
      // Optional: a pass that couldn't reach the registry omits skills_active;
      // a verify-only pass has discover_attempted 0.
      objectives?: {
        skills_active?: number;
        discover_attempted: number;
        discover_succeeded: number;
      };
    }
  // THE single human-facing escalation. Fired ONLY when the autonomous loop
  // hits an `unknown` provision state — a DOM/outcome it has never classified —
  // on the same (service, signature) for UNKNOWN_ESCALATION_THRESHOLD attempts.
  // Every other state is handled autonomously and never produces this event.
  | {
      kind: "unknown_state";
      service: string;
      url?: string;
      failure_kind: string;
      attempts: number;
      trace_excerpt?: string;
    };

export interface Notifier {
  // Identifier used in failure logs.
  readonly name: string;
  notify(event: NotifierEvent): Promise<void>;
}

// Shared one-line render of the two objective functions, reused by the log
// and telegram digests so they stay in sync. Returns "" when there's nothing
// to report (e.g. a verify-only pass with no discovery attempts).
export function formatObjectives(
  objectives:
    | { skills_active?: number; discover_attempted: number; discover_succeeded: number }
    | undefined,
): string {
  if (objectives === undefined) return "";
  const { skills_active, discover_attempted, discover_succeeded } = objectives;
  const parts: string[] = [];
  if (skills_active !== undefined) parts.push(`skills ${skills_active}`);
  if (discover_attempted > 0) {
    const rate = Math.round((100 * discover_succeeded) / discover_attempted);
    parts.push(`discover ${rate}% (${discover_succeeded}/${discover_attempted})`);
  }
  return parts.length > 0 ? ` · OBJECTIVES: ${parts.join(" · ")}` : "";
}

// Default always-on notifier — just writes one structured line per
// event to stderr (so a SystemD journal / docker logs / tmux pane
// shows the run state without setting up Telegram or GH). Cheap +
// reliable; the other notifiers add OUT-OF-process delivery.
export class LogNotifier implements Notifier {
  readonly name = "log";
  constructor(private readonly write: (line: string) => void = (l) => process.stderr.write(l + "\n")) {}
  async notify(event: NotifierEvent): Promise<void> {
    if (event.kind === "heal_digest") {
      this.write(`[heal] ${event.summary}${formatObjectives(event.objectives)}`);
      return;
    }
    if (event.kind === "unknown_state") {
      this.write(
        `[ESCALATE] unknown_state service=${event.service} kind=${event.failure_kind} ` +
          `attempts=${event.attempts} url=${event.url ?? "?"} — never-seen state, needs a human`,
      );
      return;
    }
    const prefix = event.kind === "replay_outcome" ? "[replay]" : "[discover]";
    const tail =
      event.kind === "replay_outcome"
        ? `transition=${event.transition} skill_id=${event.skill_id}`
        : event.meta?.distinct_failures !== undefined
          ? `users=${event.meta.distinct_failures} top=${event.meta.top_error_kind}`
          : "";
    this.write(
      `${prefix} queue=${event.queue} service=${event.service} outcome=${event.outcome} ${tail} ${event.reason.slice(0, 200)}`,
    );
  }
}
