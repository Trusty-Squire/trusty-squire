// The verify pass — the housekeeper's whole job. For each queued skill: ask
// codex to reproduce the signup (via the @next MCP), then relay the boolean
// outcome to the registry, which applies the mechanical rule (success →
// promote, 3rd real failure → demote). Transient failures and codex infra
// errors are SKIPPED (never posted), so a network blip or a dead operator
// session can't advance the demote counter.

import type { Config } from "./config.js";
import type { CliArgs } from "./cli.js";
import { HousekeeperRegistryClient } from "./registry-client.js";
import { runCodexVerify, type RunnerResult } from "./codex-runner.js";
import { failureCountsTowardDemotion } from "./classify.js";
import type { FailureKind, SkillRef } from "./types.js";

type ClientSurface = Pick<
  HousekeeperRegistryClient,
  "fetchQueue" | "fetchSkillSignupUrl" | "postOutcome"
>;

export interface VerifyDeps {
  client: ClientSurface;
  runVerify: (skill: SkillRef, config: Config) => Promise<RunnerResult>;
  log: (msg: string) => void;
}

export interface PassSummary {
  attempted: number;
  succeeded: number; // codex produced a credential
  promoted: number; // registry transitioned pending-review → active
  demoted: number; // registry transitioned active → demoted/retired/etc
  failures_reported: number; // real failures posted
  transient_skipped: number; // transient failures (not posted)
  infra_skipped: number; // codex couldn't run / per-skill error (not posted)
  no_url_skipped: number; // skill had no signup_url (not posted)
}

function emptySummary(): PassSummary {
  return {
    attempted: 0,
    succeeded: 0,
    promoted: 0,
    demoted: 0,
    failures_reported: 0,
    transient_skipped: 0,
    infra_skipped: 0,
    no_url_skipped: 0,
  };
}

const DEMOTE_TRANSITIONS: ReadonlySet<string> = new Set([
  "demoted",
  "retired",
  "quarantined",
  "superseded",
]);

export function formatDigest(s: PassSummary): string {
  return (
    `housekeeper pass: attempted=${s.attempted} succeeded=${s.succeeded} ` +
    `promoted=${s.promoted} demoted=${s.demoted} ` +
    `failures=${s.failures_reported} transient=${s.transient_skipped} ` +
    `infra=${s.infra_skipped} no_url=${s.no_url_skipped}`
  );
}

// One skill, end to end. Mutates `s` and emits a log line. Never throws — a
// per-skill error becomes an infra-skip so one bad skill can't abort the pass.
async function verifyOne(
  item: { skill_id: string; service: string; status: string },
  config: Config,
  args: CliArgs,
  deps: VerifyDeps,
  s: PassSummary,
): Promise<void> {
  s.attempted += 1;
  try {
    const signupUrl = await deps.client.fetchSkillSignupUrl(item.skill_id);
    if (signupUrl === null) {
      s.no_url_skipped += 1;
      deps.log(`  ${item.service} [${item.skill_id}]: no signup_url — skip`);
      return;
    }
    const skill: SkillRef = {
      id: item.skill_id,
      service: item.service,
      signup_url: signupUrl,
      status: item.status,
    };
    const result = await deps.runVerify(skill, config);
    if (result.kind === "infra_error") {
      s.infra_skipped += 1;
      deps.log(`  ${item.service}: codex infra error (${result.detail}) — skip, no demote`);
      return;
    }
    const outcome = result.outcome;
    if (outcome.ok) {
      s.succeeded += 1;
      if (args.dry) {
        deps.log(`  ${item.service}: SUCCESS (dry — would post success)`);
        return;
      }
      const resp = await deps.client.postOutcome({
        skill_id: item.skill_id,
        kind: "success",
        reason: "codex reproduced a working credential",
      });
      if (resp.transition === "promoted") s.promoted += 1;
      deps.log(`  ${item.service}: SUCCESS → ${resp.transition} (status=${resp.status})`);
      return;
    }
    // Failure path.
    const kind: FailureKind = outcome.failure_kind ?? "other";
    if (!failureCountsTowardDemotion(kind)) {
      s.transient_skipped += 1;
      deps.log(`  ${item.service}: transient failure (${kind}) — skip, no demote`);
      return;
    }
    s.failures_reported += 1;
    if (args.dry) {
      deps.log(`  ${item.service}: FAILURE (${kind}) (dry — would post failure)`);
      return;
    }
    const resp = await deps.client.postOutcome({
      skill_id: item.skill_id,
      kind: "failure",
      reason: outcome.detail ?? kind,
      failure_kind: kind,
    });
    if (DEMOTE_TRANSITIONS.has(resp.transition)) s.demoted += 1;
    deps.log(
      `  ${item.service}: FAILURE (${kind}) → ${resp.transition} ` +
        `(consecutive=${resp.consecutive_verifier_failures})`,
    );
  } catch (err) {
    s.infra_skipped += 1;
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`  ${item.service}: error (${msg}) — skip, no demote`);
  }
}

export async function runVerifyPass(
  config: Config,
  args: CliArgs,
  deps: VerifyDeps,
): Promise<PassSummary> {
  const s = emptySummary();
  const items = await deps.client.fetchQueue(config.maxSkillsPerRun);
  deps.log(
    `housekeeper: ${items.length} skill(s) in queue (cap ${config.maxSkillsPerRun})` +
      (args.dry ? " [dry run — no outcomes posted]" : ""),
  );
  for (const item of items) {
    await verifyOne(item, config, args, deps, s);
  }
  deps.log(formatDigest(s));
  return s;
}

// Entry the CLI calls. Builds the real deps (or accepts injected ones for tests)
// and runs one pass. The systemd timer provides the cadence; the binary itself
// does a single pass per invocation.
export async function runVerify(
  config: Config,
  args: CliArgs,
  injected?: Partial<VerifyDeps>,
): Promise<PassSummary> {
  if (config.adminBearer === undefined) {
    throw new Error(
      "REGISTRY_ADMIN_BEARER is required — the verify loop reads the admin queue and reports outcomes",
    );
  }
  const client: ClientSurface =
    injected?.client ??
    new HousekeeperRegistryClient({
      baseUrl: config.registryUrl,
      adminBearer: config.adminBearer,
    });
  const deps: VerifyDeps = {
    client,
    runVerify: injected?.runVerify ?? ((skill, cfg) => runCodexVerify(skill, cfg)),
    log: injected?.log ?? ((m) => process.stdout.write(`${m}\n`)),
  };
  return runVerifyPass(config, args, deps);
}
