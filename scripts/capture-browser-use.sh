#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
capture_root="$PWD/.local/browser-use"
mkdir -p "$capture_root"
export XDG_CONFIG_HOME="$capture_root/config"
export XDG_CACHE_HOME="$capture_root/cache"
export BROWSER_USE_CONFIG_DIR="$capture_root/config/browser-use"
export ANONYMIZED_TELEMETRY=false
# Chrome's SingletonSocket must fit Linux's 108-byte Unix socket path limit.
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"
export PIP_CACHE_DIR="$capture_root/cache/pip"
export PIP_DISABLE_PIP_VERSION_CHECK=1
python3 -m venv "$capture_root/venv"
"$capture_root/venv/bin/pip" install 'browser-use==0.13.10'
exec "$capture_root/venv/bin/python" scripts/capture-browser-use.py "$@"
