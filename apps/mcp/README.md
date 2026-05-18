# mcp

Local MCP server vibe coding agents (Claude Code, Cursor, Goose, Cline, Continue) install. Thin relay translating MCP tool calls into HTTP calls against the Trusty Squire API.

## Install

```bash
npx @trusty-squire/mcp install
# or specify a target explicitly:
npx @trusty-squire/mcp install --target=claude-code
```

Best run on a laptop or desktop. `install`:
1. Detects your coding agent (when `--target` is omitted) and writes its MCP
   config. Existing entries are preserved.
2. Issues an anonymous machine token — a handful of free signups, no account.
3. Connects your Google (or GitHub) account: a Chrome window opens, you sign
   in once. The bot reuses that browser session to sign you up for services,
   so there is no separate Trusty Squire account or password.

On a headless box (Codespaces, Replit, an SSH server) there is no display, so
step 3 prints a one-time remote-login URL you open from any browser — including
a phone. Headless is supported, but a laptop/desktop is the smoother path.

Flags:
- `--provider=google|github|both` — which identity to connect (default: prompt
  on a terminal, otherwise Google).
- `--skip-login` — write the config + token only; run
  `npx @trusty-squire/mcp login` later. For CI / scripted installs.

Re-run the sign-in any time with `npx @trusty-squire/mcp login`.

After install, restart your coding agent to pick up the squire tools.

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
- Store your Google/GitHub password. You enter it only on the provider's own
  sign-in page; the bot reuses the resulting browser session, never the
  password.
- Bundle the API runtime. Separate apps for separate processes.
- Charge you, in this MVP. Provisioning is free-tier services only; the
  spending-mandate flow lands with paid provisioning.
