import { describe, it, expect } from "vitest";
import { buildPrompt, parseRunnerOutput, runCodexVerify, type Spawn } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import type { SkillRef } from "../types.js";

const skill: SkillRef = {
  id: "sk_1",
  service: "vouchflow",
  signup_url: "https://vouchflow.dev/signup",
  status: "pending-review",
};

describe("buildPrompt", () => {
  it("names the service + url and demands a single RESULT line", () => {
    const p = buildPrompt(skill);
    expect(p).toContain("vouchflow");
    expect(p).toContain("https://vouchflow.dev/signup");
    expect(p).toContain("provision_start");
    expect(p).toContain('RESULT: {"ok": true}');
    expect(p).toContain("login_wall");
    // It must forbid registry/promote actions (D4 — codex stays a pure driver).
    expect(p.toLowerCase()).toContain("promote or demote");
    expect(p.toLowerCase()).toContain("registry tool");
  });
});

describe("parseRunnerOutput", () => {
  it("parses a success line", () => {
    expect(parseRunnerOutput('chatter\nRESULT: {"ok": true}\n')).toEqual({ ok: true });
  });

  it("parses a failure line with kind + detail", () => {
    const out = parseRunnerOutput('RESULT: {"ok": false, "failure_kind": "login_wall", "detail": "X wall"}');
    expect(out).toEqual({ ok: false, failure_kind: "login_wall", detail: "X wall" });
  });

  it("normalizes an unknown failure_kind to a known one", () => {
    const out = parseRunnerOutput('RESULT: {"ok": false, "failure_kind": "needs_login"}');
    expect(out).toEqual({ ok: false, failure_kind: "login_wall" });
  });

  it("defaults a kindless failure to other", () => {
    expect(parseRunnerOutput('RESULT: {"ok": false}')).toEqual({ ok: false, failure_kind: "other" });
  });

  it("takes the LAST result line when several appear", () => {
    const out = parseRunnerOutput('RESULT: {"ok": true}\n...\nRESULT: {"ok": false}\n');
    expect(out).toEqual({ ok: false, failure_kind: "other" });
  });

  it("returns null when there is no result line or invalid json", () => {
    expect(parseRunnerOutput("no verdict here")).toBeNull();
    expect(parseRunnerOutput("RESULT: {not json}")).toBeNull();
    expect(parseRunnerOutput('RESULT: {"missing": "ok"}')).toBeNull();
  });
});

describe("runCodexVerify", () => {
  const config = loadConfig({ HOUSEKEEPER_CODEX_CMD: "codex" } as NodeJS.ProcessEnv);

  it("returns a result when codex emits a parseable RESULT", async () => {
    const spawn: Spawn = async () => ({ stdout: 'RESULT: {"ok": true}', code: 0, errored: false });
    const r = await runCodexVerify(skill, config, spawn);
    expect(r).toEqual({ kind: "result", outcome: { ok: true } });
  });

  it("treats no RESULT line as infra_error (not a skill failure)", async () => {
    const spawn: Spawn = async () => ({ stdout: "codex rambled but never reported", code: 0, errored: false });
    const r = await runCodexVerify(skill, config, spawn);
    expect(r.kind).toBe("infra_error");
  });

  it("treats a codex crash as infra_error", async () => {
    const spawn: Spawn = async () => ({ stdout: "", code: 137, errored: true });
    const r = await runCodexVerify(skill, config, spawn);
    expect(r).toEqual({ kind: "infra_error", detail: "codex exited 137" });
  });

  it("passes `exec <prompt>` to the configured codex command", async () => {
    let seenCmd = "";
    let seenArgs: readonly string[] = [];
    const spawn: Spawn = async (cmd, args) => {
      seenCmd = cmd;
      seenArgs = args;
      return { stdout: 'RESULT: {"ok": true}', code: 0, errored: false };
    };
    await runCodexVerify(skill, config, spawn);
    expect(seenCmd).toBe("codex");
    expect(seenArgs[0]).toBe("exec");
    expect(seenArgs[1]).toContain("vouchflow");
  });
});
