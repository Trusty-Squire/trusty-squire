#!/usr/bin/env sh
# Trusty Squire MCP — one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Trusty-Squire/trusty-squire/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --target=claude-code
#
# This is a thin convenience wrapper around the npm package: it verifies
# Node.js is present, then runs `npx @trusty-squire/mcp install`, passing
# through any arguments. If you already have Node, running
# `npx @trusty-squire/mcp install` directly does exactly the same thing.

set -eu

MIN_NODE_MAJOR=20

err() { printf 'trusty-squire: %s\n' "$1" >&2; }

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required but was not found."
  err "Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org and re-run."
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node.js >= ${MIN_NODE_MAJOR} is required (found $(node -v 2>/dev/null || echo unknown))."
  err "Upgrade Node.js and re-run."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  err "npx was not found (it ships with npm). Install npm and re-run."
  exit 1
fi

echo "trusty-squire: installing the MCP server via npx ..."
exec npx -y @trusty-squire/mcp install "$@"
