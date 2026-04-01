#!/bin/bash
# DAI Health Watchdog - detects crash loops and auto-fixes
# Installed as systemd timer on the server
# Usage: runs every 2 minutes via systemd timer

set -euo pipefail

SERVICE="dai"
HEALTH_URL="http://localhost:3001/api/health"
DAI_DIR="/root/dai"
SLACK_WEBHOOK_URL="${DAI_SLACK_WEBHOOK_URL:-}"
STATE_FILE="/tmp/dai-watchdog-state"
MAX_FIX_ATTEMPTS=3

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

notify_slack() {
  local msg="$1"
  if [ -n "$SLACK_WEBHOOK_URL" ]; then
    curl -sf -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-type: application/json' \
      -d "{\"text\": \"🚨 *DAI Watchdog*: $msg\"}" > /dev/null 2>&1 || true
  fi
  log "ALERT: $msg"
}

# Track consecutive failures
get_fail_count() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "0"
  fi
}

set_fail_count() {
  echo "$1" > "$STATE_FILE"
}

# Check if service is healthy
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  # Healthy - reset counter
  if [ "$(get_fail_count)" -gt 0 ]; then
    log "Service recovered (was at $(get_fail_count) failures)"
    notify_slack "Service recovered and healthy ✅"
  fi
  set_fail_count 0
  exit 0
fi

# Service unhealthy
FAIL_COUNT=$(($(get_fail_count) + 1))
set_fail_count "$FAIL_COUNT"
log "Health check failed (attempt $FAIL_COUNT)"

# Check if it's a crash loop
RESTART_COUNT=$(systemctl show "$SERVICE" --property=NRestarts --value 2>/dev/null || echo "0")
IS_ACTIVE=$(systemctl is-active "$SERVICE" 2>/dev/null || echo "inactive")

log "Service status: $IS_ACTIVE, restart count: $RESTART_COUNT"

if [ "$FAIL_COUNT" -ge "$MAX_FIX_ATTEMPTS" ]; then
  notify_slack "Service still down after $FAIL_COUNT attempts. Manual intervention needed. Status: $IS_ACTIVE, restarts: $RESTART_COUNT"
  exit 1
fi

# Attempt auto-fix
log "Attempting auto-fix (attempt $FAIL_COUNT/$MAX_FIX_ATTEMPTS)..."
notify_slack "Service down (status: $IS_ACTIVE, restarts: $RESTART_COUNT). Attempting auto-fix $FAIL_COUNT/$MAX_FIX_ATTEMPTS..."

cd "$DAI_DIR"

# Step 1: Try just restarting
if [ "$FAIL_COUNT" -eq 1 ]; then
  log "Step 1: Simple restart"
  systemctl restart "$SERVICE"
  sleep 5
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    log "Simple restart fixed it"
    notify_slack "Fixed with simple restart ✅"
    set_fail_count 0
    exit 0
  fi
fi

# Step 2: Reinstall deps + rebuild
log "Step 2: Reinstall + rebuild"
pnpm install 2>&1 | tail -5
pnpm build 2>&1 | tail -5
systemctl restart "$SERVICE"
sleep 5

if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  log "Reinstall + rebuild fixed it"
  notify_slack "Fixed with reinstall + rebuild ✅"
  set_fail_count 0
  exit 0
fi

log "Auto-fix attempt $FAIL_COUNT failed. Will retry on next run."
