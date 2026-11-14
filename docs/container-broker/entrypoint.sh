#!/bin/sh
# Prepare a fixture session and a loopback vault stub, then idle.
# This image has no systemd user manager and no broker supervisor.
# The first `mcp server` tool call starts one broker.
set -u
export HOME="${HOME:-/root}"
export TRUSTY_SQUIRE_PROFILE_DIR="${TRUSTY_SQUIRE_PROFILE_DIR:-/root/.trusty-squire/chrome-profile}"
unset DISPLAY
unset TRUSTY_SQUIRE_BROKER_SOCKET
unset TRUSTY_SQUIRE_ACCOUNT_ID
unset TRUSTY_SQUIRE_MACHINE_TOKEN
unset TRUSTY_SQUIRE_BROKER_UNIT
unset INVOCATION_ID
mkdir -p "$TRUSTY_SQUIRE_PROFILE_DIR"
chmod 700 "$(dirname "$TRUSTY_SQUIRE_PROFILE_DIR")" "$TRUSTY_SQUIRE_PROFILE_DIR"
config="${HOME}/.config/trusty-squire"
mkdir -p "$config/sessions"
chmod 700 "$config" "$config/sessions"
fixture='{"account_id":"container-broker-test","agent_session_token":"container-broker-test-token","api_base_url":"http://127.0.0.1:18765","saved_at":"2026-10-31T16:00:00.000Z"}'
printf '%s\n' "$fixture" > "$config/session.json"
printf '%s\n' "$fixture" > "$config/sessions/container-broker-test.json"
chmod 600 "$config/session.json" "$config/sessions/container-broker-test.json"
# Keep this shell as PID 1. exec would SIGHUP the stub.
python3 /opt/squire/vault-stub.py &
i=0
while [ "$i" -lt 50 ]; do
  if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18765/v1/vault/credentials')" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
echo "container_idle=1"
while :; do
  sleep 3600
done
