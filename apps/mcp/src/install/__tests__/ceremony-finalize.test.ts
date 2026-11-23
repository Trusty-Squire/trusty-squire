import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENTS } from "../agents.js";
import { storeTwoCaptchaKey, writeAgentConfig } from "../ceremony-finalize.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ts-finalize-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it("writes the caller's resolved OpenCode destination after its environment is gone", async () => {
  const destination = join(home, "custom", "opencode.json");
  vi.stubEnv("OPENCODE_CONFIG", destination);
  const plan = { target: "opencode" as const, configPath: AGENTS.opencode.config_path() };
  vi.stubEnv("OPENCODE_CONFIG", "");
  await writeAgentConfig(plan, {
    api_base_url: "https://api.invalid", saved_at: "t", account_id: "account-1",
  }, true);
  const config = JSON.parse(await readFile(destination, "utf8"));
  expect(config.mcp.squire.environment.TRUSTY_SQUIRE_ACCOUNT_ID).toBe("account-1");
  await expect(readFile(AGENTS.opencode.config_path())).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds a vault POST whose server never responds", { timeout: 10_000 }, async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  try {
    await expect(storeTwoCaptchaKey("test-key", {
      api_base_url: `http://127.0.0.1:${address.port}`, saved_at: "t", agent_session_token: "test-token",
    })).resolves.toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
