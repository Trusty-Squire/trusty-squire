// Environment → typed Config for the housekeeper. Operator-only knobs; the
// package never ships to end users, so these live in the operator's shell /
// systemd unit, not an end-user MCP config.

export interface Config {
  // Registry base URL the verify loop reads skills from + reports outcomes to.
  registryUrl: string;
  // Admin bearer for the registry's /admin endpoints. Required to POST outcomes;
  // undefined → the loop runs read-only (lists skills, drives codex) but cannot
  // promote/demote. Kept server-side here, NEVER passed into codex's prompt.
  adminBearer: string | undefined;
  // The codex CLI invocation (default "codex"); the runner appends `exec <prompt>`.
  codexCmd: string;
  // Per-run budget: max skills to verify in one pass. codex exec per skill is
  // real wall-clock + token cost on the operator box, so cap each run.
  maxSkillsPerRun: number;
  // Successes required to promote pending-review → active. Default 1 (the
  // mechanical rule: one good sign-in promotes). Bump to verify-twice if a
  // service is flaky.
  promoteMinSuccesses: number;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    registryUrl: env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
    adminBearer: env.REGISTRY_ADMIN_BEARER,
    codexCmd: env.HOUSEKEEPER_CODEX_CMD ?? "codex",
    maxSkillsPerRun: intFromEnv(env.HOUSEKEEPER_MAX_SKILLS_PER_RUN, 20),
    promoteMinSuccesses: intFromEnv(env.HOUSEKEEPER_PROMOTE_MIN_SUCCESSES, 1),
  };
}
