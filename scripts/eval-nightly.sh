#!/usr/bin/env bash
# Nightly Ada eval — runs the golden set against the LIVE /chat SSE endpoint
# (the exact production surface) and writes a judged run file to
# tests/eval/runs/. Invoked by the ada-eval-nightly.timer (~05:00 UTC, before
# the mining digest). Additive + read-only: it only asks Ada questions and
# grades the answers; it does NOT restart or redeploy any service.
#
# Env it needs, sourced below:
#   ANTHROPIC_API_KEY  (the judge)                 → /root/dai/.env
#   ADA_ASSIST_SECRET  (X-Assist-Key for /chat)    → /root/ada-console-assist.env
# Optional: ADA_CHAT_URL (default http://localhost:8092/chat), JUDGE_MODEL.
set -euo pipefail

DAI_DIR="${DAI_DIR:-/root/dai}"
cd "$DAI_DIR"

set -a
# shellcheck disable=SC1091
[ -f "$DAI_DIR/.env" ] && source "$DAI_DIR/.env"
# shellcheck disable=SC1091
[ -f /root/ada-console-assist.env ] && source /root/ada-console-assist.env
set +a

export GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nightly)"

# Nightly exit semantics: exit 0 as long as the suite executed and a run file
# was written — Ada failing questions is a FINDING (a run file to review), not
# an infra error. eval-ada.ts still exits non-zero when EVERY question
# infra-failed (endpoint down / all streams truncated), so the systemd unit
# only shows 'failed' for genuine infrastructure breakage.
export EVAL_EXIT_ZERO_ON_FAIL=1

exec pnpm exec tsx scripts/eval-ada.ts --target http
