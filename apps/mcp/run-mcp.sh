#!/bin/bash
# Wrapper script for Goose / other MCP hosts that launch processes from
# a directory where Node can't find the workspace node_modules.
#
# Goose Desktop spawns extensions with cwd=/. The MCP server's deps live
# in apps/mcp/node_modules (pnpm doesn't hoist them), so launching from
# / fails with "Cannot find package '@modelcontextprotocol/sdk'".
#
# This script anchors cwd to the MCP app directory before exec'ing node.
# Using `exec` is important: it replaces this bash process so signals
# (SIGTERM on shutdown) reach Node directly.

cd /home/chode/trusty-squire/apps/mcp
exec node dist/server.js "$@"
