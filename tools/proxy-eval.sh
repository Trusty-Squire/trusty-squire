#!/usr/bin/env bash
# Evaluate a proxy endpoint BEFORE committing to it: what IP it exits from,
# whether detectors flag that IP as a proxy/hosting/datacenter address, its
# ASN/ISP (must be a real consumer ISP, not a hosting ASN), and whether it
# can actually load the services that wall the signup bot.
#
# This is a MEASUREMENT, not a vendor review — point it at a trial endpoint
# and let the numbers decide.
#
# Usage:
#   tools/proxy-eval.sh 'socks5://user:pass@host:port'
#   tools/proxy-eval.sh 'http://user:pass@host:port'
#   tools/proxy-eval.sh            # defaults to $UNIVERSAL_BOT_PROXY_URL
#
# Optional: IPQS_KEY=<key> adds IPQualityScore's numeric fraud score
# (free tier: ipqualityscore.com). Without it we use ip-api.com's free
# proxy/hosting/mobile booleans (no key, no signup) as the detection signal.
set -uo pipefail

PROXY="${1:-${UNIVERSAL_BOT_PROXY_URL:-}}"
if [ -z "$PROXY" ]; then
  echo "usage: $0 '<scheme>://[user:pass@]host:port'   (or set UNIVERSAL_BOT_PROXY_URL)" >&2
  exit 1
fi

# Force remote DNS for SOCKS — a residential exit should resolve DNS at the
# exit, not locally (local resolution leaks + can mismatch geo).
P="$PROXY"
case "$P" in socks5://*) P="socks5h://${P#socks5://}";; esac
CURL=(curl -s --max-time 25 -x "$P")

echo "== proxy-eval =="
echo "endpoint: ${PROXY%%@*}@***"   # don't echo credentials

# 1) Exit IP
EXIT_IP=$("${CURL[@]}" https://api.ipify.org 2>/dev/null || true)
if [ -z "$EXIT_IP" ]; then
  echo "EXIT IP: UNREACHABLE — the proxy didn't return an IP (down / bad creds / blocked)"
  exit 2
fi
echo "exit IP: $EXIT_IP"

# 2) IP intelligence via ip-api.com (free, no key; HTTP only on free tier).
#    Queried THROUGH the proxy so it classifies the exit IP. The proxy/
#    hosting/mobile booleans are the detection signal that matters.
INTEL=$("${CURL[@]}" "http://ip-api.com/json/?fields=status,country,city,isp,org,as,asname,proxy,hosting,mobile,query" 2>/dev/null || true)
if [ -n "$INTEL" ]; then
  python3 - "$INTEL" <<'PY'
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print("  ip-api: parse error"); sys.exit()
print(f"  geo:     {d.get('city','?')}, {d.get('country','?')}")
print(f"  ASN:     {d.get('as','?')}  ({d.get('asname','?')})")
print(f"  ISP/org: {d.get('isp','?')} / {d.get('org','?')}")
flags=[]
if d.get('proxy'):   flags.append("PROXY")
if d.get('hosting'): flags.append("HOSTING/DATACENTER")
if d.get('mobile'):  flags.append("MOBILE")
print(f"  flags:   {', '.join(flags) if flags else 'none (looks like a plain residential IP)'}")
# Heuristic verdict on the type.
verdict = "GOOD (residential-looking, unflagged)"
if d.get('hosting'): verdict = "BAD (hosting/datacenter ASN — will be treated as a bot exit)"
elif d.get('proxy'): verdict = "RISKY (detector already tags this IP as a proxy)"
elif d.get('mobile'): verdict = "EXCELLENT (mobile/CGNAT — highest trust)"
print(f"  verdict: {verdict}")
PY
else
  echo "  ip-api: no response (rate-limited? it's 45 req/min free)"
fi

# 3) Optional IPQS numeric fraud score (needs a free key).
if [ -n "${IPQS_KEY:-}" ] && [ -n "$EXIT_IP" ]; then
  IPQS=$(curl -s --max-time 20 "https://ipqualityscore.com/api/json/ip/${IPQS_KEY}/${EXIT_IP}" 2>/dev/null || true)
  echo "$IPQS" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  IPQS: parse error'); sys.exit()
fs=d.get('fraud_score')
print(f\"  IPQS fraud_score: {fs}  (>=85 suspicious, >=90 IPQS says block)  proxy={d.get('proxy')} vpn={d.get('vpn')} recent_abuse={d.get('recent_abuse')}\")
" 2>/dev/null || echo "  IPQS: lookup failed"
fi

# 4) Reachability to the services that walled the bot this session. A clean
#    IP is useless if it can't actually load these. Reports HTTP code + time.
echo "-- reachability to wall services (through the proxy) --"
for h in \
  "https://console.groq.com/" \
  "https://cloud.meilisearch.com/login" \
  "https://www.algolia.com/" \
  "https://getstream.io/" \
  "https://imagekit.io/" \
  "https://github.com/login" \
  "https://accounts.google.com/" ; do
  out=$("${CURL[@]}" -o /dev/null -w "%{http_code} %{time_total}s" "$h" 2>/dev/null || echo "FAIL")
  printf "  %-38s %s\n" "${h#https://}" "$out"
done
echo "(2xx/3xx = loads fine; 000/FAIL = the proxy can't reach it → dead on arrival)"
