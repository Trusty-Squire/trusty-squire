# Build prompt: first-class OpenCode support

Implement first-class OpenCode support in the Trusty Squire repository.

## Goal

A user should be able to run:

```bash
npx @trusty-squire/mcp connect --target=opencode
```

Trusty Squire should detect OpenCode, safely add itself as a local MCP server, preserve the user's existing configuration, and work in a real OpenCode session.

## Important facts

- OpenCode already supports local MCP servers over stdio.
- Trusty Squire's existing MCP runtime is compatible; do not build a new transport or OpenCode plugin.
- Official OpenCode MCP documentation: <https://opencode.ai/docs/mcp-servers/>
- OpenCode's global config is normally `~/.config/opencode/opencode.json`.
- OpenCode also supports JSONC, and real installations may use `~/.config/opencode/opencode.jsonc`.
- OpenCode may use `OPENCODE_CONFIG` for a custom config file and `XDG_CONFIG_HOME` for its configuration root. Respect both.
- Preserve existing configuration and comments. Do not parse JSONC with `JSON.parse` and rewrite it as plain JSON.
- Trusty Squire's backend already accepts arbitrary agent identities up to 60 characters. No API or database change should be necessary.
- Preserve all unrelated local changes.

## Required implementation

### 1. Installer target

Add `opencode` to the existing `AgentTarget` union, agent registry, interactive picker, CLI validation, detection, and supported-target output.

Detection should recognize a normal OpenCode installation without executing untrusted project configuration. Account for the executable on `PATH`, `XDG_CONFIG_HOME`, and `OPENCODE_CONFIG` where appropriate.

### 2. Configuration writer

Create an idempotent, JSONC-safe writer for OpenCode.

It must merge this conceptual structure without replacing unrelated settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "squire": {
      "type": "local",
      "command": ["<launch command>", "<launch arg>", "..."],
      "environment": {
        "TRUSTY_SQUIRE_AGENT_IDENTITY": "opencode",
        "TRUSTY_SQUIRE_REGISTRY_URL": "https://registry.trustysquire.ai"
      },
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

Use the command and arguments returned by Trusty Squire's existing `resolveServerLaunch()` logic. OpenCode requires one `command` array, unlike hosts that use separate `command` and `args` fields.

Requirements:

- Honor `OPENCODE_CONFIG` when supplied.
- Otherwise use the appropriate config root, including `XDG_CONFIG_HOME`.
- Prefer an existing `opencode.jsonc` or `opencode.json` appropriately.
- Preserve comments, formatting where practical, unrelated MCP servers, providers, models, permissions, and plugins.
- Preserve supported existing Squire environment values, applying the same dead-environment-key cleanup used by other targets.
- Running `connect` twice must not duplicate or corrupt anything.
- Use atomic file writes.
- Set `timeout: 30000` because npx cold starts can exceed OpenCode's default.
- Never place account tokens or credentials in the config.

### 3. Automated tests

Add tests covering:

- Target detection.
- A new empty configuration.
- Existing JSON configuration.
- Existing JSONC containing comments and trailing commas.
- Preservation of unrelated settings and MCP servers.
- Replacement or refresh of an existing `mcp.squire` entry.
- Preservation of supported Squire environment values.
- Dead environment-variable cleanup.
- Idempotency.
- `XDG_CONFIG_HOME` behavior.
- `OPENCODE_CONFIG` behavior.
- `--target=opencode` through the installer E2E suite.
- Registry-disabled behavior.
- Exact OpenCode property names: `mcp`, a combined `command` array, and `environment`—not `mcpServers`, `args`, or `env`.

### 4. Real compatibility smoke test

Use the installed OpenCode client if available.

At minimum, demonstrate that OpenCode reports the Trusty Squire MCP server as connected and can enumerate its tools. Do not modify the developer's real global OpenCode config; use a temporary home/config or inline/custom configuration.

Then test one representative tool call if it can be done without mutating external accounts. Clearly distinguish "MCP connected" from a complete website-provisioning test.

OpenCode automatically exposes MCP tools and Trusty Squire has roughly 22 tools. Check whether the tool inventory loads without errors or unreasonable context overhead. Record any concern instead of hiding it.

### 5. Documentation and discovery

Update:

- The root README.
- npm/package metadata where supported agents or keywords are listed.
- The website start/install page.
- The integrations hub.
- `llms.txt` and other LLM-facing content where host lists are maintained.
- Sitemap generation and tests.
- Any canonical supported-target documentation.

Add `/integrations/opencode`, following the existing Claude Code, Codex, and Cursor page conventions exactly.

The page should include:

- A title and metadata targeting "OpenCode MCP server" and "OpenCode signup automation."
- The one-command installation: `npx @trusty-squire/mcp connect --target=opencode`.
- The exact prompt: "Use Trusty Squire to sign up for Resend and wire the API key into my app."
- A factual explanation that OpenCode remains the planner while Trusty Squire operates the website and stores generated credentials in its encrypted, write-only vault.
- The honest limits: phone verification, hard captcha, payment, and human decisions stop the run.
- Internal links to relevant integrations and security guides.
- Canonical, Open Graph, breadcrumb, and structured metadata matching existing site conventions.
- A short explanation of enabling or disabling the MCP server and OpenCode's `squire_*` permission wildcard, without silently changing the user's permissions.

Update supported-agent wording to include OpenCode where appropriate, without turning every sentence into a keyword list.

Do not create a provider service page for OpenCode. It is an MCP client integration, not a registry-backed service that Trusty Squire provisions.

### 6. Upstream discovery material

Prepare, but do not submit, concise entry text for:

- OpenCode's official ecosystem.
- `awesome-opencode`.

Save the copy in an appropriate documentation file. Do not claim affiliation with OpenCode.

## Verification

Run the focused tests, then the package's full relevant test, typecheck, lint, and build suite. Build the website and confirm `/integrations/opencode` is statically rendered and included in the sitemap.

Audit the final diff for:

- Accidental config clobbering.
- JSONC comment loss.
- Incorrect OpenCode field names.
- Secret or token leakage.
- Unrelated changes.
- Unsupported product claims.

## Delivery

- Create a focused branch and commit.
- Push it and open a PR for review.
- Do not merge, publish npm packages, cut a release, or deploy.
- In the PR summary, include:
  - What changed.
  - Configuration path and merge behavior.
  - Tests run.
  - Real OpenCode smoke-test evidence.
  - Routes and documentation added.
  - Remaining risks, especially MCP tool-context size.
