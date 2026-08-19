#!/usr/bin/env bash
# Exercises the real tools/release-mcp.mjs against a throwaway git fixture so
# the stable-cut de-prerelease + dependent-pin repin (the "stale workspace
# dep pins" release-tooling bug) stays fixed.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

MOCK_BIN="$TEST_DIR/bin"
ORIGIN_DIR="$TEST_DIR/origin.git"
CLONE_DIR="$TEST_DIR/clone"
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

mkdir -p "$CLONE_DIR/apps/mcp" "$CLONE_DIR/apps/registry" "$CLONE_DIR/packages/skill-schema" "$CLONE_DIR/packages/recipe-schema"

# apps/mcp pins skill-schema to an EXACT prerelease workspace version — the
# reproduction of the stale-pin bug. recipe-schema already uses workspace:*
# and must be left alone.
cat >"$CLONE_DIR/apps/mcp/package.json" <<'EOF'
{
  "name": "@trusty-squire/mcp",
  "version": "1.2.3-rc.1",
  "dependencies": {
    "@trusty-squire/recipe-schema": "workspace:*",
    "@trusty-squire/skill-schema": "workspace:0.4.0-rc.2"
  }
}
EOF

# A second dependent, to prove the repin isn't hardcoded to apps/mcp.
cat >"$CLONE_DIR/apps/registry/package.json" <<'EOF'
{
  "name": "@trusty-squire/registry",
  "version": "1.0.0",
  "dependencies": {
    "@trusty-squire/skill-schema": "workspace:0.4.0-rc.2"
  }
}
EOF

cat >"$CLONE_DIR/apps/mcp/CHANGELOG.md" <<'EOF'
# Changelog — @trusty-squire/mcp
EOF

cat >"$CLONE_DIR/packages/skill-schema/package.json" <<'EOF'
{
  "name": "@trusty-squire/skill-schema",
  "version": "0.4.0-rc.2"
}
EOF

cat >"$CLONE_DIR/packages/recipe-schema/package.json" <<'EOF'
{
  "name": "@trusty-squire/recipe-schema",
  "version": "0.7.0-rc.5"
}
EOF

# Minimal pnpm-lock.yaml fixture whose per-importer specifiers must stay in
# lockstep with the package.json rewrites above.
cat >"$CLONE_DIR/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'

importers:
  apps/mcp:
    dependencies:
      '@trusty-squire/recipe-schema':
        specifier: workspace:*
        version: link:../../packages/recipe-schema
      '@trusty-squire/skill-schema':
        specifier: workspace:0.4.0-rc.2
        version: link:../../packages/skill-schema
  apps/registry:
    dependencies:
      '@trusty-squire/skill-schema':
        specifier: workspace:0.4.0-rc.2
        version: link:../../packages/skill-schema
EOF

git -C "$CLONE_DIR" add -A
git -C "$CLONE_DIR" commit --quiet -m "fixture"
git -C "$CLONE_DIR" branch -m staging
git -C "$CLONE_DIR" push --quiet -u origin staging

set +e
OUTPUT=$(cd "$CLONE_DIR" && PATH="$MOCK_BIN:$PATH" node "$ROOT_DIR/tools/release-mcp.mjs" 1.2.3 2>&1)
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  echo "Expected a stable cut to succeed"
  printf '%s\n' "$OUTPUT"
  exit 1
fi

read_json() {
  node -p "JSON.parse(require('node:fs').readFileSync('$1', 'utf8')).$2"
}

SKILL_VERSION=$(read_json "$CLONE_DIR/packages/skill-schema/package.json" version)
if [[ "$SKILL_VERSION" != "0.4.0" ]]; then
  echo "Expected skill-schema stripped to 0.4.0, got $SKILL_VERSION"
  exit 1
fi

RECIPE_VERSION=$(read_json "$CLONE_DIR/packages/recipe-schema/package.json" version)
if [[ "$RECIPE_VERSION" != "0.7.0" ]]; then
  echo "Expected recipe-schema stripped to 0.7.0, got $RECIPE_VERSION"
  exit 1
fi

MCP_SKILL_PIN=$(read_json "$CLONE_DIR/apps/mcp/package.json" "dependencies['@trusty-squire/skill-schema']")
if [[ "$MCP_SKILL_PIN" != "workspace:*" ]]; then
  echo "Expected apps/mcp's skill-schema pin repinned to workspace:*, got $MCP_SKILL_PIN"
  exit 1
fi

MCP_RECIPE_PIN=$(read_json "$CLONE_DIR/apps/mcp/package.json" "dependencies['@trusty-squire/recipe-schema']")
if [[ "$MCP_RECIPE_PIN" != "workspace:*" ]]; then
  echo "Expected apps/mcp's already-workspace:* recipe-schema pin left untouched, got $MCP_RECIPE_PIN"
  exit 1
fi

REGISTRY_SKILL_PIN=$(read_json "$CLONE_DIR/apps/registry/package.json" "dependencies['@trusty-squire/skill-schema']")
if [[ "$REGISTRY_SKILL_PIN" != "workspace:*" ]]; then
  echo "Expected apps/registry's skill-schema pin repinned too, got $REGISTRY_SKILL_PIN"
  exit 1
fi

if grep -q "specifier: workspace:0.4.0-rc.2" "$CLONE_DIR/pnpm-lock.yaml"; then
  echo "Expected pnpm-lock.yaml specifiers refreshed, stale pin remains"
  cat "$CLONE_DIR/pnpm-lock.yaml"
  exit 1
fi

LOCK_SKILL_SPECIFIERS=$(grep -c "specifier: workspace:\*" "$CLONE_DIR/pnpm-lock.yaml")
if [[ "$LOCK_SKILL_SPECIFIERS" != "3" ]]; then
  echo "Expected 3 workspace:* specifiers in pnpm-lock.yaml (1 pre-existing + 2 repinned), got $LOCK_SKILL_SPECIFIERS"
  cat "$CLONE_DIR/pnpm-lock.yaml"
  exit 1
fi

# The repin must land IN the release commit, not just on disk.
COMMITTED_FILES=$(git -C "$CLONE_DIR" show --stat --format= HEAD)
for f in "apps/registry/package.json" "packages/skill-schema/package.json" "packages/recipe-schema/package.json" "pnpm-lock.yaml"; do
  if [[ "$COMMITTED_FILES" != *"$f"* ]]; then
    echo "Expected $f in the release commit, got:"
    printf '%s\n' "$COMMITTED_FILES"
    exit 1
  fi
done

if [[ ! -f "$STATE_FILE" ]] || ! grep -q -- "--base main" "$STATE_FILE"; then
  echo "Expected gh pr create --base main for a stable cut"
  exit 1
fi

echo "release-mcp stable-cut dependent-pin repin: OK"
