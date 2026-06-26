// The codex-exec runner: ask codex (holding the @next Trusty Squire MCP) to
// reproduce a skill's signup, and parse the boolean outcome back out. The
// housekeeper — not codex — relays that outcome to the registry (D4), so this
// module never touches the admin bearer or any registry tool.
//
// Split for testability: buildPrompt + parseRunnerOutput are pure; runCodexVerify
// is the only side-effectful piece and takes an injectable spawn fn.

import { execFile } from "node:child_process";
import type { Config } from "./config.js";
import { normalizeFailureKind } from "./classify.js";
import type { FailureKind, SkillRef, VerifyOutcome } from "./types.js";

// A verify attempt either produced a parseable outcome, or the runner itself
// couldn't get one (codex crashed / timed out / emitted no RESULT line). The
// latter is an INFRA problem, never a skill failure — the scheduler skips it
// (no demote), so a flaky codex run can't demote good skills.
export type RunnerResult =
  | { kind: "result"; outcome: VerifyOutcome }
  | { kind: "infra_error"; detail: string };

// Per-skill wall-clock cap. codex driving a full browser signup can take
// minutes; beyond this we give up this pass (infra_error → skip, no demote).
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

const VALID_KINDS = [
  "nav_timeout",
  "account_exists",
  "brittle_probe",
  "login_wall",
  "captcha_blocked",
  "no_credentials",
  "step_failed",
  "other",
] as const satisfies readonly FailureKind[];

export function buildPrompt(skill: SkillRef): string {
  return [
    `You are verifying whether a Trusty Squire skill still works. Use ONLY the`,
    `Trusty Squire MCP provision_* tools. Do not call any registry tool, and do`,
    `not promote or demote anything — your only job is to verify and report.`,
    ``,
    `Service: ${skill.service}`,
    `Signup URL: ${skill.signup_url}`,
    ``,
    `1. provision_start with service_url "${skill.signup_url}". Read the route`,
    `   hint if one is returned.`,
    `2. Drive the signup to obtain a working API credential. If a provider login`,
    `   is offered, use the live session (prefer Google); the account may already`,
    `   exist — log IN, do not re-sign-up.`,
    `3. provision_extract to get the credential. A real credential = the skill works.`,
    `4. provision_finish.`,
    ``,
    `Then output EXACTLY ONE final line and nothing after it:`,
    `  on success:  RESULT: {"ok": true}`,
    `  on failure:  RESULT: {"ok": false, "failure_kind": "<kind>", "detail": "<short reason>"}`,
    `where <kind> is one of: ${VALID_KINDS.join(" | ")}.`,
    `Use "login_wall" if a login/anti-bot wall blocked you, "captcha_blocked" for`,
    `an uncleared captcha, "no_credentials" if you reached the end with no key.`,
  ].join("\n");
}

// Find the LAST `RESULT: {json}` line and parse it. Returns null when there is
// no parseable result line (→ the caller treats it as infra_error).
export function parseRunnerOutput(stdout: string): VerifyOutcome | null {
  const lines = stdout.split(/\r?\n/);
  let found: string | null = null;
  for (const line of lines) {
    const m = /^\s*RESULT:\s*(\{.*\})\s*$/.exec(line);
    if (m && m[1] !== undefined) found = m[1];
  }
  if (found === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(found);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.ok === true) return { ok: true };
  if (rec.ok !== false) return null;
  const failure_kind = normalizeFailureKind(
    typeof rec.failure_kind === "string" ? rec.failure_kind : undefined,
  );
  const detail = typeof rec.detail === "string" ? rec.detail : undefined;
  return detail === undefined ? { ok: false, failure_kind } : { ok: false, failure_kind, detail };
}

// Injectable spawn — default shells out to `codex exec <prompt>`. Returns the
// captured stdout + exit code; never throws (errors become a non-zero code).
export interface SpawnResult {
  stdout: string;
  code: number;
  errored: boolean;
}
export type Spawn = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<SpawnResult>;

export const defaultSpawn: Spawn = (cmd, args, timeoutMs) =>
  new Promise<SpawnResult>((resolve) => {
    execFile(
      cmd,
      args as string[],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          const code = typeof err.code === "number" ? err.code : 1;
          resolve({ stdout: stdout ?? "", code, errored: true });
          return;
        }
        resolve({ stdout: stdout ?? "", code: 0, errored: false });
      },
    );
  });

export async function runCodexVerify(
  skill: SkillRef,
  config: Config,
  spawn: Spawn = defaultSpawn,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RunnerResult> {
  const prompt = buildPrompt(skill);
  const res = await spawn(config.codexCmd, ["exec", prompt], timeoutMs);
  const outcome = parseRunnerOutput(res.stdout);
  if (outcome === null) {
    // codex produced no parseable RESULT — infra problem, not a skill failure.
    const why = res.errored ? `codex exited ${res.code}` : "no RESULT line in codex output";
    return { kind: "infra_error", detail: why };
  }
  return { kind: "result", outcome };
}
