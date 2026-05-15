#!/bin/bash
# Receives email via stdin, forwards to API webhook

# Read the entire email
EMAIL_BODY=$(cat)

# Extract recipient from DELIVERED_TO environment variable (set by postfix)
RECIPIENT="${RECIPIENT:-unknown@trustysquire.ai}"

# Forward to API
curl -X POST "${API_WEBHOOK_URL:-http://trusty-squire-api.internal:8080/v1/webhooks/postfix}" \
  -H "Content-Type: message/rfc822" \
  -H "X-Original-To: $RECIPIENT" \
  --data-binary "$EMAIL_BODY" \
  --max-time 10 \
  --silent \
  --fail || echo "Failed to forward email to webhook" >&2

exit 0
