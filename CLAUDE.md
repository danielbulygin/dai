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

## Deploy

`dai.service` on the droplet (139.59.144.194): `cd /root/dai && git pull --ff-only && pnpm build && systemctl restart dai`.
Restart bounces ALL agents (Ada/Piper/Maya/Jasmin). Env: `/root/dai/.env`.
