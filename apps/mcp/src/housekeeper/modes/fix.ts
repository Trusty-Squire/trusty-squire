// modes/fix.ts (C2 wiring) — the `mcp housekeeper --mode=fix` step. Runs AFTER a
// daily run: reads the failure batch from the capture dir, drives the holistic
// fix-agent against the eval gate, and commits surviving fixes to the `next`
// (RC) channel. See docs/DESIGN-autonomous-output-loop.md.
//
// Operator-only; never shipped (housekeeper/ is excluded from the npm tarball).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveCaptureDir } from "../../bot/onboarding-capture.js";
import { readFixBatch } from "../fix-batch.js";
import {
  runFixAgent,
  type FixAgentResult,
  type FixCluster,
  type StaleClusterGateResult,
} from "../fix-agent.js";
import { appendFixAttempts } from "../fix-ledger.js";
import type { ServiceRoutingFacts } from "../fix-router-input.js";
import {
  codingAgentProposer,
  gitCommitter,
  makeClusterReplayRunner,
  makeEvalGateRunner,
} from "../fix-agent-runtime.js";

// Posture (a): the fix-agent may only touch the gated post-OAuth navigation
// planner. agent.ts holds planPostVerifyStep + its prompt. Anything else
// (form-fill, other packages) is parked for human review.
const DEFAULT_ALLOWED_PATHS = [
  "apps/mcp/src/bot/agent.ts",
  "apps/mcp/src/bot/terminal-gate.ts",
  "apps/mcp/src/bot/state-classifier.ts",
] as const;
const DEFAULT_SERVICE_FACTS_PATH = "tools/housekeeper-services.yaml";

const NAMED_AGENT_COMMANDS = {
  claude: ["claude", "-p"],
  codex: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
} as const;

type NamedFixAgent = keyof typeof NAMED_AGENT_COMMANDS;

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

function splitCliCommand(raw: string): string[] {
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

function isNamedFixAgent(v: string): v is NamedFixAgent {
  return v === "claude" || v === "codex";
}

interface YamlServiceFactEntry {
  slug?: string;
  status?: string;
  signup_url?: string;
}

interface YamlServiceFactFile {
  services?: YamlServiceFactEntry[];
}

function serviceFactPath(repoRoot: string): string | null {
  const raw = process.env.TRUSTY_SQUIRE_FIX_SERVICE_FACTS_YAML;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "off" || trimmed === "0") return null;
    return trimmed;
  }
  const candidate = join(repoRoot, DEFAULT_SERVICE_FACTS_PATH);
  return existsSync(candidate) ? candidate : null;
}

function hostnameOf(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

export async function resolveServiceRoutingFacts(
  repoRoot: string,
  services: readonly string[],
): Promise<ServiceRoutingFacts> {
  const path = serviceFactPath(repoRoot);
  if (path === null) return {};
  let entries: YamlServiceFactEntry[];
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as YamlServiceFactFile | YamlServiceFactEntry[];
    entries = Array.isArray(parsed) ? parsed : (parsed.services ?? []);
  } catch {
    return {};
  }
  const wanted = new Set(services.map((s) => s.toLowerCase()));
  const facts: Record<string, { dnsAlive?: boolean; curatedNeedsManual?: boolean }> = {};
  await Promise.all(entries.map(async (entry) => {
    if (typeof entry.slug !== "string") return;
    const service = entry.slug.toLowerCase();
    if (!wanted.has(service)) return;
    const status = typeof entry.status === "string" ? entry.status.toLowerCase() : "";
    const fact = facts[service] ?? {};
    if (status === "needs-manual" || status === "manual") fact.curatedNeedsManual = true;
    const host = hostnameOf(entry.signup_url);
    if (host !== null) {
      try {
        await lookup(host);
        fact.dnsAlive = true;
      } catch {
        fact.dnsAlive = false;
      }
    }
    facts[service] = fact;
  }));
  return facts;
}

export function resolveFixAgentCommand(agent: string | undefined): {
  label: string;
  command: string[];
} {
  const selected = agent ?? process.env.TRUSTY_SQUIRE_FIX_AGENT;
  if (selected !== undefined && selected.trim().length > 0) {
    const trimmed = selected.trim();
    const normalized = trimmed.toLowerCase();
    if (isNamedFixAgent(normalized)) {
      return { label: normalized, command: [...NAMED_AGENT_COMMANDS[normalized]] };
    }
    return { label: "custom", command: splitCliCommand(trimmed) };
  }

  const fromEnv = process.env.TRUSTY_SQUIRE_FIX_AGENT_CLI;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { label: "custom", command: splitCliCommand(fromEnv) };
  }

  return { label: "claude", command: [...NAMED_AGENT_COMMANDS.claude] };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function checkFixAgentCommand(command: readonly string[]): string | null {
  const cmd = command[0];
  if (cmd === undefined) return "fix-agent proposer command is empty";
  try {
    execFileSync("sh", ["-lc", `command -v ${shellQuote(cmd)}`], {
      stdio: "ignore",
    });
    return null;
  } catch {
    return `fix-agent proposer command not found on PATH: ${cmd}`;
  }
}

export async function runFixMode(opts: {
  // Only fold in outcomes newer than this (scopes the batch to one pass).
  // Defaults to the last 24h (TRUSTY_SQUIRE_FIX_SINCE_HOURS overrides) so a
  // daily run only re-clusters recent failures, not the accumulated dir.
  sinceMs?: number;
  log?: (line: string) => void;
  // Named proposer agent ("claude" or "codex") or a custom command string.
  // TRUSTY_SQUIRE_FIX_AGENT provides the same named-agent override; the older
  // TRUSTY_SQUIRE_FIX_AGENT_CLI remains the raw command escape hatch.
  agent?: string;
  // The LIVE ORACLE (Phase 2). When provided, a fix commits only if it also
  // passes the live gate. The autoloop builds this (canary baseline measured
  // once); a plain --mode=fix run leaves it undefined (offline-only).
  liveGate?: (cluster: FixCluster) => Promise<{ passed: boolean; reason: string }>;
  routerFacts?: ServiceRoutingFacts;
  currentCommit?: string;
  staleClusterGate?: (cluster: FixCluster) => Promise<StaleClusterGateResult>;
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
    opts.currentCommit !== undefined ? { currentCommit: opts.currentCommit } : {},
  );

  if (batch.failures.length === 0) {
    log("no failures in the batch — nothing to fix");
    return { committed: [], walls: [], parked: [], routed: [] };
  }

  const cliCommand = resolveFixAgentCommand(opts.agent);
  const push = isTruthy(process.env.TRUSTY_SQUIRE_FIX_AGENT_PUSH);
  const commandProblem = checkFixAgentCommand(cliCommand.command);
  const routerFacts = opts.routerFacts ?? await resolveServiceRoutingFacts(
    repoRoot,
    [...new Set(batch.failures.map((f) => f.service))],
  );

  log(
    `fix pass: ${batch.failures.length} failure(s), bot=${botVersion}, branch=${branch}, agent=${cliCommand.label}, push=${push}`,
  );
  if (commandProblem !== null) {
    log(commandProblem);
    return {
      committed: [],
      walls: [],
      routed: [],
      parked: [{ cluster_id: "proposer", reason: commandProblem, touched_paths: [] }],
    };
  }

  const result = await runFixAgent({
    batch,
    branch,
    currentVersion: botVersion,
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    routerFacts,
    propose: codingAgentProposer({ repoRoot, cliCommand: cliCommand.command, log }),
    gate: makeEvalGateRunner({ repoRoot }),
    replay: makeClusterReplayRunner({ repoRoot }),
    ...(opts.liveGate !== undefined ? { liveGate: opts.liveGate } : {}),
    ...(opts.staleClusterGate !== undefined ? { staleClusterGate: opts.staleClusterGate } : {}),
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
