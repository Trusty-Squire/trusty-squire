// Agent config-writer tests. Each writer reads the existing config,
// merges in a `squire` entry, writes back — and is idempotent.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { AGENTS } from "../install/agents.js";

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-test-"));
  process.env.HOME = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("claude-code config writer", () => {
  it("creates the file with the squire server entry when absent", async () => {
    await AGENTS["claude-code"].writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "claude-code" },
    });
    const raw = await fs.readFile(AGENTS["claude-code"].config_path(), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers: { squire: { command: string } } };
    expect(parsed.mcpServers.squire.command).toBe("npx");
  });

  it("preserves existing entries", async () => {
    const filePath = AGENTS["claude-code"].config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          mcpServers: {
            "user-tool": { command: "node", args: ["script.js"] },
          },
          someOtherKey: "preserved",
        },
        null,
        2,
      ),
    );

    await AGENTS["claude-code"].writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    });

    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, unknown>;
      someOtherKey: string;
    };
    expect(parsed.mcpServers["user-tool"]).toBeDefined();
    expect(parsed.mcpServers.squire).toBeDefined();
    expect(parsed.someOtherKey).toBe("preserved");
  });

  it("is idempotent (second call doesn't duplicate)", async () => {
    const input = {
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    };
    await AGENTS["claude-code"].writeConfig(input);
    await AGENTS["claude-code"].writeConfig(input);
    const raw = await fs.readFile(AGENTS["claude-code"].config_path(), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["squire"]);
  });
});

describe("cursor + cline JSON writers", () => {
  it("cursor writes the same mcpServers shape", async () => {
    await AGENTS.cursor.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    });
    const raw = await fs.readFile(AGENTS.cursor.config_path(), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers: { squire: unknown } };
    expect(parsed.mcpServers.squire).toBeDefined();
  });

  it("cline writes the same mcpServers shape", async () => {
    await AGENTS.cline.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    });
    const raw = await fs.readFile(AGENTS.cline.config_path(), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers: { squire: unknown } };
    expect(parsed.mcpServers.squire).toBeDefined();
  });
});

describe("goose YAML writer", () => {
  it("creates a config.yaml entry goose will actually load", async () => {
    await AGENTS.goose.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: { TS_LOG: "info" },
    });
    // Modern goose reads config.yaml, not the old profiles.yaml.
    expect(AGENTS.goose.config_path().endsWith("/goose/config.yaml")).toBe(true);
    const raw = await fs.readFile(AGENTS.goose.config_path(), "utf8");
    const parsed = yamlParse(raw) as {
      extensions: {
        squire: {
          cmd: string;
          envs: unknown;
          enabled: boolean;
          name: string;
          type: string;
        };
      };
    };
    expect(parsed.extensions.squire.cmd).toBe("npx");
    expect(parsed.extensions.squire.envs).toEqual({ TS_LOG: "info" });
    // Without `enabled`/`name`/`type` goose silently ignores the
    // extension — the bug that hid it before 0.4.2.
    expect(parsed.extensions.squire.enabled).toBe(true);
    expect(parsed.extensions.squire.name).toBe("squire");
    expect(parsed.extensions.squire.type).toBe("stdio");
  });

  it("preserves other extensions", async () => {
    const { stringify: yamlStringify } = await import("yaml");
    const filePath = AGENTS.goose.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      yamlStringify({ extensions: { custom: { cmd: "echo", args: ["hi"] } } }),
    );
    await AGENTS.goose.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    });
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yamlParse(raw) as { extensions: Record<string, unknown> };
    expect(parsed.extensions.custom).toBeDefined();
    expect(parsed.extensions.squire).toBeDefined();
  });
});

describe("continue YAML writer", () => {
  it("writes the mcpServers array with a squire entry", async () => {
    await AGENTS.continue.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {},
    });
    const raw = await fs.readFile(AGENTS.continue.config_path(), "utf8");
    const parsed = yamlParse(raw) as {
      mcpServers: Array<{ name: string; command: string }>;
    };
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0]?.name).toBe("squire");
  });

  it("is idempotent and replaces the squire entry instead of duplicating", async () => {
    const input = { command: "npx", args: ["-y", "@trusty-squire/mcp"], env: {} };
    await AGENTS.continue.writeConfig(input);
    await AGENTS.continue.writeConfig(input);
    const raw = await fs.readFile(AGENTS.continue.config_path(), "utf8");
    const parsed = yamlParse(raw) as { mcpServers: Array<{ name: string }> };
    expect(parsed.mcpServers.filter((s) => s.name === "squire")).toHaveLength(1);
  });
});

describe("codex TOML writer", () => {
  it("creates ~/.codex/config.toml with an [mcp_servers.squire] table", async () => {
    await AGENTS.codex.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp", "server"],
      env: { TS_LOG: "info" },
    });
    expect(AGENTS.codex.config_path().endsWith("/.codex/config.toml")).toBe(true);
    const raw = await fs.readFile(AGENTS.codex.config_path(), "utf8");
    const parsed = tomlParse(raw) as {
      mcp_servers: {
        squire: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    expect(parsed.mcp_servers.squire.command).toBe("npx");
    expect(parsed.mcp_servers.squire.args).toEqual([
      "-y",
      "@trusty-squire/mcp",
      "server",
    ]);
    expect(parsed.mcp_servers.squire.env).toEqual({ TS_LOG: "info" });
  });

  it("preserves the user's other config.toml entries", async () => {
    const filePath = AGENTS.codex.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      tomlStringify({ model: "gpt-5", approval_policy: "untrusted" }),
    );
    await AGENTS.codex.writeConfig({
      command: "npx",
      args: ["server"],
      env: {},
    });
    const parsed = tomlParse(await fs.readFile(filePath, "utf8")) as {
      model: string;
      approval_policy: string;
      mcp_servers: { squire: unknown };
    };
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.approval_policy).toBe("untrusted");
    expect(parsed.mcp_servers.squire).toBeDefined();
  });
});
