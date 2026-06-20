// fix-agent-runtime.ts (C2, production seams) — the real FixProposer + Committer
// + GateRunner that wire the deterministic orchestration (fix-agent.ts) to a
// coding agent, git, and the eval gate. These are IO/LLM boundaries, kept out of
// the pure orchestration so that stays unit-testable; the invariants the loop
// enforces (staging-only, path fence, green-only-commit) live in fix-agent.ts.
//
// Operator-only (housekeeper/, excluded from the npm tarball).

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  NoChangeClassification,
} from "./fix-agent.js";
import { NoChangeProposalError } from "./fix-agent.js";

import { runLiveGate, type LiveRunAttempt, type LiveRunner } from "./live-gate.js";
import {
  recordSpent,
  releaseIdentityLease,
  reserveIdentityForService,
  type VerifyIdentity,
} from "./identity-pool.js";
import { replenishVerifyPool } from "./robot-replenish.js";

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

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function tailForLog(text: string, maxLines = 8): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-maxLines)
    .join(" | ")
    .slice(0, 1800);
}

function safeSegment(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "run";
}

function transcriptExcerpt(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-8)
    .join(" | ")
    .slice(0, 900);
}

function classifyNoChange(text: string): NoChangeClassification {
  if (
    /not fixable|cannot be fixed|can't be fixed|requires human|manual review|phone|card|payment|captcha|anti.?bot|ip reputation|blocked by/i.test(
      text,
    )
  ) {
    return "wall";
  }
  if (
    /outside (the )?(allowed|permitted) (surface|paths?)|out.of.fence|need(s)? to edit|requires changes? (outside|in another)|not in allowed/i.test(
      text,
    )
  ) {
    return "out_of_fence";
  }
  return "confused";
}

function writeProposerTranscript(input: {
  repoRoot: string;
  runId: string;
  cluster: FixCluster;
  attemptNumber: number;
  rateAttempt: number;
  prompt: string;
  stdout: string;
  stderr: string;
  exit: "ok" | "error";
  error?: string;
}): string {
  const dir = join(
    input.repoRoot,
    ".debug",
    "fix-agent",
    input.runId,
    safeSegment(input.cluster.id),
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `attempt-${input.attemptNumber}-try-${input.rateAttempt}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schema_version: 1,
        cluster_id: input.cluster.id,
        family_id: input.cluster.family_id,
        services: input.cluster.services,
        failure_stage: input.cluster.failure_stage,
        signature: input.cluster.signature,
        attempt: input.attemptNumber,
        rate_attempt: input.rateAttempt,
        exit: input.exit,
        ...(input.error !== undefined ? { error: input.error } : {}),
        prompt: input.prompt,
        stdout: input.stdout,
        stderr: input.stderr,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

export interface LocalLiveRunLease {
  runId: string;
  debugDir: string;
  tmpDir: string;
  attemptLabel: string;
  env: NodeJS.ProcessEnv;
  identity?: VerifyIdentity;
}

export function leaseLocalLiveRun(config: {
  repoRoot: string;
  service: string;
  attempt?: LiveRunAttempt;
  excludeIdentityIds?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}): LocalLiveRunLease {
  const baseEnv = config.baseEnv ?? process.env;
  const attemptNumber = config.attempt?.attempt ?? 1;
  const maxAttempts = config.attempt?.maxAttempts ?? 1;
  const runId = [
    "live",
    safeSegment(config.service),
    `a${attemptNumber}-of-${maxAttempts}`,
    `${process.pid}`,
    `${Date.now().toString(36)}`,
    Math.random().toString(36).slice(2, 8),
  ].join("-");
  const root = join(config.repoRoot, ".debug", "live-runs", runId);
  const debugDir = join(root, "snapshots");
  const tmpDir = join(root, "tmp");
  mkdirSync(debugDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const identity = reserveIdentityForService({
    service: config.service,
    provider: "google",
    runId,
    ...(config.excludeIdentityIds !== undefined
      ? { excludeIdentityIds: config.excludeIdentityIds }
      : {}),
  });
  if (identity === null) {
    return {
      runId,
      debugDir,
      tmpDir,
      attemptLabel: `${attemptNumber}/${maxAttempts}`,
      env: {
      ...baseEnv,
      HOUSEKEEPER_CONCURRENCY: "1",
      UNIVERSAL_BOT_RUN_ID: runId,
      UNIVERSAL_BOT_DEBUG_DIR: debugDir,
    },
    };
  }
  return {
    runId,
    debugDir,
    tmpDir,
    attemptLabel: `${attemptNumber}/${maxAttempts}`,
    identity,
    env: {
      ...baseEnv,
      HOUSEKEEPER_CONCURRENCY: "1",
      UNIVERSAL_BOT_RUN_ID: runId,
      UNIVERSAL_BOT_DEBUG_DIR: debugDir,
      BOT_FORCE_IDENTITY: identity.id,
    },
  };
}

function liveFailureIsRetryable(text: string): boolean {
  return /Chrome DevTools endpoint never came up|bot crash|SIGTRAP|browser.*crash|timed out|timeout=1|account already exists|already have an account|password reset|reset your password|wrong.*account|oauth_session_not_persisted|needs_login/i.test(
    text,
  );
}

function runProcessGroup(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (which: "stdout" | "stderr", chunk: Buffer): void => {
      const next = chunk.toString("utf8");
      if (which === "stdout") {
        stdout = (stdout + next).slice(-opts.maxBuffer);
      } else {
        stderr = (stderr + next).slice(-opts.maxBuffer);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", reject);

    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // process already exited
          }
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            try {
              process.kill(child.pid!, "SIGKILL");
            } catch {
              // process already exited
            }
          }
        }, 5_000);
        killTimer.unref();
      }
    }, opts.timeoutMs);
    timeout.unref();

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
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
function refsForPrompt(cluster: FixCluster): string {
  const refs: string[] = [];
  for (const page of cluster.pages) {
    if (!refs.includes(page.captureRef)) refs.push(page.captureRef);
    if (refs.length >= 12) break;
  }
  for (const ref of cluster.capture_refs) {
    if (!refs.includes(ref)) refs.push(ref);
    if (refs.length >= 12) break;
  }
  return refs.join("\n  ");
}

function clusterPrompt(
  cluster: FixCluster,
  attempt: number,
  priorFeedback: string | undefined,
): string {
  const services = cluster.services.join(", ");
  const refs = refsForPrompt(cluster);
  const reasoning = cluster.failures
    .map((f) => f.planner_reasoning)
    .filter((r): r is string => r !== undefined)
    .slice(0, 8)
    .join("\n  ");
  return [
    `You are the autonomous fix-agent for the Trusty Squire signup bot.`,
    `Attempt ${attempt} of this cluster.`,
    `A daily run failed on these services at the SAME stuck page (failure_stage=${cluster.failure_stage}):`,
    `  ${services}`,
    ``,
    `Captured DOM/inventory traces (round sidecars):`,
    `  ${refs}`,
    ``,
    `The planner's last reasoning on these failures:`,
    `  ${reasoning}`,
    ...(priorFeedback !== undefined
      ? [
          ``,
          `Previous attempt feedback:`,
          `  ${priorFeedback}`,
        ]
      : []),
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
// Coding-agent invocations rate-limit (per-minute 429s, or a usage-window cap)
// — the CLI exits non-zero with one of these in its output. The serial fix loop
// is naturally paced by the live gate, but a back-to-back retry burst (offline
// rejects → re-propose) or a usage-window cap can still trip it. We detect the
// shape and back off rather than crash the lap.
const RATE_LIMIT_RE = /rate.?limit|\b429\b|usage limit|too many requests|overloaded|quota exceeded|exceeded your/i;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function codingAgentProposer(config: {
  repoRoot: string;
  cliCommand: readonly string[];
  log?: (line: string) => void;
  runId?: string;
  // Hard ceiling on one coding-agent invocation — a hung agent must not block
  // the lap forever. Default 15 min (agentic sessions read many sidecars).
  timeoutMs?: number;
  // Rate-limit backoff retries before giving up on this cluster. Default 4
  // (1→2→4→8 min, capped 10).
  maxRateRetries?: number;
}): FixProposer {
  const log = config.log ?? (() => undefined);
  const runId = config.runId ?? `fix-agent-${process.pid}-${Date.now().toString(36)}`;
  const timeoutMs = config.timeoutMs ?? 15 * 60 * 1000;
  const maxRateRetries = config.maxRateRetries ?? 4;
  return async (
    cluster: FixCluster,
    attemptNumber: number,
    priorFeedback: string | undefined,
  ): Promise<FixProposal | null> => {
    // Start from a clean tree so changedPaths attributes only this attempt.
    const before = await changedPaths(config.repoRoot);
    if (before.length > 0) {
      throw new Error(
        `fix-agent: working tree not clean before proposing (${before.length} change(s)) — refusing to attribute`,
      );
    }
    const [cmd, ...rest] = config.cliCommand;
    if (cmd === undefined) throw new Error("fix-agent: empty cliCommand");
    let lastTranscriptPath: string | undefined;
    let lastOutput = "";
    try {
      for (let attempt = 0; ; attempt++) {
        const prompt = clusterPrompt(cluster, attemptNumber, priorFeedback);
        try {
          const result = await exec(cmd, [...rest, prompt], {
            cwd: config.repoRoot,
            maxBuffer: 64 * 1024 * 1024,
            timeout: timeoutMs,
          });
          lastOutput = `${result.stdout}\n${result.stderr}`;
          lastTranscriptPath = writeProposerTranscript({
            repoRoot: config.repoRoot,
            runId,
            cluster,
            attemptNumber,
            rateAttempt: attempt + 1,
            prompt,
            stdout: result.stdout,
            stderr: result.stderr,
            exit: "ok",
          });
          break;
        } catch (err) {
          const e = err as { message?: string; stderr?: string; stdout?: string };
          const blob = `${e.message ?? ""}\n${e.stderr ?? ""}\n${e.stdout ?? ""}`;
          lastOutput = blob;
          lastTranscriptPath = writeProposerTranscript({
            repoRoot: config.repoRoot,
            runId,
            cluster,
            attemptNumber,
            rateAttempt: attempt + 1,
            prompt,
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
            exit: "error",
            error: e.message ?? String(err),
          });
          if (RATE_LIMIT_RE.test(blob) && attempt < maxRateRetries) {
            // Drop any partial edits so the retry attributes cleanly.
            await git(config.repoRoot, ["checkout", "--", "."]).catch(() => undefined);
            await git(config.repoRoot, ["clean", "-fd"]).catch(() => undefined);
            const waitMs = Math.min(10 * 60 * 1000, 60 * 1000 * 2 ** attempt);
            log(
              `cluster ${cluster.id}: coding agent rate-limited — backing off ${Math.round(
                waitMs / 1000,
              )}s (retry ${attempt + 1}/${maxRateRetries})`,
            );
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      // Any terminal proposer failure (non-rate crash, timeout, exhausted
      // backoff) must leave a CLEAN tree so the next cluster's clean-tree
      // assertion holds — then rethrow for the orchestrator to park.
      await git(config.repoRoot, ["checkout", "--", "."]).catch(() => undefined);
      await git(config.repoRoot, ["clean", "-fd"]).catch(() => undefined);
      throw err;
    }
    const touched = await changedPaths(config.repoRoot);
    if (touched.length === 0) {
      const classification = classifyNoChange(lastOutput);
      const transcriptPath = lastTranscriptPath ?? "missing-transcript";
      const excerpt = transcriptExcerpt(lastOutput) || "no proposer output";
      log(
        `cluster ${cluster.id}: coding agent made no change (${classification}); transcript=${transcriptPath}`,
      );
      throw new NoChangeProposalError(classification, transcriptPath, excerpt);
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

// ── The LIVE ORACLE (autonomous-fix-loop Phase 2) ───────────────────────────
//
// A LiveRunner backed by a real single-service discover subprocess. It runs
// `dist/bin.js housekeeper --service=<svc> --once`, exercising the freshly BUILT
// dist — which is why makeLiveGate rebuilds dist before each gate run, so the
// applied (not-yet-committed) fix is actually live. Green = the run extracted a
// credential; a crash/timeout/non-green outcome = not green.

export function discoverLiveRunner(config: {
  repoRoot: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): LiveRunner {
  const timeout = config.timeoutMs ?? 9 * 60 * 1000;
  const usedByService = new Map<string, string[]>();
  return async (service, attempt) => {
    const used = usedByService.get(service) ?? [];
    let lease = leaseLocalLiveRun({
      repoRoot: config.repoRoot,
      service,
      ...(attempt !== undefined ? { attempt } : {}),
      excludeIdentityIds: used,
    });
    if (lease.identity === undefined) {
      config.log?.(`live: ${service}: no fresh robot available — replenishing verify fleet`);
      await replenishVerifyPool({
        force: true,
        rotateAll: true,
        maxPerPass: Number(process.env.ROBOT_REPLENISH_ON_EXHAUSTION_MAX ?? "9999"),
        log: (line) => config.log?.(`live: ${service}: ${line}`),
      }).catch((err) => {
        config.log?.(
          `live: ${service}: fleet replenish failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return "";
      });
      lease = leaseLocalLiveRun({
        repoRoot: config.repoRoot,
        service,
        ...(attempt !== undefined ? { attempt } : {}),
        excludeIdentityIds: used,
      });
      if (lease.identity === undefined) {
        config.log?.(
          `live: ${service} → red (run_id=${lease.runId} retryable=0 no fresh robot available after replenish)`,
        );
        return { green: false, retryable: false };
      }
    }
    used.push(lease.identity.id);
    usedByService.set(service, used);
    try {
      const { stdout, stderr, code, signal, timedOut } = await runProcessGroup(
        "node",
        ["apps/mcp/dist/bin.js", "housekeeper", `--service=${service}`, "--once"],
        {
          cwd: config.repoRoot,
          maxBuffer: 64 * 1024 * 1024,
          timeoutMs: timeout,
          env: lease.env,
        },
      );
      const out = `${stdout}\n${stderr}`;
      const green = /extracted \d+ credential|outcome=ok|→ ok \(/i.test(out);
      if (green) {
        config.log?.(`live: ${service} → green (try ${lease.attemptLabel})`);
      } else {
        const tail = tailForLog(out);
        const retryable = timedOut || liveFailureIsRetryable(out);
        const terminal = attempt === undefined || attempt.attempt >= attempt.maxAttempts;
        const prefix = terminal
          ? `live: ${service} → red`
          : `live: ${service} try ${lease.attemptLabel} → red`;
        config.log?.(
          `${prefix} (run_id=${lease.runId} retryable=${retryable ? 1 : 0} identity=${lease.identity.id} exit=${code ?? "null"} signal=${signal ?? "none"}${
            timedOut ? " timeout=1" : ""
          }${tail.length > 0 ? ` tail=${tail}` : ""})`,
        );
        return { green, retryable };
      }
      return { green };
    } catch (err) {
      const terminal = attempt === undefined || attempt.attempt >= attempt.maxAttempts;
      const prefix = terminal
        ? `live: ${service} → red`
        : `live: ${service} try ${lease.attemptLabel} → red`;
      config.log?.(
        `${prefix} (run_id=${lease.runId} retryable=1 identity=${lease.identity.id} spawn_error=${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return { green: false, retryable: true };
    } finally {
      try {
        recordSpent(lease.identity.id, service, new Date().toISOString());
      } catch (err) {
        config.log?.(
          `live: ${service} spend ${lease.identity.id} failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        releaseIdentityLease(lease.runId);
      } catch (err) {
        config.log?.(
          `live: ${service} release ${lease.identity.id} failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };
}

// The fix-agent's live gate: rebuild dist (so the applied fix is live), then
// runLiveGate(cluster + canary) against a FIXED pre-loop canary baseline (the
// caller measures it once, so canary flakiness doesn't block a good fix — only
// a real regression below where we started does).
export function makeLiveGate(config: {
  repoRoot: string;
  canary: readonly string[];
  baselineCanaryGreen: number;
  minClusterMove: number;
  concurrency?: number;
  maxAttempts?: number;
  runner: LiveRunner;
  build: () => Promise<void>;
  log?: (line: string) => void;
}): (cluster: FixCluster) => Promise<{ passed: boolean; reason: string }> {
  return async (cluster) => {
    config.log?.("live gate: rebuilding dist so the applied fix is live…");
    await config.build();
    const v = await runLiveGate(config.runner, {
      cluster: cluster.services,
      canary: config.canary,
      baselineCanaryGreen: config.baselineCanaryGreen,
      minClusterMove: config.minClusterMove,
      ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    });
    return { passed: v.passed, reason: v.reason };
  };
}

// Rebuild the mcp dist (tsc) — the live runner spawns dist/bin.js, so the fix
// must be compiled in before a gate run.
export function makeDistBuilder(config: {
  repoRoot: string;
}): () => Promise<void> {
  return async () => {
    await exec("pnpm", ["-F", "@trusty-squire/mcp", "build"], {
      cwd: config.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
  };
}
