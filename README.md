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
npx @trusty-squire/mcp connect
```

Sign in with Google or GitHub, and Trusty Squire adds itself to your coding agent. Restart the agent and ask for what you need.

To pick the agent yourself:

```bash
npx @trusty-squire/mcp connect --target=codex
```

Works with Claude Code, Codex, Cursor, OpenCode, Goose, Cline, Continue, and Hermes.
