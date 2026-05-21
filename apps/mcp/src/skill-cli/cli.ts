// `npx @trusty-squire/mcp skill <subcommand>` — operator CLI for the
// Tier-2 Learned Skill registry.
//
// Subcommands:
//   list     [--service=X] [--status=S] [--limit=N] [--json]
//   show     <skill_id> [--json]
//   replays  <skill_id> [--limit=N] [--json]
//   captures <skill_id> [--json]
//   demote   <skill_id> --reason=<text>
//   approve  <skill_id>
//   help
//
// Environment:
//   TRUSTY_SQUIRE_REGISTRY_URL — base URL of the registry-api (required)
//   TRUSTY_SQUIRE_ACCOUNT_ID   — x-account-id header value (optional)
//
// Exit codes — see errors.ts (ExitCode). Distinct codes per failure
// class so shell scripts can branch reliably.

import process from "node:process";
import { CliExit, ExitCode } from "./errors.js";
import { clientFromEnvOrThrow, RegistryHttpClient } from "./registry-http.js";

// ── Public entry point ──────────────────────────────────────────────

export interface SkillCliOpts {
  /** Override RegistryHttpClient construction (tests inject mocks). */
  buildClient?: () => RegistryHttpClient;
  /** Override stdout for tests. Default: console.log. */
  stdout?: (line: string) => void;
  /** Override stderr for tests. Default: console.error. */
  stderr?: (line: string) => void;
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
  rejectUnknownFlags(parsed, new Set(["service", "status", "limit", "json"]));

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

// ── Help ────────────────────────────────────────────────────────────

function printHelp(out: (line: string) => void): void {
  out(`Usage: npx @trusty-squire/mcp skill <subcommand> [args]

Subcommands:
  list     [--service=X] [--status=S] [--limit=N] [--json]
           List skills with optional filters.

  show     <skill_id> [--json]
           Show a skill's full record (steps, credentials, counters).

  replays  <skill_id> [--limit=N] [--json]
           Show recent replay outcomes for a skill (any status).

  captures <skill_id> [--json]
           List capture sidecars (source-map for the skill's promotion).

  demote   <skill_id> --reason=<text>
           Manually demote a skill so the router stops serving it.

  approve  <skill_id>
           Flip a pending-review skill to active (C11 human gate).

  help
           Print this message.

Environment:
  TRUSTY_SQUIRE_REGISTRY_URL    Required. Base URL of registry-api.
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
