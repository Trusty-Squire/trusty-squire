// modes/fix.ts (C2 wiring) — the `mcp housekeeper --mode=fix` step. Runs AFTER a
// daily run: reads the failure batch from the capture dir, drives the holistic
// fix-agent against the eval gate, and commits surviving fixes to the `next`
// (RC) channel. See docs/DESIGN-autonomous-output-loop.md.
//
// Operator-only; never shipped (housekeeper/ is excluded from the npm tarball).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCaptureDir } from "../../bot/onboarding-capture.js";
import { readFixBatch } from "../fix-batch.js";
import {
  runFixAgent,
  type FixAgentResult,
  type FixCluster,
} from "../fix-agent.js";
import { appendFixAttempts } from "../fix-ledger.js";
import {
  codingAgentProposer,
  gitCommitter,
  makeClusterReplayRunner,
  makeEvalGateRunner,
} from "../fix-agent-runtime.js";

// Posture (a): the fix-agent may only touch the gated post-OAuth navigation
// planner. agent.ts holds planPostVerifyStep + its prompt. Anything else
// (form-fill, other packages) is parked for human review.
const DEFAULT_ALLOWED_PATHS = ["apps/mcp/src/bot/agent.ts"] as const;

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "on" || t === "yes";
}

function defaultSinceMs(): number {
  const raw = process.env.TRUSTY_SQUIRE_FIX_SINCE_HOURS;
  const hours = raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 24;
  return Date.now() - hours * 60 * 60 * 1000;
}

export async function runFixMode(opts: {
  // Only fold in outcomes newer than this (scopes the batch to one pass).
  // Defaults to the last 24h (TRUSTY_SQUIRE_FIX_SINCE_HOURS overrides) so a
  // daily run only re-clusters recent failures, not the accumulated dir.
  sinceMs?: number;
  log?: (line: string) => void;
  // The LIVE ORACLE (Phase 2). When provided, a fix commits only if it also
  // passes the live gate. The autoloop builds this (canary baseline measured
  // once); a plain --mode=fix run leaves it undefined (offline-only).
  liveGate?: (cluster: FixCluster) => Promise<{ passed: boolean; reason: string }>;
}): Promise<FixAgentResult | null> {
  const log = opts.log ?? ((line: string) => console.log(`[fix] ${line}`));
  const sinceMs = opts.sinceMs ?? defaultSinceMs();
  const repoRoot = process.cwd();

  const captureDir = resolveCaptureDir();
  if (captureDir === null) {
    log("no capture dir resolved (TRUSTY_SQUIRE_ONBOARDING_CAPTURE off?) — nothing to fix");
    return null;
  }

  let botVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/mcp/package.json"), "utf8")) as {
      version?: string;
    };
    botVersion = pkg.version ?? "0.0.0";
  } catch {
    log("could not read apps/mcp/package.json version — run from the repo root");
    return null;
  }

  let branch: string;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    })
      .toString()
      .trim();
  } catch {
    log("not a git checkout — the fix-agent needs git to commit RCs");
    return null;
  }

  const batch = readFixBatch(
    captureDir,
    {
      batchId: `fix-${botVersion}-${Date.now().toString(36)}`,
      botVersion,
      generatedAt: new Date().toISOString(),
    },
    sinceMs,
  );

  if (batch.failures.length === 0) {
    log("no failures in the batch — nothing to fix");
    return { committed: [], walls: [], parked: [] };
  }

  const cliCommand = (process.env.TRUSTY_SQUIRE_FIX_AGENT_CLI ?? "claude -p").split(/\s+/).filter((s) => s.length > 0);
  const push = isTruthy(process.env.TRUSTY_SQUIRE_FIX_AGENT_PUSH);

  log(
    `fix pass: ${batch.failures.length} failure(s), bot=${botVersion}, branch=${branch}, push=${push}`,
  );

  const result = await runFixAgent({
    batch,
    branch,
    currentVersion: botVersion,
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    propose: codingAgentProposer({ repoRoot, cliCommand, log }),
    gate: makeEvalGateRunner({ repoRoot }),
    replay: makeClusterReplayRunner({ repoRoot }),
    ...(opts.liveGate !== undefined ? { liveGate: opts.liveGate } : {}),
    commit: gitCommitter({ repoRoot, push, log }),
    log,
  });

  // Close-the-loop (#1): record each committed fix as an OPEN attempt. A later
  // heal pass grades it once that RC has re-run discovery on the targeted
  // services (orchestrator → gradeLedgerAgainstPass → digest). A fix isn't
  // "done" when it commits — it's done when the next run proves the rate moved.
  if (result.committed.length > 0) {
    const now = new Date().toISOString();
    appendFixAttempts(
      result.committed.map((c) => ({
        rc_version: c.version,
        cluster_id: c.cluster_id,
        services: c.services,
        signature: c.signature,
        summary: c.summary,
        committed_at: now,
        status: "open" as const,
      })),
    );
    log(`recorded ${result.committed.length} fix attempt(s) to the grading ledger`);
  }

  return result;
}
