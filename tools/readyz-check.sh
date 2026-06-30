#!/usr/bin/env bash
# API readiness alert (checklist #3). Polls GET /readyz — which returns 503 when
# the DB is unreachable (the 256MB OOM-wedge failure mode; /health stays shallow
# for Fly liveness so it can't catch this) — and pings Telegram when it's down.
# Revived from the openrouter-credit-check.sh pattern. Cron it on the housekeeper
# box, e.g. every 5 minutes:
#
#   */5 * * * * bash -lc 'set -a; . ~/.config/trusty-squire/harvester.env; set +a; ~/proj-ts/tools/readyz-check.sh' >> ~/.trusty-squire/logs/readyz-check.log 2>&1
#
# Reads (env or defaults):
#   TRUSTY_SQUIRE_API_BASE   API base (default prod)
#   TELEGRAM_BOT_TOKEN       bot token (from @BotFather); no push if unset
# Telegram chat id is read from the operator's local file (same as the credit check).
set -euo pipefail

API_BASE="${TRUSTY_SQUIRE_API_BASE:-https://trusty-squire-api.fly.dev}"
CHAT_ID_FILE="${HOME}/.trusty-squire/telegram-chat-id.txt"
URL="${API_BASE}/readyz"

# Two attempts 10s apart so a single transient blip doesn't page.
healthy=0
for attempt in 1 2; do
  code=$(curl -s --max-time 10 -o /tmp/readyz-body -w '%{http_code}' "$URL" 2>/dev/null || echo "000")
  body=$(cat /tmp/readyz-body 2>/dev/null || true)
  printf 'attempt %s: HTTP %s — %s\n' "$attempt" "$code" "$body"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ready":true'; then
    healthy=1
    break
  fi
  [ "$attempt" = "1" ] && sleep 10
done

if [ "$healthy" = "1" ]; then
  echo "readyz OK"
  exit 0
fi

msg="🔴 Trusty Squire: /readyz DOWN — HTTP ${code} (${body:-no body}). The DB is likely unreachable (OOM-wedge?). Check: https://fly.io/apps/trusty-squire-api/monitoring"
echo "$msg" >&2

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f "${CHAT_ID_FILE}" ]; then
  CHAT_ID=$(tr -d '[:space:]' < "${CHAT_ID_FILE}")
  if [ -n "${CHAT_ID}" ]; then
    curl -s --max-time 15 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null 2>&1 \
      && echo "telegram alert sent" >&2 || echo "telegram send failed" >&2
  fi
fi
exit 2
