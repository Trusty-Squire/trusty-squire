#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

FIXTURE="$TEST_DIR/resend-key.txt"
# Build the synthetic key at runtime so the repository-wide scanner does not
# flag its own regression fixture.
printf 're_%s_%s\n' "N7qP4vX9mK2sT8wZ" "R6bC3dF5hJ1lG0uY" >"$FIXTURE"

set +e
OUTPUT=$(bash "$ROOT_DIR/tools/secret-scan.sh" "$FIXTURE" 2>&1)
STATUS=$?
set -e

if [[ $STATUS -eq 0 ]]; then
  echo "Expected an underscore-bearing Resend key to be rejected"
  exit 1
fi

if [[ "$OUTPUT" != *"credential-shaped value(s) found"* ]]; then
  echo "Expected secret-scan diagnostics"
  exit 1
fi

echo "secret-scan Resend key handling: OK"
