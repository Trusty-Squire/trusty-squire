#!/usr/bin/env bash
# Launch the operator MCP from a dedicated local checkout of origin/main.
#
# The Codex MCP configuration points at this script instead of npx so every
# launch uses the current main source without an npm release or cache.
# Install this script in the dedicated checkout (default below), then leave
# that checkout solely to this wrapper.

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly CHECKOUT="${TRUSTY_SQUIRE_MCP_CHECKOUT:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
readonly BUILD_STATE="$CHECKOUT/.operator-mcp-build-state"
readonly BUILD_LOCK="$CHECKOUT/.operator-mcp-build.lock"

fail() {
  echo "[operator-mcp] $*" >&2
  exit 1
}

sync_and_build() {
  cd "$CHECKOUT"

  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "checkout is not a git worktree: $CHECKOUT"
  git remote get-url origin >/dev/null 2>&1 \
    || fail "checkout has no origin remote: $CHECKOUT"

  git fetch --quiet origin main
  local target current lock_hash expected_state
  target="$(git rev-parse origin/main)"
  current="$(git rev-parse HEAD)"

  # This checkout belongs to the operator. Discard any tracked drift so a
  # launch cannot accidentally run a local or stale revision.
  if [[ "$current" != "$target" ]] \
    || [[ "$(git branch --show-current)" != "main" ]] \
    || [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git reset --hard --quiet "$target"
    git checkout --quiet -B main "$target"
    git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
  fi

  lock_hash="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
  expected_state="$target $lock_hash"
  if [[ "${TS_OPERATOR_MCP_FORCE_REBUILD:-}" != "1" ]] \
    && [[ -f apps/mcp/dist/bin.js ]] \
    && [[ "$(cat "$BUILD_STATE" 2>/dev/null || true)" == "$expected_state" ]]; then
    echo "[operator-mcp] cache hit: $(git rev-parse --short "$target")" >&2
    return
  fi

  echo "[operator-mcp] building $(git rev-parse --short "$target")" >&2
  # The ellipsis includes mcp and every workspace dependency. Building them in
  # recursive (topological) order produces the dist/ entry points mcp imports.
  pnpm install --frozen-lockfile --filter '@trusty-squire/mcp...'
  pnpm -r --filter '@trusty-squire/mcp...' run build
  [[ -f apps/mcp/dist/bin.js ]] || fail "build did not create apps/mcp/dist/bin.js"
  printf '%s\n' "$expected_state" >"$BUILD_STATE"
}

[[ -d "$CHECKOUT" ]] || fail "dedicated checkout does not exist: $CHECKOUT"

# Separate the short sync/build critical section from the server process. The
# lock prevents simultaneous Codex launches from racing on git, pnpm, or dist/.
(
  flock -w 300 9 || fail "timed out waiting for another local MCP launch"
  sync_and_build
) 9>"$BUILD_LOCK"

cd "$CHECKOUT"
readonly RUNNING_COMMIT="$(git rev-parse HEAD)"
readonly MAIN_COMMIT="$(git rev-parse origin/main)"
[[ "$RUNNING_COMMIT" == "$MAIN_COMMIT" ]] \
  || fail "checkout drifted from origin/main during startup"
readonly MCP_VERSION="$(node -p "require('./apps/mcp/package.json').version")"
echo "[operator-mcp] starting @trusty-squire/mcp@$MCP_VERSION from ${RUNNING_COMMIT:0:12} (origin/main)" >&2

# Test and maintenance callers can validate the exact selected build without
# starting a long-lived stdio server.
if [[ "${TS_OPERATOR_MCP_VERIFY_ONLY:-}" == "1" ]]; then
  exit 0
fi

cd "$CHECKOUT/apps/mcp"
exec node dist/bin.js server "$@"
