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
    echo $((count + 1)) >"$STATE_DIR/install-count"
    echo "npm ERR! simulated network failure" >&2
    exit 42
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

set +e
OUTPUT=$(PATH="$MOCK_BIN:$PATH" STATE_DIR="$STATE_DIR" bash "$ROOT_DIR/scripts/verify-install.sh" "@scope/example" "1.2.3" 2>&1)
STATUS=$?
set -e

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

echo "verify-install npm failure handling: OK"
