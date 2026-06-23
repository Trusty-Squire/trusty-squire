#!/usr/bin/env bash
# Autonomous ledger drain loop (memory-overhaul Layer 4, operator driver).
#
# Each pass: pre-warm the verify pool (Edge 3 — the dominant 5-wide failure was
# stale-session needs_login, and the JIT re-warm is disabled under concurrency),
# build a YAML of the OPEN ledger services that have a curated signup URL and
# aren't a known wall, run discover 5-wide (drain-on-green auto-resolves the
# greens via the registry route), and repeat until a pass yields no NEW greens
# (convergence) or the pass cap.
#
# It does NOT try to make code-bug clusters (bot_crash, planning_failed) green —
# those need generalizable fixes, not re-runs; they remain as the honest
# residual. The walls stay walled. This drains exactly the re-runnable subset.
set -uo pipefail
cd /home/lunchbox/proj-ts
set -a; source ~/.config/trusty-squire/harvester.env; set +a
export DISPLAY=:99 UNIVERSAL_BOT_LLM_TIER=cheap HOUSEKEEPER_CONCURRENCY=5
BIN="node apps/mcp/dist/bin.js"
MAX_PASSES="${DRAIN_MAX_PASSES:-5}"

resolved_count() { $BIN housekeeper issue list --status resolved 2>/dev/null | grep -c '^  \[' || echo 0; }
open_count()     { $BIN housekeeper issue list --status open 2>/dev/null | grep -c '^  \[' || echo 0; }

build_yaml() {
  $BIN housekeeper issue list --status open 2>/dev/null \
    | grep '^  \[open\]' | sed -E 's/^  \[open\] ([^:]+):.*/\1/' | sort -u > /tmp/open-services.txt
  python3 - <<'PY'
import re
opn=set(l.strip() for l in open('/tmp/open-services.txt') if l.strip())
out=[]; seen=set()
for line in open('tools/discovery-candidates.yaml'):
    m=re.match(r'\s*-\s*\{\s*slug:\s*([^,]+),',line)
    if not m: continue
    s=m.group(1).strip()
    if s not in opn or s in seen or 'needs-manual' in line: continue
    nm=re.search(r'name:\s*([^,}]+)',line); su=re.search(r'signup_url:\s*([^,}\s]+)',line); op=re.search(r'oauth_provider:\s*([^,}\s]+)',line)
    if not su: continue
    e='- slug: %s'%s
    if nm: e+='\n  name: %s'%nm.group(1).strip()
    e+='\n  signup_url: %s'%su.group(1).strip()
    if op: e+='\n  oauth_provider: %s'%op.group(1).strip()
    out.append(e); seen.add(s)
open('/tmp/drain-pass.yaml','w').write('\n'.join(out)+'\n')
print(len(out))
PY
}

echo "===== WARM POOL $(date +%H:%M:%S) ====="
for n in 01 02 03 04 05 10 11 12 13 14; do
  echo -n "  verify-$n "; node tools/provision-verify-robot.mjs warm verify-$n 2>&1 | grep -oE 'logged in|❌.*' | head -1 || echo "?"
done

PASS=0
while :; do
  PASS=$((PASS+1))
  N=$(build_yaml)
  echo "===== PASS $PASS — $N attemptable open services — $(date +%H:%M:%S) ====="
  if [ "${N:-0}" -eq 0 ]; then echo "CONVERGED: no attemptable open services left"; break; fi
  BEFORE=$(resolved_count)
  node apps/mcp/dist/bin.js housekeeper --mode=discover --from=/tmp/drain-pass.yaml --once 2>&1 \
    | grep -E "discover end:|batch done:|SELF-DEADLINE"
  AFTER=$(resolved_count)
  echo "PASS $PASS RESULT: resolved $BEFORE -> $AFTER | open now $(open_count)"
  if [ "$AFTER" -le "$BEFORE" ]; then echo "CONVERGED: pass $PASS produced no new greens"; break; fi
  if [ "$PASS" -ge "$MAX_PASSES" ]; then echo "STOP: hit pass cap ($MAX_PASSES)"; break; fi
done
echo "===== DRAIN-LOOP DONE $(date +%H:%M:%S) ====="
echo "FINAL: open=$(open_count) resolved=$(resolved_count) wall=$($BIN housekeeper issue list --status wall 2>/dev/null | grep -c '^  \[') superseded=$($BIN housekeeper issue list --status superseded 2>/dev/null | grep -c '^  \[')"
