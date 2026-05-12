#!/usr/bin/env bash
# Live demo orchestrator: brings up everything needed to run the
# "Claude Code asks → squire signs you up → API key returned" loop.
#
#   pnpm demo            # foreground, Ctrl-C tears everything down
#   pnpm demo:stop       # external cleanup if a previous run crashed
#
# Idempotent — safe to re-run. Each component is restarted from a known
# state.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

LOG_DIR="$REPO_ROOT/.demo-logs"
PID_DIR="$REPO_ROOT/.demo-pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

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
docker info >/dev/null 2>&1 || { red "docker daemon unreachable"; exit 1; }
green "  ✓ docker + pnpm ok"

# ── Infrastructure ───────────────────────────────────────────
bold "Bringing up Postgres + Redis + MailHog (docker)…"
docker compose -f docker-compose.dev.yml up -d >/dev/null
ATTEMPTS=0
until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U dev -d trusty_squire >/dev/null 2>&1; do
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
  start_bg api pnpm --filter @trusty-squire/api dev

start_bg pwa pnpm --filter @trusty-squire/pwa dev

wait_for_url mock-resend http://localhost:4001/health 15
wait_for_url api         http://localhost:3000/health 30
wait_for_url pwa         http://localhost:3002/ 60

# ── Summary ──────────────────────────────────────────────────
echo
bold "Demo running."
cat <<EOF

  PWA:           http://localhost:3002
  API:           http://localhost:3000
  Mock Resend:   http://localhost:4001
  MailHog UI:    http://localhost:8025

Try it:
  1. Sign up at http://localhost:3002/signup
  2. Pair Claude Code:
       node apps/mcp/dist/install/cli.js install --target=claude-code --api-base=http://localhost:3000
  3. In Claude Code, ask the squire to provision Resend.

Logs:    $LOG_DIR/
Stop:    Ctrl-C here (or run \`pnpm demo:stop\` from another shell)

EOF

# Block on the api process; if it dies the trap cleans up the rest.
wait "${pids[1]}"
