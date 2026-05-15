#!/usr/bin/env bash
# Simple mobile demo: start services, create tunnels, show URLs
# User can refresh their browser to pick up the updated API base

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# Run the regular demo in background
bold "Starting demo services..."
bash "$REPO_ROOT/scripts/demo.sh" &
DEMO_PID=$!

# Wait for services to be ready
sleep 15

# Create tunnels
bold "Creating Cloudflare tunnels..."
cloudflared tunnel --url http://localhost:3000 > /tmp/api-tunnel.log 2>&1 &
API_TUNNEL_PID=$!
cloudflared tunnel --url http://localhost:3002 > /tmp/pwa-tunnel.log 2>&1 &
PWA_TUNNEL_PID=$!

# Wait and extract URLs
sleep 5
API_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/api-tunnel.log | head -1)
PWA_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/pwa-tunnel.log | head -1)

echo
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bold "  🌐 MOBILE DEMO READY"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
green "  📱 PWA URL:  $PWA_URL"
green "  🔗 API URL:  $API_URL"
echo
yellow "  ⚠️  IMPORTANT: On first load, you may see API errors."
yellow "     Just refresh the page after 10 seconds and it will work!"
echo
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Press Ctrl-C to stop all services"

# Write API URL to env file for Next.js to eventually pick up
cat > "$REPO_ROOT/apps/pwa/.env.local" <<EOF
NEXT_PUBLIC_API_BASE=$API_URL
NEXT_PUBLIC_VOUCHFLOW_MODE=stub
EOF

# Wait
wait $DEMO_PID
