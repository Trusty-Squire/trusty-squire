#!/usr/bin/env node
// Skill harvester — single-shot runner.
//
// Picks the next pending service from services.yaml, runs one signup
// via the MCP `provision_any_service` tool, and updates the per-service
// GitHub issue with the outcome. Exits. The 10-minute cooldown is
// enforced by the systemd timer that calls this script, NOT by this
// process — keep it single-shot.
//
// **Phase B** implements MCP-over-stdio invocation + GitHub issue
// lifecycle. Phase C will add the circuit breaker (consecutive-failure
// counter + halt sentinel). Phase D will wire the systemd timer.
//
// Usage:
//   node run.mjs --dry-run    # print plan, touch nothing
//   node run.mjs --once       # run a single attempt
//   node run.mjs              # equivalent to --once

import { spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "services.yaml");
const HALTED_FILE = join(homedir(), ".trusty-squire", "harvester-halted");
const COUNTER_FILE = join(homedir(), ".trusty-squire", "harvester-consecutive-failures");
const REPO = process.env.GH_REPO ?? "Trusty-Squire/trusty-squire";
const MCP_VERSION = process.env.HARVESTER_MCP_VERSION ?? "0.6.14-rc.19";

// Tool-call polling cadence. The MCP server reports the running step
// trail as it happens; polling more frequently means richer logs but
// more JSON-RPC traffic. 15s matches the cadence the bot's own status
// tool was designed for.
const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPT_DURATION_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once") || (!DRY_RUN && args.length === 0);

// ── GitHub helpers ─────────────────────────────────────────────────────

function gh(...rest) {
  // Wraps `gh <args> --repo $REPO` with consistent stderr handling.
  // Returns parsed JSON when --json was requested, raw stdout
  // otherwise. Throws on non-zero exit so the caller can decide
  // whether to swallow.
  const result = spawnSync("gh", [...rest, "--repo", REPO], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh ${rest.join(" ")} → exit ${result.status}: ${result.stderr}`);
  }
  const wantsJson = rest.includes("--json");
  return wantsJson ? JSON.parse(result.stdout) : result.stdout;
}

function ghBodyEdit(num, body) {
  // gh issue edit takes the body via --body-file to handle multiline
  // content with shell-unsafe characters. Write to a temp file, edit,
  // unlink.
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "body.md");
  writeFileSync(tmp, body);
  try {
    gh("issue", "edit", String(num), "--body-file", tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function ghAvailable() {
  const result = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  return result.status === 0;
}

function findIssueForSlug(slug) {
  const issues = gh(
    "issue", "list",
    "--label", `service:${slug}`,
    "--label", "skill-harvester",
    "--state", "all",
    "--limit", "5",
    "--json", "number,title,state,labels,updatedAt,body",
  );
  return issues[0] ?? null;
}

function statusLabelFromIssue(issue) {
  if (issue === null) return null;
  for (const lbl of issue.labels) {
    if (typeof lbl.name === "string" && lbl.name.startsWith("status:")) {
      return lbl.name.slice("status:".length);
    }
  }
  return null;
}

function ensureLabels(...names) {
  // Best-effort label creation. gh label create returns non-zero if the
  // label exists; swallow that case. New labels are created with a
  // neutral color so the operator can recolor by hand.
  for (const name of names) {
    spawnSync("gh", ["label", "create", name, "--color", "ededed", "--repo", REPO], {
      stdio: "pipe",
    });
  }
}

function createIssueForService(entry) {
  // Create the per-service issue with placeholder body — the body is
  // rewritten on every attempt by `applyAttemptToIssue`. Labels:
  //   skill-harvester    — global filter
  //   service:<slug>     — per-service key
  //   status:running     — set at creation, since we're about to run
  ensureLabels("skill-harvester", `service:${entry.slug}`, "status:running");
  const title = `[skill-harvester] ${entry.slug} — ${entry.name}`;
  const body = `**Status**: running (first attempt)\n\n## Recent attempts\n\n_(none yet — first attempt in progress)_\n`;
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "body.md");
  writeFileSync(tmp, body);
  try {
    const out = gh(
      "issue", "create",
      "--title", title,
      "--body-file", tmp,
      "--label", `skill-harvester,service:${entry.slug},status:running`,
    );
    // gh prints the issue URL — pull the trailing /<number>.
    const m = out.match(/\/issues\/(\d+)\s*$/);
    if (m === null) throw new Error(`could not parse issue URL from gh output: ${out}`);
    return Number(m[1]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function setIssueStatus(num, status) {
  // Remove every status:* label currently on the issue, then add the
  // new one. gh's --remove-label tolerates labels that aren't present.
  const current = gh("issue", "view", String(num), "--json", "labels");
  const statusLabels = current.labels
    .map((l) => l.name)
    .filter((n) => typeof n === "string" && n.startsWith("status:"));
  if (statusLabels.length > 0) {
    gh("issue", "edit", String(num), "--remove-label", statusLabels.join(","));
  }
  ensureLabels(`status:${status}`);
  gh("issue", "edit", String(num), "--add-label", `status:${status}`);
}

function closeIssue(num, comment) {
  // gh issue close also accepts a comment.
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "comment.md");
  writeFileSync(tmp, comment);
  try {
    gh("issue", "close", String(num), "--comment", comment, "--reason", "completed");
  } finally {
    rmSync(tmp, { force: true });
  }
}

function commentOnIssue(num, comment) {
  const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "comment.md");
  writeFileSync(tmp, comment);
  try {
    gh("issue", "comment", String(num), "--body-file", tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ── Queue + selection ─────────────────────────────────────────────────

function loadQueue() {
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
  if (issueStatus === null) return { eligible: true, reason: "first attempt" };
  if (issueStatus === "replay-ok") return { eligible: false, reason: "already validated" };
  if (issueStatus === "needs-manual") return { eligible: false, reason: "operator marked needs-manual" };
  if (issueStatus === "failed") return { eligible: true, reason: "previous attempt failed — retrying" };
  if (issueStatus === "promotion-only") return { eligible: true, reason: "promoted previously but replay not validated — retrying" };
  if (issueStatus === "running") return { eligible: true, reason: "prior attempt crashed mid-run" };
  return { eligible: true, reason: `unknown status ${JSON.stringify(issueStatus)} — treating as retryable` };
}

function pickNextService(queue) {
  // HARVESTER_FORCE_SERVICE — manual override for targeted validation
  // runs (e.g. drive the disambiguator against a specific service that
  // sits deep in the queue). Filters the queue to JUST that slug and
  // bypasses issue-label eligibility checks. No-op when unset.
  const forceSlug = process.env.HARVESTER_FORCE_SERVICE;
  if (forceSlug !== undefined && forceSlug.length > 0) {
    const forced = queue.find((e) => e.slug === forceSlug);
    if (forced === undefined) {
      throw new Error(
        `HARVESTER_FORCE_SERVICE=${JSON.stringify(forceSlug)} but no such ` +
          `slug in services.yaml. Available: ${queue.map((e) => e.slug).join(", ")}`,
      );
    }
    const issue = findIssueForSlug(forced.slug);
    const issueStatus = statusLabelFromIssue(issue);
    return {
      entry: forced,
      issue,
      issueStatus,
      reason: `forced via HARVESTER_FORCE_SERVICE (issue status=${issueStatus ?? "<none>"})`,
    };
  }
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

function preflightChecks() {
  const checks = [];
  checks.push({
    name: "gh CLI authenticated",
    ok: ghAvailable(),
    detail: "needed to create/comment/close GitHub issues",
  });
  checks.push({
    name: "harvester chrome profile",
    ok: existsSync(process.env.TRUSTY_SQUIRE_PROFILE_DIR ??
                   join(homedir(), ".trusty-squire", "chrome-profile")),
    detail: `must be seeded with methoxine's Google OAuth session via 'npx @trusty-squire/mcp login --provider=google' (TRUSTY_SQUIRE_PROFILE_DIR=${process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "<default>"})`,
  });
  const proxyDisabled = process.env.UNIVERSAL_BOT_PROXY_ALWAYS === "false";
  checks.push({
    name: "SOCKS proxy listening on 127.0.0.1:1080",
    ok: proxyDisabled || (() => {
      try {
        execSync("ss -tnlp 2>/dev/null | grep -q 127.0.0.1:1080", { stdio: "pipe" });
        return true;
      } catch { return false; }
    })(),
    detail: "ssh -D to the residential proxy host. Tunnel dies on Mac sleep — re-run the ssh -D command if missing. (Skipped when UNIVERSAL_BOT_PROXY_ALWAYS=false — direct-egress diagnostic runs.)",
  });
  checks.push({
    name: "harvester not halted",
    ok: !existsSync(HALTED_FILE),
    detail: `${HALTED_FILE} present → circuit breaker tripped; clear after fixing what broke.`,
  });
  return checks;
}

// ── MCP invocation ────────────────────────────────────────────────────

async function invokeProvisionAnyService(entry) {
  // Spawn the MCP server as a child, send a single provision_any_service
  // call, poll check_provision_status until terminal, return the final
  // result + accumulated step trail. The server process exits when
  // we close the client transport.
  //
  // Env passed to the child:
  //   TRUSTY_SQUIRE_PROFILE_DIR — harvester-only chrome profile so the
  //     methoxine OAuth session is used (NOT the daily-driver profile)
  //   UNIVERSAL_BOT_PROXY_URL / _ALWAYS — residential proxy routing
  //   UNIVERSAL_BOT_PREFER_CHEAP=true — Gemini Flash primary (default)
  //   The MCP server reads its session.json from the standard path
  //   ~/.config/trusty-squire/session.json, which already exists for
  //   the lunchbox user.
  const childEnv = {
    ...process.env,
    UNIVERSAL_BOT_PROXY_URL:
      process.env.UNIVERSAL_BOT_PROXY_URL ?? "socks5://127.0.0.1:1080",
    UNIVERSAL_BOT_PROXY_ALWAYS:
      process.env.UNIVERSAL_BOT_PROXY_ALWAYS ?? "true",
    UNIVERSAL_BOT_PREFER_CHEAP:
      process.env.UNIVERSAL_BOT_PREFER_CHEAP ?? "true",
    TRUSTY_SQUIRE_PROFILE_DIR:
      process.env.TRUSTY_SQUIRE_PROFILE_DIR ??
      join(homedir(), ".trusty-squire", "chrome-profile"),
  };

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", `@trusty-squire/mcp@${MCP_VERSION}`, "server"],
    env: childEnv,
  });
  const client = new Client(
    { name: "harvester", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  try {
    const startResp = await callTool(client, "provision_any_service", {
      service: entry.name,
      signup_url: entry.signup_url,
      oauth_provider: entry.oauth_provider,
      ...(entry.scope_hint !== null && entry.scope_hint !== undefined
        ? { scope_hint: entry.scope_hint }
        : {}),
    });

    if (startResp.status !== "started") {
      // provision_any_service may return a non-started terminal status
      // (not_installed / payment_required / error) when called against
      // a misconfigured machine token. Surface as-is.
      return { final: startResp, steps: [] };
    }
    const runId = startResp.run_id;
    if (typeof runId !== "string") {
      throw new Error(`provision_any_service started without run_id: ${JSON.stringify(startResp)}`);
    }

    const deadline = Date.now() + MAX_ATTEMPT_DURATION_MS;
    let lastSteps = [];
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const checkResp = await callTool(client, "check_provision_status", { run_id: runId });
      // Surface the running step trail as it grows — the systemd journal
      // captures stdout so this becomes the live log.
      const liveSteps = Array.isArray(checkResp.steps) ? checkResp.steps : [];
      for (let i = lastSteps.length; i < liveSteps.length; i++) {
        console.log(`  step: ${liveSteps[i]}`);
      }
      lastSteps = liveSteps;
      if (checkResp.status !== "running") {
        return { final: checkResp, steps: lastSteps };
      }
    }
    return {
      final: { status: "timeout", error: `attempt exceeded ${MAX_ATTEMPT_DURATION_MS / 1000}s ceiling` },
      steps: lastSteps,
    };
  } finally {
    try {
      await client.close();
    } catch {
      // close failures on a dead child are noise
    }
  }
}

async function callTool(client, name, args) {
  const resp = await client.callTool({ name, arguments: args });
  // The MCP SDK returns { content: [{type: "text", text: "..."}, ...] }.
  // Our tools return JSON-shaped objects as a single text block.
  const block = Array.isArray(resp.content) ? resp.content[0] : null;
  if (block === null || block.type !== "text") {
    throw new Error(`Unexpected tool response shape for ${name}: ${JSON.stringify(resp)}`);
  }
  try {
    return JSON.parse(block.text);
  } catch {
    // Some tools return plain text — pass it through under a `_raw` key.
    return { _raw: block.text };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Result interpretation ─────────────────────────────────────────────

function classifyOutcome(final, steps) {
  // Decide which status label the per-service issue should carry.
  //   replay-ok       — bot returned status:success AND the step trail
  //                     shows the skill registry router engaged + the
  //                     replay completed (no fall-through to LLM)
  //   promotion-only  — bot returned status:success and auto-promote
  //                     published a skill, but replay didn't engage
  //                     (first-ever attempt OR replay fell through)
  //   skill-replay-failed
  //                   — replay attempted but step_failed; bot fell
  //                     through to LLM. Distinguished from
  //                     promotion-only because the operator should
  //                     debug WHY replay failed.
  //   failed          — bot returned a non-success terminal status
  //                     (captcha_blocked, anti_bot_blocked, etc.)
  //   needs-manual    — terminal status the operator must triage
  //                     (oauth_consent_needs_review, needs_login,
  //                     verification_not_sent, onboarding_blocked,
  //                     payment_required)
  const status = final.status;
  const stepText = steps.join("\n");
  const replayAttempted = /\[skill-promoter\] fetched skill /.test(stepText);
  const replayFailed = /\[skill-promoter\] (?:full replay|dry replay) failed/.test(stepText);
  const promoted = /\[auto-promote\] published /.test(stepText);

  if (status === "success") {
    if (replayAttempted && !replayFailed) return "replay-ok";
    if (replayAttempted && replayFailed) return "skill-replay-failed";
    if (promoted) return "promotion-only";
    // success without promotion AND without replay = something weird.
    // Treat as promotion-only so the operator notices.
    return "promotion-only";
  }
  if (status === "captcha_blocked" || status === "anti_bot_blocked") {
    return "failed";
  }
  if (
    status === "oauth_consent_needs_review" ||
    status === "needs_login" ||
    status === "verification_not_sent" ||
    status === "onboarding_blocked" ||
    status === "payment_required" ||
    status === "oauth_required"
  ) {
    return "needs-manual";
  }
  // Anything else (failed / error / timeout / not_installed / unknown_run)
  return "failed";
}

function summarizeAttempt(entry, final, steps, attemptNumber, classification) {
  // Markdown block appended to the issue body + posted as a comment.
  // Includes the full step trail (truncated to keep the comment under
  // GitHub's 65k limit — 200 step lines is plenty in practice).
  const trail = steps.slice(0, 200).map((s, i) => `${i + 1}. ${s}`).join("\n");
  const moreSuffix = steps.length > 200 ? `\n  …(${steps.length - 200} more steps elided)` : "";
  const credSummary = final.credentials
    ? `Extracted credentials: ${Object.keys(final.credentials).join(", ")}`
    : final.run_id
      ? `run_id=${final.run_id}`
      : final.error
        ? `Error: ${final.error}`
        : "";
  return [
    `### Attempt ${attemptNumber} — ${new Date().toISOString()}`,
    ``,
    `**Outcome**: ${classification}`,
    `**Bot status**: ${final.status}`,
    credSummary !== "" ? `**Detail**: ${credSummary}` : "",
    `**Service**: ${entry.name} (${entry.slug})`,
    `**Signup URL**: ${entry.signup_url}`,
    ``,
    `<details><summary>Step trail (${steps.length} lines)</summary>`,
    ``,
    "```",
    trail + moreSuffix,
    "```",
    `</details>`,
  ].filter((s) => s !== "").join("\n");
}

// ── Counter helpers (Phase C will wire the breaker) ──────────────────

function readCounter() {
  if (!existsSync(COUNTER_FILE)) return 0;
  const raw = readFileSync(COUNTER_FILE, "utf8").trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function writeCounter(n) {
  writeFileSync(COUNTER_FILE, String(n), "utf8");
}

// ── Main flow ─────────────────────────────────────────────────────────

async function runOnce(pick) {
  const { entry, issue } = pick;
  console.log(`\n─── Attempting: ${entry.slug} (${entry.name}) ───────────────`);

  // 1. Find or create the per-service issue, set status:running.
  let issueNumber;
  let attemptNumber = 1;
  if (issue === null) {
    issueNumber = createIssueForService(entry);
    console.log(`  created issue #${issueNumber}`);
  } else {
    issueNumber = issue.number;
    setIssueStatus(issueNumber, "running");
    // Derive attempt number from the prior body. Crude but durable: count
    // "### Attempt " occurrences in the body, +1.
    const priorAttempts = (issue.body ?? "").match(/^### Attempt /gm) ?? [];
    attemptNumber = priorAttempts.length + 1;
    console.log(`  found issue #${issueNumber} (attempt ${attemptNumber})`);
  }

  // 2. Invoke the MCP tool. Long-running — log substeps as they come.
  let final;
  let steps;
  try {
    ({ final, steps } = await invokeProvisionAnyService(entry));
  } catch (err) {
    final = { status: "error", error: err instanceof Error ? err.message : String(err) };
    steps = [];
  }

  // 3. Classify + update issue.
  const classification = classifyOutcome(final, steps);
  console.log(`  outcome: ${classification} (bot status=${final.status})`);

  const summary = summarizeAttempt(entry, final, steps, attemptNumber, classification);
  commentOnIssue(issueNumber, summary);
  setIssueStatus(issueNumber, classification);

  if (classification === "replay-ok") {
    closeIssue(
      issueNumber,
      `Closed by harvester — replay validated end-to-end on attempt ${attemptNumber}.`,
    );
    writeCounter(0);
  } else {
    // rc.C circuit breaker. After 3 consecutive non-replay-ok outcomes
    // across the whole queue, halt: write the halt sentinel, create
    // (or update) the HALTED issue, exit non-zero. Subsequent timer
    // ticks short-circuit on the sentinel until the operator clears
    // it. Counts ANY non-replay-ok outcome — including needs-manual
    // — because the harvester needs operator attention to make
    // progress in either case.
    const newCount = readCounter() + 1;
    writeCounter(newCount);
    if (newCount >= 3) {
      writeFileSync(HALTED_FILE, new Date().toISOString(), "utf8");
      tripCircuitBreakerIssue(entry, classification, newCount);
    }
  }

  return classification;
}

function tripCircuitBreakerIssue(latestEntry, latestClassification, count) {
  // Surface the halt as a single dedicated GH issue. Idempotent: if a
  // HALTED issue is already open, append a comment; otherwise create
  // it. Labels: skill-harvester, status:halted.
  ensureLabels("skill-harvester", "status:halted");
  const existing = gh(
    "issue", "list",
    "--label", "status:halted",
    "--label", "skill-harvester",
    "--state", "open",
    "--limit", "1",
    "--json", "number,title",
  );
  const summary = [
    `**Circuit breaker tripped** — ${count} consecutive non-replay-ok outcomes.`,
    ``,
    `Latest failure: \`${latestEntry.slug}\` (${latestEntry.name}) → \`${latestClassification}\``,
    ``,
    `To resume the harvester:`,
    `  1. Investigate the per-service issues (label: \`skill-harvester\`).`,
    `  2. Fix or mark \`status:needs-manual\` on the offending services.`,
    `  3. Clear the halt state:`,
    `     \`\`\``,
    `     rm ~/.trusty-squire/harvester-halted`,
    `     rm ~/.trusty-squire/harvester-consecutive-failures`,
    `     \`\`\``,
    `  4. Close this issue with a "resumed" comment.`,
  ].join("\n");
  if (existing.length > 0) {
    commentOnIssue(existing[0].number, summary);
    console.log(`  circuit breaker: appended comment to existing HALTED issue #${existing[0].number}`);
  } else {
    const tmp = join(mkdtempSync(join(tmpdir(), "harvester-")), "body.md");
    writeFileSync(tmp, summary);
    try {
      gh(
        "issue", "create",
        "--title", `[skill-harvester] HALTED — ${count} consecutive failures`,
        "--body-file", tmp,
        "--label", "skill-harvester,status:halted",
      );
    } finally {
      rmSync(tmp, { force: true });
    }
    console.log(`  circuit breaker: created HALTED issue`);
  }
}

async function main() {
  const queue = loadQueue();
  const checks = preflightChecks();

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
    console.log("gh CLI not authenticated — cannot proceed.");
    process.exit(2);
  }

  const pick = pickNextService(queue);
  if (pick === null) {
    console.log("─── Decision ───────────────────────────────────────────");
    console.log("No eligible service. Either every pending is already replay-ok, or every pending has an open needs-manual issue.");
    return;
  }

  const counter = readCounter();
  console.log("─── Decision ───────────────────────────────────────────");
  console.log(`  next service:        ${pick.entry.slug} (${pick.entry.name})`);
  console.log(`  signup_url:          ${pick.entry.signup_url}`);
  console.log(`  oauth_provider:      ${pick.entry.oauth_provider}`);
  console.log(`  scope_hint:          ${pick.entry.scope_hint ?? "(default — max permissions)"}`);
  console.log(`  existing issue:      ${pick.issue?.number ? `#${pick.issue.number} (${pick.issueStatus ?? "no status label"})` : "(none — would create)"}`);
  console.log(`  reason for picking:  ${pick.reason}`);
  console.log(`  consecutive_failures: ${counter} (Phase C will halt at 3)`);
  console.log();

  if (DRY_RUN) {
    console.log("─── Dry run — nothing executed ─────────────────────────");
    return;
  }

  if (!ONCE) {
    console.log("Use --once to actually run a single attempt.");
    process.exit(64);
  }

  // Halt sentinel is a clean exit, not an error: timer ticks expect
  // exit 0 so they don't email the operator on every cooldown.
  if (existsSync(HALTED_FILE)) {
    console.log(`─── Halted — exiting cleanly. Sentinel at ${HALTED_FILE} ─────`);
    process.exit(0);
  }
  const failed = checks.find((c) => !c.ok);
  if (failed !== undefined) {
    console.log(`─── Aborting: pre-flight failed (${failed.name}) ─────`);
    process.exit(3);
  }

  const classification = await runOnce(pick);
  process.exit(classification === "replay-ok" ? 0 : 1);
}

main().catch((err) => {
  console.error(`UNCAUGHT: ${err?.stack || err}`);
  process.exit(99);
});
