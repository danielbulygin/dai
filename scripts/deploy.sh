#!/bin/bash
# Deploy DAI to DigitalOcean droplet (pma-agent)
# Usage: ./scripts/deploy.sh

set -euo pipefail

HOST="root@139.59.144.194"

echo "Deploying DAI to $HOST..."

ssh "$HOST" "cd /root/dai \
  && git pull \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && systemctl restart dai \
  && sleep 3 \
  && systemctl status dai --no-pager"

echo ""
echo "Deploy complete. Tailing logs (Ctrl+C to stop):"
ssh "$HOST" "journalctl -u dai -n 20 --no-pager"
