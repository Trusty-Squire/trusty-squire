#!/usr/bin/env bash
# Exercises the real tools/release-mcp.mjs against a throwaway git fixture:
# single-main model — every cut branches off `main` and PRs back to `main`
# (npm `next`), and a stable version request is refused (stable is now a
# workflow_dispatch, not a script-driven PR).

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

MOCK_BIN="$TEST_DIR/bin"
ORIGIN_DIR="$TEST_DIR/origin.git"
CLONE_DIR="$TEST_DIR/clone"
RC_CLONE_DIR="$TEST_DIR/rc-clone"
mkdir -p "$MOCK_BIN"

cat >"$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then
  echo "$*" >>"$STATE_FILE"
  echo "https://github.com/example/example/pull/1"
  exit 0
fi
exit 64
EOF
chmod +x "$MOCK_BIN/gh"
STATE_FILE="$TEST_DIR/gh-pr-create-calls"
export STATE_FILE

git init --quiet --bare "$ORIGIN_DIR"
git clone --quiet "$ORIGIN_DIR" "$CLONE_DIR"

git -C "$CLONE_DIR" config user.email "test@example.com"
git -C "$CLONE_DIR" config user.name "Test"

mkdir -p "$CLONE_DIR/apps/mcp"

cat >"$CLONE_DIR/apps/mcp/package.json" <<'EOF'
{
  "name": "@trusty-squire/mcp",
  "version": "1.2.3-rc.1"
}
EOF

cat >"$CLONE_DIR/apps/mcp/CHANGELOG.md" <<'EOF'
# Changelog — @trusty-squire/mcp
EOF

git -C "$CLONE_DIR" add -A
git -C "$CLONE_DIR" commit --quiet -m "fixture"
git -C "$CLONE_DIR" branch -m main
git -C "$CLONE_DIR" push --quiet -u origin main

# The one-command RC path derives the next version from origin/main, then
# performs the branch/commit/push/PR ceremony.
git clone --quiet --branch main "$ORIGIN_DIR" "$RC_CLONE_DIR"
git -C "$RC_CLONE_DIR" config user.email "test@example.com"
git -C "$RC_CLONE_DIR" config user.name "Test"

set +e
RC_OUTPUT=$(cd "$RC_CLONE_DIR" && PATH="$MOCK_BIN:$PATH" node "$ROOT_DIR/tools/release-mcp.mjs" next-rc 2>&1)
RC_STATUS=$?
set -e

if [[ $RC_STATUS -ne 0 ]]; then
  echo "Expected next-rc cut to succeed"
  printf '%s\n' "$RC_OUTPUT"
  exit 1
fi

RC_VERSION=$(node -p "JSON.parse(require('node:fs').readFileSync('$RC_CLONE_DIR/apps/mcp/package.json', 'utf8')).version")
if [[ "$RC_VERSION" != "1.2.3-rc.2" ]]; then
  echo "Expected next-rc to derive 1.2.3-rc.2, got $RC_VERSION"
  exit 1
fi

if [[ "$(git -C "$RC_CLONE_DIR" branch --show-current)" != "release-1.2.3-rc.2" ]]; then
  echo "Expected next-rc release branch"
  exit 1
fi

if [[ ! -f "$STATE_FILE" ]] || ! grep -q -- "--base main" "$STATE_FILE"; then
  echo "Expected gh pr create --base main for next-rc"
  exit 1
fi

# A stable version request must be refused — stable is a workflow_dispatch now.
set +e
STABLE_OUTPUT=$(cd "$CLONE_DIR" && PATH="$MOCK_BIN:$PATH" node "$ROOT_DIR/tools/release-mcp.mjs" 1.2.3 2>&1)
STABLE_STATUS=$?
set -e

if [[ $STABLE_STATUS -eq 0 ]]; then
  echo "Expected a stable-version request to be refused"
  printf '%s\n' "$STABLE_OUTPUT"
  exit 1
fi

if [[ "$STABLE_OUTPUT" != *"workflow_dispatch"* ]]; then
  echo "Expected the refusal to point at the workflow_dispatch stable-release path, got:"
  printf '%s\n' "$STABLE_OUTPUT"
  exit 1
fi

echo "release-mcp single-main next-rc + stable refusal: OK"
