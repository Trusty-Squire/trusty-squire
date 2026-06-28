// `npx @trusty-squire/mcp skill <subcommand>` — operator CLI for the
// Tier-2 Learned Skill registry.
//
// Subcommands:
//   list     [--service=X] [--status=S] [--limit=N] [--json] [--health]
//   show     <skill_id> [--json]
//   replays  <skill_id> [--limit=N] [--json]
//   captures <skill_id> [--json]
//   demote   <skill_id> --reason=<text>
//   approve  <skill_id>
//   help
//
// Environment:
//   TRUSTY_SQUIRE_REGISTRY_URL — base URL of the registry (required)
//   TRUSTY_SQUIRE_ACCOUNT_ID   — x-account-id header value (optional)
//
// Exit codes — see errors.ts (ExitCode). Distinct codes per failure
// class so shell scripts can branch reliably.

import process from "node:process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { CliExit, ExitCode } from "./errors.js";
import { clientFromEnvOrThrow } from "./registry-http.js";
import type { RegistryHttpClient } from "./registry-http.js";
import { signSkillForPublish } from "./signing.js";
import { promoteToSkill, deriveSkillId } from "../bot/promote-to-skill.js";
import { parseSkill, type Skill } from "@trusty-squire/skill-schema";

// ── Public entry point ──────────────────────────────────────────────

export interface SkillCliOpts {
  /** Override RegistryHttpClient construction (tests inject mocks). */
  buildClient?: () => RegistryHttpClient;
  /** Override stdout for tests. Default: console.log. */
  stdout?: (line: string) => void;
  /** Override stderr for tests. Default: console.error. */
  stderr?: (line: string) => void;
  /**
   * Corpus root for `promote`. Default: env CORPUS_DIR, else
   * `./corpus/onboarding`. Tests override directly so they don't
   * depend on cwd.
   */
  corpusDir?: string;
  /**
   * Signing-key override for `promote`. When omitted, the signer
   * reads SKILL_SIGNING_PRIVATE_KEY from env. Tests inject a
   * KeyObject so they don't have to round-trip a real env var.
   */
  signingPrivateKey?: import("node:crypto").KeyObject;
  /**
   * Editor invocation for `edit`. Default: spawnSync($EDITOR, [filePath]).
   * Tests inject a function that mutates the tempfile in place — that's
   * how we exercise the "save → re-validate → re-publish" path without
   * an interactive editor.
   */
  editorCommand?: (filePath: string) => void | Promise<void>;
}

/**
 * Dispatch a `skill` subcommand. Returns the exit code (does NOT
 * call process.exit — bin.ts owns that). Throwing is reserved for
 * truly unexpected failures; expected failures use CliExit.
 */
export async function runSkillCli(
  argv: string[],
  opts: SkillCliOpts = {},
): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  // First non-flag arg = subcommand. Empty/help → print usage.
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp(stdout);
    return ExitCode.OK;
  }

  try {
    const client = (opts.buildClient ?? (() => {
      // Only forward accountId when it's actually set — passing
      // `undefined` violates exactOptionalPropertyTypes on the
      // Partial<RegistryHttpOpts> the http helper expects.
      const acctId = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
      return clientFromEnvOrThrow(acctId !== undefined ? { accountId: acctId } : {});
    }))();
    switch (subcommand) {
      case "list":
        return await cmdList(argv.slice(1), client, stdout);
      case "needs-human":
        return await cmdNeedsHuman(argv.slice(1), stdout);
      case "show":
        return await cmdShow(argv.slice(1), client, stdout);
      case "replays":
        return await cmdReplays(argv.slice(1), client, stdout);
      case "captures":
        return await cmdCaptures(argv.slice(1), client, stdout);
      case "demote":
        return await cmdDemote(argv.slice(1), client, stdout);
      case "approve":
        return await cmdApprove(argv.slice(1), client, stdout);
      case "promote":
        return await cmdPromote(argv.slice(1), client, stdout, opts);
      case "reactivate":
        return await cmdReactivate(argv.slice(1), client, stdout);
      case "delete":
        return await cmdDelete(argv.slice(1), client, stdout);
      case "diff":
        return await cmdDiff(argv.slice(1), client, stdout);
      case "edit":
        return await cmdEdit(argv.slice(1), client, stdout, opts);
      default:
        stderr(`unknown skill subcommand: ${subcommand}`);
        printHelp(stderr);
        return ExitCode.USAGE;
    }
  } catch (err) {
    if (err instanceof CliExit) {
      stderr(`error: ${err.message}`);
      return err.code;
    }
    throw err;
  }
}

// ── Flag parsing ────────────────────────────────────────────────────

interface ParsedFlags {
  flags: Record<string, string>;
  positional: string[];
  booleans: Set<string>;
}

/**
 * Parse `--flag=value`, `--flag value`, `--bool`, and positional args.
 * Returns flags map (string-valued), booleans set, and the positionals.
 *
 * Unknown flags surface as ARGS errors at the subcommand level (we
 * don't pre-define a spec here; each command checks the keys it cares
 * about and rejects unexpected ones).
 */
function parseFlags(argv: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      booleans.add(name);
      continue;
    }
    flags[name] = next;
    i += 1; // consume value
  }
  return { flags, positional, booleans };
}

function rejectUnknownFlags(parsed: ParsedFlags, allowed: Set<string>): void {
  for (const key of Object.keys(parsed.flags)) {
    if (!allowed.has(key)) {
      throw new CliExit(ExitCode.ARGS, `unknown flag: --${key}`);
    }
  }
  for (const key of parsed.booleans) {
    if (!allowed.has(key)) {
      throw new CliExit(ExitCode.ARGS, `unknown flag: --${key}`);
    }
  }
}

function requirePositional(parsed: ParsedFlags, count: number, label: string): void {
  if (parsed.positional.length !== count) {
    throw new CliExit(
      ExitCode.ARGS,
      `expected ${count} positional argument${count === 1 ? "" : "s"} (${label}), got ${parsed.positional.length}`,
    );
  }
}

// ── Subcommands ─────────────────────────────────────────────────────

interface ListResponse {
  ok: boolean;
  skills: Array<{
    skill_id: string;
    service: string;
    version: string;
    status: string;
    signed_by: string;
    signed_at: string;
    replays_succeeded: number;
    replays_failed: number;
    consecutive_failures: number;
    created_at: string;
    last_replayed_at: string | null;
  }>;
}

async function cmdList(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["service", "status", "limit", "json", "health"]));

  const qs = new URLSearchParams();
  if (parsed.flags.service !== undefined) qs.set("service", parsed.flags.service);
  if (parsed.flags.status !== undefined) qs.set("status", parsed.flags.status);
  if (parsed.flags.limit !== undefined) qs.set("limit", parsed.flags.limit);
  const path = `/skills${qs.size > 0 ? `?${qs.toString()}` : ""}`;

  const data = await client.get<ListResponse>(path);

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }

  // --health: the closed-loop's north-star view. First-time signup rate
  // is the wrong metric to chase (it's dragged by services the bot can
  // never complete unattended); what the architecture actually optimises
  // is "distinct services that have succeeded once" (= a promoted skill)
  // and the replay success rate on those. Surface exactly that.
  if (parsed.booleans.has("health")) {
    return renderHealth(data, out);
  }

  if (data.skills.length === 0) {
    out("(no skills)");
    return ExitCode.OK;
  }
  // Compact table. Columns: STATUS  SERVICE  VERSION  SKILL_ID  COUNTERS  CREATED
  const rows = data.skills.map((s) => ({
    status: s.status,
    service: s.service,
    version: s.version,
    skill_id: s.skill_id,
    counters: `${s.replays_succeeded}✓/${s.replays_failed}✗`,
    created: s.created_at.slice(0, 10),
  }));
  const widths = {
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    service: Math.max(7, ...rows.map((r) => r.service.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    skill_id: Math.max(8, ...rows.map((r) => r.skill_id.length)),
    counters: Math.max(8, ...rows.map((r) => r.counters.length)),
  };
  const header = [
    "STATUS".padEnd(widths.status),
    "SERVICE".padEnd(widths.service),
    "VERSION".padEnd(widths.version),
    "SKILL_ID".padEnd(widths.skill_id),
    "REPLAYS".padEnd(widths.counters),
    "CREATED",
  ].join("  ");
  out(header);
  for (const r of rows) {
    out(
      [
        r.status.padEnd(widths.status),
        r.service.padEnd(widths.service),
        r.version.padEnd(widths.version),
        r.skill_id.padEnd(widths.skill_id),
        r.counters.padEnd(widths.counters),
        r.created,
      ].join("  "),
    );
  }
  return ExitCode.OK;
}

// Aggregate health view — the metric that should actually climb as the
// closed loop matures, in place of aggregate first-time signup rate.
function renderHealth(data: ListResponse, out: (line: string) => void): number {
  const skills = data.skills;
  if (skills.length === 0) {
    out("(no skills — 0 services have succeeded once yet)");
    return ExitCode.OK;
  }
  const distinctServices = new Set(skills.map((s) => s.service)).size;
  const active = skills.filter((s) => s.status === "active").length;
  const demoted = skills.filter((s) => s.status === "demoted").length;
  const totalSucc = skills.reduce((n, s) => n + s.replays_succeeded, 0);
  const totalFail = skills.reduce((n, s) => n + s.replays_failed, 0);
  const total = totalSucc + totalFail;
  const rate = total > 0 ? `${Math.round((100 * totalSucc) / total)}%` : "—";

  out(`Skill health`);
  out(`  services succeeded once (have a skill): ${distinctServices}`);
  out(`  skills: ${skills.length}  (active ${active}, demoted ${demoted}, other ${skills.length - active - demoted})`);
  out(`  replay success: ${totalSucc}/${total} (${rate})`);

  // Skills that have failed at least one replay, worst failure rate first —
  // the re-promotion / re-capture worklist before auto-demotion bites.
  const attention = skills
    .filter((s) => s.replays_failed > 0)
    .map((s) => {
      const t = s.replays_succeeded + s.replays_failed;
      return { s, t, failRate: t > 0 ? s.replays_failed / t : 1 };
    })
    .sort((a, b) => b.failRate - a.failRate || b.s.replays_failed - a.s.replays_failed);
  if (attention.length > 0) {
    out("");
    out("Needs attention (by replay failure rate):");
    for (const { s, t, failRate } of attention) {
      out(`  ${s.service}  ${s.replays_succeeded}/${t} ok (${Math.round((1 - failRate) * 100)}%)  [${s.status}]  ${s.skill_id}`);
    }
  }
  return ExitCode.OK;
}

interface ShowResponse {
  ok: boolean;
  skill: Record<string, unknown>;
  signature: string;
  signed_at: string;
  signed_by: string;
  counters: {
    replays_succeeded: number;
    replays_failed: number;
    consecutive_failures: number;
  };
}

// T8 — `mcp skill needs-human`: the operator worklist. Reads the
// admin-gated /admin/needs-human roll-up (T6) so a sole operator sees what
// rotted/walled in one place. Admin-bearer-authed (the housekeeper
// operator already has REGISTRY_ADMIN_BEARER); the shared RegistryHttpClient
// only carries x-account-id, so this does its own authed fetch.
interface NeedsHumanItem {
  service: string;
  skill_id: string;
  status: string;
  reason: string | null;
  needs: string;
  last_attempt_at: string | null;
  verifier_failed: number;
}

async function cmdNeedsHuman(
  argv: string[],
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["limit", "json"]));

  const baseUrl = (
    process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai"
  ).replace(/\/+$/, "");
  const bearer = process.env.REGISTRY_ADMIN_BEARER;
  if (bearer === undefined || bearer.length === 0) {
    throw new CliExit(
      ExitCode.CONFIG,
      "REGISTRY_ADMIN_BEARER is required for `skill needs-human` (the worklist is admin-gated).",
    );
  }
  const qs =
    parsed.flags.limit !== undefined
      ? `?limit=${encodeURIComponent(parsed.flags.limit)}`
      : "";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/needs-human${qs}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
  } catch (err) {
    throw new CliExit(
      ExitCode.UNAVAILABLE,
      `needs-human: registry unreachable — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new CliExit(
      res.status === 401 ? ExitCode.CONFIG : ExitCode.UNAVAILABLE,
      `needs-human: ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as { ok: boolean; count: number; items: NeedsHumanItem[] };

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  if (data.items.length === 0) {
    out("(nothing needs a human — registry is healthy ✓)");
    return ExitCode.OK;
  }

  // Table: NEEDS  STATUS  SERVICE  REASON  LAST_ATTEMPT
  const rows = data.items.map((i) => ({
    needs: i.needs,
    status: i.status,
    service: i.service,
    reason: i.reason ?? "(none)",
    last: i.last_attempt_at?.slice(0, 10) ?? "—",
  }));
  const w = {
    needs: Math.max(5, ...rows.map((r) => r.needs.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    service: Math.max(7, ...rows.map((r) => r.service.length)),
    reason: Math.max(6, ...rows.map((r) => r.reason.length)),
  };
  out(
    [
      "NEEDS".padEnd(w.needs),
      "STATUS".padEnd(w.status),
      "SERVICE".padEnd(w.service),
      "REASON".padEnd(w.reason),
      "LAST",
    ].join("  "),
  );
  for (const r of rows) {
    out(
      [
        r.needs.padEnd(w.needs),
        r.status.padEnd(w.status),
        r.service.padEnd(w.service),
        r.reason.padEnd(w.reason),
        r.last,
      ].join("  "),
    );
  }
  out(`\n${data.items.length} service(s) need a human.`);
  return ExitCode.OK;
}

async function cmdShow(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const data = await client.get<ShowResponse>(`/skills/by-id/${encodeURIComponent(skillId)}`);

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  const skill = data.skill as {
    skill_id: string;
    service: string;
    version: string;
    status: string;
    signup_url: string;
    oauth_provider: string | null;
    steps: Array<{ kind: string }>;
    credentials: Array<{ type: string; env_var_suggestion: string; shape_hint: string }>;
  };
  out(`skill_id:      ${skill.skill_id}`);
  out(`service:       ${skill.service}`);
  out(`version:       ${skill.version}`);
  out(`status:        ${skill.status}`);
  out(`signup_url:    ${skill.signup_url}`);
  out(`oauth:         ${skill.oauth_provider ?? "(email/password)"}`);
  out(`signed_by:     ${data.signed_by}`);
  out(`signed_at:     ${data.signed_at}`);
  out(`replays:       ${data.counters.replays_succeeded}✓ / ${data.counters.replays_failed}✗ (${data.counters.consecutive_failures} consecutive failures)`);
  out(``);
  out(`steps (${skill.steps.length}):`);
  for (const [i, step] of skill.steps.entries()) {
    out(`  ${i}. ${step.kind}`);
  }
  out(``);
  out(`credentials (${skill.credentials.length}):`);
  for (const cred of skill.credentials) {
    out(`  - ${cred.env_var_suggestion} (${cred.type}, shape=${cred.shape_hint})`);
  }
  return ExitCode.OK;
}

interface ReplaysResponse {
  ok: boolean;
  service: string;
  skill_id: string;
  replays: Array<{
    id: string;
    outcome: string;
    reason: string;
    step_index: number | null;
    replayed_at: string;
  }>;
}

async function cmdReplays(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["limit", "json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const qs = new URLSearchParams();
  if (parsed.flags.limit !== undefined) qs.set("limit", parsed.flags.limit);
  const path = `/skills/by-id/${encodeURIComponent(skillId)}/replays${qs.size > 0 ? `?${qs.toString()}` : ""}`;

  const data = await client.get<ReplaysResponse>(path);

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  if (data.replays.length === 0) {
    out(`(no replays for ${data.skill_id})`);
    return ExitCode.OK;
  }
  out(`replays for ${data.skill_id} (${data.service}):`);
  for (const r of data.replays) {
    const step = r.step_index !== null ? ` [step ${r.step_index}]` : "";
    out(`  ${r.replayed_at}  ${r.outcome.padEnd(20)}${step}  ${r.reason}`);
  }
  return ExitCode.OK;
}

interface CapturesResponse {
  ok: boolean;
  skill_id: string;
  captures: Array<{
    content_hash: string;
    run_id: string;
    round_index: number;
    byte_size: number;
    uploaded_at: string;
  }>;
}

async function cmdCaptures(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const data = await client.get<CapturesResponse>(
    `/skills/${encodeURIComponent(skillId)}/captures`,
  );

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  if (data.captures.length === 0) {
    out(`(no captures uploaded for ${skillId})`);
    return ExitCode.OK;
  }
  out(`captures for ${skillId}:`);
  for (const c of data.captures) {
    out(
      `  ${c.run_id} round ${c.round_index}  ${c.content_hash.slice(0, 12)}…  ${c.byte_size}B  ${c.uploaded_at}`,
    );
  }
  return ExitCode.OK;
}

async function cmdDemote(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["reason", "json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const reason = parsed.flags.reason;
  if (reason === undefined || reason.length === 0) {
    throw new CliExit(
      ExitCode.ARGS,
      "demote requires --reason=<text> (operator must explain why)",
    );
  }

  const data = await client.post<{ ok: boolean; skill_id: string; status: string }>(
    `/skills/${encodeURIComponent(skillId)}/demote`,
    { reason },
  );

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  out(`demoted ${data.skill_id} (status=${data.status})`);
  return ExitCode.OK;
}

async function cmdApprove(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const data = await client.post<{ ok: boolean; skill_id: string; status: string }>(
    `/skills/${encodeURIComponent(skillId)}/approve-review`,
    {},
  );

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  out(`approved ${data.skill_id} (status=${data.status})`);
  return ExitCode.OK;
}

// ── promote ─────────────────────────────────────────────────────────

interface PromoteResponseOk {
  ok: true;
  skill_id: string;
  service: string;
  version: string;
  status: string;
  idempotent?: boolean;
}

async function cmdPromote(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
  opts: SkillCliOpts,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(
    parsed,
    new Set(["run-id", "corpus-dir", "dry-run", "json", "skip-verifier"]),
  );
  requirePositional(parsed, 1, "service");
  const service = parsed.positional[0]!;
  const runId = parsed.flags["run-id"];
  if (runId === undefined || runId.length === 0) {
    // `--run-id` is required for 0.7.0: there's no manifest of "which
    // capture is canonical", and silently picking one would let a
    // half-finished capture leak into the registry. Operator picks.
    throw new CliExit(
      ExitCode.ARGS,
      "promote requires --run-id=<id> (pick which capture run to promote)",
    );
  }
  const corpusRoot =
    parsed.flags["corpus-dir"] ?? opts.corpusDir ?? process.env.CORPUS_DIR ?? "./corpus/onboarding";
  const dir = path.join(corpusRoot, service);
  const dryRun = parsed.booleans.has("dry-run");
  const json = parsed.booleans.has("json");
  // --skip-verifier — operator vouches the skill is already validated
  // and lands it directly as active. Default is pending-review (the
  // two-tier registry's staging slot, gated by the verifier worker).
  const skipVerifier = parsed.booleans.has("skip-verifier");

  // Stage 1 — synthesize. Capture-chain verification, step translation,
  // credential-spec inference, schema validation all happen here.
  const result = promoteToSkill({
    dir,
    service,
    run_id: runId,
    ...(skipVerifier ? { status: "active" as const } : {}),
  });
  if (result.kind !== "ok") {
    const payload = {
      ok: false,
      stage: result.stage,
      error_kind: result.error_kind,
      message: result.message,
      ...(result.offending_round !== undefined
        ? { offending_round: result.offending_round }
        : {}),
      ...(result.offending_step !== undefined
        ? { offending_step: result.offending_step }
        : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      synthesizer_version: result.synthesizer_version,
    };
    if (json) {
      out(JSON.stringify(payload, null, 2));
    } else {
      out(`rejected: ${result.stage} / ${result.error_kind}`);
      out(`  ${result.message}`);
      if (result.offending_round !== undefined) out(`  at round ${result.offending_round}`);
      if (result.offending_step !== undefined) out(`  at step ${result.offending_step}`);
      if (result.detail !== undefined) out(`  detail: ${result.detail}`);
    }
    return ExitCode.VALIDATION;
  }

  if (dryRun) {
    // Dry-run stops here — no signing, no publish. The synthesis
    // result is itself the validation we'd otherwise hit the server
    // with. Print enough that the operator can decide whether to
    // re-run without --dry-run.
    const payload = {
      ok: true,
      dry_run: true,
      skill_id: result.skill.skill_id,
      service: result.skill.service,
      version: result.skill.version,
      steps: result.skill.steps.length,
    };
    if (json) {
      out(JSON.stringify(payload, null, 2));
    } else {
      out(`dry-run OK — synthesized ${result.skill.skill_id} v${result.skill.version} (${result.skill.steps.length} steps)`);
      out("  re-run without --dry-run to sign and publish.");
    }
    return ExitCode.OK;
  }

  // Stage 2 — sign. CliExit(CONFIG) bubbles when the key isn't set.
  const signed = signSkillForPublish(result.skill, opts.signingPrivateKey !== undefined ? { privateKey: opts.signingPrivateKey } : {});

  // Stage 3 — publish. POST /skills returns 201 on first publish, 200
  // on idempotent re-publish. The HTTP client throws on 401/400/etc.
  // (caught by the top-level dispatcher and surfaced as the right
  // exit code).
  const response = await client.post<PromoteResponseOk>("/skills", {
    skill: result.skill,
    signature: signed.signature,
  });

  if (json) {
    out(JSON.stringify(response, null, 2));
  } else {
    const tag = response.idempotent ? "already published" : "published";
    out(`${tag}: ${response.service} ${response.version} (skill_id=${response.skill_id}, status=${response.status})`);
  }
  return ExitCode.OK;
}

// ── reactivate ──────────────────────────────────────────────────────

async function cmdReactivate(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  const data = await client.post<{
    ok: boolean;
    skill_id: string;
    status: string;
    previously: string;
  }>(`/skills/${encodeURIComponent(skillId)}/reactivate`, {});

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  if (data.previously === data.status) {
    out(`${data.skill_id} is already ${data.status} (no-op)`);
  } else {
    out(`reactivated ${data.skill_id} (${data.previously} → ${data.status})`);
  }
  return ExitCode.OK;
}

// ── delete ──────────────────────────────────────────────────────────

async function cmdDelete(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["confirm", "json"]));
  requirePositional(parsed, 1, "skill_id");
  const skillId = parsed.positional[0]!;

  if (!parsed.booleans.has("confirm")) {
    throw new CliExit(
      ExitCode.ARGS,
      "delete is irreversible — pass --confirm to acknowledge. " +
        "Captures linked to this skill_id are deleted with it.",
    );
  }

  // Hard delete via DELETE /skills/:skill_id. The HTTP client always
  // tries to parse JSON, so the server responds with a small body.
  const data = await client.delete<{ ok: boolean; skill_id: string; deleted: boolean }>(
    `/skills/${encodeURIComponent(skillId)}`,
  );

  if (parsed.booleans.has("json")) {
    out(JSON.stringify(data, null, 2));
    return ExitCode.OK;
  }
  out(`deleted ${data.skill_id}`);
  return ExitCode.OK;
}

// ── diff ────────────────────────────────────────────────────────────

type StepDiffEntry =
  | { kind: "unchanged"; index: number; step_kind: string }
  | {
      kind: "modified";
      index: number;
      step_kind: string;
      fields: string[];
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | { kind: "added"; index: number; step_kind: string; step: Record<string, unknown> }
  | { kind: "removed"; index: number; step_kind: string; step: Record<string, unknown> };

// Fields that participate in semantic identity per step kind. Anything
// outside this list (e.g. `provenance`) is bookkeeping the diff
// ignores — operators care about what the replay engine actually
// targets, not which capture round originated each step.
const STEP_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  navigate: ["url"],
  click_oauth_button: ["provider"],
  click: ["text_match", "role"],
  fill: ["text_match", "role", "value_template"],
  select: ["text_match", "role", "option_match"],
  extract_via_copy_button: ["near_text_hint"],
  extract_via_regex: ["pattern_name"],
};

function semanticStepDiff(
  before: ReadonlyArray<Record<string, unknown>>,
  after: ReadonlyArray<Record<string, unknown>>,
): StepDiffEntry[] {
  const out: StepDiffEntry[] = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const b = before[i];
    const a = after[i];
    if (b === undefined && a !== undefined) {
      out.push({
        kind: "added",
        index: i,
        step_kind: typeof a.kind === "string" ? a.kind : "<unknown>",
        step: a,
      });
      continue;
    }
    if (a === undefined && b !== undefined) {
      out.push({
        kind: "removed",
        index: i,
        step_kind: typeof b.kind === "string" ? b.kind : "<unknown>",
        step: b,
      });
      continue;
    }
    if (a === undefined || b === undefined) continue;
    const bKind = typeof b.kind === "string" ? b.kind : "<unknown>";
    const aKind = typeof a.kind === "string" ? a.kind : "<unknown>";
    if (bKind !== aKind) {
      out.push({
        kind: "modified",
        index: i,
        step_kind: `${bKind} → ${aKind}`,
        fields: ["kind"],
        before: b,
        after: a,
      });
      continue;
    }
    const identityFields = STEP_IDENTITY_FIELDS[bKind] ?? [];
    const changed: string[] = [];
    for (const field of identityFields) {
      if (JSON.stringify(b[field]) !== JSON.stringify(a[field])) changed.push(field);
    }
    if (changed.length === 0) {
      out.push({ kind: "unchanged", index: i, step_kind: bKind });
    } else {
      out.push({
        kind: "modified",
        index: i,
        step_kind: bKind,
        fields: changed,
        before: b,
        after: a,
      });
    }
  }
  return out;
}

interface SkillListItem {
  skill_id: string;
  service: string;
  version: string;
  status: string;
}

interface ByIdResponse {
  ok: boolean;
  skill: Record<string, unknown>;
  signature: string;
  signed_at: string;
  signed_by: string;
}

async function cmdDiff(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["json"]));
  if (parsed.positional.length !== 3) {
    throw new CliExit(
      ExitCode.ARGS,
      `expected 3 positional arguments (service v1 v2), got ${parsed.positional.length}`,
    );
  }
  const [service, v1, v2] = parsed.positional as [string, string, string];
  const json = parsed.booleans.has("json");

  if (v1 === v2) {
    if (json) {
      out(JSON.stringify({ ok: true, identical: true, service, from: v1, to: v2 }, null, 2));
    } else {
      out(`identical: both arguments are ${JSON.stringify(v1)}`);
    }
    return 1; // T30 exit code: versions identical (design doc §CLI)
  }

  // 1. Find both versions in the service's list.
  const list = await client.get<{ ok: boolean; skills: SkillListItem[] }>(
    `/skills?service=${encodeURIComponent(service)}&limit=500`,
  );
  const items = list.skills ?? [];
  const fromItem = items.find((s) => s.version === v1);
  const toItem = items.find((s) => s.version === v2);
  if (fromItem === undefined || toItem === undefined) {
    const missing: string[] = [];
    if (fromItem === undefined) missing.push(v1);
    if (toItem === undefined) missing.push(v2);
    throw new CliExit(
      // Design doc maps "version not found" to exit code 2 (ARGS class
      // — operator named a version that doesn't exist).
      ExitCode.ARGS,
      `version${missing.length > 1 ? "s" : ""} not found for service ${JSON.stringify(service)}: ${missing.join(", ")}`,
    );
  }

  // 2. Fetch full payloads — list returns metadata only.
  const before = await client.get<ByIdResponse>(`/skills/by-id/${encodeURIComponent(fromItem.skill_id)}`);
  const after = await client.get<ByIdResponse>(`/skills/by-id/${encodeURIComponent(toItem.skill_id)}`);

  const beforeSteps = Array.isArray((before.skill as { steps?: unknown }).steps)
    ? ((before.skill as { steps: Record<string, unknown>[] }).steps)
    : [];
  const afterSteps = Array.isArray((after.skill as { steps?: unknown }).steps)
    ? ((after.skill as { steps: Record<string, unknown>[] }).steps)
    : [];

  const entries = semanticStepDiff(beforeSteps, afterSteps);
  const identical = entries.every((e) => e.kind === "unchanged");

  if (json) {
    out(
      JSON.stringify(
        {
          ok: true,
          service,
          from: { version: v1, skill_id: fromItem.skill_id },
          to: { version: v2, skill_id: toItem.skill_id },
          identical,
          step_diff: entries,
        },
        null,
        2,
      ),
    );
    return identical ? 1 : ExitCode.OK;
  }

  // Human-readable output. Unified-diff-ish: prefix each line with a
  // sigil (=, ~, +, -) so a `grep '^[+-]'` finds only real changes.
  out(`diff: ${service} ${v1} → ${v2}`);
  out(`  skill_id: ${fromItem.skill_id} → ${toItem.skill_id}`);
  out(`  steps: ${beforeSteps.length} → ${afterSteps.length}` +
    (beforeSteps.length !== afterSteps.length
      ? ` (${afterSteps.length > beforeSteps.length ? "+" : ""}${afterSteps.length - beforeSteps.length})`
      : ""));
  out("");
  for (const entry of entries) {
    const sigil =
      entry.kind === "unchanged"
        ? "="
        : entry.kind === "modified"
          ? "~"
          : entry.kind === "added"
            ? "+"
            : "-";
    const label = `${sigil} [${entry.index}] ${entry.step_kind}`;
    if (entry.kind === "unchanged") {
      out(`${label}  unchanged`);
    } else if (entry.kind === "modified") {
      out(`${label}  modified: ${entry.fields.join(", ")}`);
      for (const field of entry.fields) {
        out(`    - ${field}: ${JSON.stringify(entry.before[field])}`);
        out(`    + ${field}: ${JSON.stringify(entry.after[field])}`);
      }
    } else if (entry.kind === "added") {
      out(`${label}  added`);
    } else {
      out(`${label}  removed`);
    }
  }

  // Exit code: 0 if differences shown, 1 if identical (per design doc).
  return identical ? 1 : ExitCode.OK;
}

// ── edit ────────────────────────────────────────────────────────────

async function cmdEdit(
  argv: string[],
  client: RegistryHttpClient,
  out: (line: string) => void,
  opts: SkillCliOpts,
): Promise<number> {
  const parsed = parseFlags(argv);
  rejectUnknownFlags(parsed, new Set(["dry-run", "json"]));
  requirePositional(parsed, 1, "service");
  const service = parsed.positional[0]!;
  const dryRun = parsed.booleans.has("dry-run");
  const json = parsed.booleans.has("json");

  // 1. Fetch the active skill. The endpoint returns 404 when there's
  //    nothing to edit; the HTTP client maps that to NOT_FOUND.
  const envelope = await client.get<{
    ok: boolean;
    skill: Record<string, unknown>;
    signed_by: string;
  }>(`/skills/${encodeURIComponent(service)}`);
  let before: Skill;
  try {
    before = parseSkill(envelope.skill);
  } catch (err) {
    throw new CliExit(
      ExitCode.GENERIC,
      `registry returned a skill that fails schema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Write the skill to a tempfile and let $EDITOR (or the injected
  //    editorCommand) modify it. Save the original bytes to detect
  //    "no changes" cleanly — comparing JSON would also work but the
  //    string compare catches whitespace/order edits the operator
  //    might intentionally make.
  const tempPath = path.join(
    os.tmpdir(),
    `skill-edit-${before.skill_id}-${Date.now()}.json`,
  );
  const originalText = JSON.stringify(before, null, 2);
  fs.writeFileSync(tempPath, originalText, "utf8");

  try {
    if (opts.editorCommand !== undefined) {
      await opts.editorCommand(tempPath);
    } else {
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      const result = spawnSync(editor, [tempPath], { stdio: "inherit" });
      if (result.error !== undefined) {
        throw new CliExit(
          ExitCode.GENERIC,
          `failed to launch editor (${editor}): ${result.error.message}`,
        );
      }
      if (typeof result.status === "number" && result.status !== 0) {
        throw new CliExit(
          ExitCode.GENERIC,
          `editor (${editor}) exited with status ${result.status}`,
        );
      }
    }

    const editedText = fs.readFileSync(tempPath, "utf8");
    if (editedText === originalText) {
      if (json) {
        out(JSON.stringify({ ok: false, no_edits: true }, null, 2));
      } else {
        out("no edits made — skill unchanged.");
      }
      // Design doc maps "no edits made" to exit code 2 (ARGS class).
      return ExitCode.ARGS;
    }

    // 3. Parse the edited JSON.
    let edited: unknown;
    try {
      edited = JSON.parse(editedText);
    } catch (err) {
      throw new CliExit(
        ExitCode.VALIDATION,
        `edited file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4. Recompute skill_id from the edited content so the operator
    //    doesn't need to manage it manually. The edit field is
    //    ignored in favor of the deterministic derivation — but a
    //    schema-invalid Omit<Skill,"skill_id"> still throws here.
    if (typeof edited !== "object" || edited === null || Array.isArray(edited)) {
      throw new CliExit(
        ExitCode.VALIDATION,
        "edited file must be a JSON object",
      );
    }
    const editedObj = edited as Record<string, unknown>;
    delete editedObj.skill_id;
    // parseSkill requires skill_id; insert a deterministically-derived
    // placeholder so validation passes, then we'll recompute from the
    // validated shape.
    editedObj.skill_id = before.skill_id;
    let candidate: Skill;
    try {
      candidate = parseSkill(editedObj);
    } catch (err) {
      throw new CliExit(
        ExitCode.VALIDATION,
        `edited skill failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const candidateWithoutId: Omit<Skill, "skill_id"> = { ...candidate };
    delete (candidateWithoutId as { skill_id?: string }).skill_id;
    const newSkillId = deriveSkillId(candidateWithoutId);
    const finalSkill: Skill = { ...candidate, skill_id: newSkillId };

    // 5. Detect security-relevant edits. The server's review gate
    //    (T26) does the actual hold; we surface a clear warning so
    //    the operator knows the new skill won't go live until
    //    `skill approve <skill_id>` runs.
    const securityChanges: string[] = [];
    if (finalSkill.signup_url !== before.signup_url) {
      securityChanges.push(
        `signup_url: ${before.signup_url} → ${finalSkill.signup_url}`,
      );
    }
    if (finalSkill.oauth_provider !== before.oauth_provider) {
      securityChanges.push(
        `oauth_provider: ${before.oauth_provider ?? "null"} → ${finalSkill.oauth_provider ?? "null"}`,
      );
    }

    if (dryRun) {
      if (json) {
        out(
          JSON.stringify(
            {
              ok: true,
              dry_run: true,
              skill_id: finalSkill.skill_id,
              previous_skill_id: before.skill_id,
              version: finalSkill.version,
              security_changes: securityChanges,
            },
            null,
            2,
          ),
        );
      } else {
        out(`dry-run OK — edited skill validates (${finalSkill.skill_id} v${finalSkill.version}).`);
        if (securityChanges.length > 0) {
          out("");
          out("⚠ security-gated edits — would land in pending-review:");
          for (const change of securityChanges) out(`  ${change}`);
        }
      }
      return ExitCode.OK;
    }

    // 6. Sign + publish.
    const signed = signSkillForPublish(
      finalSkill,
      opts.signingPrivateKey !== undefined ? { privateKey: opts.signingPrivateKey } : {},
    );
    const response = await client.post<{
      ok: boolean;
      skill_id: string;
      service: string;
      version: string;
      status: string;
    }>("/skills", { skill: finalSkill, signature: signed.signature });

    if (json) {
      out(
        JSON.stringify(
          {
            ...response,
            ok: true,
            previous_skill_id: before.skill_id,
            security_changes: securityChanges,
          },
          null,
          2,
        ),
      );
    } else {
      out(`published: ${response.service} ${response.version} (skill_id=${response.skill_id}, status=${response.status})`);
      if (securityChanges.length > 0) {
        out("");
        out("⚠ this edit touched security-relevant fields — the registry holds");
        out("  it as pending-review until an operator runs:");
        out(`    skill approve ${response.skill_id}`);
        for (const change of securityChanges) out(`  ${change}`);
      }
    }
    return ExitCode.OK;
  } finally {
    // Always clean the tempfile — it contains the full skill payload,
    // which isn't secret per se but lingering tempfiles are noise.
    try { fs.unlinkSync(tempPath); } catch { /* noop */ }
  }
}

// ── Help ────────────────────────────────────────────────────────────

function printHelp(out: (line: string) => void): void {
  out(`Usage: npx @trusty-squire/mcp skill <subcommand> [args]

Subcommands:
  promote     <service> --run-id=<id> [--corpus-dir=<path>] [--dry-run] [--json] [--skip-verifier]
              Synthesize a skill from corpus/onboarding/<service>/<run_id>/* and publish.
              Lands as pending-review (verifier-worker gated) by default;
              --skip-verifier publishes directly as active (operator vouching).

  list        [--service=X] [--status=S] [--limit=N] [--json] [--health]
              --health: aggregate view — services succeeded once + replay success rate
              List skills with optional filters.
  needs-human [--limit=N] [--json]
              The operator worklist: demoted (rot) + quarantined (wall)
              skills with WHY + last attempt. Needs REGISTRY_ADMIN_BEARER.

  show        <skill_id> [--json]
              Show a skill's full record (steps, credentials, counters).

  replays     <skill_id> [--limit=N] [--json]
              Show recent replay outcomes for a skill (any status).

  captures    <skill_id> [--json]
              List capture sidecars (source-map for the skill's promotion).

  demote      <skill_id> --reason=<text>
              Manually demote a skill so the router stops serving it.

  reactivate  <skill_id> [--json]
              Undo a demotion; reset consecutive_failures to 0.

  approve     <skill_id>
              Flip a pending-review skill to active (C11 human gate).

  delete      <skill_id> --confirm [--json]
              Hard-delete a skill and its captures. Irreversible.

  diff        <service> <v1> <v2> [--json]
              Semantic step-graph diff between two skill versions for a service.

  edit        <service> [--dry-run] [--json]
              Open the active skill in $EDITOR; re-validate, re-sign, re-publish.

  help
              Print this message.

Environment:
  TRUSTY_SQUIRE_REGISTRY_URL    Required. Base URL of registry.
  TRUSTY_SQUIRE_ACCOUNT_ID      Optional. Sent as x-account-id.

Exit codes:
  0    success
  1    generic error
  2    bad arguments
  64   usage / unknown subcommand
  65   config missing (registry URL unset)
  66   registry unavailable
  67   not found
  68   forbidden
  69   validation rejected
`);
}
