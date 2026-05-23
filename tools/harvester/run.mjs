#!/usr/bin/env node
// Skill harvester — single-shot runner.
//
// Picks the next pending service from services.yaml, runs one signup
// via the MCP `provision_any_service` tool, and updates the per-service
// GitHub issue with the outcome. Exits. The 10-minute cooldown is
// enforced by the systemd timer that calls this script, NOT by this
// process — keep it single-shot.
//
// **Phase A** of the harvester (this build) implements:
//   - YAML queue parsing
//   - GitHub issue state lookup (via `gh` CLI)
//   - Next-service selection
//   - --dry-run mode that prints what it WOULD do
//
// Phase B will add MCP invocation. Phase C the circuit breaker. Phase
// D the systemd timer.
//
// Usage:
//   node run.mjs --dry-run    # print plan, touch nothing
//   node run.mjs --once       # run a single attempt (Phase B+)
//   node run.mjs              # equivalent to --once
//
// Env (set in the systemd unit file, NOT here):
//   GH_REPO                   # owner/repo for issue mgmt; default Trusty-Squire/trusty-squire
//   TRUSTY_SQUIRE_PROFILE_DIR # chrome profile to use (must already
//                              have methoxine's Google session)
//   UNIVERSAL_BOT_PROXY_URL   # socks5 to lunchbox's Mac, e.g. socks5://127.0.0.1:1080
//   UNIVERSAL_BOT_PROXY_ALWAYS=true
//   UNIVERSAL_BOT_PREFER_CHEAP=true

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "services.yaml");
const HALTED_FILE = join(homedir(), ".trusty-squire", "harvester-halted");
const COUNTER_FILE = join(homedir(), ".trusty-squire", "harvester-consecutive-failures");
const REPO = process.env.GH_REPO ?? "Trusty-Squire/trusty-squire";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// ── GitHub helpers (shell out to gh) ───────────────────────────────────

function gh(...rest) {
  // Wraps `gh <args> --repo $REPO` with consistent stderr handling. Returns
  // parsed JSON when --json was requested, raw stdout otherwise. Throws on
  // non-zero exit so the caller can decide whether to swallow.
  const result = spawnSync("gh", [...rest, "--repo", REPO], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh ${rest.join(" ")} → exit ${result.status}: ${result.stderr}`);
  }
  const wantsJson = rest.includes("--json");
  return wantsJson ? JSON.parse(result.stdout) : result.stdout;
}

function ghAvailable() {
  // Verify the `gh` CLI is logged in for the current user. Caches nothing —
  // cheap call.
  const result = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  return result.status === 0;
}

function findIssueForSlug(slug) {
  // Look up the per-service issue by its stable label `service:<slug>`.
  // Returns null when no open issue exists yet (first-ever attempt).
  // Closed issues are also returned because they may need to be reopened
  // for re-attempts (e.g. service status flips from skip → pending).
  const issues = gh(
    "issue", "list",
    "--label", `service:${slug}`,
    "--label", "skill-harvester",
    "--state", "all",
    "--limit", "5",
    "--json", "number,title,state,labels,updatedAt",
  );
  return issues[0] ?? null;
}

function statusLabelFromIssue(issue) {
  // Extract the canonical `status:*` label from an issue's label set. The
  // harvester sets exactly one of these at a time; if more than one is
  // present the FIRST one wins (operator-edited state — accept it).
  if (issue === null) return null;
  for (const lbl of issue.labels) {
    if (typeof lbl.name === "string" && lbl.name.startsWith("status:")) {
      return lbl.name.slice("status:".length);
    }
  }
  return null;
}

// ── Queue ──────────────────────────────────────────────────────────────

function loadQueue() {
  // Parse services.yaml. The YAML lives in this directory; the systemd
  // unit's WorkingDirectory must point here so relative paths resolve.
  const raw = readFileSync(QUEUE_FILE, "utf8");
  const parsed = yaml.load(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`services.yaml must be a top-level array; got ${typeof parsed}`);
  }
  for (const entry of parsed) {
    if (typeof entry.slug !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.slug)) {
      throw new Error(`Invalid service slug ${JSON.stringify(entry.slug)} — must be lowercase alnum/hyphen`);
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      throw new Error(`Service ${entry.slug} missing name`);
    }
    if (!["pending", "skip", "hold"].includes(entry.status)) {
      throw new Error(`Service ${entry.slug} has invalid status ${JSON.stringify(entry.status)}`);
    }
  }
  return parsed;
}

function eligibleStatusFromIssue(issueStatus) {
  // Decide whether to re-attempt a service based on its current issue
  // status label. `replay-ok` and `needs-manual` are terminal — never
  // re-attempted automatically. `failed` and `promotion-only` are
  // retryable (the next ship of the bot may fix what broke last time).
  // `running` means a prior run crashed mid-attempt; treat as retryable
  // but flag for the operator.
  if (issueStatus === null) return { eligible: true, reason: "first attempt" };
  if (issueStatus === "replay-ok") return { eligible: false, reason: "already validated" };
  if (issueStatus === "needs-manual") return { eligible: false, reason: "operator marked needs-manual" };
  if (issueStatus === "failed") return { eligible: true, reason: "previous attempt failed — retrying" };
  if (issueStatus === "promotion-only") return { eligible: true, reason: "promoted previously but replay didn't validate — retrying" };
  if (issueStatus === "running") return { eligible: true, reason: "prior attempt crashed mid-run" };
  return { eligible: true, reason: `unknown status ${JSON.stringify(issueStatus)} — treating as retryable` };
}

function pickNextService(queue) {
  // Walk the queue in declared order, return the first service whose:
  //   - declared status is `pending` (not skip / hold)
  //   - GH issue status (if any) is retryable per eligibleStatusFromIssue
  for (const entry of queue) {
    if (entry.status !== "pending") continue;
    const issue = findIssueForSlug(entry.slug);
    const issueStatus = statusLabelFromIssue(issue);
    const verdict = eligibleStatusFromIssue(issueStatus);
    if (verdict.eligible) {
      return { entry, issue, issueStatus, reason: verdict.reason };
    }
  }
  return null;
}

// ── Pre-flight checks ─────────────────────────────────────────────────

function preflightReport() {
  // Surface every dependency the harvester needs before the systemd
  // unit goes live. Dry-run prints this; Phase B's --once will refuse
  // to run if any check returns notReady.
  const checks = [];

  checks.push({
    name: "gh CLI authenticated",
    ok: ghAvailable(),
    detail: "needed to create/comment/close GitHub issues",
  });

  checks.push({
    name: "harvester chrome profile",
    ok: existsSync(process.env.TRUSTY_SQUIRE_PROFILE_DIR ??
                   join(homedir(), ".trusty-squire", "chrome-profile-harvester")),
    detail: `must be seeded with methoxine's Google OAuth session via 'npx @trusty-squire/mcp login --provider=google' (TRUSTY_SQUIRE_PROFILE_DIR=${process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "<default>"})`,
  });

  checks.push({
    name: "SOCKS proxy listening on 127.0.0.1:1080",
    ok: (() => {
      try {
        execSync("ss -tnlp 2>/dev/null | grep -q 127.0.0.1:1080", { stdio: "pipe" });
        return true;
      } catch { return false; }
    })(),
    detail: "ssh -D to the residential proxy host. Tunnel dies on Mac sleep — re-run the ssh -D command if missing.",
  });

  checks.push({
    name: "harvester not halted",
    ok: !existsSync(HALTED_FILE),
    detail: `${HALTED_FILE} present → circuit breaker tripped; clear after fixing what broke.`,
  });

  return checks;
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const queue = loadQueue();
  const checks = preflightReport();

  console.log("─── Pre-flight ─────────────────────────────────────────");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
  }
  console.log();

  console.log("─── Queue ──────────────────────────────────────────────");
  for (const entry of queue) {
    console.log(`  [${entry.status}] ${entry.slug.padEnd(12)} — ${entry.name}`);
  }
  console.log();

  if (!ghAvailable()) {
    console.log("gh CLI not authenticated — skipping per-service issue lookup.");
    return;
  }

  const pick = pickNextService(queue);
  if (pick === null) {
    console.log("─── Decision ───────────────────────────────────────────");
    console.log("No eligible service. Either every pending is already replay-ok, or every pending has an open needs-manual issue.");
    return;
  }

  const counter = existsSync(COUNTER_FILE) ? Number(readFileSync(COUNTER_FILE, "utf8")) : 0;
  console.log("─── Decision ───────────────────────────────────────────");
  console.log(`  next service:        ${pick.entry.slug} (${pick.entry.name})`);
  console.log(`  signup_url:          ${pick.entry.signup_url}`);
  console.log(`  oauth_provider:      ${pick.entry.oauth_provider}`);
  console.log(`  scope_hint:          ${pick.entry.scope_hint ?? "(default — max permissions)"}`);
  console.log(`  existing issue:      ${pick.issue?.number ? `#${pick.issue.number} (${pick.issueStatus ?? "no status label"})` : "(none — would create)"}`);
  console.log(`  reason for picking:  ${pick.reason}`);
  console.log(`  consecutive_failures: ${counter} (circuit breaker trips at 3)`);
  console.log();

  if (DRY_RUN) {
    console.log("─── Dry run — nothing executed ─────────────────────────");
    console.log("Re-run with --once to actually invoke the bot once Phase B lands.");
    return;
  }

  console.log("─── Phase A only ───────────────────────────────────────");
  console.log("Phase B (MCP invocation + GH issue lifecycle) not yet implemented.");
  console.log("This script currently only supports --dry-run.");
  process.exit(64);
}

main();
