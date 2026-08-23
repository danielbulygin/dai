#!/usr/bin/env bash
# Nightly Ada eval — TWO suites against the LIVE /chat SSE endpoint, then notify.
#
# 1. The agency suite (golden-questions.json): the internal door (X-Assist-Key,
#    unscoped) — terminal-grade Ada, cross-account questions.
# 2. The WEB-PARITY suite (golden-questions-web.json): the CUSTOMER door — the
#    client-scoped /chat branch with a real minted scope claim (scope AOTUS, the
#    practice account act_1570076840279279). This is the Ada a web customer gets;
#    it includes fence probes where the only right answer is a refusal.
#
# After both: eval-notify.ts posts the web verdicts to Slack and writes a fix
# brief on failures; eval-autofix.sh PREPARES (never deploys) a fix branch in a
# separate worktree. Invoked by ada-eval-nightly.timer (~05:00 UTC). Additive +
# read-only toward the running system: it only asks Ada questions and grades the
# answers; it does NOT restart or redeploy any service.
#
# Env it needs, sourced below:
#   ANTHROPIC_API_KEY        (the judge)                    → /root/dai/.env
#   ADA_ASSIST_SECRET        (X-Assist-Key for /chat)       → /root/ada-console-assist.env
#   ADA_SCOPE_SIGNING_SECRET (mints the customer-door claim)→ /root/ada-console-assist.env
# Optional: ADA_CHAT_URL (default http://localhost:8092/chat), JUDGE_MODEL,
#   EVAL_SLACK_CHANNEL_ID (notify override; default PIPER_CHANNEL_ID).
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

pnpm exec tsx scripts/eval-ada.ts --target http

pnpm exec tsx scripts/eval-ada.ts --target http --scope AOTUS --questions golden-questions-web.json

# Best-effort tail: notification and fix preparation never fail the unit.
pnpm exec tsx scripts/eval-notify.ts || true
bash scripts/eval-autofix.sh || true
