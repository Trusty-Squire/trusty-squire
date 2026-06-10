// fix-agent-runtime.ts (C2, production seams) — the real FixProposer + Committer
// + GateRunner that wire the deterministic orchestration (fix-agent.ts) to a
// coding agent, git, and the eval gate. These are IO/LLM boundaries, kept out of
// the pure orchestration so that stays unit-testable; the invariants the loop
// enforces (staging-only, path fence, green-only-commit) live in fix-agent.ts.
//
// Operator-only (housekeeper/, excluded from the npm tarball).

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PostVerifyStep } from "../bot/agent.js";
import type { EvalGateResult } from "../bot/eval-gate.js";
import type { GateBucketResult } from "../bot/eval-corpus.js";
import type {
  ClusterReplay,
  Committer,
  FixCluster,
  FixProposal,
  FixProposer,
  GateRunner,
} from "./fix-agent.js";

const exec = promisify(execFile);

// Both the gate and the page replay must run in a FRESH process so they reflect
// the coding agent's just-applied edits — an in-process import of the planner
// would use the stale module. We shell out to the tsx dev-harnesses (eval-gate /
// eval-page), which compile from current source on each run. cwd is apps/mcp so
// the relative harness paths + corpus resolution work.
function mcpDir(repoRoot: string): string {
  return join(repoRoot, "apps/mcp");
}

interface ExecResult {
  stdout: string;
  code: number;
}

// Run a command, capturing stdout + exit code even on non-zero exit (the gate
// exits 1 when regress < 100% — that's data, not an error).
async function runCapturing(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  try {
    const { stdout } = await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    if (typeof e.stdout === "string") {
      return { stdout: e.stdout, code: typeof e.code === "number" ? e.code : 1 };
    }
    throw err;
  }
}

// Parse the eval-gate's stdout into a structured verdict. The harness prints
//   regress: X/X · target-tune: a/b · target-holdout: c/d
// plus "REGRESS FAIL <service> <id> — <detail>" lines, and warns to stderr when
// the corpus is empty (exit 0 but vacuous).
export function parseGateOutput(stdout: string, code: number): EvalGateResult {
  const m =
    /regress:\s*(\d+)\/(\d+)\s*·\s*target-tune:\s*(\d+)\/(\d+)\s*·\s*target-holdout:\s*(\d+)\/(\d+)/.exec(
      stdout,
    );
  const n = (i: number): number => (m !== null ? Number(m[i]) : 0);
  const failures = [...stdout.matchAll(/REGRESS FAIL\s+(\S+)\s+(\S+)\s+—\s+(.*)/g)].map((x) => ({
    service: x[1] ?? "",
    id: x[2] ?? "",
    detail: (x[3] ?? "").trim(),
  }));
  const bucket = (passed: number, total: number, fails: GateBucketResult["failures"] = []): GateBucketResult => ({
    passed,
    total,
    failures: fails,
  });
  const regress = bucket(n(1), n(2), failures);
  const emptyRegress = regress.total === 0;
  return {
    regress,
    targetTune: bucket(n(3), n(4)),
    targetHoldout: bucket(n(5), n(6)),
    // exit 0 AND a non-empty regress bucket that's perfect.
    regressPassed: code === 0 && !emptyRegress && regress.passed === regress.total,
    emptyRegress,
  };
}

// The real gate: shell the temp-0 eval gate over the committed corpus.
export function makeEvalGateRunner(config: { repoRoot: string }): GateRunner {
  return async (): Promise<EvalGateResult> => {
    const r = await runCapturing("npx", ["tsx", "src/bot/eval-gate.ts"], mcpDir(config.repoRoot));
    return parseGateOutput(r.stdout, r.code);
  };
}

// The real replay: shell eval-page over the capture file and parse the STEP line.
export function makeClusterReplayRunner(config: { repoRoot: string }): ClusterReplay {
  return async (captureRef: string): Promise<PostVerifyStep> => {
    const r = await runCapturing(
      "npx",
      ["tsx", "src/bot/eval-page.ts", captureRef],
      mcpDir(config.repoRoot),
    );
    const m = /^STEP (.*)$/m.exec(r.stdout);
    if (m === null || m[1] === undefined) {
      throw new Error(`eval-page produced no STEP line for ${captureRef}`);
    }
    return JSON.parse(m[1]) as PostVerifyStep;
  };
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Paths git reports as modified/added/deleted, normalized to repo-relative
// forward-slash form (what the fix-agent's path fence expects).
async function changedPaths(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["status", "--porcelain"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^\S+\s+/, "").replace(/^.*->\s*/, ""));
}

// Build the coding-agent prompt for a cluster: the evidence + the contract.
function clusterPrompt(cluster: FixCluster): string {
  const services = cluster.services.join(", ");
  const refs = cluster.capture_refs.slice(0, 8).join("\n  ");
  const reasoning = cluster.failures
    .map((f) => f.planner_reasoning)
    .filter((r): r is string => r !== undefined)
    .slice(0, 4)
    .join("\n  ");
  return [
    `You are the autonomous fix-agent for the Trusty Squire signup bot.`,
    `A daily run failed on these services at the SAME stuck page (failure_stage=${cluster.failure_stage}):`,
    `  ${services}`,
    ``,
    `Captured DOM/inventory traces (round sidecars):`,
    `  ${refs}`,
    ``,
    `The planner's last reasoning on these failures:`,
    `  ${reasoning}`,
    ``,
    `Propose ONE GENERALIZING fix to the post-OAuth navigation planner prompt or`,
    `the deterministic nav/inventory code that resolves this cluster without a`,
    `per-service hack. Do NOT touch form-fill code or the eval corpus. After`,
    `editing, the change will be gated against the planner eval corpus; only a`,
    `change that keeps the regress bucket 100% and does not drop target-holdout`,
    `will be kept. If this is a genuine infra wall (real phone/card/IP-reputation`,
    `that no code change beats), make NO edits and say so explicitly.`,
  ].join("\n");
}

// The real proposer: invoke a coding-agent CLI in the repo, then diff the
// working tree to discover what it touched. apply() is a no-op (the agent
// already edited the tree); revert() restores those paths so a gate-red attempt
// leaves no residue. Returns null when the agent made no change.
//
// `cliCommand` is split argv (e.g. ["claude","-p"]) — the prompt is appended as
// the final arg. The operator wires the actual coding CLI; this module only
// orchestrates it.
export function codingAgentProposer(config: {
  repoRoot: string;
  cliCommand: readonly string[];
  log?: (line: string) => void;
}): FixProposer {
  const log = config.log ?? (() => undefined);
  return async (cluster: FixCluster): Promise<FixProposal | null> => {
    // Start from a clean tree so changedPaths attributes only this attempt.
    const before = await changedPaths(config.repoRoot);
    if (before.length > 0) {
      throw new Error(
        `fix-agent: working tree not clean before proposing (${before.length} change(s)) — refusing to attribute`,
      );
    }
    const [cmd, ...rest] = config.cliCommand;
    if (cmd === undefined) throw new Error("fix-agent: empty cliCommand");
    await exec(cmd, [...rest, clusterPrompt(cluster)], {
      cwd: config.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    const touched = await changedPaths(config.repoRoot);
    if (touched.length === 0) {
      log(`cluster ${cluster.id}: coding agent made no change`);
      return null;
    }
    return {
      summary: `auto-fix ${cluster.failure_stage} on ${cluster.services.join("/")}`,
      touched_paths: touched,
      apply: async () => undefined,
      revert: async () => {
        // restore tracked edits and drop any new files the agent created.
        await git(config.repoRoot, ["checkout", "--", "."]);
        await git(config.repoRoot, ["clean", "-fd"]);
      },
    };
  };
}

// The real committer: write the bumped RC into apps/mcp/package.json, stage the
// touched paths + the manifest, and commit on `staging`. Pushing is opt-in
// (`push: true`) so a dry operator run can inspect commits first; the release
// fence (assertStagingPrerelease, enforced upstream in the orchestration) means
// the version is always a legal `next`-channel prerelease by the time we get here.
export function gitCommitter(config: {
  repoRoot: string;
  push?: boolean;
  log?: (line: string) => void;
}): Committer {
  const log = config.log ?? (() => undefined);
  return async ({ cluster, proposal, version }): Promise<void> => {
    const manifest = join(config.repoRoot, "apps/mcp/package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    pkg["version"] = version;
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

    await git(config.repoRoot, ["add", "apps/mcp/package.json", ...proposal.touched_paths]);
    const msg =
      `fix(bot): auto-fix ${cluster.failure_stage} cluster (${cluster.services.join(", ")})\n\n` +
      `${proposal.summary}\n\n` +
      `Autonomous fix-agent — gated green against the planner eval corpus.\n` +
      `Ships to the next (RC) channel as ${version}.`;
    await git(config.repoRoot, ["commit", "-m", msg]);
    log(`committed ${version} on staging for cluster ${cluster.id}`);
    if (config.push === true) {
      await git(config.repoRoot, ["push", "origin", "staging"]);
      log(`pushed staging → CI publishes @trusty-squire/mcp@${version} (next)`);
    }
  };
}
