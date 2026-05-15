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

# Ensure we're on main before pulling (detached HEAD would break `git pull`)
CURRENT_BRANCH=$(git symbolic-ref --short -q HEAD || echo "")
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Not on main (was: '${CURRENT_BRANCH:-detached HEAD}'), checking out main..."
  git checkout main
fi

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

# Sanity check: dist/index.js exists and isn't suspiciously small.
# tsup externalises everything except `zod` by design, so we don't try to
# validate the import list. Just confirm the build produced a bundle.
if [ ! -f dist/index.js ]; then
  echo "ERROR: dist/index.js missing after build, rolling back..."
  git checkout "$PREV_COMMIT"
  pnpm install --frozen-lockfile
  pnpm build
  exit 1
fi
BUNDLE_SIZE=$(stat -c %s dist/index.js)
if [ "$BUNDLE_SIZE" -lt 102400 ]; then
  echo "ERROR: dist/index.js is only ${BUNDLE_SIZE} bytes (<100KB), build likely broken. Rolling back..."
  git checkout "$PREV_COMMIT"
  pnpm install --frozen-lockfile
  pnpm build
  exit 1
fi
echo "Bundle size: ${BUNDLE_SIZE} bytes"

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
