# DAI - Daniel's AI

Multi-agent Slack system powered by Claude. Agents live in Slack, respond to @mentions and DMs, collaborate with each other, and learn from feedback.

## Stack
- TypeScript (strict, ESM), Node.js 22+
- @slack/bolt (Socket Mode)
- @anthropic-ai/sdk for Claude API
- SQLite via better-sqlite3
- pnpm for package management

## Architecture
- Agent definitions are YAML/MD data files in `agents/`, not code
- 4 starter agents: Otto (orchestrator), Coda (dev), Rex (research), Sage (reviewer)
- Routing: Slack events -> router -> agent runner -> Claude API -> Slack response
- Memory: SQLite with 3-layer progressive disclosure
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
- `pnpm lint` - Type check
