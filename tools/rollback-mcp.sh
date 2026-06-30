#!/usr/bin/env bash
# Emergency npm rollback for @trusty-squire/mcp (checklist #11).
#
# npm can't unpublish (and unpublishing breaks every pinned install), so a
# rollback = repoint the `latest` dist-tag at the last known-good version —
# instant for every new `npx` / `npm i` — then deprecate the bad one. Fix
# forward with a patch afterward (pnpm release:mcp <next>).
#
# Needs NPM_AUTOMATION_TOKEN: npmjs.com → Access Tokens → Automation. The
# account's passkey-2FA makes interactive npm writes fail with EOTP, so the
# automation token is the only thing that works non-interactively.
#
# Usage:
#   NPM_AUTOMATION_TOKEN=… tools/rollback-mcp.sh <last-good-version> [<bad-version>]
#   NPM_AUTOMATION_TOKEN=… tools/rollback-mcp.sh 1.0.7          # move latest -> 1.0.7
#   NPM_AUTOMATION_TOKEN=… tools/rollback-mcp.sh 1.0.7 1.0.8    # ...and deprecate 1.0.8
set -euo pipefail

PKG="@trusty-squire/mcp"
GOOD="${1:?usage: rollback-mcp.sh <last-good-version> [<bad-version>]}"
BAD="${2:-}"
: "${NPM_AUTOMATION_TOKEN:?set NPM_AUTOMATION_TOKEN (npmjs.com -> Access Tokens -> Automation)}"

NPMRC="$(mktemp)"
trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_AUTOMATION_TOKEN" > "$NPMRC"

# Refuse to point `latest` at a version that was never published.
if ! npm view "${PKG}@${GOOD}" version --userconfig "$NPMRC" >/dev/null 2>&1; then
  echo "ERROR: ${PKG}@${GOOD} is not published — pick a version that exists." >&2
  echo "Published versions:" >&2
  npm view "$PKG" versions --userconfig "$NPMRC" >&2 || true
  exit 1
fi

echo "Before: $(npm view "$PKG" dist-tags --userconfig "$NPMRC")"
echo "Pointing 'latest' -> ${GOOD} ..."
npm dist-tag add "${PKG}@${GOOD}" latest --userconfig "$NPMRC"

if [ -n "$BAD" ]; then
  echo "Deprecating ${PKG}@${BAD} ..."
  npm deprecate "${PKG}@${BAD}" \
    "Broken release — rolled back. Use ${PKG}@${GOOD} or newer." \
    --userconfig "$NPMRC" || echo "(deprecate failed; non-fatal)"
fi

echo "After:  $(npm view "$PKG" dist-tags --userconfig "$NPMRC")"
echo
echo "Done. New installs of ${PKG} now resolve to ${GOOD}."
echo "Reminder: users who already npx-cached the bad version keep it until their"
echo "cache expires/clears (npx clear-npx-cache). Then fix forward: pnpm release:mcp <next-patch>."
