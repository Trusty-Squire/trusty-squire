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
      echo "  killed $(basename "$f" .pid) (pid=$pid)"
    fi
    rm -f "$f"
  done
fi

# Reap anything we might have missed (mock-resend / next / tsx tied
# to our ports).
for port in 3000 3002 4001; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  killing leftover processes on :$port (pids=$pids)"
    echo "$pids" | xargs -r kill 2>/dev/null || true
  fi
done

green "✓ Demo stopped."
echo
echo "Postgres/Redis/MailHog are still up (docker). Stop with:"
echo "  docker compose -f docker-compose.dev.yml down"
