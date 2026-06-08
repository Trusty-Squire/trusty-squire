#!/usr/bin/env bash
# secret-scan.sh — block real captured credentials from entering the repo.
#
# WHY THIS EXISTS: on 2026-06-08 a live Pusher app_key + secret captured by
# the universal bot got pasted into a committed test fixture, and GitGuardian
# flagged it as exposed within ~2 hours. This repo's whole thesis is a
# write-only credential vault — secrets never enter context or commits. A
# captured value is a REAL secret; a fixture is a public artifact. They must
# never meet. This guard is the mechanical enforcement of that rule.
#
# It scans git-tracked text files for credential-shaped strings (the prefixes
# the bot actually captures + generic secret=hex assignments + JWTs), with an
# allowlist for obvious synthetic placeholders. Dependency-free: bash + grep.
#
# Usage:
#   tools/secret-scan.sh                # scan all tracked files
#   tools/secret-scan.sh --staged       # scan only staged changes (pre-commit)
#   tools/secret-scan.sh file1 file2    # scan specific files
#
# Exit 0 = clean. Exit 1 = a real secret-shaped value was found (CI fails).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# --- patterns: credential shapes worth blocking -----------------------------
# Each is an ERE. Kept intentionally tight so false positives stay rare —
# a noisy guard gets ignored (the way the old workspace-wide lint was).
PATTERNS=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                       # Anthropic
  'sk-or-v1-[A-Za-z0-9]{20,}'                        # OpenRouter
  'sk-proj-[A-Za-z0-9_-]{20,}'                       # OpenAI project key
  'sk-[A-Za-z0-9]{32,}'                              # generic OpenAI-style
  'gh[pousr]_[A-Za-z0-9]{36,}'                       # GitHub PAT / OAuth / refresh
  'gsk_[A-Za-z0-9]{40,}'                             # Groq
  'sntrys_[A-Za-z0-9_=]{30,}'                         # Sentry
  're_[A-Za-z0-9]{20,}'                              # Resend
  'xox[baprs]-[A-Za-z0-9-]{10,}'                     # Slack
  'AKIA[0-9A-Z]{16}'                                 # AWS access key id
  'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'  # JWT
  # generic: a secret-ish name assigned a 20+ char hex/base62 literal
  "(secret|api[_-]?key|app[_-]?key|app[_-]?secret|client[_-]?secret|password|access[_-]?token|admin[_-]?key)['\"]?[[:space:]]*[:=][[:space:]]*['\"][0-9a-fA-F]{20,}['\"]"
)

# --- allowlist: lines containing any of these are obviously-synthetic --------
# Case-insensitive substring match on the matched line.
ALLOW='example|redacted|placeholder|dummy|fake|sample|changeme|your[_-]?(key|token|secret)|xxxxxxxx|deadbeef|0000000000|1234567890|abcdef0123|abcdefghij|abc123def456|test[_-]?(key|token|secret)|a{20,}|<[a-z_]+>|EXAMPLE'

# --- gather files -----------------------------------------------------------
if [ "${1:-}" = "--staged" ]; then
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACM)
elif [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(git ls-files)
fi

# Skip this scanner itself (it contains the patterns), the lockfile (integrity
# hashes look base64-ish but aren't secrets), and binary/minified noise.
SKIP_RE='^(tools/secret-scan\.sh|pnpm-lock\.yaml|.*\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|min\.js|map))$'

hits=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  [[ "$f" =~ $SKIP_RE ]] && continue
  # text files only
  grep -Iq . "$f" 2>/dev/null || continue
  for pat in "${PATTERNS[@]}"; do
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # strip "file:lineno:" prefix to test the content against the allowlist
      content="${line#*:}"; content="${content#*:}"
      if printf '%s' "$content" | grep -qiE "$ALLOW"; then
        continue
      fi
      if [ "$hits" -eq 0 ]; then
        echo "❌ secret-scan: credential-shaped value(s) found in tracked files:" >&2
        echo >&2
      fi
      echo "  $line" >&2
      hits=$((hits + 1))
    done < <(grep -nEI "$pat" "$f" 2>/dev/null || true)
  done
done

if [ "$hits" -gt 0 ]; then
  echo >&2
  echo "  $hits match(es). If these are REAL secrets: remove them, and rotate/" >&2
  echo "  delete the exposed account (git history keeps the value otherwise)." >&2
  echo "  If they are test fixtures: use synthetic placeholders (example…, test…)." >&2
  echo "  See the no-real-creds-in-fixtures rule in CLAUDE.md / memory." >&2
  exit 1
fi

echo "✅ secret-scan: clean ($(printf '%s\n' "${FILES[@]}" | grep -c . ) file(s) scanned)"
