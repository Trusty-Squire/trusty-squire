#!/bin/sh
# PID 1 runs the unit ExecStart and exits with the broker's status.
# Docker's restart policy is the supervisor. This script does not start
# another broker when the first one dies.
set -u
entry=/opt/squire/node_modules/@trusty-squire/mcp/dist/bin.js
export HOME="${HOME:-/root}"
export TRUSTY_SQUIRE_PROFILE_DIR="${TRUSTY_SQUIRE_PROFILE_DIR:-/root/.trusty-squire/chrome-profile}"
export TRUSTY_SQUIRE_BROKER_UNIT=1
unset DISPLAY
unset TRUSTY_SQUIRE_BROKER_SOCKET
unset TRUSTY_SQUIRE_ACCOUNT_ID
unset TRUSTY_SQUIRE_MACHINE_TOKEN
mkdir -p "$TRUSTY_SQUIRE_PROFILE_DIR"
# The broker refuses a socket directory other users can read. mkdir -p
# follows the umask, so set the profile and its parent explicitly.
chmod 700 "$(dirname "$TRUSTY_SQUIRE_PROFILE_DIR")" "$TRUSTY_SQUIRE_PROFILE_DIR"
# A local fixture, not a real account. operate_start refuses until some
# session is on disk. The API base is loopback, so this does not call
# production and does not use the owner's account.
config="${HOME}/.config/trusty-squire"
mkdir -p "$config/sessions"
chmod 700 "$config" "$config/sessions"
fixture='{"account_id":"container-broker-test","agent_session_token":"container-broker-test-token","api_base_url":"http://127.0.0.1:9","saved_at":"2026-10-31T16:00:00.000Z"}'
printf '%s\n' "$fixture" > "$config/session.json"
printf '%s\n' "$fixture" > "$config/sessions/container-broker-test.json"
chmod 600 "$config/session.json" "$config/sessions/container-broker-test.json"
: > /tmp/broker.log
node "$entry" broker >>/tmp/broker.log 2>&1 &
echo $! >/tmp/broker.pid
echo "broker_pid=$(cat /tmp/broker.pid)"
wait "$(cat /tmp/broker.pid)"
status=$?
echo "broker_exit=$status"
exit "$status"
