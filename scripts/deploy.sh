#!/bin/bash
# Deploy DAI to DigitalOcean droplet (pma-agent)
# Usage: ./scripts/deploy.sh

set -euo pipefail

HOST="root@139.59.144.194"
SSH_OPTS="-p 443"
# SSH uses port 443 to bypass ISP blocks on port 22
# When phone tethering blocks ALL connections, use DigitalOcean web console instead

echo "Deploying DAI to $HOST..."

ssh $SSH_OPTS "$HOST" "cd /root/dai \
  && git pull \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && systemctl restart dai \
  && sleep 3 \
  && systemctl status dai --no-pager"

echo ""
echo "Deploy complete. Tailing logs (Ctrl+C to stop):"
ssh $SSH_OPTS "$HOST" "journalctl -u dai -n 20 --no-pager"
