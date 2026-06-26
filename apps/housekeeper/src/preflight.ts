// `ts-housekeeper --check` — confirm the operator box is set up before a real
// pass. The two things that silently break a verify run: codex isn't installed/
// on PATH, and the admin bearer is missing. (The third — a dead operator Google
// session — can't be checked cheaply here; it surfaces at run time as login_wall
// transient failures, which by design never demote.)

import type { Config } from "./config.js";
import { defaultSpawn, type Spawn } from "./codex-runner.js";

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export async function checkCodex(config: Config, spawn: Spawn = defaultSpawn): Promise<CheckResult> {
  try {
    const res = await spawn(config.codexCmd, ["--version"], 15000);
    if (res.code === 0) {
      const ver = res.stdout.trim().slice(0, 80);
      return { ok: true, detail: `codex OK${ver.length > 0 ? ` (${ver})` : ""}` };
    }
    return {
      ok: false,
      detail: `codex '${config.codexCmd}' exited ${res.code} — is the codex CLI installed + on PATH?`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `codex '${config.codexCmd}' not runnable: ${msg}` };
  }
}

// Prints a setup summary; returns true when the box is ready to run a real pass.
export async function runPreflight(config: Config, spawn?: Spawn): Promise<boolean> {
  const codex = await checkCodex(config, spawn);
  const bearerOk = config.adminBearer !== undefined;
  const lines = [
    `registry:      ${config.registryUrl}`,
    `admin bearer:  ${bearerOk ? "set" : "MISSING — set REGISTRY_ADMIN_BEARER"}`,
    `codex cmd:     ${config.codexCmd}`,
    `${codex.ok ? "✓" : "✗"} ${codex.detail}`,
    `max/run:       ${config.maxSkillsPerRun}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return codex.ok && bearerOk;
}
