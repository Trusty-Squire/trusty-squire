# mcp

Local MCP server vibe coding agents (Claude Code, Cursor, Goose, Cline, Continue) install. Thin relay translating MCP tool calls into HTTP calls against the Trusty Squire API.

## Install

```bash
npx @trusty-squire/mcp install
# or specify a target explicitly:
npx @trusty-squire/mcp install --target=claude-code
```

The CLI:
1. Detects installed coding agents (when `--target` is omitted).
2. Generates a one-time pairing token via `POST /v1/mcp/pair/initiate`.
3. Opens your browser to `https://app.trustysquire.ai/pair?token=…`.
4. Polls the API. Once you complete the browser flow with a passkey, the CLI receives the agent session token.
5. Saves the session to your OS keychain (or a `0600` file fallback when keytar isn't available).
6. Writes the MCP server config into the target agent's config file. Existing entries are preserved.

After install, restart your coding agent to pick up the eight squire tools.

## Tools

| Tool | Purpose |
|---|---|
| `provision` | Sign up for a SaaS service on the user's behalf, returning working credentials |
| `wait_for_approval` | Poll a run until it leaves PENDING_APPROVAL or times out |
| `get_credential` | Retrieve a vault-stored credential (audit-logged) |
| `list_services` | Browse the adapter directory by category or query |
| `list_subscriptions` | List the user's active subscriptions |
| `cancel` | Cancel a subscription (v0 stub — flow selector lands later) |
| `get_usage` | Report monthly + daily spending vs the user's mandate budget |
| `rotate_credential` | Rotate a credential (v0 stub — same reason as cancel) |

Every tool's description is hand-tuned to drive agent behavior — the assistant reads them and decides when to call, so the wording matters more than the JSON schema.

## Logout

```bash
npx @trusty-squire/mcp logout
```

Clears the local session. The browser-side AgentSession row remains revocable via the PWA's settings page.

## Agent config locations

| Agent | File |
|---|---|
| Claude Code | `~/.claude/mcp.json` |
| Cursor | `~/.cursor/mcp.json` (or `.cursor/mcp.json` for project-scoped) |
| Goose | `$XDG_CONFIG_HOME/goose/profiles.yaml` (default `~/.config/goose/profiles.yaml`) |
| Cline | `~/.cline/mcp_config.json` |
| Continue | `~/.continue/config.yaml` |

Each writer is idempotent: rerunning `install` won't duplicate entries.

## Session storage

By default the CLI saves the session to the OS keychain via [keytar](https://github.com/atom/node-keytar). When keytar isn't available — minimal Linux containers without `libsecret-1-dev`, CI machines — the CLI silently falls back to a file at `$XDG_CONFIG_HOME/trusty-squire/session.json` (default `~/.config/trusty-squire/session.json`), permissions `0600`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `TRUSTY_SQUIRE_API_BASE` | `https://api.trustysquire.ai` | API gateway URL |
| `ADAPTER_REGISTRY_URL` | `https://registry.trustysquire.ai` | Adapter registry (read by `list_services`) |
| `TRUSTY_SQUIRE_AGENT_IDENTITY` | `unknown` | Self-reported agent identity in audit headers |

For local dev against your own API at `localhost:3000`:

```bash
TRUSTY_SQUIRE_API_BASE=http://localhost:3000 \
ADAPTER_REGISTRY_URL=http://localhost:3001 \
npx @trusty-squire/mcp install --target=claude-code --api-base=http://localhost:3000
```

## What this server does NOT do

- Fork the coding agent. We write configs only.
- Implement OAuth. One-time pairing is the entire flow.
- Bundle the API runtime. Separate apps for separate processes.
- Implement tier-2 fallbacks. The API drives execution.
