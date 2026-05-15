#!/usr/bin/env bash
# Wrapper for cloudflared that extracts the tunnel URL and writes it to a file

URL_FILE="$1"
shift

# Run cloudflared and capture URL
cloudflared "$@" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    echo "${BASH_REMATCH[0]}" > "$URL_FILE"
  fi
done
