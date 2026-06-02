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
      transition: "promoted" | "retired" | "demoted" | "none";
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
    };

export interface Notifier {
  // Identifier used in failure logs.
  readonly name: string;
  notify(event: NotifierEvent): Promise<void>;
}

// Default always-on notifier — just writes one structured line per
// event to stderr (so a SystemD journal / docker logs / tmux pane
// shows the run state without setting up Telegram or GH). Cheap +
// reliable; the other notifiers add OUT-OF-process delivery.
export class LogNotifier implements Notifier {
  readonly name = "log";
  constructor(private readonly write: (line: string) => void = (l) => process.stderr.write(l + "\n")) {}
  async notify(event: NotifierEvent): Promise<void> {
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
