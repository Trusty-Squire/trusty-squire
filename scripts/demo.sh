#!/usr/bin/env bash
# Live demo orchestrator: brings up everything needed to run the
# "Claude Code asks → squire signs you up → API key returned" loop.
#
#   pnpm demo            # foreground, Ctrl-C tears everything down
#   pnpm demo:mobile     # with cloudflared tunnels for mobile access
#   pnpm demo:stop       # external cleanup if a previous run crashed
#
# Idempotent — safe to re-run. Each component is restarted from a known
# state.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Check if mobile mode requested
MOBILE_MODE="${1:-}"
if [ "$MOBILE_MODE" = "mobile" ]; then
  ENABLE_TUNNELS=true
else
  ENABLE_TUNNELS=false
fi

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

LOG_DIR="$REPO_ROOT/.demo-logs"
PID_DIR="$REPO_ROOT/.demo-pids"
URL_DIR="$REPO_ROOT/.demo-urls"
mkdir -p "$LOG_DIR" "$PID_DIR" "$URL_DIR"

pids=()
trap cleanup INT TERM EXIT

cleanup() {
  echo
  bold "Shutting down demo…"
  for pid in "${pids[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Give children a moment, then SIGKILL anything still alive.
  sleep 1
  for pid in "${pids[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_DIR"/*.pid 2>/dev/null || true
  rm -f "$REPO_ROOT/apps/pwa/.env.local" 2>/dev/null || true
  green "✓ All demo processes stopped."
}

start_bg() {
  local name="$1"
  local log="$LOG_DIR/$name.log"
  shift
  "$@" >"$log" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_DIR/$name.pid"
  pids+=("$pid")
  printf "  started %-14s pid=%s log=%s\n" "$name" "$pid" "$log"
}

wait_for_url() {
  local name="$1" url="$2" timeout="${3:-30}"
  local i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      green "  ✓ $name ready ($url)"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  red "  ✗ $name did not respond within ${timeout}s (check $LOG_DIR/$name.log)"
  return 1
}

# ── Preflight ────────────────────────────────────────────────
bold "Preflight checks…"
command -v docker >/dev/null 2>&1 || { red "docker not found"; exit 1; }
command -v pnpm   >/dev/null 2>&1 || { red "pnpm not found";   exit 1; }

# Check docker access and set DOCKER_CMD appropriately
if docker info >/dev/null 2>&1; then
  DOCKER_CMD="docker"
elif sudo docker info >/dev/null 2>&1; then
  DOCKER_CMD="sudo docker"
  yellow "  ⚠ Using sudo for docker commands"
else
  red "docker daemon unreachable"
  exit 1
fi

if [ "$ENABLE_TUNNELS" = true ]; then
  command -v cloudflared >/dev/null 2>&1 || { red "cloudflared not found (needed for mobile mode)"; exit 1; }
  green "  ✓ docker + pnpm + cloudflared ok"
else
  green "  ✓ docker + pnpm ok"
fi

# ── Infrastructure ───────────────────────────────────────────
bold "Bringing up Postgres + Redis (docker)…"
$DOCKER_CMD compose -f docker-compose.dev.yml up -d >/dev/null
ATTEMPTS=0
until $DOCKER_CMD compose -f docker-compose.dev.yml exec -T postgres pg_isready -U dev -d trusty_squire >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  [ "$ATTEMPTS" -ge 30 ] && { red "Postgres did not become ready"; exit 1; }
  sleep 1
done
green "  ✓ Postgres ready"
green "  ✓ Redis ready (docker healthcheck)"

# ── Build what needs building ────────────────────────────────
bold "Building MCP package (needed for the install step)…"
pnpm --filter @trusty-squire/mcp build >/dev/null
green "  ✓ MCP built"

# ── Start processes ──────────────────────────────────────────
bold "Starting demo processes…"

start_bg mock-resend node scripts/mock-resend.mjs

DEMO_MODE=true API_PORT=3000 PWA_BASE_URL=http://localhost:3002 \
  VOUCHFLOW_STUB_MODE=true start_bg api pnpm --filter @trusty-squire/api dev

wait_for_url mock-resend http://localhost:4001/health 15
wait_for_url api         http://localhost:3000/health 30

# ── Cloudflare Tunnels (Mobile Mode) ─────────────────────────
API_TUNNEL_URL=""
PWA_TUNNEL_URL=""

if [ "$ENABLE_TUNNELS" = true ]; then
  bold "Starting Cloudflare tunnels…"
  
  # Start API tunnel with wrapper that captures URL
  API_URL_FILE="$URL_DIR/api-tunnel.txt"
  rm -f "$API_URL_FILE"
  start_bg cloudflared-api bash "$REPO_ROOT/scripts/cloudflared-wrapper.sh" "$API_URL_FILE" tunnel --url http://localhost:3000 --no-autoupdate
  
  # Wait for URL file to be created
  printf "  Waiting for API tunnel URL"
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if [ -f "$API_URL_FILE" ] && [ -s "$API_URL_FILE" ]; then
      API_TUNNEL_URL=$(cat "$API_URL_FILE")
      if [ -n "$API_TUNNEL_URL" ]; then
        echo ""
        break
      fi
    fi
    printf "."
    sleep 1
    attempts=$((attempts + 1))
  done
  
  if [ -z "$API_TUNNEL_URL" ]; then
    echo ""
    red "  ✗ Failed to get API tunnel URL after 30s"
    red "  Check $LOG_DIR/cloudflared-api.log for details"
    red "  URL file status: $(ls -lah "$API_URL_FILE" 2>&1 || echo "not found")"
    exit 1
  fi
  green "  ✓ API tunnel: $API_TUNNEL_URL"
fi

# Start PWA with appropriate configuration
if [ "$ENABLE_TUNNELS" = true ]; then
  # Mobile mode: use API_PROXY_TARGET so Next.js proxies to API tunnel
  # Keep NEXT_PUBLIC_API_BASE empty so browser makes relative calls
  cat > "$REPO_ROOT/apps/pwa/.env.local" <<EOF
API_PROXY_TARGET=$API_TUNNEL_URL
NEXT_PUBLIC_VOUCHFLOW_MODE=stub
EOF
else
  # Local mode: no special env needed (defaults work)
  rm -f "$REPO_ROOT/apps/pwa/.env.local"
fi

start_bg pwa pnpm --filter @trusty-squire/pwa dev
wait_for_url pwa http://localhost:3002/ 90

if [ "$ENABLE_TUNNELS" = true ]; then
  # Start PWA tunnel with wrapper that captures URL
  PWA_URL_FILE="$URL_DIR/pwa-tunnel.txt"
  rm -f "$PWA_URL_FILE"
  start_bg cloudflared-pwa bash "$REPO_ROOT/scripts/cloudflared-wrapper.sh" "$PWA_URL_FILE" tunnel --url http://localhost:3002 --no-autoupdate
  
  # Wait for URL file to be created
  printf "  Waiting for PWA tunnel URL"
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if [ -f "$PWA_URL_FILE" ] && [ -s "$PWA_URL_FILE" ]; then
      PWA_TUNNEL_URL=$(cat "$PWA_URL_FILE")
      if [ -n "$PWA_TUNNEL_URL" ]; then
        echo ""
        break
      fi
    fi
    printf "."
    sleep 1
    attempts=$((attempts + 1))
  done
  
  if [ -z "$PWA_TUNNEL_URL" ]; then
    echo ""
    red "  ✗ Failed to get PWA tunnel URL after 30s"
    red "  Check $LOG_DIR/cloudflared-pwa.log for details"
    red "  URL file status: $(ls -lah "$PWA_URL_FILE" 2>&1 || echo "not found")"
    exit 1
  fi
  green "  ✓ PWA tunnel: $PWA_TUNNEL_URL"
fi

# ── Summary ──────────────────────────────────────────────────
echo
bold "Demo running."

if [ "$ENABLE_TUNNELS" = true ]; then
  cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🌐 MOBILE ACCESS (via Cloudflare Tunnels)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  📱 Open on your phone:  $PWA_TUNNEL_URL
  
  API Tunnel:            $API_TUNNEL_URL

  Note: Vouchflow is in STUB MODE (fake passkeys for demo)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Local URLs:
  PWA:           http://localhost:3002
  API:           http://localhost:3000
  Mock Resend:   http://localhost:4001

Logs:    $LOG_DIR/
Stop:    Ctrl-C here (or run \`pnpm demo:stop\` from another shell)

EOF
else
  cat <<EOF

  PWA:           http://localhost:3002
  API:           http://localhost:3000
  Mock Resend:   http://localhost:4001

Try it:
  1. Sign up at http://localhost:3002/signup
  2. Pair Claude Code:
       node apps/mcp/dist/install/cli.js install --target=claude-code --api-base=http://localhost:3000
  3. In Claude Code, ask the squire to provision Resend.

For mobile access, run: pnpm demo:mobile

Logs:    $LOG_DIR/
Stop:    Ctrl-C here (or run \`pnpm demo:stop\` from another shell)

EOF
fi

# Block on the api process; if it dies the trap cleans up the rest.
wait "${pids[1]}"
