#!/usr/bin/env bash
# Run this ON THE MAC. Launches a REAL-GPU Chrome with a CDP endpoint and
# bridges that endpoint onto the Tailscale interface, so the signup bot running
# on the Linux box can attach over CDP (BOT_CDP_ENDPOINT) and drive it remotely.
#
# Why: the Linux harvester box has no GPU — Chrome renders WebGL with llvmpipe
# (software), and the toughest anti-bot (hCaptcha Enterprise on Stripe) hashes
# the actual rendered pixels, which software rendering can't fake. The Mac has a
# real GPU (Metal/ANGLE) AND a residential IP — running Chrome HERE fixes both
# the rendered-pixel fingerprint and the egress in one move. The bot then needs
# NO fingerprint spoofing (it sets BOT_CDP_ENDPOINT → spoof auto-disables).
#
# Usage:   bash tools/mac-gpu-browser.sh
# Stop:    Ctrl-C (tears down Chrome + the bridge)
set -euo pipefail

MAC_TS_IP="${MAC_TS_IP:-100.104.88.126}"    # this Mac's Tailscale IP
CDP_LOCAL_PORT="${CDP_LOCAL_PORT:-9222}"    # Chrome's localhost-only debug port
CDP_BRIDGE_PORT="${CDP_BRIDGE_PORT:-9223}"  # the Tailscale-exposed port
PROFILE="${PROFILE:-$HOME/.trusty-squire-mac-profile}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
HEADLESS="${HEADLESS:-0}"                    # 0 = headed (most authentic); 1 = --headless=new (still real Metal GPU on macOS)

command -v socat >/dev/null 2>&1 || { echo "[mac-gpu] need socat:  brew install socat"; exit 1; }
[ -x "$CHROME" ] || { echo "[mac-gpu] Chrome not found at: $CHROME  (set CHROME=/path/to/Chrome)"; exit 1; }
mkdir -p "$PROFILE"

HEADLESS_ARG=()
[ "$HEADLESS" = "1" ] && HEADLESS_ARG=(--headless=new)

echo "[mac-gpu] launching real-GPU Chrome  port=$CDP_LOCAL_PORT  headless=$HEADLESS  profile=$PROFILE"
"$CHROME" \
  --remote-debugging-port="$CDP_LOCAL_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins='*' \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --password-store=basic \
  --window-size=1280,1024 "${HEADLESS_ARG[@]}" \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!
SOCAT_PID=""
cleanup() { [ -n "$SOCAT_PID" ] && kill "$SOCAT_PID" 2>/dev/null || true; kill "$CHROME_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for the DevTools endpoint to come up.
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$CDP_LOCAL_PORT/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:$CDP_LOCAL_PORT/json/version" >/dev/null 2>&1; then
  echo "[mac-gpu] Chrome DevTools endpoint never came up on :$CDP_LOCAL_PORT"; exit 1
fi
echo "[mac-gpu] up: $(curl -sf "http://127.0.0.1:$CDP_LOCAL_PORT/json/version" | sed -E 's/.*"Browser":"([^"]*)".*/\1/')"

# Bridge the Tailscale interface → Chrome's localhost debug port. Playwright's
# connectOverCDP fetches /json/version then rewrites the ws host to the endpoint
# host, so a single forwarded port serves both the HTTP probe and the WS upgrade.
echo "[mac-gpu] bridging $MAC_TS_IP:$CDP_BRIDGE_PORT  ->  127.0.0.1:$CDP_LOCAL_PORT"
socat "TCP-LISTEN:$CDP_BRIDGE_PORT,bind=$MAC_TS_IP,reuseaddr,fork" "TCP:127.0.0.1:$CDP_LOCAL_PORT" &
SOCAT_PID=$!

cat <<EOF

  ✅ Ready. On the LINUX box, point the bot at this Mac:
       export BOT_CDP_ENDPOINT=http://$MAC_TS_IP:$CDP_BRIDGE_PORT

  Verify from Linux first:
       curl -s http://$MAC_TS_IP:$CDP_BRIDGE_PORT/json/version

  Ctrl-C here to stop Chrome + the bridge.
EOF
wait "$SOCAT_PID"
