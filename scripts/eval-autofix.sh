#!/usr/bin/env bash
# Auto-fix step for the nightly web-parity eval — PREPARES a fix, never ships one.
#
# When tonight's web-parity run (customer-door suite) has failures, this spawns a
# headless Claude session in a SEPARATE git worktree (/root/dai-autofix-<date>,
# branch fix/eval-web-<date>) to diagnose the failures and commit a proposed fix
# plus a report. Hard limits, on purpose:
#   - /root/dai stays on main and untouched; the fixer works only in the worktree.
#   - The droplet's dai SSH key is READ-ONLY, so the fixer physically cannot push.
#   - It never restarts services and never edits /root/ada-sdk-spike (the LIVE
#     serving checkout). A founder reviews the branch, relay-pushes from the Mac,
#     syncs the spike, restarts — the human gate is the deploy itself.
#   - One attempt per day (worktree existence is the latch).
# Exit 0 always: a broken auto-fix must not fail the eval unit.
set -uo pipefail

DAI_DIR="${DAI_DIR:-/root/dai}"
cd "$DAI_DIR" || exit 0
export HOME="${HOME:-/root}"

if ! command -v claude >/dev/null 2>&1; then
  echo "[eval-autofix] claude CLI not installed — skipping (fix brief still written)."
  exit 0
fi

# Newest fresh web-parity run file (same 6h freshness the notifier uses).
RUN_FILE=""
for f in $(ls -t "$DAI_DIR"/tests/eval/runs/*.json 2>/dev/null | head -10); do
  if grep -q '"suite": "golden-questions-web.json"' "$f"; then RUN_FILE="$f"; break; fi
done
[ -z "$RUN_FILE" ] && { echo "[eval-autofix] no web run file — skipping."; exit 0; }
if [ "$(find "$RUN_FILE" -mmin -360 | wc -l)" -eq 0 ]; then
  echo "[eval-autofix] newest web run is stale — skipping."
  exit 0
fi

FAILS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUN_FILE','utf8')).summary.fail)" 2>/dev/null || echo 0)
[ "$FAILS" = "0" ] && { echo "[eval-autofix] web suite green — nothing to fix."; exit 0; }

BRIEF="${RUN_FILE%.json}-web-fix-brief.md"
STAMP=$(date -u +%Y%m%d)
BRANCH="fix/eval-web-$STAMP"
WORKTREE="/root/dai-autofix-$STAMP"

if [ -d "$WORKTREE" ]; then
  echo "[eval-autofix] $WORKTREE already exists — one attempt per day, skipping."
  exit 0
fi
if ! git worktree add "$WORKTREE" -b "$BRANCH" main >/dev/null 2>&1; then
  echo "[eval-autofix] could not create worktree/branch $BRANCH — skipping."
  exit 0
fi

PROMPT="$(cat "$DAI_DIR/scripts/eval-autofix-prompt.md")

Tonight's failing run file: $RUN_FILE
Fix brief (failures + judge reasons + answer excerpts): $BRIEF
You are working in the worktree $WORKTREE on branch $BRANCH."

cd "$WORKTREE" || exit 0
claude -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools "Bash(git:*)" \
  --max-turns 60 \
  > "$WORKTREE/autofix-session-log.txt" 2>&1
CLAUDE_EXIT=$?

COMMITS=$(git rev-list --count main.."$BRANCH" 2>/dev/null || echo 0)
SLACK_TEXT=""
if [ "$COMMITS" -gt 0 ]; then
  SUMMARY=$(git log --oneline main.."$BRANCH" | head -5)
  SLACK_TEXT=":wrench: Web-Ada auto-fix prepared branch \`$BRANCH\` in \`$WORKTREE\` ($COMMITS commit(s)):\n$SUMMARY\nReview the branch, then relay-push from the Mac and deploy — nothing is live yet."
else
  SLACK_TEXT=":wrench: Web-Ada auto-fix ran (exit $CLAUDE_EXIT) but committed nothing — see \`$WORKTREE/autofix-session-log.txt\` and the fix brief \`$BRIEF\`."
fi

if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${PIPER_CHANNEL_ID:-}" ]; then
  curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H 'Content-Type: application/json' \
    -d "$(node -e "console.log(JSON.stringify({channel: process.env.PIPER_CHANNEL_ID, text: process.argv[1], unfurl_links: false}))" "$SLACK_TEXT")" \
    >/dev/null || true
else
  echo "[eval-autofix] $SLACK_TEXT"
fi
exit 0
