// Agent registry: each entry knows where its MCP config file lives,
// how to merge a `squire` server entry into the existing config, and
// how to detect whether the user has the agent installed.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// Tests override $HOME to isolate the file system. Node's os.homedir()
// reads from getpwuid_r and ignores $HOME, so we honor HOME first
// (matching the convention every shell uses).
function home(): string {
  return process.env.HOME ?? os.homedir();
}

export type AgentTarget =
  | "claude-code"
  | "cursor"
  | "goose"
  | "cline"
  | "continue";

export interface AgentDefinition {
  target: AgentTarget;
  display_name: string;
  config_path: () => string;
  // Heuristic: is this agent installed on the user's machine? Used
  // when --target isn't supplied so the CLI can prompt with the
  // detected options first.
  detect: () => Promise<boolean>;
  // Idempotent: read current config (if any), merge the squire
  // server entry, write back. Preserves user-customised entries.
  writeConfig: (input: WriteConfigInput) => Promise<void>;
}

export interface WriteConfigInput {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const SERVER_KEY = "squire";

// ── Helpers shared across JSON-format agents ─────────────────

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw err;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Atomic write: ~/.claude.json holds the user's entire Claude Code
  // state, so a torn write would be catastrophic. Write a temp file on
  // the same filesystem, then rename (atomic) over the target.
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

// Merge a `squire` entry into the standard mcpServers map without
// clobbering other entries the user has added.
async function mergeMcpServersJson(filePath: string, input: WriteConfigInput): Promise<void> {
  const existing = await readJsonIfExists(filePath);
  const servers =
    existing.mcpServers !== undefined && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  servers[SERVER_KEY] = {
    command: input.command,
    args: input.args,
    env: input.env,
  };
  existing.mcpServers = servers;
  await writeJson(filePath, existing);
}

// ── claude-code ──────────────────────────────────────────────

const claudeCode: AgentDefinition = {
  target: "claude-code",
  display_name: "Claude Code",
  config_path: () => path.join(home(), ".claude.json"),
  detect: async () => exists(path.join(home(), ".claude")),
  writeConfig: async (input) => mergeMcpServersJson(claudeCode.config_path(), input),
};

// ── cursor ──────────────────────────────────────────────────

const cursor: AgentDefinition = {
  target: "cursor",
  display_name: "Cursor",
  config_path: () => path.join(home(), ".cursor", "mcp.json"),
  detect: async () => exists(path.join(home(), ".cursor")),
  writeConfig: async (input) => mergeMcpServersJson(cursor.config_path(), input),
};

// ── goose ───────────────────────────────────────────────────
//
// goose uses YAML with an `extensions` key. Spec listed `profiles.yaml`
// but recent goose versions use `~/.config/goose/profiles.yaml`. We
// merge into the same key shape (`extensions.squire`) so existing
// custom extensions are preserved.

const goose: AgentDefinition = {
  target: "goose",
  display_name: "Goose",
  config_path: () =>
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(home(), ".config"),
      "goose",
      "profiles.yaml",
    ),
  detect: async () => exists(goose.config_path()),
  writeConfig: async (input) => {
    const filePath = goose.config_path();
    let data: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = yamlParse(raw);
      if (parsed !== null && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const extensions =
      data.extensions !== undefined && typeof data.extensions === "object"
        ? (data.extensions as Record<string, unknown>)
        : {};
    extensions[SERVER_KEY] = {
      type: "stdio",
      cmd: input.command,
      args: input.args,
      envs: input.env,
    };
    data.extensions = extensions;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, yamlStringify(data), { mode: 0o600 });
  },
};

// ── cline ───────────────────────────────────────────────────

const cline: AgentDefinition = {
  target: "cline",
  display_name: "Cline",
  config_path: () => path.join(home(), ".cline", "mcp_config.json"),
  detect: async () => exists(path.join(home(), ".cline")),
  writeConfig: async (input) => mergeMcpServersJson(cline.config_path(), input),
};

// ── continue ────────────────────────────────────────────────

const continueAgent: AgentDefinition = {
  target: "continue",
  display_name: "Continue",
  config_path: () => path.join(home(), ".continue", "config.yaml"),
  detect: async () => exists(path.join(home(), ".continue")),
  writeConfig: async (input) => {
    const filePath = continueAgent.config_path();
    let data: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = yamlParse(raw);
      if (parsed !== null && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const mcpServers =
      data.mcpServers !== undefined && Array.isArray(data.mcpServers)
        ? (data.mcpServers as Array<Record<string, unknown>>)
        : [];
    const filtered = mcpServers.filter((s) => s.name !== SERVER_KEY);
    filtered.push({
      name: SERVER_KEY,
      command: input.command,
      args: input.args,
      env: input.env,
    });
    data.mcpServers = filtered;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, yamlStringify(data), { mode: 0o600 });
  },
};

export const AGENTS: Record<AgentTarget, AgentDefinition> = {
  "claude-code": claudeCode,
  cursor,
  goose,
  cline,
  continue: continueAgent,
};

export async function detectInstalledAgents(): Promise<AgentDefinition[]> {
  const out: AgentDefinition[] = [];
  for (const agent of Object.values(AGENTS)) {
    if (await agent.detect()) out.push(agent);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
