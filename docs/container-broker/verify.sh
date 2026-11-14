#!/bin/sh
# Prove on-demand broker start in a container with no systemd user manager.
# Run from anywhere; paths are absolute.
set -eu
repo=$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)
data=/home/lunchbox/firstmate/data/ts-broker-on-demand-nosystemd
ctx=$(mktemp -d /tmp/ts-container-broker-ctx.XXXXXX)
evidence="$data/container-evidence.txt"
mkdir -p "$data"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/squire"

pnpm -C "$repo" --filter @trusty-squire/sdk --filter @trusty-squire/skill-schema --filter @trusty-squire/mcp build
pnpm -C "$repo" --filter @trusty-squire/mcp deploy "$ctx/squire" --prod
cp "$repo/docs/container-broker/Dockerfile" "$ctx/Dockerfile"
cp "$repo/docs/container-broker/entrypoint.sh" "$ctx/entrypoint.sh"
cp "$repo/docs/container-broker/vault-stub.py" "$ctx/vault-stub.py"
cp "$repo/docs/container-broker/client.mjs" "$ctx/client.mjs"
cp "$repo/docs/container-broker/systemctl" "$ctx/systemctl"

docker build -t ts-container-broker:test "$ctx"
docker rm -f ts-container-broker-runtime >/dev/null 2>&1 || true
docker run -d --name ts-container-broker-runtime ts-container-broker:test >/dev/null
i=0
while [ "$i" -lt 50 ]; do
  if docker logs ts-container-broker-runtime 2>&1 | grep -q 'container_idle=1'; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

{
  echo "=== first call ==="
  docker exec ts-container-broker-runtime node /opt/squire/client.mjs || echo "first_exit=$?"
  echo "=== brokers after first ==="
  docker exec ts-container-broker-runtime ps -eo pid,ppid,args
  echo "=== concurrent ==="
  docker exec ts-container-broker-runtime sh -c 'node /opt/squire/client.mjs > /tmp/c1.txt 2>&1 & node /opt/squire/client.mjs > /tmp/c2.txt 2>&1 & wait; echo --- c1 ---; cat /tmp/c1.txt; echo --- c2 ---; cat /tmp/c2.txt'
  echo "=== brokers after concurrent ==="
  docker exec ts-container-broker-runtime sh -c 'ps -eo pid,args | grep "[d]ist/bin.js broker" || true'
  echo "=== kill broker ==="
  docker exec ts-container-broker-runtime sh -c 'pid=$(ps -eo pid,args | awk "/dist\\/bin.js broker/{print \$1; exit}"); echo kill=$pid; if [ -n "$pid" ]; then kill -9 "$pid" || true; fi'
  sleep 2
  echo "=== brokers after kill (must be none) ==="
  docker exec ts-container-broker-runtime sh -c 'ps -eo pid,args | grep "[d]ist/bin.js broker" || true'
  echo "=== next call after kill ==="
  docker exec ts-container-broker-runtime node /opt/squire/client.mjs || echo "after_kill_exit=$?"
  echo "=== fail to start ==="
  docker exec ts-container-broker-runtime sh -c 'pid=$(ps -eo pid,args | awk "/dist\\/bin.js broker/{print \$1; exit}"); if [ -n "$pid" ]; then kill -9 "$pid" || true; fi; sleep 1; printf x > /tmp/ts-ondemand-notdir; TRUSTY_SQUIRE_BROKER_SOCKET=/tmp/ts-ondemand-notdir/broker.sock node /opt/squire/client.mjs; echo fail_exit=$?'
  echo "=== processes after failed start ==="
  docker exec ts-container-broker-runtime ps -eo pid,ppid,args
} > "$evidence" 2>&1 || true

docker rm -f ts-container-broker-runtime >/dev/null 2>&1 || true
echo "wrote $evidence"

fail() {
  echo "$1" >&2
  exit 1
}
section() {
  awk -v title="$1" '$0==title{p=1;next} /^=== /{p=0} p' "$evidence"
}
grep -q 'CLIENT list_credentials .* isError=false' "$evidence" || fail "list_credentials did not succeed"
first_brokers=$(section "=== brokers after first ===" | grep -c '[d]ist/bin.js broker' || true)
[ "$first_brokers" -eq 1 ] || fail "expected one broker after first call, got $first_brokers"
concurrent_brokers=$(section "=== brokers after concurrent ===" | grep -c '[d]ist/bin.js broker' || true)
[ "$concurrent_brokers" -eq 1 ] || fail "expected one broker after concurrent clients, got $concurrent_brokers"
after_kill=$(section "=== brokers after kill (must be none) ===" | grep -c '[d]ist/bin.js broker' || true)
[ "$after_kill" -eq 0 ] || fail "broker restarted after kill, count=$after_kill"
section "=== next call after kill ===" | grep -q 'RESULT pass' || fail "next call after kill did not pass"
section "=== fail to start ===" | grep -qi 'failed to start' || fail "failed start did not surface the broker error"
section "=== fail to start ===" | grep -q 'No retry was attempted' || fail "failed start did not say no retry"
after_fail=$(section "=== processes after failed start ===" | grep -c '[d]ist/bin.js broker' || true)
[ "$after_fail" -eq 0 ] || fail "failed start left broker processes, count=$after_fail"
echo "container verify passed"
