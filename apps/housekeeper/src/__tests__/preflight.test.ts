import { describe, it, expect } from "vitest";
import { checkCodex } from "../preflight.js";
import { loadConfig } from "../config.js";
import type { Spawn } from "../codex-runner.js";

const config = loadConfig({ HOUSEKEEPER_CODEX_CMD: "codex" } as NodeJS.ProcessEnv);

describe("checkCodex", () => {
  it("reports ok when codex --version exits 0", async () => {
    const spawn: Spawn = async () => ({ stdout: "codex 1.2.3", code: 0, errored: false });
    const r = await checkCodex(config, spawn);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("1.2.3");
  });

  it("reports not-ok when codex exits non-zero", async () => {
    const spawn: Spawn = async () => ({ stdout: "", code: 127, errored: true });
    const r = await checkCodex(config, spawn);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/installed|PATH/);
  });

  it("reports not-ok when the spawn throws", async () => {
    const spawn: Spawn = async () => {
      throw new Error("ENOENT");
    };
    const r = await checkCodex(config, spawn);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ENOENT");
  });
});
