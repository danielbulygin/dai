#!/bin/bash
# Send a Slack message as Daniel
# Usage: ./scripts/slack-send.sh <channel-or-DM-id> <message>
# Example: ./scripts/slack-send.sh C0123456789 "Hey @Otto, status check"

set -euo pipefail

CHANNEL="${1:?Usage: slack-send.sh <channel-id> <message>}"
TEXT="${2:?Usage: slack-send.sh <channel-id> <message>}"

# Load token from .env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN=$(grep '^SLACK_USER_TOKEN=' "$SCRIPT_DIR/../.env" | cut -d= -f2)

if [ -z "$TOKEN" ]; then
  echo "Error: SLACK_USER_TOKEN not found in .env"
  exit 1
fi

RESPONSE=$(curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$CHANNEL\", \"text\": \"$TEXT\"}")

OK=$(echo "$RESPONSE" | grep -o '"ok":true' || true)
if [ -n "$OK" ]; then
  echo "Sent to $CHANNEL"
else
  echo "Failed: $RESPONSE"
fi
