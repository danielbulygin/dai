#!/bin/bash
# Deploy DAI to DigitalOcean droplet (pma-agent)
# Usage: ./scripts/deploy.sh

set -euo pipefail

HOST="root@139.59.144.194"
SSH_OPTS="-p 8443"
HEALTH_URL="http://localhost:3001/api/health"
MAX_HEALTH_RETRIES=10

echo "Deploying DAI to $HOST..."

ssh $SSH_OPTS "$HOST" bash -s <<'DEPLOY'
set -euo pipefail
cd /root/dai

# Save current commit for rollback
PREV_COMMIT=$(git rev-parse HEAD)
echo "Current commit: $PREV_COMMIT"

# Pull latest code
git pull

# Install dependencies
if ! pnpm install --frozen-lockfile 2>&1; then
  echo "ERROR: pnpm install failed, rolling back..."
  git checkout "$PREV_COMMIT"
  exit 1
fi

# Build
if ! pnpm build 2>&1; then
  echo "ERROR: build failed, rolling back..."
  git checkout "$PREV_COMMIT"
  pnpm install --frozen-lockfile
  pnpm build
  exit 1
fi

# Verify bundle has no unexpected external imports that would crash at runtime
EXTERNAL_ISSUES=$(grep -P '^import .+ from "(?!node:|#)' dist/index.js | grep -v '"playwright-core"' || true)
if [ -n "$EXTERNAL_ISSUES" ]; then
  echo "WARNING: Bundle has external imports that may not be available at runtime:"
  echo "$EXTERNAL_ISSUES"
  echo "Attempting rebuild with pnpm install..."
  pnpm install
  pnpm build
  EXTERNAL_ISSUES=$(grep -P '^import .+ from "(?!node:|#)' dist/index.js | grep -v '"playwright-core"' || true)
  if [ -n "$EXTERNAL_ISSUES" ]; then
    echo "ERROR: External imports still present after rebuild, rolling back..."
    git checkout "$PREV_COMMIT"
    pnpm install --frozen-lockfile
    pnpm build
    exit 1
  fi
fi

echo "Build verified. Restarting service..."
systemctl restart dai

# Health check: wait for service to come up
echo "Running health check..."
for i in $(seq 1 10); do
  sleep 2
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "Health check passed on attempt $i"
    systemctl status dai --no-pager
    exit 0
  fi
  # Check if service is crash-looping
  if ! systemctl is-active dai > /dev/null 2>&1; then
    echo "Service crashed, checking logs..."
    journalctl -u dai -n 10 --no-pager
    echo ""
    echo "Attempting auto-fix: reinstall + rebuild..."
    pnpm install
    pnpm build
    systemctl restart dai
    sleep 3
    if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
      echo "Auto-fix succeeded!"
      exit 0
    fi
    echo "Auto-fix failed. Rolling back to $PREV_COMMIT..."
    git checkout "$PREV_COMMIT"
    pnpm install --frozen-lockfile
    pnpm build
    systemctl restart dai
    sleep 3
    if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
      echo "Rollback succeeded. Service running on previous commit."
      exit 1
    fi
    echo "CRITICAL: Rollback also failed. Manual intervention needed."
    journalctl -u dai -n 20 --no-pager
    exit 2
  fi
  echo "  Attempt $i/10 - waiting..."
done

echo "WARNING: Health endpoint not responding after 20s, but service is running."
systemctl status dai --no-pager
DEPLOY

echo ""
echo "Deploy complete. Tailing logs (Ctrl+C to stop):"
ssh $SSH_OPTS "$HOST" "journalctl -u dai -n 20 --no-pager"
