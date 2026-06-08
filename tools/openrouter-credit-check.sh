#!/usr/bin/env bash
# OpenRouter low-credit alert. The 0.9.6 incident was the operator's
# OpenRouter account hitting zero credits (cheap+premium 402) — invisible
# until signups silently failed. This polls GET /v1/llm/credits and pings
# Telegram when the remaining balance drops below a threshold. Cron it on
# the housekeeper box (e.g. hourly):
#
#   0 * * * * TELEGRAM_BOT_TOKEN=... /path/to/tools/openrouter-credit-check.sh
#
# Reads (env or defaults):
#   OPENROUTER_CREDIT_THRESHOLD  alert below this many USD (default 10)
#   TRUSTY_SQUIRE_API_BASE       API base (default prod)
#   TELEGRAM_BOT_TOKEN           bot token (from @BotFather); no alert if unset
# Machine token + Telegram chat id are read from the operator's local files.
set -euo pipefail

THRESHOLD="${OPENROUTER_CREDIT_THRESHOLD:-10}"
API_BASE="${TRUSTY_SQUIRE_API_BASE:-https://trusty-squire-api.fly.dev}"
SESSION="${HOME}/.config/trusty-squire/session.json"
CHAT_ID_FILE="${HOME}/.trusty-squire/telegram-chat-id.txt"

MT=$(python3 -c "import json;print(json.load(open('${SESSION}'))['machine_token'])" 2>/dev/null || true)
if [ -z "${MT:-}" ]; then
  echo "no machine token at ${SESSION} — run 'mcp connect' first" >&2
  exit 1
fi

resp=$(curl -s --max-time 30 -H "Authorization: Bearer ${MT}" "${API_BASE}/v1/llm/credits" 2>/dev/null || true)
remaining=$(printf '%s' "$resp" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print(d.get('remaining',''))
except Exception:
    print('')" 2>/dev/null)

if [ -z "${remaining}" ]; then
  echo "credit check failed: ${resp:-<no response>}" >&2
  exit 1
fi

printf 'OpenRouter remaining: $%.2f (threshold $%s)\n' "$remaining" "$THRESHOLD"

# Below threshold → alert.
below=$(python3 -c "print(1 if float('${remaining}') < float('${THRESHOLD}') else 0)")
if [ "$below" != "1" ]; then
  exit 0
fi

msg="⚠️ Trusty Squire: OpenRouter balance LOW — \$$(printf '%.2f' "$remaining") remaining (< \$${THRESHOLD}). Top up before paid-tier signups start failing with 402."
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
