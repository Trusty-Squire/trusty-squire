// failure-report writer — the structured contract the subagent
// (Phase 3) will consume as its sole ingest. Defined in
// docs/DESIGN-harvester-subagent.md.
//
// Each harvester run that fails writes one report to
//   ~/.trusty-squire/halts/<ts>-<service>.json
//
// The subagent reads ONLY this file (plus referenced .debug PNGs);
// it does not scrape harvester logs, journalctl, or per-service
// GitHub issues. That's the boundary that lets the harvester's
// internal logging evolve without breaking the subagent's ingest.
//
// Phase 1: write on every failed attempt (more data is fine; the
// subagent's halt-sentinel gate decides when to actually act on it).
// Phase 2 may narrow to "only halt-eligible" once per-service backoff
// lands and a flood of unrelated failures becomes noisy.

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./state.mjs";

const HALTS_DIR = join(homedir(), ".trusty-squire", "halts");

// Resolve a possibly-floating MCP version spec (e.g. "next", "latest",
// "0.6.14-rc.33") to an actual semver string. Used to preserve
// reproducibility when the harvester is pinned to a dist-tag (D3) —
// without this, "@next" failures lose the "which rc was this?" signal.
//
// Shells `npm view`; 5s timeout. On failure (offline, registry blip)
// returns "unknown" rather than throwing — the report is still useful
// without the version stamp, and we don't want failure-report writing
// itself to be a failure mode.
export function resolveMcpVersion(spec) {
  if (/^\d+\.\d+\.\d+/.test(spec)) return spec;
  try {
    const out = execSync(`npm view @trusty-squire/mcp@${spec} version`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// Build the failure-report payload. Pure — does no IO. Takes everything
// it needs as opts so the caller (run.mjs) owns the data extraction.
//
// opts:
//   service           — { slug, name, signup_url } from services.yaml
//   final             — bot tool result: { status, error?, ... }
//   steps             — step trail (string[]) accumulated during the run
//   classification    — harvester's outcome classifier output
//                       ("failed", "needs-manual", "skill-replay-failed", …)
//   attemptNumber     — 1-indexed attempt count this issue cycle
//   consecutiveFailures — global consecutive-failure counter (per-service
//                       backoff is Phase 2; this is the global value)
//   mcpVersionResolved — output of resolveMcpVersion()
//   runStartedAt      — Date the run started (for debug-artifact scan)
//   issueNumber       — GitHub issue # (or null if not yet created)
//   repo              — "owner/repo" for issue URL construction
//   debugDir          — directory to scan for new .debug artifacts
//                       (default: ./.debug relative to cwd)
export function buildFailureReport(opts) {
  const {
    service,
    final,
    steps,
    classification,
    attemptNumber,
    consecutiveFailures,
    mcpVersionResolved,
    runStartedAt,
    issueNumber,
    repo,
    debugDir = ".debug",
  } = opts;

  return {
    ts: new Date().toISOString(),
    service: service.slug,
    service_name: service.name,
    signup_url: service.signup_url,
    mcp_version_resolved: mcpVersionResolved,
    bot_status: final.status ?? "unknown",
    error_message: final.error ?? null,
    classification,
    // Phase 2 — separate from `classification` (the harvester outcome).
    // failure_category is the subagent's decision input: one of
    // code_bug / environment / external_block / upstream_change / null.
    // null means rules abstained — Phase 3 subagent will LLM-classify
    // on the fallback path.
    failure_category: opts.failureCategory ?? null,
    attempt_number: attemptNumber,
    consecutive_failures: consecutiveFailures,
    step_trail: steps,
    debug_artifacts: scanDebugArtifacts(debugDir, runStartedAt),
    captured_planner_output: extractPlannerOutput(steps),
    github_issue_url:
      issueNumber !== null && issueNumber !== undefined
        ? `https://github.com/${repo}/issues/${issueNumber}`
        : null,
  };
}

// Write the report and return the absolute path. The filename embeds
// the timestamp (millisecond precision) + service slug so concurrent
// halts on different services don't collide.
export async function writeFailureReport(report) {
  const tsMs = Date.parse(report.ts) || Date.now();
  const filename = `${tsMs}-${report.service}.json`;
  const targetPath = join(HALTS_DIR, filename);
  await writeJsonAtomic(targetPath, report);
  return targetPath;
}

// Phase 2 — eval-fixture archival. When a code_bug-classified failure
// lands, also copy the report into tools/harvester-subagent/eval/
// fixtures/ so Phase 3 can grade the subagent's propose-fix prompt
// against real-world fixtures from this corpus. Skipped for non-
// code_bug categories (environment / external_block / upstream_change
// aren't subagent-PR-eligible, so they don't seed the eval).
//
// Filename matches the halt-report filename for cross-referencing.
// Caller passes the repo root so we don't have to hardcode paths
// inside the module (helps tests).
export async function archiveAsEvalFixture(report, repoRoot) {
  if (report.failure_category !== "code_bug") return null;
  const tsMs = Date.parse(report.ts) || Date.now();
  const filename = `${tsMs}-${report.service}.json`;
  const targetPath = join(
    repoRoot,
    "tools",
    "harvester-subagent",
    "eval",
    "fixtures",
    filename,
  );
  await writeJsonAtomic(targetPath, report);
  return targetPath;
}

// Scan the debug dir for files modified after `runStartedAt`. Returns
// absolute paths. Bounded to 50 entries to keep the report small —
// failures that produce 100+ debug files are pathological and the
// subagent doesn't need all of them.
function scanDebugArtifacts(debugDir, runStartedAt) {
  if (runStartedAt === undefined) return [];
  try {
    const entries = readdirSync(debugDir);
    const sinceMs = runStartedAt.getTime();
    const matches = [];
    for (const name of entries) {
      const full = join(debugDir, name);
      try {
        const s = statSync(full);
        if (s.isFile() && s.mtimeMs >= sinceMs) {
          matches.push(full);
        }
      } catch {
        // file may have been removed mid-scan; skip
      }
    }
    matches.sort();
    return matches.slice(0, 50);
  } catch {
    return [];
  }
}

// Extract the planner-relevant slice of the step trail. The planner's
// substeps follow recognizable patterns ("Asking Claude to plan…",
// "Plan: N action(s), confidence=…", "Click <selector>", "Fill <field>
// → <selector>"). Subagent uses these to reason about what the bot
// tried; we filter rather than dump the whole trail to keep prompt
// budget bounded.
//
// Phase 1: include any step matching the planner regex set. Phase 3
// may refine if the subagent's context budget gets tight.
function extractPlannerOutput(steps) {
  if (!Array.isArray(steps)) return [];
  const re =
    /^(Asking Claude to plan|Plan:|Click |Fill |Inventory:|OAuth-first|Committed to |Pre-submit captcha|Post-submit captcha|Plan only revealed)/;
  return steps.filter((s) => typeof s === "string" && re.test(s.replace(/^\s*step:\s*/, "")));
}
