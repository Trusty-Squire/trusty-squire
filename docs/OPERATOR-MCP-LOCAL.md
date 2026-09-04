# Operator MCP local runner

The operator Codex MCP runs the local `origin/main` build through
`bin/run-operator-mcp-local.sh`. It does not run a package-manager launcher or
an npm-published release.

The dedicated checkout is `/home/lunchbox/.local/share/trusty-squire/operator-mcp`.
Its Codex entry calls:

```toml
[mcp_servers.squire]
command = "/home/lunchbox/.local/share/trusty-squire/operator-mcp/bin/run-operator-mcp-local.sh"
args = []

[mcp_servers.squire.env]
TRUSTY_SQUIRE_AGENT_IDENTITY = "codex"
TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.trustysquire.ai"
```

On every launch, the wrapper fetches `origin/main`, resets its dedicated
checkout to that revision, and runs the compiled `apps/mcp/dist/bin.js server`.
It saves the built commit and lockfile digest in `.operator-mcp-build-state`, so
normal launches skip installation and builds. A changed main commit or lockfile
causes a fresh `pnpm install --frozen-lockfile --filter '@trusty-squire/mcp...'`
and a recursive build of the MCP and its workspace dependencies.

To update, do nothing: restart Codex and the wrapper self-syncs. To force a
rebuild of the current main revision, run:

```bash
TS_OPERATOR_MCP_FORCE_REBUILD=1 \
  /home/lunchbox/.local/share/trusty-squire/operator-mcp/bin/run-operator-mcp-local.sh
```

For a non-server verification of the selected revision and cache state, add
`TS_OPERATOR_MCP_VERIFY_ONLY=1` to that command.
