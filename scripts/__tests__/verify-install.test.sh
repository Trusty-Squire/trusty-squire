#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

MOCK_BIN="$TEST_DIR/bin"
STATE_DIR="$TEST_DIR/state"
mkdir -p "$MOCK_BIN" "$STATE_DIR"

cat >"$MOCK_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  view)
    if [[ "${3:-}" == "version" ]]; then
      echo "1.2.3"
    else
      echo '{"latest":"1.2.3"}'
    fi
    ;;
  init)
    ;;
  install)
    count=0
    if [[ -f "$STATE_DIR/install-count" ]]; then
      count=$(<"$STATE_DIR/install-count")
    fi
    count=$((count + 1))
    echo "$count" >"$STATE_DIR/install-count"

    if [[ " $* " != *" --prefer-online "* ]]; then
      echo "missing --prefer-online" >&2
      exit 65
    fi
    echo "called" >>"$STATE_DIR/prefer-online-calls"

    if [[ "$TEST_MODE" == "failure" ]]; then
      echo "npm ERR! simulated network failure" >&2
      exit 42
    fi

    version="1.2.2"
    if [[ "$TEST_MODE" == "stale-then-current" && $count -gt 1 ]]; then
      version="1.2.3"
    fi
    mkdir -p "node_modules/@scope/example"
    printf '{"version":"%s"}\n' "$version" >"node_modules/@scope/example/package.json"
    ;;
  *)
    exit 64
    ;;
esac
EOF

cat >"$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-sI" ]]; then
  echo "HTTP/1.1 200 OK"
else
  echo '{"dist-tags":{"latest":"1.2.3"}}'
fi
EOF

cat >"$MOCK_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo "called" >>"$STATE_DIR/sleep-calls"
EOF

chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/curl" "$MOCK_BIN/sleep"

run_verifier() {
  local mode=$1
  set +e
  OUTPUT=$(PATH="$MOCK_BIN:$PATH" STATE_DIR="$STATE_DIR" TEST_MODE="$mode" \
    bash "$ROOT_DIR/scripts/verify-install.sh" "@scope/example" "1.2.3" 2>&1)
  STATUS=$?
  set -e
}

reset_state() {
  rm -f "$STATE_DIR"/*
}

run_verifier failure

if [[ $STATUS -eq 0 ]]; then
  echo "Expected verifier to fail when npm install fails"
  exit 1
fi

if [[ "$(<"$STATE_DIR/install-count")" != "1" ]]; then
  echo "Expected one npm install attempt"
  exit 1
fi

if [[ -e "$STATE_DIR/sleep-calls" ]]; then
  echo "Expected no retry delay after npm install failure"
  exit 1
fi

if [[ "$OUTPUT" != *"FAIL: npm install @scope/example@latest failed on attempt 1"* ]]; then
  echo "Expected immediate npm install failure"
  exit 1
fi

if [[ "$OUTPUT" != *"npm ERR! simulated network failure"* ]]; then
  echo "Expected npm diagnostics in verifier output"
  exit 1
fi

reset_state
run_verifier stale-then-current

if [[ $STATUS -ne 0 ]]; then
  echo "Expected verifier to recover from one stale install"
  printf '%s\n' "$OUTPUT"
  exit 1
fi

if [[ "$(<"$STATE_DIR/install-count")" != "2" ]]; then
  echo "Expected two npm install attempts"
  exit 1
fi

if [[ "$(wc -l <"$STATE_DIR/prefer-online-calls")" != "2" ]]; then
  echo "Expected every npm install to prefer online metadata"
  exit 1
fi

if [[ "$(wc -l <"$STATE_DIR/sleep-calls")" != "1" ]]; then
  echo "Expected one retry delay"
  exit 1
fi

if [[ "$OUTPUT" != *"Attempt 1 installed '1.2.2'; retrying in 10s"* ]]; then
  echo "Expected stale install retry diagnostics"
  exit 1
fi

reset_state
run_verifier always-stale

if [[ $STATUS -eq 0 ]]; then
  echo "Expected verifier to fail after exhausting stale installs"
  exit 1
fi

if [[ "$(<"$STATE_DIR/install-count")" != "30" ]]; then
  echo "Expected a five-minute retry budget of 30 attempts"
  exit 1
fi

if [[ "$(wc -l <"$STATE_DIR/prefer-online-calls")" != "30" ]]; then
  echo "Expected every retry to prefer online metadata"
  exit 1
fi

if [[ "$(wc -l <"$STATE_DIR/sleep-calls")" != "29" ]]; then
  echo "Expected 29 retry delays"
  exit 1
fi

if [[ "$OUTPUT" != *"expected 1.2.3 after 30 attempts"* ]]; then
  echo "Expected exhausted retry diagnostics"
  exit 1
fi

echo "verify-install retry handling: OK"
