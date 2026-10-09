<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire shield" />
  </a>
</p>

<h1 align="center">Trusty Squire</h1>

<p align="center"><strong>Empower agents with auth and payments.</strong></p>

## What you can do

Ask your coding agent to:

- **Get an API key.** "Sign me up for Pinecone and get an API key." It signs up, verifies the email, creates the key, and stores it in your vault instead of the chat.
- **Sign in anywhere.** It uses your Google or GitHub account on any site that offers it.
- **Buy things.** "Order one Glow Serum from whitejade.xyz." You approve the purchase once, and your card number never reaches the agent.
- **Call APIs with stored keys.** The agent uses a saved key without ever seeing it.
- **Finish setup.** OAuth apps, dashboards, and verification steps, end to end.

## Install

```bash
npx -y @trusty-squire/mcp@latest connect
```

Sign in with Google or GitHub, and Trusty Squire adds itself to your coding agent. Restart the agent and ask for what you need.

To pick the agent yourself:

```bash
npx -y @trusty-squire/mcp@latest connect --target=codex
```

On Linux, connect registers and starts a systemd user service; on macOS, a launchd user agent. A working user service manager is required. MCP clients connect to that broker and report "broker not running" after bounded retries if it is stopped. Installer-written client entries use `@trusty-squire/mcp@latest`.

Works with Claude Code, Codex, Cursor, OpenCode, Goose, Cline, Continue, and Hermes.

### CLI commands and options

| Command or option | Purpose |
| --- | --- |
| `connect` | Set up this machine; the default when no command is given. |
| `settings` | Edit registry and email verification choices. |
| `logout [--account=<id>]` | Clear one local account session. |
| `help`, `--help`, `-h` | Show CLI help. |
| `--target <agent>` | Choose a coding agent for `connect` or `settings` instead of detecting one. |
| `--account <id>` | Select the local account session to clear with `logout`. |
| `--force-relogin[=google\|github]` | Reopen sign-in for the account or one provider. |
| `--skip-browser` | Hand off the sign-in URL to a separate browser for scripted setup. |
| `--json` | Stream machine-readable connect reports and skip setup prompts. |

Value options accept both `--flag value` and `--flag=value`. Unknown options, missing values, and invalid values exit with a usage error. Set `TRUSTY_SQUIRE_API_BASE` to use a development API; use `settings` to change managed registry participation. Run `npx -y @trusty-squire/mcp@latest --help` for the full command reference. The interactive setup also offers an optional 2Captcha key, stored in your vault.
