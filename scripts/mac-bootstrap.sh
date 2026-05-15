#!/bin/bash
# Trusty Squire — Mac bootstrap for residential-IP captcha testing.
#
# Run this ONCE on your Mac (over Tailscale SSH or directly in Terminal).
# It clones the repo, installs deps, builds, and wires the MCP server
# into your local Claude Desktop or Goose Desktop config.
#
# Usage:
#   curl -fsSL https://<wherever>/mac-bootstrap.sh | bash
#   # or
#   ./mac-bootstrap.sh [claude|goose]   (default: claude)
#
# Prereqs on the Mac:
#   - Homebrew (https://brew.sh)
#   - ~10 min of patience the first time (Playwright Chromium download)

set -euo pipefail

TARGET="${1:-claude}"
REPO_DIR="${HOME}/trusty-squire"
BRANCH="${TRUSTY_SQUIRE_BRANCH:-main}"

say() { printf "\n\033[1;36m▸\033[0m %s\n" "$*"; }
warn() { printf "\n\033[1;33m⚠\033[0m %s\n" "$*"; }
die() { printf "\n\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# ---- 1. Prereqs ------------------------------------------------------------
say "Checking prerequisites…"

command -v brew >/dev/null || die "Homebrew not found. Install from https://brew.sh first."

if ! command -v node >/dev/null; then
  say "Installing Node 20 via Homebrew…"
  brew install node@20
  brew link --overwrite --force node@20
fi

if ! command -v pnpm >/dev/null; then
  say "Installing pnpm…"
  brew install pnpm
fi

node --version | grep -qE "^v(20|21|22)" || warn "Node $(node --version) detected; project targets v20+. Continuing."

# ---- 2. Clone / update repo ------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
  say "Repo exists at $REPO_DIR — pulling latest…"
  git -C "$REPO_DIR" fetch origin
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" pull --ff-only
else
  say "Cloning trusty-squire to $REPO_DIR…"
  # NOTE: replace with the actual repo URL. If the repo is private,
  # `gh repo clone` or an SSH URL works too.
  git clone https://github.com/YOUR_ORG/trusty-squire.git "$REPO_DIR"
  git -C "$REPO_DIR" checkout "$BRANCH"
fi

cd "$REPO_DIR"

# ---- 3. Install + build ----------------------------------------------------
say "Installing workspace deps (pnpm install)…"
pnpm install --frozen-lockfile

say "Building all packages…"
pnpm -r build || warn "Some packages had type errors but emitted JS — continuing (matches dev-box behavior)."

say "Installing Playwright's bundled Chromium…"
pnpm -F @trusty-squire/universal-bot exec playwright install chromium

# ---- 4. Wire into the host agent ------------------------------------------
MCP_CMD="$REPO_DIR/apps/mcp/run-mcp.sh"
chmod +x "$MCP_CMD"

case "$TARGET" in
  claude)
    CONFIG_DIR="$HOME/Library/Application Support/Claude"
    CONFIG_FILE="$CONFIG_DIR/claude_desktop_config.json"
    mkdir -p "$CONFIG_DIR"

    if [ ! -f "$CONFIG_FILE" ]; then
      echo '{"mcpServers":{}}' > "$CONFIG_FILE"
    fi

    say "Patching $CONFIG_FILE to register trusty-squire MCP…"
    # Use python for safe JSON edit — every Mac has python3.
    python3 - <<PY
import json, pathlib
p = pathlib.Path("$CONFIG_FILE")
cfg = json.loads(p.read_text())
cfg.setdefault("mcpServers", {})
cfg["mcpServers"]["trusty-squire"] = {
    "command": "$MCP_CMD",
    "args": []
}
p.write_text(json.dumps(cfg, indent=2))
print("ok")
PY
    say "Registered. Now: quit Claude Desktop fully (Cmd-Q), reopen, and the trusty-squire tools will appear."
    ;;

  goose)
    CONFIG_FILE="$HOME/.config/goose/config.yaml"
    mkdir -p "$(dirname "$CONFIG_FILE")"
    if [ ! -f "$CONFIG_FILE" ]; then
      echo "extensions: {}" > "$CONFIG_FILE"
    fi

    say "Appending trusty-squire stanza to $CONFIG_FILE…"
    say "(Manual step: confirm there isn't already a stanza for it.)"
    cat >> "$CONFIG_FILE" <<YAML

  trusty-squire:
    type: stdio
    cmd: $MCP_CMD
    args: []
    enabled: true
    bundled: false
    name: trusty-squire
    description: Trusty Squire universal signup bot
    envs: {}
    timeout: 300
YAML
    say "Registered. Restart Goose Desktop fully."
    ;;

  *)
    die "Unknown target: $TARGET. Use 'claude' or 'goose'."
    ;;
esac

# ---- 5. Sanity check -------------------------------------------------------
say "Sanity check — does the MCP server start?"
if timeout 5 "$MCP_CMD" </dev/null >/dev/null 2>&1; then
  echo "(server exited cleanly within 5s — expected for stdio without a client)"
else
  echo "(server timed out within 5s — also expected; means it's running and waiting on stdin)"
fi

# ---- 6. IP sanity ----------------------------------------------------------
say "Your egress IP (this is what reCAPTCHA will see):"
curl -fsS ipinfo.io/json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"  IP:   {d['ip']}\"); print(f\"  ASN:  {d.get('org','?')}\"); print(f\"  Geo:  {d.get('city','?')}, {d.get('country','?')}\")"
echo ""
say "If the ASN above is a residential carrier (Comcast, AT&T, BT, etc.) — reCAPTCHA will pass."
say "If it's a datacenter ASN (Hetzner, OVH, AWS, etc.) — you'll hit the same wall as before."

echo ""
say "Done. Next step:"
echo "  1. Quit + reopen $TARGET Desktop"
echo "  2. Start a new chat"
echo "  3. Ask the agent: \"sign up for Postmark using provision_any_service\""
echo "  4. Watch it pass (or report back exactly where it failed)."
