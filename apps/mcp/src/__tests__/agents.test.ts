// Agent config-writer tests. Each writer reads the existing config,
// merges in a `squire` entry, writes back — and is idempotent.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as jsoncParse } from "jsonc-parser";
import { parse as yamlParse } from "yaml";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { AGENTS } from "../install/agents.js";

let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let originalOpenCodeConfig: string | undefined;
let originalPath: string | undefined;
let tmpHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
  originalPath = process.env.PATH;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-test-"));
  process.env.HOME = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG;
});

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  if (originalXdgConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  if (originalOpenCodeConfig !== undefined) {
    process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  } else {
    delete process.env.OPENCODE_CONFIG;
  }
  if (originalPath !== undefined) process.env.PATH = originalPath;
  else delete process.env.PATH;
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

  // Regression: shared mergeMcpServersJson (claude-code/cursor/cline)
  // was assigning env wholesale. A re-install that omitted a flag
  // wiped the previously-set value.
  it("merges prior env across re-installs instead of clobbering", async () => {
    await AGENTS["claude-code"].writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "claude-code",
        UNIVERSAL_BOT_PROXY_URL: "socks5://127.0.0.1:1080",
      },
    });
    await AGENTS["claude-code"].writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "claude-code" },
    });
    const raw = await fs.readFile(AGENTS["claude-code"].config_path(), "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: { squire: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.squire.env.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://127.0.0.1:1080");
    expect(parsed.mcpServers.squire.env.TRUSTY_SQUIRE_AGENT_IDENTITY).toBe("claude-code");
  });

  // Regression: the merge keeps prior keys, so a REMOVED flag would linger in a
  // user's config forever. Dead keys (UNIVERSAL_BOT_PREFER_CHEAP, retired with
  // the in-process planner) must be pruned on the next connect.
  it("prunes dead env keys left by an older connect", async () => {
    // Seed a config with the stale flag, as an old connect would have written it.
    await fs.writeFile(
      AGENTS["claude-code"].config_path(),
      JSON.stringify({
        mcpServers: {
          squire: {
            command: "npx",
            args: ["-y", "@trusty-squire/mcp"],
            env: {
              UNIVERSAL_BOT_PREFER_CHEAP: "true",
              TRUSTY_SQUIRE_AGENT_IDENTITY: "claude-code",
            },
          },
        },
      }),
      "utf8",
    );
    await AGENTS["claude-code"].writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "claude-code" },
    });
    const parsed = JSON.parse(await fs.readFile(AGENTS["claude-code"].config_path(), "utf8")) as {
      mcpServers: { squire: { env: Record<string, string> } };
    };
    expect("UNIVERSAL_BOT_PREFER_CHEAP" in parsed.mcpServers.squire.env).toBe(false);
    expect(parsed.mcpServers.squire.env.TRUSTY_SQUIRE_AGENT_IDENTITY).toBe("claude-code");
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
          description: string;
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
    expect(parsed.extensions.squire.description).toBe(
      "Trusty Squire signs up / in to websites for you so you don’t have to.",
    );
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

  it("removes legacy Trusty Squire goose aliases that point at old packages", async () => {
    const { stringify: yamlStringify } = await import("yaml");
    const filePath = AGENTS.goose.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      yamlStringify({
        extensions: {
          trustysquire: {
            enabled: true,
            type: "stdio",
            name: "trustysquire",
            cmd: "npx",
            args: ["-y", "@trusty-squire/mcp@0.4.1", "server"],
            envs: {
              TRUSTY_SQUIRE_AGENT_IDENTITY: "goose",
              UNIVERSAL_BOT_PROXY_URL: "socks5://127.0.0.1:1080",
            },
          },
          custom: { cmd: "echo", args: ["hi"] },
        },
      }),
    );

    await AGENTS.goose.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp@0.9.19-rc.12", "server"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "goose",
        TRUSTY_SQUIRE_REGISTRY_URL: "https://registry.trustysquire.ai",
      },
    });

    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yamlParse(raw) as {
      extensions: {
        trustysquire?: unknown;
        custom?: unknown;
        squire: { args: string[]; envs: Record<string, string> };
      };
    };
    expect(parsed.extensions.trustysquire).toBeUndefined();
    expect(parsed.extensions.custom).toBeDefined();
    expect(parsed.extensions.squire.args).toEqual([
      "-y",
      "@trusty-squire/mcp@0.9.19-rc.12",
      "server",
    ]);
    expect(parsed.extensions.squire.envs.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://127.0.0.1:1080");
    expect(parsed.extensions.squire.envs.TRUSTY_SQUIRE_REGISTRY_URL).toBe(
      "https://registry.trustysquire.ai",
    );
  });

  // Regression: pre-rc.21 writeConfig replaced the entire envs block on
  // every install. A re-install that omitted --proxy-url= wiped the
  // previously-set value. Merge contract: present key in input.env
  // wins; absent key preserves prior value.
  it("merges prior envs across re-installs instead of clobbering", async () => {
    // Seed: install with a proxy URL set.
    await AGENTS.goose.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: {
        TRUSTY_SQUIRE_AGENT_IDENTITY: "goose",
        UNIVERSAL_BOT_PROXY_URL: "socks5://127.0.0.1:1080",
      },
    });
    // Re-install: --proxy-url not passed this run, so input.env omits it.
    await AGENTS.goose.writeConfig({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp"],
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "goose" },
    });
    const raw = await fs.readFile(AGENTS.goose.config_path(), "utf8");
    const parsed = yamlParse(raw) as {
      extensions: { squire: { envs: Record<string, string> } };
    };
    expect(parsed.extensions.squire.envs.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://127.0.0.1:1080");
    expect(parsed.extensions.squire.envs.TRUSTY_SQUIRE_AGENT_IDENTITY).toBe("goose");
  });
});

describe("hermes YAML writer", () => {
  it("creates an mcp_servers.squire stdio entry Hermes will load", async () => {
    await AGENTS.hermes.writeConfig({
      command: "node",
      args: ["/abs/dist/bin.js", "server"],
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes" },
    });
    expect(AGENTS.hermes.config_path().endsWith("/.hermes/config.yaml")).toBe(true);
    const raw = await fs.readFile(AGENTS.hermes.config_path(), "utf8");
    const parsed = yamlParse(raw) as {
      mcp_servers: {
        squire: { command: string; args: string[]; env: unknown; enabled: boolean };
      };
    };
    // Hermes uses command/args/env (NOT goose's cmd/envs) in a keyed map.
    expect(parsed.mcp_servers.squire.command).toBe("node");
    expect(parsed.mcp_servers.squire.args).toEqual(["/abs/dist/bin.js", "server"]);
    expect(parsed.mcp_servers.squire.env).toEqual({ TRUSTY_SQUIRE_AGENT_IDENTITY: "hermes" });
    expect(parsed.mcp_servers.squire.enabled).toBe(true);
  });

  it("preserves other mcp_servers and merges prior env on re-install", async () => {
    const { stringify: yamlStringify } = await import("yaml");
    const filePath = AGENTS.hermes.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      yamlStringify({
        mcp_servers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
          squire: {
            command: "node",
            args: ["old", "server"],
            env: { UNIVERSAL_BOT_PROXY_URL: "socks5://127.0.0.1:1080" },
          },
        },
      }),
    );
    // A re-install that omits --proxy-url must not wipe the prior value.
    await AGENTS.hermes.writeConfig({ command: "node", args: ["new", "server"], env: {} });
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yamlParse(raw) as {
      mcp_servers: { filesystem: unknown; squire: { args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcp_servers.filesystem).toBeDefined();
    expect(parsed.mcp_servers.squire.args).toEqual(["new", "server"]);
    expect(parsed.mcp_servers.squire.env.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://127.0.0.1:1080");
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
    expect(parsed.mcp_servers.squire.args).toEqual(["-y", "@trusty-squire/mcp", "server"]);
    expect(parsed.mcp_servers.squire.env).toEqual({ TS_LOG: "info" });
  });

  it("preserves the user's other config.toml entries", async () => {
    const filePath = AGENTS.codex.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, tomlStringify({ model: "gpt-5", approval_policy: "untrusted" }));
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

describe("opencode JSONC writer", () => {
  const input = {
    command: "npx",
    args: ["-y", "@trusty-squire/mcp", "server"],
    env: {
      TRUSTY_SQUIRE_AGENT_IDENTITY: "opencode",
      TRUSTY_SQUIRE_REGISTRY_URL: "https://registry.trustysquire.ai",
    },
  };

  it("creates the documented local MCP shape", async () => {
    await AGENTS.opencode.writeConfig(input);

    expect(AGENTS.opencode.config_path()).toBe(
      path.join(tmpHome, ".config", "opencode", "opencode.json"),
    );
    const parsed = jsoncParse(await fs.readFile(AGENTS.opencode.config_path(), "utf8")) as {
      $schema: string;
      mcp: {
        squire: {
          type: string;
          command: string[];
          environment: Record<string, string>;
          enabled: boolean;
          timeout: number;
          args?: unknown;
          env?: unknown;
        };
      };
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.mcp.squire).toEqual({
      type: "local",
      command: ["npx", "-y", "@trusty-squire/mcp", "server"],
      environment: input.env,
      enabled: true,
      timeout: 30_000,
    });
    expect(parsed.mcp.squire.args).toBeUndefined();
    expect(parsed.mcp.squire.env).toBeUndefined();
  });

  it("preserves JSONC comments, trailing commas, settings, and other MCP servers", async () => {
    const filePath = path.join(tmpHome, ".config", "opencode", "opencode.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `{
  // keep this model choice
  "model": "anthropic/claude-sonnet-4-5",
  "permission": { "bash": "ask", },
  "mcp": {
    // user's existing server
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp", },
  },
}
`,
    );

    expect(AGENTS.opencode.config_path()).toBe(filePath);
    await AGENTS.opencode.writeConfig(input);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = jsoncParse(raw) as {
      model: string;
      permission: { bash: string };
      mcp: { context7: unknown; squire: unknown };
    };
    expect(raw).toContain("// keep this model choice");
    expect(raw).toContain("// user's existing server");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    expect(parsed.permission.bash).toBe("ask");
    expect(parsed.mcp.context7).toBeDefined();
    expect(parsed.mcp.squire).toBeDefined();
  });

  it("repairs a non-object mcp value without losing other settings", async () => {
    const filePath = AGENTS.opencode.config_path();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ model: "openai/gpt-5", mcp: false }));

    await AGENTS.opencode.writeConfig(input);
    const parsed = jsoncParse(await fs.readFile(filePath, "utf8")) as {
      model: string;
      mcp: { squire: unknown };
    };
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed.mcp.squire).toBeDefined();
  });

  it("preserves prior environment, prunes dead keys, and removes legacy aliases", async () => {
    const filePath = path.join(tmpHome, ".config", "opencode", "opencode.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        mcp: {
          trustysquire: {
            type: "local",
            command: ["npx", "old-package", "server"],
            environment: { UNIVERSAL_BOT_PROXY_URL: "socks5://127.0.0.1:1080" },
          },
          squire: {
            type: "local",
            command: ["npx", "older-package", "server"],
            environment: {
              UNIVERSAL_BOT_PREFER_CHEAP: "true",
              TRUSTY_SQUIRE_AGENT_IDENTITY: "old-host",
            },
          },
        },
      }),
    );

    await AGENTS.opencode.writeConfig(input);
    const parsed = jsoncParse(await fs.readFile(filePath, "utf8")) as {
      mcp: {
        trustysquire?: unknown;
        squire: { environment: Record<string, string> };
      };
    };
    expect(parsed.mcp.trustysquire).toBeUndefined();
    expect(parsed.mcp.squire.environment.UNIVERSAL_BOT_PROXY_URL).toBe("socks5://127.0.0.1:1080");
    expect(parsed.mcp.squire.environment.TRUSTY_SQUIRE_AGENT_IDENTITY).toBe("opencode");
    expect(parsed.mcp.squire.environment.UNIVERSAL_BOT_PREFER_CHEAP).toBeUndefined();
  });

  it("removes registry routing when a reconnect opts out", async () => {
    await AGENTS.opencode.writeConfig(input);
    await AGENTS.opencode.writeConfig({
      ...input,
      env: { TRUSTY_SQUIRE_AGENT_IDENTITY: "opencode" },
    });
    const parsed = jsoncParse(await fs.readFile(AGENTS.opencode.config_path(), "utf8")) as {
      mcp: { squire: { environment: Record<string, string> } };
    };
    expect(parsed.mcp.squire.environment.TRUSTY_SQUIRE_REGISTRY_URL).toBeUndefined();
  });

  it("updates a symlink target without replacing the link", async () => {
    const managedPath = path.join(tmpHome, "dotfiles", "opencode.jsonc");
    const linkedPath = path.join(tmpHome, ".config", "opencode", "opencode.jsonc");
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    await fs.mkdir(path.dirname(linkedPath), { recursive: true });
    await fs.writeFile(managedPath, '{\n  "model": "openai/gpt-5",\n}\n');
    await fs.symlink(managedPath, linkedPath);

    await AGENTS.opencode.writeConfig(input);

    expect((await fs.lstat(linkedPath)).isSymbolicLink()).toBe(true);
    const parsed = jsoncParse(await fs.readFile(managedPath, "utf8")) as {
      model: string;
      mcp: { squire: unknown };
    };
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed.mcp.squire).toBeDefined();
  });

  it("is byte-idempotent", async () => {
    await AGENTS.opencode.writeConfig(input);
    const first = await fs.readFile(AGENTS.opencode.config_path(), "utf8");
    await AGENTS.opencode.writeConfig(input);
    const second = await fs.readFile(AGENTS.opencode.config_path(), "utf8");
    expect(second).toBe(first);
  });

  it("honors XDG_CONFIG_HOME", async () => {
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, "xdg");
    await AGENTS.opencode.writeConfig(input);
    expect(AGENTS.opencode.config_path()).toBe(
      path.join(tmpHome, "xdg", "opencode", "opencode.json"),
    );
    await expect(fs.access(AGENTS.opencode.config_path())).resolves.toBeUndefined();
  });

  it("honors OPENCODE_CONFIG, including a home-relative path", async () => {
    process.env.OPENCODE_CONFIG = "~/.custom/opencode.jsonc";
    await AGENTS.opencode.writeConfig(input);
    expect(AGENTS.opencode.config_path()).toBe(path.join(tmpHome, ".custom", "opencode.jsonc"));
    await expect(fs.access(AGENTS.opencode.config_path())).resolves.toBeUndefined();
  });

  it("detects an OpenCode executable on PATH without running it", async () => {
    const binDir = path.join(tmpHome, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "opencode"), "must not execute", { mode: 0o755 });
    process.env.PATH = binDir;
    expect(await AGENTS.opencode.detect()).toBe(true);
  });
});
