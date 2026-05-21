#!/usr/bin/env bash
# Ground-truth oracle for published npm package verification.
# Use this to PROVE a package version is actually end-user-installable.
# Context: AI agents have falsely claimed publish success when tarballs weren't uploaded,
# dist-tags weren't moved, or CDN-cached endpoints returned stale data.

set -euo pipefail

# Parse arguments
PKG="${1:-}"
EXPECTED_VERSION="${2:-}"
SENTINEL="${3:-}"

# Auto-detect expected dist-tag from version string:
#   stable (e.g. 0.6.13)        → latest
#   prerelease (e.g. 0.6.13-rc) → next
# Override with EXPECTED_TAG env var.
if [[ -n "${EXPECTED_TAG:-}" ]]; then
  TAG="$EXPECTED_TAG"
elif [[ "$EXPECTED_VERSION" == *-* ]]; then
  TAG="next"
else
  TAG="latest"
fi

if [[ -z "$PKG" || -z "$EXPECTED_VERSION" ]]; then
  echo "Usage: $0 <package-name> <expected-version> [<sentinel-string-in-dist>]"
  echo "  EXPECTED_TAG env var overrides auto-detected dist-tag (latest/next)."
  echo "Example: $0 @trusty-squire/mcp 0.6.15 'case \"connect\"'"
  exit 1
fi

# Extract unscoped package name for tarball URL
if [[ "$PKG" == @*/* ]]; then
  UNSCOPED_NAME="${PKG#*/}"
else
  UNSCOPED_NAME="$PKG"
fi

echo "Verifying: $PKG@$EXPECTED_VERSION"
echo "=========================================="

# STEP 1: Verify version exists
echo -n "STEP 1: npm view $PKG@$EXPECTED_VERSION version ... "
ACTUAL_VERSION=$(npm view "$PKG@$EXPECTED_VERSION" version 2>&1 || echo "")
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "FAIL: Expected $EXPECTED_VERSION, got: $ACTUAL_VERSION"
  exit 1
fi
echo "OK"

# STEP 2: Verify dist-tags[$TAG] via npm view (authoritative)
echo -n "STEP 2: npm view $PKG dist-tags --json ($TAG=$EXPECTED_VERSION) ... "
DIST_TAGS_JSON=$(npm view "$PKG" dist-tags --json 2>&1 || echo "{}")
CURRENT_TAG=$(echo "$DIST_TAGS_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('$TAG', ''))" 2>/dev/null || echo "")
if [[ "$CURRENT_TAG" != "$EXPECTED_VERSION" ]]; then
  echo "FAIL: dist-tags.$TAG=$CURRENT_TAG, expected $EXPECTED_VERSION"
  exit 1
fi
echo "OK"

# STEP 3: Cross-check with full package document
echo -n "STEP 3: curl https://registry.npmjs.org/$PKG (dist-tags.$TAG cross-check) ... "
FULL_DOC=$(curl -sS "https://registry.npmjs.org/$PKG" 2>&1 || echo "{}")
TAG_FROM_DOC=$(echo "$FULL_DOC" | python3 -c "import sys, json; print(json.load(sys.stdin).get('dist-tags', {}).get('$TAG', ''))" 2>/dev/null || echo "")
if [[ "$TAG_FROM_DOC" != "$EXPECTED_VERSION" ]]; then
  echo "FAIL: Full doc has dist-tags.$TAG=$TAG_FROM_DOC, npm view said $CURRENT_TAG. CDN inconsistency detected!"
  exit 1
fi
echo "OK"

# STEP 4: Verify tarball URL responds 200
TARBALL_URL="https://registry.npmjs.org/$PKG/-/$UNSCOPED_NAME-$EXPECTED_VERSION.tgz"
echo -n "STEP 4: curl -sI $TARBALL_URL (HTTP 200) ... "
HTTP_STATUS=$(curl -sI "$TARBALL_URL" | head -n1 | awk '{print $2}')
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "FAIL: Got HTTP $HTTP_STATUS"
  exit 1
fi
echo "OK"

# STEP 5: Tarball contents grep (if sentinel provided)
if [[ -n "$SENTINEL" ]]; then
  echo -n "STEP 5: Download tarball and grep for sentinel '$SENTINEL' ... "
  TMPTAR=$(mktemp)
  trap "rm -f $TMPTAR" EXIT
  curl -sS "$TARBALL_URL" -o "$TMPTAR"
  
  # First try the known file for @trusty-squire/mcp
  FOUND=0
  if tar -tzf "$TMPTAR" 2>/dev/null | grep -q "package/dist/install/cli.js"; then
    if tar -xzOf "$TMPTAR" package/dist/install/cli.js 2>/dev/null | grep -qF "$SENTINEL"; then
      FOUND=1
    fi
  fi
  
  # Fallback: grep all .js files under package/dist/
  if [[ $FOUND -eq 0 ]]; then
    TMPDIR=$(mktemp -d)
    trap "rm -rf $TMPDIR $TMPTAR" EXIT
    tar -xzf "$TMPTAR" -C "$TMPDIR" 2>/dev/null
    if grep -r --include="*.js" -F "$SENTINEL" "$TMPDIR/package/dist/" >/dev/null 2>&1; then
      FOUND=1
    fi
    rm -rf "$TMPDIR"
  fi
  
  if [[ $FOUND -eq 0 ]]; then
    echo "FAIL: Sentinel string not found in tarball dist/"
    exit 1
  fi
  echo "OK"
  rm -f "$TMPTAR"
  trap - EXIT
else
  echo "STEP 5: Tarball grep ... SKIPPED (no sentinel provided)"
fi

# STEP 6: End-to-end clean install
echo -n "STEP 6: Clean tmpdir install (npm install $PKG@$TAG) ... "
INSTALL_DIR=$(mktemp -d)
trap "rm -rf $INSTALL_DIR" EXIT

(
  cd "$INSTALL_DIR"
  npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund "$PKG@$TAG" >/dev/null 2>&1
  
  # Read installed version (handle scoped packages correctly)
  PKG_DIR="./node_modules/$PKG"
  INSTALLED_VERSION=$(node -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo "")
  if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "FAIL: Installed version=$INSTALLED_VERSION, expected $EXPECTED_VERSION"
    exit 1
  fi
)

if [[ $? -ne 0 ]]; then
  exit 1
fi
echo "OK"

# STEP 7: Bin works
echo -n "STEP 7: Test bin --version ... "
(
  cd "$INSTALL_DIR"
  
  # Read bin name from package.json
  BIN_NAME=$(node -p "Object.keys(require('./$PKG/package.json').bin || {})[0] || ''" 2>/dev/null || echo "")
  
  if [[ -z "$BIN_NAME" ]]; then
    echo "WARN: No bin defined in package.json"
    exit 0
  fi
  
  BIN_PATH="./node_modules/.bin/$BIN_NAME"
  
  if [[ ! -x "$BIN_PATH" ]]; then
    echo "FAIL: Binary $BIN_PATH not found or not executable"
    exit 1
  fi
  
  # Try --version
  BIN_VERSION=$("$BIN_PATH" --version 2>&1 || echo "")
  
  # Check if version matches
  if [[ "$BIN_VERSION" == "$EXPECTED_VERSION" ]]; then
    echo "OK"
    exit 0
  fi
  
  # If --version isn't supported or doesn't return expected format, warn but don't fail
  if [[ -z "$BIN_VERSION" ]] || [[ "$BIN_VERSION" == *"unknown option"* ]] || [[ "$BIN_VERSION" == *"not supported"* ]]; then
    echo "WARN: --version not supported on this version"
    exit 0
  fi
  
  echo "WARN: --version returned '$BIN_VERSION', expected '$EXPECTED_VERSION' (continuing anyway)"
)

rm -rf "$INSTALL_DIR"
trap - EXIT

echo ""
echo "✓ VERIFIED: $PKG@$EXPECTED_VERSION is published and end-user-installable."
echo "  Registry latest = $EXPECTED_VERSION (both authoritative endpoints agree)."
if [[ -n "$SENTINEL" ]]; then
  echo "  Tarball serves 200 and contains: $SENTINEL"
else
  echo "  Tarball serves 200."
fi
echo "  Clean install resolves to $EXPECTED_VERSION."
