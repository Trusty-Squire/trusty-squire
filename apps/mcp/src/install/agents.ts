// Agent registry: each entry knows where its MCP config file lives,
// how to merge a `squire` server entry into the existing config, and
// how to detect whether the user has the agent installed.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { stringify as tomlStringify, parse as tomlParse } from "smol-toml";

// Tests override $HOME to isolate the file system. Node's os.homedir()
// reads from getpwuid_r and ignores $HOME, so we honor HOME first
// (matching the convention every shell uses).
function home(): string {
  return process.env.HOME ?? os.homedir();
}

// VS Code's globalStorage root, OS-specific. Cline (the
// saoudrizwan.claude-dev extension) stores its MCP settings under
// <here>/saoudrizwan.claude-dev/settings/cline_mcp_settings.json. Covers
// vanilla "Code" only — Code-Insiders / VSCodium use sibling dirs and
// would need their own targets if we ever cared about them.
function vscodeGlobalStorage(): string {
  const h = home();
  if (process.platform === "darwin") {
    return path.join(h, "Library", "Application Support", "Code", "User", "globalStorage");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(h, "AppData", "Roaming"),
      "Code",
      "User",
      "globalStorage",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(h, ".config"),
    "Code",
    "User",
    "globalStorage",
  );
}

export type AgentTarget =
  | "claude-code"
  | "cursor"
  | "codex"
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
// Read the env block off a previously-written server entry, if any.
// Used so a re-install that omits a flag (e.g. forgets --proxy-url=)
// preserves the prior value instead of clobbering it. The install CLI
// conditionally puts env keys into input.env when their flag is
// present — so the merge contract is: present-flag wins, absent-flag
// preserves prior. Env-key field names differ across agents ("env"
// vs "envs"); caller passes the right one.
function priorServerEnv(
  existing: unknown,
  field: "env" | "envs",
): Record<string, string> {
  if (existing === undefined || existing === null || typeof existing !== "object") {
    return {};
  }
  const prior = (existing as Record<string, unknown>)[field];
  if (prior === undefined || prior === null || typeof prior !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(prior as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function mergeMcpServersJson(filePath: string, input: WriteConfigInput): Promise<void> {
  const existing = await readJsonIfExists(filePath);
  const servers =
    existing.mcpServers !== undefined && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const priorEnv = priorServerEnv(servers[SERVER_KEY], "env");
  servers[SERVER_KEY] = {
    command: input.command,
    args: input.args,
    env: { ...priorEnv, ...input.env },
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
// Modern goose (the Rust CLI + Desktop) reads ~/.config/goose/
// config.yaml with an `extensions` map. (`profiles.yaml` was the old
// pre-1.0 Python goose — writing there leaves the extension invisible
// and makes detect() miss an installed goose.) We merge into
// `extensions.squire`, preserving the user's other extensions, and
// write the full entry shape goose expects — `enabled` and `name`
// included, or goose treats the extension as absent.

const goose: AgentDefinition = {
  target: "goose",
  display_name: "Goose",
  config_path: () =>
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(home(), ".config"),
      "goose",
      "config.yaml",
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
    // Merge env on top of any previously-set vars rather than replacing
    // wholesale. Same regression class as the JSON-mcp-servers path —
    // see priorServerEnv() comment.
    const priorEnvs = priorServerEnv(extensions[SERVER_KEY], "envs");
    extensions[SERVER_KEY] = {
      type: "stdio",
      name: SERVER_KEY,
      cmd: input.command,
      args: input.args,
      envs: { ...priorEnvs, ...input.env },
      // goose treats a missing `enabled` as not-loaded and surfaces the
      // extension by `name` — both are required for it to appear.
      enabled: true,
      bundled: false,
      description: "Trusty Squire — credential broker + universal signup bot",
      timeout: 300,
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
  // Cline is a VS Code extension (saoudrizwan.claude-dev) — its MCP
  // settings live in the extension's globalStorage, not the
  // ~/.cline/mcp_config.json the installer once wrote (which Cline
  // never reads). Same bug class as the pre-0.4.2 goose path.
  config_path: () =>
    path.join(
      vscodeGlobalStorage(),
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    ),
  detect: async () =>
    exists(path.join(vscodeGlobalStorage(), "saoudrizwan.claude-dev")),
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
    // Merge env from any prior entry — same env-clobber regression
    // class as the JSON-mcp-servers path; see priorServerEnv().
    const priorEntry = mcpServers.find((s) => s.name === SERVER_KEY);
    const priorEnv = priorServerEnv(priorEntry, "env");
    const filtered = mcpServers.filter((s) => s.name !== SERVER_KEY);
    filtered.push({
      name: SERVER_KEY,
      command: input.command,
      args: input.args,
      env: { ...priorEnv, ...input.env },
    });
    data.mcpServers = filtered;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, yamlStringify(data), { mode: 0o600 });
  },
};

// ── codex ───────────────────────────────────────────────────
//
// Codex CLI reads ~/.codex/config.toml — TOML, not JSON. MCP servers
// live under `[mcp_servers.<name>]` tables. We parse + merge + write
// back via smol-toml so the user's other config.toml entries (model,
// approval policy, sandbox mode, etc.) survive untouched.

const codex: AgentDefinition = {
  target: "codex",
  display_name: "Codex CLI",
  config_path: () => path.join(home(), ".codex", "config.toml"),
  detect: async () => exists(path.join(home(), ".codex")),
  writeConfig: async (input) => {
    const filePath = codex.config_path();
    let data: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = tomlParse(raw);
      if (parsed !== null && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const servers =
      data.mcp_servers !== undefined && typeof data.mcp_servers === "object"
        ? (data.mcp_servers as Record<string, unknown>)
        : {};
    // Merge env — see priorServerEnv() comment.
    const priorEnv = priorServerEnv(servers[SERVER_KEY], "env");
    servers[SERVER_KEY] = {
      command: input.command,
      args: input.args,
      env: { ...priorEnv, ...input.env },
    };
    data.mcp_servers = servers;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, tomlStringify(data), { mode: 0o600 });
  },
};

export const AGENTS: Record<AgentTarget, AgentDefinition> = {
  "claude-code": claudeCode,
  cursor,
  codex,
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
