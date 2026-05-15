#!/usr/bin/env bash
# Tear down a demo started by scripts/demo.sh. Use this when the
# orchestrator's trap didn't fire (crashed shell, killed -9, etc.).
# Idempotent — safe to run when nothing is up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$REPO_ROOT/.demo-pids"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

bold "Killing demo PIDs…"
if [ -d "$PID_DIR" ]; then
  for f in "$PID_DIR"/*.pid; do
    [ -f "$f" ] || continue
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
      echo "  killed $(basename "$f" .pid) (pid=$pid)"
    fi
    rm -f "$f"
  done
fi

# Kill process trees by pattern (more aggressive)
echo "  killing cloudflared processes..."
pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
pkill -9 -f "cloudflared-wrapper" 2>/dev/null || true

echo "  killing API/PWA/mock-resend processes..."
pkill -9 -f "tsx watch src/server.ts" 2>/dev/null || true
pkill -9 -f "mock-resend.mjs" 2>/dev/null || true
pkill -9 -f "next-server" 2>/dev/null || true

# Reap anything on our ports (last resort)
for port in 3000 3002 4001; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  killing leftover processes on :$port (pids=$pids)"
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
  fi
done

# Clean up temp files
rm -f "$REPO_ROOT/apps/pwa/.env.local"
rm -rf "$REPO_ROOT/.demo-urls"

green "✓ Demo stopped."
echo
echo "Postgres/Redis/MailHog are still up (docker). Stop with:"
echo "  docker compose -f docker-compose.dev.yml down"
