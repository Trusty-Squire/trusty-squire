<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://raw.githubusercontent.com/Trusty-Squire/trusty-squire/main/apps/web/public/logo-400.png" alt="Trusty Squire shield" />
  </a>
</p>

<h1 align="center">Trusty Squire</h1>

<p align="center"><strong>Empower agents with auth and payments.</strong></p>

## What you can do

Ask your coding agent to:

- **Get an API key.** "Sign me up for Pinecone and get an API key." It signs up, verifies the email, and stores the key in your vault instead of the chat.
- **Sign in anywhere.** It uses your Google or GitHub account on any site that offers it.
- **Buy things.** "Order one Glow Serum from whitejade.xyz." You approve once, and Trusty Squire fills the card fields in its browser.
- **Call APIs with stored keys.** The agent uses a saved key without ever seeing it.

## Install

```bash
npx -y @trusty-squire/mcp@latest connect
```

Sign in with Google or GitHub, and Trusty Squire adds itself to your coding agent. Restart the agent and ask for what you need. Add `--target=codex` (or another agent) to pick the agent yourself.

Works with Claude Code, Codex, Cursor, OpenCode, Goose, Cline, Continue, and Hermes.

Full setup, CLI options, and tools: [docs/reference.md](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/reference.md). To build approvals into your own app, use [`@trusty-squire/sdk`](https://www.npmjs.com/package/@trusty-squire/sdk).
