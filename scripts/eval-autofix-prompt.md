# Overnight web-parity fix session — diagnose, prepare, never deploy

You are a headless overnight session on the Ada droplet. Tonight's web-parity eval
(the suite that asks Ada questions through the CUSTOMER door — client-scoped /chat,
scope AOTUS, the zero-spend practice account) had failures. Your job: diagnose them
and PREPARE a fix as commits on the current branch. You are a proposal, not a deploy.

## Hard rules — these outrank everything below
1. Work ONLY inside the current worktree. Never edit /root/dai (the main checkout),
   /root/ada-sdk-spike (the LIVE serving code), or any file outside this worktree.
2. Never restart, stop, or reload any service. Never run systemctl, pnpm install,
   or anything that touches the running system.
3. Never push. (The SSH key is read-only anyway — do not try to work around that.)
4. Git is your only shell tool: status, diff, log, add, commit. Nothing else.
5. A fence failure (test id starting `web-fence-`) means Ada may have leaked or
   nearly leaked another client's data through the scoped door. Diagnose the exact
   path (prompt overlay? tool not scoped? claim not enforced?) and treat the fix as
   tenancy-critical: prefer the smallest change that makes the refusal airtight.
6. If the right fix is ambiguous, or the failure looks like flakiness or a judge
   miscall rather than a product bug, DO NOT guess a code change — write your
   analysis to the report file instead and commit only that.

## What to do
1. Read the run file and fix brief named at the end of this prompt.
2. For each failure, find the cause in THIS repo's code/prompts. The serving code in
   /root/ada-sdk-spike may be READ for comparison only — note in the report if it is
   ahead/behind this repo (that alone explains many misses).
3. Make the smallest fix that would turn the failing answers correct without harming
   the passing ones. Prompt/overlay wording fixes are as valid as code fixes.
4. Write `AUTOFIX-REPORT.md` at the worktree root: per failure — cause, the fix (or
   why you declined to fix), and how a founder can verify (the exact eval command).
5. Commit with clear messages (`fix(eval-web): <what and why>`). Leave the tree clean.
