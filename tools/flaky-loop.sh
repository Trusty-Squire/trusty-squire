#!/usr/bin/env bash
# flaky-loop.sh — the iterate-to-100% validation harness.
#
# Runs N real signups per service SERIALLY (shared Chrome profile + a single
# Xvfb / SingletonLock mean concurrency is unsafe), records each attempt's
# outcome + failure reason, and prints a per-service pass-rate table. The loop
# is: run → read the failures → fix the bot generally → rebuild dist → re-run,
# until a service hits 100%.
#
# Usage:
#   [N=10] tools/flaky-loop.sh <service> [service ...]
#   N=10 tools/flaky-loop.sh anthropic
#   N=5  tools/flaky-loop.sh cartesia pinecone meilisearch
#
# Reads harvester.env for the machine token / account / registry / egress.
# Refuses to start if a housekeeper is already running (would collide on the
# profile). Logs land in /tmp/flaky-<timestamp>/.
set -uo pipefail

N="${N:-10}"
SERVICES="$*"
if [ -z "$SERVICES" ]; then
  echo "usage: [N=10] tools/flaky-loop.sh <service> [service ...]" >&2
  exit 1
fi

# Profile-collision guard — serial only.
if pgrep -f "bin.js housekeeper" >/dev/null 2>&1; then
  echo "ERROR: a housekeeper is already running — free the profile before running the loop." >&2
  exit 1
fi

ENV_FILE="$HOME/.config/trusty-squire/harvester.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  echo "WARN: $ENV_FILE not found — discover may fail without a machine token." >&2
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="/tmp/flaky-$TS"
mkdir -p "$OUT"
RES="$OUT/results.tsv"
printf 'service\tattempt\toutcome\treason\n' > "$RES"

for svc in $SERVICES; do
  ok=0; total=0
  for i in $(seq 1 "$N"); do
    log="$OUT/$svc-$i.log"
    node apps/mcp/dist/bin.js housekeeper \
      --service="$svc" --from=tools/discovery-candidates.yaml --once \
      > "$log" 2>&1 || true
    line="$(grep -oE "discover end:[[:space:]]+$svc → (ok|failed|blocked).*" "$log" | tail -1)"
    total=$((total+1))
    if printf '%s' "$line" | grep -q "→ ok"; then
      ok=$((ok+1)); out=ok
    elif printf '%s' "$line" | grep -q "→ blocked"; then
      out=blocked
    else
      out=fail
    fi
    reason="$(printf '%s' "$line" | sed -E 's/.*→ (ok|failed|blocked) ?\(?//; s/\)+$//' | cut -c1-110)"
    printf '%s\t%d\t%s\t%s\n' "$svc" "$i" "$out" "$reason" >> "$RES"
    echo "[$svc $i/$N] $out — ${reason:-（no discover-end line; see $log）}"
  done
  echo "=== $svc: $ok/$total passed ==="
done

echo
echo "=== SUMMARY ($TS) ==="
awk -F'\t' 'NR>1{t[$1]++; if($3=="ok")o[$1]++}
  END{for(s in t) printf "%-22s %d/%d (%d%%)\n", s, o[s]+0, t[s], (o[s]+0)*100/t[s]}' "$RES" | sort
echo "logs: $OUT  ·  results: $RES"
