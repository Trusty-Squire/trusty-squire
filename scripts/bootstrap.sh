#!/usr/bin/env bash
# One-command local bootstrap: deps + Docker services + ready-check.
# Idempotent — safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red() { printf "\033[31m%s\033[0m\n" "$*" >&2; }

# ── Tool checks ──────────────────────────────────────────────
bold "Checking prerequisites…"

if ! command -v node >/dev/null 2>&1; then
  red "node not found. Install Node 20.11.0 (see .nvmrc)."
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Node 20+ required. Found: $(node -v)"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  red "pnpm not found. Install with: npm install -g pnpm@8.15.0"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  red "docker not found. Install Docker Desktop or Docker Engine."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  red "docker daemon is not reachable as user '$(id -un)'."
  red "Most likely fix on Linux: add yourself to the docker group, then re-login."
  red "  sudo usermod -aG docker $(id -un)"
  red "  # log out and back in (or run: newgrp docker)"
  exit 1
fi

green "✓ node $(node -v), pnpm $(pnpm -v), docker $(docker -v | awk '{print $3}' | tr -d ',')"

# ── Install deps ─────────────────────────────────────────────
bold "Installing pnpm workspace dependencies…"
pnpm install

# ── Start services ───────────────────────────────────────────
bold "Starting Postgres, Redis, MailHog (Docker)…"
docker compose -f docker-compose.dev.yml up -d

# ── Wait for Postgres ────────────────────────────────────────
bold "Waiting for Postgres to accept connections…"
ATTEMPTS=0
until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U dev -d trusty_squire >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ $ATTEMPTS -ge 30 ]; then
    red "Postgres did not become ready within 30s."
    exit 1
  fi
  sleep 1
done
green "✓ Postgres ready (trusty_squire)"

# Vault + inbox DBs live on the same instance under separate databases;
# created by scripts/postgres-init.sh on first start. For volumes that
# pre-date a database addition, idempotent createdb fills the gap.
for SECONDARY_DB in trusty_squire_vault trusty_squire_inbox trusty_squire_registry; do
  if ! docker compose -f docker-compose.dev.yml exec -T postgres \
      psql -U dev -d trusty_squire -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${SECONDARY_DB}'" 2>/dev/null \
      | grep -q 1; then
    docker compose -f docker-compose.dev.yml exec -T postgres \
      createdb -U dev "${SECONDARY_DB}" >/dev/null 2>&1 || true
  fi

  ATTEMPTS=0
  until docker compose -f docker-compose.dev.yml exec -T postgres \
      pg_isready -U dev -d "${SECONDARY_DB}" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge 15 ]; then
      red "Postgres DB (${SECONDARY_DB}) did not become ready within 15s."
      exit 1
    fi
    sleep 1
  done
  green "✓ Postgres ready (${SECONDARY_DB})"
done

# ── Summary ──────────────────────────────────────────────────
echo
bold "Local environment ready."
cat <<EOF
  Postgres:    postgresql://dev:dev@localhost:5432/trusty_squire
  Redis:       redis://localhost:6379
  MailHog UI:  http://localhost:8025
  MailHog SMTP: localhost:1025

Stop services:  docker compose -f docker-compose.dev.yml down
Reset data:     docker compose -f docker-compose.dev.yml down -v
EOF
