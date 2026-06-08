import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarvesterEnvFile } from "../cli.js";

// loadHarvesterEnvFile reads $XDG_CONFIG_HOME/trusty-squire/harvester.env and
// populates process.env (non-overwriting). We point XDG_CONFIG_HOME at a temp
// dir so the test is hermetic.
describe("loadHarvesterEnvFile", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harvester-env-"));
    mkdirSync(join(dir, "trusty-squire"), { recursive: true });
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.REGISTRY_ADMIN_BEARER;
    delete process.env.UNIVERSAL_BOT_PROXY_URL;
    delete process.env.QUOTED_VAL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  const write = (body: string): void =>
    writeFileSync(join(dir, "trusty-squire", "harvester.env"), body);

  it("loads KEY=VALUE lines into process.env", () => {
    write("REGISTRY_ADMIN_BEARER=abc123\nUNIVERSAL_BOT_PROXY_URL=socks5://h:1\n");
    loadHarvesterEnvFile();
    expect(process.env.REGISTRY_ADMIN_BEARER).toBe("abc123");
    expect(process.env.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://h:1");
  });

  it("skips comments and blank lines", () => {
    write("# a comment\n\n  \nREGISTRY_ADMIN_BEARER=ok\n");
    loadHarvesterEnvFile();
    expect(process.env.REGISTRY_ADMIN_BEARER).toBe("ok");
  });

  it("strips one layer of matching quotes", () => {
    write(`QUOTED_VAL="spaced value"\n`);
    loadHarvesterEnvFile();
    expect(process.env.QUOTED_VAL).toBe("spaced value");
  });

  it("does NOT overwrite an already-set env var (explicit export wins)", () => {
    process.env.REGISTRY_ADMIN_BEARER = "from-shell";
    write("REGISTRY_ADMIN_BEARER=from-file\n");
    loadHarvesterEnvFile();
    expect(process.env.REGISTRY_ADMIN_BEARER).toBe("from-shell");
  });

  it("is a no-op when the file is absent", () => {
    // no file written
    expect(() => loadHarvesterEnvFile()).not.toThrow();
    expect(process.env.REGISTRY_ADMIN_BEARER).toBeUndefined();
  });
});
