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

# ---------------------------------------------------------------------------
# FULL vs SMOKE
# ---------------------------------------------------------------------------
# The full net is 36 live Ada sessions (24 agency + 12 web) at ~$42 a night.
# Re-grading an UNCHANGED commit buys nothing: in August 2026, 21 of 33 nightly
# runs graded a commit that had already been graded — $329 for no new
# information (six consecutive nights on 05d6038 alone).
#
# But skipping outright when nothing changed would be worse. August's most
# important failure had nothing to do with our code: on the 28th every question
# failed with "Credit balance is too low" while the tree sat untouched. A dead
# token, an exhausted balance or a Meta-side change breaks Ada with the commit
# frozen, and only a live question finds that.
#
# So: FULL when there is something new to grade, SMOKE every other night as a
# liveness net. A weekly FULL baseline still runs on Mondays, so drift that is
# nobody's commit (data, tools, model) cannot hide behind a quiet week.
#
#   eval-nightly.sh            → auto (full if changed / Monday, else smoke)
#   eval-nightly.sh --full     → force the full net
#   eval-nightly.sh --smoke    → force the smoke net
SMOKE_AGENCY="${SMOKE_AGENCY:-tl-weekly-read,laori-net-profit,methodology-kill-rule,governed-launch-posture}"
SMOKE_WEB="${SMOKE_WEB:-web-weekly-read,web-fence-other-client}"

# The last commit this net actually graded. Run files are named by timestamp, so
# the newest filename is the newest run; `git` is the sha it was run against.
LAST_RUN="$(ls -1 tests/eval/runs/*.json 2>/dev/null | tail -1 || true)"
LAST_SHA=""
if [ -n "$LAST_RUN" ]; then
  LAST_SHA="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git??""))}catch{}' "$LAST_RUN" || true)"
fi

MODE=auto
case "${1:-}" in
  --full)  MODE=full ;;
  --smoke) MODE=smoke ;;
esac

if [ "$MODE" = auto ]; then
  if [ -z "$LAST_SHA" ]; then
    MODE=full; WHY="no previous run on record"
  elif [ "$GIT_SHA" != "$LAST_SHA" ]; then
    MODE=full; WHY="code moved ${LAST_SHA} → ${GIT_SHA}"
  elif [ "$(date -u +%u)" = "1" ]; then
    MODE=full; WHY="Monday weekly baseline"
  else
    MODE=smoke; WHY="unchanged since ${LAST_SHA}"
  fi
else
  WHY="forced by ${1}"
fi

echo "[eval-nightly] mode=${MODE} (${WHY}) sha=${GIT_SHA} judge=${JUDGE_MODEL:-claude-sonnet-5}"

if [ "$MODE" = full ]; then
  pnpm exec tsx scripts/eval-ada.ts --target http

  pnpm exec tsx scripts/eval-ada.ts --target http --scope AOTUS --questions golden-questions-web.json
else
  pnpm exec tsx scripts/eval-ada.ts --target http --only "$SMOKE_AGENCY"

  pnpm exec tsx scripts/eval-ada.ts --target http --scope AOTUS --questions golden-questions-web.json --only "$SMOKE_WEB"
fi

# Best-effort tail: notification and fix preparation never fail the unit.
pnpm exec tsx scripts/eval-notify.ts || true
bash scripts/eval-autofix.sh || true
