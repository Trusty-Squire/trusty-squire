#!/usr/bin/env node
// Harvester daily summary — creates / closes the day's roll-up GitHub
// issue. Invoked twice via systemd timers (Phase D):
//
//   00:05 UTC: node daily.mjs --create    → opens "[skill-harvester] daily YYYY-MM-DD"
//   23:55 UTC: node daily.mjs --close     → rewrites body from per-service issue state, closes
//
// Body is rebuilt from per-service issue labels on close — there's no
// separate state DB. The summary lives entirely in GitHub's data model
// (issue title = date, body = label snapshot, closed=archived).
//
// Two operating modes besides the time-boxed ones:
//   node daily.mjs --refresh   → idempotent: rewrites today's open
//                                summary body if it exists, no
//                                create/close. Useful for cron at
//                                fixed times throughout the day.
//   node daily.mjs --print     → write the body to stdout without
//                                touching GitHub. Diagnostic.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "services.yaml");
const REPO = process.env.GH_REPO ?? "Trusty-Squire/trusty-squire";

const args = process.argv.slice(2);
const MODE = args.find((a) => a.startsWith("--"))?.slice(2) ?? "refresh";

function gh(...rest) {
  const result = spawnSync("gh", [...rest, "--repo", REPO], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh ${rest.join(" ")} → exit ${result.status}: ${result.stderr}`);
  }
  return rest.includes("--json") ? JSON.parse(result.stdout) : result.stdout;
}

function ensureLabel(name) {
  spawnSync("gh", ["label", "create", name, "--color", "ededed", "--repo", REPO], { stdio: "pipe" });
}

function todayUtcDate() {
  // Title format: YYYY-MM-DD in UTC. Matches the systemd timer's
  // OnCalendar=*-*-* 00:05:00 UTC firing schedule. Using UTC means the
  // summary's date matches the cron's day boundary even when the
  // operator's local zone is offset.
  return new Date().toISOString().slice(0, 10);
}

function dailyIssueTitle(date) {
  return `[skill-harvester] daily ${date}`;
}

function findDailyIssue(date, state = "open") {
  const issues = gh(
    "issue", "list",
    "--label", "skill-harvester",
    "--label", "daily-summary",
    "--state", state,
    "--limit", "10",
    "--json", "number,title,state",
  );
  const wantedTitle = dailyIssueTitle(date);
  return issues.find((i) => i.title === wantedTitle) ?? null;
}

function loadQueue() {
  return yaml.load(readFileSync(QUEUE_FILE, "utf8"));
}

function listServiceIssues() {
  // One snapshot of every per-service issue's current label state.
  // Used to project the daily summary table. We include closed issues
  // too because a service that hit replay-ok is what the summary
  // exists to celebrate.
  return gh(
    "issue", "list",
    "--label", "skill-harvester",
    "--state", "all",
    "--limit", "200",
    "--json", "number,title,state,labels,updatedAt",
  );
}

function statusOf(issue) {
  for (const lbl of issue.labels) {
    if (typeof lbl.name === "string" && lbl.name.startsWith("status:")) {
      return lbl.name.slice("status:".length);
    }
  }
  return null;
}

function serviceOf(issue) {
  for (const lbl of issue.labels) {
    if (typeof lbl.name === "string" && lbl.name.startsWith("service:")) {
      return lbl.name.slice("service:".length);
    }
  }
  return null;
}

function STATUS_EMOJI(status) {
  switch (status) {
    case "replay-ok": return "✅";
    case "promotion-only": return "🟡";
    case "skill-replay-failed": return "🟠";
    case "failed": return "❌";
    case "needs-manual": return "🛑";
    case "running": return "⏳";
    case "halted": return "🚨";
    default: return "❓";
  }
}

function buildBody(date) {
  // Compose a Markdown body from the per-service issue state.
  // Sections:
  //   1. Header w/ date and a one-line tally
  //   2. Status table (one row per service in declared order, plus
  //      any services that have an issue but were removed from YAML)
  //   3. Halt status (if HALTED issue is open)
  const queue = loadQueue();
  const issues = listServiceIssues();
  const issueBySlug = new Map();
  for (const i of issues) {
    const slug = serviceOf(i);
    if (slug !== null) issueBySlug.set(slug, i);
  }

  const rows = [];
  let counts = { "replay-ok": 0, "promotion-only": 0, "skill-replay-failed": 0, "failed": 0, "needs-manual": 0, "running": 0, "no-attempts": 0 };
  for (const entry of queue) {
    if (entry.status === "skip" || entry.status === "hold") {
      rows.push(`| ${STATUS_EMOJI("needs-manual")} | \`${entry.slug}\` | ${entry.name} | _${entry.status}_ — ${(entry.reason ?? "").split("\n")[0]} | — |`);
      continue;
    }
    const issue = issueBySlug.get(entry.slug) ?? null;
    if (issue === null) {
      counts["no-attempts"] += 1;
      rows.push(`| ${STATUS_EMOJI(null)} | \`${entry.slug}\` | ${entry.name} | _no attempts yet_ | — |`);
      continue;
    }
    const status = statusOf(issue);
    if (status !== null && counts[status] !== undefined) counts[status] += 1;
    rows.push(`| ${STATUS_EMOJI(status)} | \`${entry.slug}\` | ${entry.name} | \`${status ?? "?"}\` | [#${issue.number}](https://github.com/${REPO}/issues/${issue.number}) |`);
  }

  // Any per-service issue whose slug is NOT in the YAML (stale entry).
  const queueSlugs = new Set(queue.map((e) => e.slug));
  for (const [slug, issue] of issueBySlug.entries()) {
    if (queueSlugs.has(slug)) continue;
    const status = statusOf(issue);
    rows.push(`| ${STATUS_EMOJI(status)} | \`${slug}\` | _(not in queue)_ | \`${status ?? "?"}\` | [#${issue.number}](https://github.com/${REPO}/issues/${issue.number}) |`);
  }

  const totalAttempted =
    counts["replay-ok"] +
    counts["promotion-only"] +
    counts["skill-replay-failed"] +
    counts["failed"] +
    counts["needs-manual"] +
    counts["running"];
  const headline =
    `${counts["replay-ok"]} replay-ok / ${counts["promotion-only"]} promoted / ` +
    `${counts["failed"] + counts["skill-replay-failed"]} failed / ` +
    `${counts["needs-manual"]} needs-manual / ${counts["no-attempts"]} untouched`;

  // HALTED state from per-issue search — surface prominently if open.
  const halted = gh(
    "issue", "list",
    "--label", "status:halted",
    "--label", "skill-harvester",
    "--state", "open",
    "--limit", "1",
    "--json", "number,title",
  );
  const haltBlock = halted.length > 0
    ? `\n## 🚨 Harvester HALTED\n\nCircuit breaker tripped. See [#${halted[0].number}](https://github.com/${REPO}/issues/${halted[0].number}).\n`
    : "";

  return [
    `# Skill harvester — daily summary ${date} (UTC)`,
    ``,
    `**Tally**: ${headline} (${totalAttempted} total with an attempt)`,
    ``,
    `_This body is rebuilt from per-service issue labels at \`--refresh\` / \`--close\` time. No separate DB._`,
    haltBlock,
    `## Per-service status`,
    ``,
    `| | Slug | Name | Status | Issue |`,
    `|---|---|---|---|---|`,
    ...rows,
    ``,
    `## Legend`,
    ``,
    `- ✅ \`replay-ok\` — skill replayed end-to-end, closed-loop validated`,
    `- 🟡 \`promotion-only\` — bot succeeded + auto-promoted, replay not yet validated`,
    `- 🟠 \`skill-replay-failed\` — replay attempted, fell through to LLM`,
    `- ❌ \`failed\` — captcha / anti-bot / internal failure`,
    `- 🛑 \`needs-manual\` — operator must triage (phone / consent / payment gates, or YAML status:skip)`,
    `- ⏳ \`running\` — attempt in progress, or prior attempt crashed mid-run`,
    `- ❓ — no attempts yet`,
  ].join("\n");
}

function writeBody(num, body) {
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "daily-body.md");
  writeFileSync(tmp, body);
  try {
    gh("issue", "edit", String(num), "--body-file", tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function cmdCreate() {
  const date = todayUtcDate();
  const existing = findDailyIssue(date, "all");
  if (existing !== null) {
    console.log(`  daily issue already exists (#${existing.number}, state=${existing.state}) — refreshing body in place.`);
    writeBody(existing.number, buildBody(date));
    return;
  }
  ensureLabel("skill-harvester");
  ensureLabel("daily-summary");
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "body.md");
  writeFileSync(tmp, buildBody(date));
  try {
    const out = gh(
      "issue", "create",
      "--title", dailyIssueTitle(date),
      "--body-file", tmp,
      "--label", "skill-harvester,daily-summary",
    );
    console.log(`  created daily issue: ${out.trim()}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function cmdClose() {
  const date = todayUtcDate();
  const existing = findDailyIssue(date, "open");
  if (existing === null) {
    console.log(`  no open daily issue for ${date}; nothing to close.`);
    // Still create + close — useful when the morning cron was skipped.
    cmdCreate();
    const created = findDailyIssue(date, "open");
    if (created !== null) {
      gh("issue", "close", String(created.number), "--reason", "completed");
      console.log(`  created + closed daily issue #${created.number}`);
    }
    return;
  }
  writeBody(existing.number, buildBody(date));
  gh("issue", "close", String(existing.number), "--reason", "completed");
  console.log(`  closed daily issue #${existing.number}`);
}

function cmdRefresh() {
  const date = todayUtcDate();
  const existing = findDailyIssue(date, "open");
  if (existing === null) {
    console.log(`  no open daily issue for ${date}; creating one and refreshing.`);
    cmdCreate();
    return;
  }
  writeBody(existing.number, buildBody(date));
  console.log(`  refreshed body of daily issue #${existing.number}`);
}

function cmdPrint() {
  console.log(buildBody(todayUtcDate()));
}

function main() {
  switch (MODE) {
    case "create": return cmdCreate();
    case "close": return cmdClose();
    case "refresh": return cmdRefresh();
    case "print": return cmdPrint();
    default:
      console.error(`Unknown mode --${MODE}. Use --create / --close / --refresh / --print.`);
      process.exit(64);
  }
}

main();
