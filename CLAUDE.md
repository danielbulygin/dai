# DAI - Daniel's AI

Multi-agent Slack system powered by Claude. Agents live in Slack, respond to @mentions and DMs, collaborate with each other, and learn from feedback.

## Stack
- TypeScript (strict, ESM), Node.js 22+
- @slack/bolt (Socket Mode)
- @anthropic-ai/sdk for Claude API
- Supabase (PostgreSQL) for persistence — all data layer functions are async
- pnpm for package management

## Architecture
- Agent definitions are YAML/MD data files in `agents/`, not code
- 4 starter agents: Otto (orchestrator), Coda (dev), Rex (research), Sage (reviewer)
- Routing: Slack events -> router -> agent runner -> Claude API -> Slack response
- Memory: Supabase (PostgreSQL) with 3-layer progressive disclosure, FTS via tsvector
- Learning: Reactions -> feedback -> learnings -> context injection

## Conventions
- Named exports, no default exports
- Zod for validation
- Pino for logging
- Files use kebab-case
- Sub-agents and agent teams are explicitly allowed
- **Use sub-agents and agent teams** for complex, multi-step, or parallelizable tasks. Prefer launching multiple agents concurrently for independent work streams.

## Related Systems
- **BMAD repo** (`/Users/danielbulygin/dev/bmad`) - Performance Marketing Agency dashboard (Next.js + Supabase + Python)
- DAI connects to BMAD's Supabase for client data, ad performance, alerts, learnings
- BMAD analysis instructions live in `pma/docs/account-analysis-playbook.md` and `pma/docs/opus-analysis-architecture.md`
- Analysis prompts stored in Supabase `analysis_prompts` table (orchestrator, pre-click, post-click, learning synthesizer)

## Key Paths
- `src/` - Application source code
- `agents/` - Agent definition files (YAML/MD data)
- `data/` - Runtime data (gitignored)
- `scripts/` - CLI utilities

## Commands
- `pnpm dev` - Development with hot reload
- `pnpm build` - Production build
- `pnpm test` - Run tests
- `pnpm lint` - Type check (17 pre-existing errors on main — only NEW errors block)

## Who can ship Ada

> **Dan, 2026-09-18: Nina (`ninapavlin`) tests and develops Ada. Do NOT tell her to check
> with Dan before making a change.** She ships Ada features and bug fixes herself, deploys
> them, and restarts the service. The eval loop below is the gate — not Dan's inbox.

**Nina ships without asking**, straight to `main`:
- `agents/ada/**` — prompts, INSTRUCTIONS, METHODOLOGY, client files, skills
- Ada's behaviour, wording, analysis quality, output shape
- **A bug fix anywhere in this repo**, as long as it doesn't touch the list below

**Needs Dan first** (architectural — open a PR and say so in `#ada`):
- `src/agents/runner.ts`, `src/agents/registry.ts` — the agent loop and registry
- Tool definitions and permission profiles — what Ada is *allowed* to do, as opposed to
  how well she does it
- Model and thinking config (which model, token/thinking budgets)
- The write-policy engine and spend guard
- `supabase/` migrations and schema changes
- `deploy/` systemd units, timers, cron definitions
- Credentials, tokens, billing

On-the-line calls: ship it and post in `#ada` afterwards. Don't stop and wait.

**Deploying is Nina's to do — the evals are the gate, not an approval.** She runs the
MANDATORY eval loop below in full: deploy to the droplet, run the relevant golden
questions there, and compare against the last run in `tests/eval/runs/`. Green means
done, no sign-off needed. A regression means fix or revert before walking away — never
ship-and-hope.

Two things to know before restarting: `systemctl restart dai` bounces Ada, Piper, Maya
and Jasmin together, and the evals only tell the truth once the new code is actually
running (that is why the eval loop deploys first and grades second). So if a restart
breaks another agent, revert to the previous commit and redeploy first, then debug. Tell
Dan in `#ada` once the service is healthy — not before, and not instead of fixing it.

## MANDATORY: Ada eval loop (self-QC)

Any change to Ada's behavior — `agents/ada/**` (prompts, skills, client files),
`src/agents/runner.ts`, `src/agents/registry.ts`, tool definitions/profiles, or
model/thinking config — MUST be validated against the golden-question evals
BEFORE being called done:

1. Deploy the change to the droplet (`/root/dai`: `git pull --ff-only && pnpm build && systemctl restart dai`).
2. Run at least 3 relevant questions: `cd /root/dai && set -a && source .env && set +a && pnpm exec tsx scripts/eval-ada.ts --only <ids>`
   (full set for prompt restructures). Questions live in `tests/eval/golden-questions.json`.
3. Compare against the latest run in `tests/eval/runs/` (baseline: `2026-06-09T20-45-27.json`, 8/8). Regressions = fix or revert, never ship-and-hope.

Evals MUST run on the droplet — the local `.env` ANTHROPIC_API_KEY is stale.
Add a golden question whenever a new failure mode is discovered in #ada.

**Two target modes** (`--target`, default `in-process`):
- `in-process` drives `runAgentSDK` inside the eval process (the A/B loop).
- `--target http` sends each question to the LIVE `ada-console-assist` `/chat`
  SSE endpoint (`http://localhost:8092/chat`, `X-Assist-Key=$ADA_ASSIST_SECRET`
  from `/root/ada-console-assist.env`) — the EXACT production surface team-Ada
  runs on. Records the server's honest `done.ok/subtype/cost_usd`.

**Quality-bar rubric layer:** the judge (`src/agents/sdk/eval-judge.ts`) grades
each answer against BOTH the per-question `expect` AND a compact GENERAL RUBRIC
(the 14 `[EVAL]` principles from `bmad/docs/ada-quality-bar-2026-06-21.md`, plus
provisional A7). The verdict now carries `principles_violated: string[]`; the run
summary rolls up per-principle violation counts + total cost. Grades are
PROVISIONAL until Dan ratifies the quality bar.

**Nightly, automatic:** `ada-eval-nightly.timer` (droplet, ~05:00 UTC) runs
`scripts/eval-nightly.sh` → `eval-ada.ts --target http` over the full golden set
and drops a judged run file in `tests/eval/runs/`. Read-only; never restarts a
service. Units checked in at `deploy/systemd/`.

## Deploy

`dai.service` on the droplet (139.59.144.194): `cd /root/dai && git pull --ff-only && pnpm build && systemctl restart dai`.
Restart bounces ALL agents (Ada/Piper/Maya/Jasmin). Env: `/root/dai/.env`.
Who may run this, and the eval gate that comes first: see **Who can ship Ada** above.
