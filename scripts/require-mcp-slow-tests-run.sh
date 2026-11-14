#!/usr/bin/env bash
# Stable-promotion gate: require a successful "MCP slow tests" workflow run
# for this exact SHA. mcp-slow-tests.yml already runs
# `pnpm --filter @trusty-squire/mcp test:real-browser` on every qualifying
# push to main; a promotion must reuse that result instead of spending
# ~25min re-running the suite. Missing, in-progress, or failed runs fail
# this script; it never launches the tests itself.
#
# Usage: require-mcp-slow-tests-run.sh [<sha>] [<owner/repo>]
# Defaults: $GITHUB_SHA and $GITHUB_REPOSITORY (set on GitHub Actions).
# Talks to the GitHub API via `gh`. Needs `actions: read` on GITHUB_TOKEN.

set -euo pipefail

SHA="${1:-${GITHUB_SHA:-}}"
REPO="${2:-${GITHUB_REPOSITORY:-}}"
WORKFLOW="${MCP_SLOW_TESTS_WORKFLOW:-mcp-slow-tests.yml}"

if [[ -z "$SHA" || -z "$REPO" ]]; then
  echo "Usage: $0 <sha> [owner/repo]" >&2
  echo "  or set GITHUB_SHA and GITHUB_REPOSITORY." >&2
  exit 2
fi

RUNS_JSON=$(mktemp)
trap 'rm -f "$RUNS_JSON"' EXIT
gh api "repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${SHA}&per_page=20" > "$RUNS_JSON"

python3 - "$SHA" "$RUNS_JSON" <<'PY'
import json
import sys

sha = sys.argv[1]
path = sys.argv[2]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    print(
        f"::error::Failed to parse MCP slow tests API response for SHA {sha}: {exc}",
        file=sys.stderr,
    )
    sys.exit(1)

runs = data.get("workflow_runs") or []


def fmt(run: object) -> str:
    if not isinstance(run, dict):
        return f"MCP slow tests run (unreadable) for SHA {sha}"
    rid = run.get("id")
    url = run.get("html_url") or f"id={rid}"
    status = run.get("status")
    conclusion = run.get("conclusion")
    event = run.get("event")
    return (
        f"MCP slow tests run {url} (id={rid}, event={event}, "
        f"status={status}, conclusion={conclusion}) for SHA {sha}"
    )


if not runs:
    print(
        f"::error::No MCP slow tests workflow run for SHA {sha}. "
        "Promotion requires a successful mcp-slow-tests.yml run for this exact SHA "
        "(push path runs pnpm --filter @trusty-squire/mcp test:real-browser). "
        'Dispatch "MCP slow tests" on this SHA, wait for success, then re-run this promotion. '
        "This job does not run the real-browser suite itself.",
        file=sys.stderr,
    )
    sys.exit(1)

unfinished = [r for r in runs if isinstance(r, dict) and r.get("status") != "completed"]
if unfinished:
    print(
        f"::error::{fmt(unfinished[0])} is still running. "
        "Wait for it to finish, then re-run this promotion. "
        "This job does not run the real-browser suite itself.",
        file=sys.stderr,
    )
    sys.exit(1)

successes = [
    r
    for r in runs
    if isinstance(r, dict) and r.get("conclusion") == "success"
]
successes.sort(key=lambda r: 0 if r.get("event") == "push" else 1)
if not successes:
    print(
        f"::error::{fmt(runs[0])} did not succeed. "
        "Promotion requires conclusion=success. "
        "This job does not run the real-browser suite itself.",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    f"{fmt(successes[0])} concluded success. "
    "Reusing that real-browser result; this job does not re-run the suite."
)
sys.exit(0)
PY
