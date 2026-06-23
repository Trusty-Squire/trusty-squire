#!/usr/bin/env bash
# system-truth — one command, the AUTHORITATIVE live state of every layer.
#
# The point: stop reading an agent's prose for "is it shipped / deployed /
# active." Run this; read the output. Each line proves a fact end-to-end, not
# from a local test or committed code (the two that lied this project's worst:
# a published package that didn't boot, and an API route that wasn't deployed).
#
# Read-only. Sources session.json (machine token) + harvester.env (admin bearer).
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
SESS="$HOME/.config/trusty-squire/session.json"
[ -f "$SESS" ] && { MTOK="$(node -e 'process.stdout.write(require(process.env.HOME+"/.config/trusty-squire/session.json").machine_token||"")' 2>/dev/null)"; } || MTOK=""
[ -f "$HOME/.config/trusty-squire/harvester.env" ] && { set -a; . "$HOME/.config/trusty-squire/harvester.env"; set +a; }
API="${TRUSTY_SQUIRE_API_BASE:-https://trusty-squire-api.fly.dev}"
REG="${TRUSTY_SQUIRE_REGISTRY_URL:-https://registry.trustysquire.ai}"
code() { curl -s -o /dev/null -w "%{http_code}" -m 12 "$@" 2>/dev/null || echo "ERR"; }

echo "===================== SYSTEM TRUTH ($(date -u +%H:%M:%SZ)) ====================="

echo "-- npm (@trusty-squire/mcp) --------------------------------------------------"
npm view @trusty-squire/mcp dist-tags 2>/dev/null | tr -d '{} ' | sed 's/^/  dist-tags: /'
LATEST=$(npm view @trusty-squire/mcp dist-tags.latest 2>/dev/null)
echo "  boot smoke (clean-install latest=$LATEST + start server):"
( cd /tmp && rm -rf .systruth && mkdir .systruth && cd .systruth \
    && npm install "@trusty-squire/mcp@$LATEST" >/dev/null 2>&1 \
    && timeout 12 node node_modules/@trusty-squire/mcp/dist/bin.js server </dev/null >/dev/null 2>/tmp/.systruth.err & p=$!; sleep 9; kill $p 2>/dev/null
  if grep -qiE "does not provide an export|SyntaxError|Cannot find package" /tmp/.systruth.err; then
    echo "    ❌ BOOT CRASH — $(head -1 /tmp/.systruth.err)"
  elif grep -qi "server v.* starting" /tmp/.systruth.err; then
    echo "    ✅ boots — $(grep -i 'starting' /tmp/.systruth.err | head -1)"
  else echo "    ⚠ unknown — $(head -1 /tmp/.systruth.err 2>/dev/null)"; fi )

echo "-- deployed API ($API) -------------------------------------------------------"
echo "  route presence (401=deployed+auth-gated, 404=NOT deployed):"
for r in "POST /v1/egress/grants" "POST /v1/vault/use" "GET /v1/vault/credentials"; do
  m="${r%% *}"; path="${r##* }"
  c=$(code -X "$m" "$API$path" -H "content-type: application/json" -d '{}')
  flag=$([ "$c" = "404" ] && echo "❌ NOT DEPLOYED" || echo "✅")
  printf "    %-28s → %s %s\n" "$r" "$c" "$flag"
done
if [ -n "$MTOK" ]; then
  echo "  OpenRouter credit:"
  curl -s -m 12 "$API/v1/llm/credits" -H "Authorization: Bearer $MTOK" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"    remaining=\${d.get('remaining'):.2f} of \${d.get('total_credits')}\")" 2>/dev/null || echo "    (unavailable)"
fi

echo "-- registry ($REG) ----------------------------------------------------------"
if [ -n "${REGISTRY_ADMIN_BEARER:-}" ]; then
  curl -s -m 15 "$REG/admin/verifier/queue" -H "Authorization: Bearer $REGISTRY_ADMIN_BEARER" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);q=d if isinstance(d,list) else d.get('queue') or d.get('items') or d.get('skills') or [];print(f'  verifier queue (pending/rot): {len(q)} skills');[print('   ',s.get('service'),s.get('status')) for s in q[:12]]" 2>/dev/null || echo "  (queue unavailable)"
else echo "  (no REGISTRY_ADMIN_BEARER — set in harvester.env)"; fi

echo "-- this checkout -------------------------------------------------------------"
echo "  branch: $(git branch --show-current 2>/dev/null)  HEAD: $(git rev-parse --short HEAD 2>/dev/null)  uncommitted: $(git status --porcelain 2>/dev/null | grep -vc '^?? .claude')"
echo "=============================================================================="
