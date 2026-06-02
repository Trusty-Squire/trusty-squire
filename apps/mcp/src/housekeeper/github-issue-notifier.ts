// GitHub Issue notifier — ported from tools/archived-harvester/run.mjs.
//
// Maintains one issue per service slug. On each NotifierEvent:
//   - Finds an existing issue via `label:service:<slug>` AND `label:housekeeper`.
//   - Creates one if none exists.
//   - Rewrites the issue body with the latest outcome summary.
//   - Sets the issue's status:* label per outcome class.
//   - Closes the issue when the outcome is success (replay promoted /
//     discover ok). Re-opens on failure.
//
// Shells out to the `gh` CLI (the harvester's pattern). Requires
// `gh auth status` to succeed; if not, the notifier no-ops with a
// stderr warning. GH_REPO env overrides the default
// "Trusty-Squire/trusty-squire".

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier, NotifierEvent } from "./notifier.js";

export interface GithubIssueNotifierOpts {
  // Override GH_REPO. Defaults to Trusty-Squire/trusty-squire.
  repo?: string;
  // Spawn override for tests.
  spawnFn?: typeof spawnSync;
  // Write override for tests.
  write?: (line: string) => void;
}

export class GithubIssueNotifier implements Notifier {
  readonly name = "github-issues";
  private readonly repo: string;
  private readonly spawn: typeof spawnSync;
  private readonly write: (line: string) => void;
  private availabilityChecked = false;
  private available = false;

  constructor(opts: GithubIssueNotifierOpts = {}) {
    this.repo = opts.repo ?? process.env.GH_REPO ?? "Trusty-Squire/trusty-squire";
    this.spawn = opts.spawnFn ?? spawnSync;
    this.write = opts.write ?? ((l) => process.stderr.write(l + "\n"));
  }

  async notify(event: NotifierEvent): Promise<void> {
    // One issue per SERVICE; the heal digest is a run-level summary with no
    // service, so it doesn't map to an issue. Telegram + log carry it.
    if (event.kind === "heal_digest") return;
    if (!this.checkAvailable()) return;
    const slug = serviceSlug(event.service);
    const existing = this.findIssueForSlug(slug);
    const title = `[housekeeper] ${slug}`;
    const { body, statusLabel, shouldClose } = renderBodyAndStatus(event);

    let issueNumber: number;
    if (existing === null) {
      issueNumber = this.createIssue(slug, title, body, statusLabel);
    } else {
      issueNumber = existing.number;
      this.editBody(issueNumber, body);
      this.setStatusLabel(issueNumber, existing.labels, statusLabel);
      if (existing.state !== "OPEN" && !shouldClose) {
        // Re-open if a previously-closed issue is failing again.
        this.gh(["issue", "reopen", String(issueNumber)]);
      }
    }
    if (shouldClose) {
      this.gh([
        "issue",
        "close",
        String(issueNumber),
        "--comment",
        `Auto-closed by housekeeper: ${event.kind === "replay_outcome" ? "replay" : "discover"} ${event.outcome}`,
      ]);
    }
  }

  // ── gh wrapper ────────────────────────────────────────────────

  private gh(args: string[], opts: { wantsJson?: boolean } = {}): unknown {
    const result = this.spawn("gh", [...args, "--repo", this.repo], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `gh ${args.join(" ")} → exit ${result.status}: ${result.stderr ?? ""}`,
      );
    }
    if (opts.wantsJson === true || args.includes("--json")) {
      return JSON.parse(result.stdout);
    }
    return result.stdout;
  }

  private checkAvailable(): boolean {
    if (this.availabilityChecked) return this.available;
    this.availabilityChecked = true;
    const result = this.spawn("gh", ["auth", "status"], { encoding: "utf8" });
    if (result.status !== 0) {
      this.write(
        "[github-issue-notifier] gh CLI not authenticated (gh auth status failed) — skipping issue posting",
      );
      this.available = false;
      return false;
    }
    this.available = true;
    return true;
  }

  private findIssueForSlug(
    slug: string,
  ): { number: number; state: string; labels: { name: string }[] } | null {
    try {
      const issues = this.gh([
        "issue",
        "list",
        "--label",
        `service:${slug}`,
        "--label",
        "housekeeper",
        "--state",
        "all",
        "--limit",
        "5",
        "--json",
        "number,state,labels",
      ]) as Array<{ number: number; state: string; labels: { name: string }[] }>;
      return issues[0] ?? null;
    } catch (err) {
      this.write(
        `[github-issue-notifier] findIssueForSlug(${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private createIssue(
    slug: string,
    title: string,
    body: string,
    statusLabel: string,
  ): number {
    this.ensureLabels(["housekeeper", `service:${slug}`, statusLabel]);
    const tmp = join(mkdtempSync(join(tmpdir(), "housekeeper-")), "body.md");
    writeFileSync(tmp, body);
    try {
      const out = this.gh([
        "issue",
        "create",
        "--title",
        title,
        "--body-file",
        tmp,
        "--label",
        `housekeeper,service:${slug},${statusLabel}`,
      ]) as string;
      const m = out.match(/\/issues\/(\d+)\s*$/);
      if (m === null) {
        throw new Error(`could not parse issue URL from gh output: ${out}`);
      }
      return Number(m[1]);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private editBody(num: number, body: string): void {
    const tmp = join(mkdtempSync(join(tmpdir(), "housekeeper-")), "body.md");
    writeFileSync(tmp, body);
    try {
      this.gh(["issue", "edit", String(num), "--body-file", tmp]);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private setStatusLabel(
    num: number,
    existingLabels: { name: string }[],
    newLabel: string,
  ): void {
    const existingStatus = existingLabels
      .map((l) => l.name)
      .filter((n) => typeof n === "string" && n.startsWith("status:"));
    if (existingStatus.length > 0) {
      this.gh(["issue", "edit", String(num), "--remove-label", existingStatus.join(",")]);
    }
    this.ensureLabels([newLabel]);
    this.gh(["issue", "edit", String(num), "--add-label", newLabel]);
  }

  private ensureLabels(names: string[]): void {
    for (const name of names) {
      // `gh label create` returns non-zero when the label exists;
      // swallow that case.
      this.spawn(
        "gh",
        ["label", "create", name, "--color", "ededed", "--repo", this.repo],
        { stdio: "pipe" },
      );
    }
  }
}

function serviceSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function renderBodyAndStatus(event: NotifierEvent): {
  body: string;
  statusLabel: string;
  shouldClose: boolean;
} {
  // Unreachable — notify() returns early on heal_digest (no per-service
  // issue). Guard so the discriminated-union narrowing below is exhaustive.
  if (event.kind === "heal_digest") {
    return { body: event.summary, statusLabel: "status:digest", shouldClose: false };
  }
  if (event.kind === "replay_outcome") {
    const ts = new Date().toISOString();
    const shouldClose = event.outcome === "success" && event.transition === "promoted";
    const statusLabel =
      event.outcome === "success"
        ? event.transition === "promoted"
          ? "status:active"
          : "status:passing"
        : event.outcome === "skipped"
          ? "status:skipped"
          : event.transition === "demoted" || event.transition === "retired"
            ? "status:demoted"
            : "status:failing";
    const body =
      `**Status**: ${event.outcome}\n` +
      `**Queue**: ${event.queue}\n` +
      `**Skill**: \`${event.skill_id}\`\n` +
      `**Transition**: ${event.transition}\n` +
      `**Last updated**: ${ts}\n\n` +
      `## Reason\n\n\`\`\`\n${event.reason.slice(0, 4000)}\n\`\`\`\n`;
    return { body, statusLabel, shouldClose };
  }
  // discover_outcome
  const ts = new Date().toISOString();
  const shouldClose = event.outcome === "ok";
  const statusLabel =
    event.outcome === "ok"
      ? "status:passing"
      : event.outcome === "blocked"
        ? "status:blocked"
        : "status:failing";
  const userLine =
    event.meta?.distinct_failures !== undefined
      ? `\n**Users hit**: ${event.meta.distinct_failures} (top error: ${event.meta.top_error_kind ?? "?"})\n`
      : "";
  const body =
    `**Status**: ${event.outcome}\n` +
    `**Queue**: ${event.queue}\n` +
    userLine +
    `**Last updated**: ${ts}\n\n` +
    `## Reason\n\n\`\`\`\n${event.reason.slice(0, 4000)}\n\`\`\`\n`;
  return { body, statusLabel, shouldClose };
}
