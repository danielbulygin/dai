# Ada → Claude Agent SDK spike (branch `ada-agent-sdk-spike`)

Path-B spike: run Slack-Ada on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) instead of
the hand-rolled `runWithTools` loop, so Ada loads the same `.claude/skills/ada-*` skills as terminal Claude
Code. Built and self-verified overnight 2026-06-15/16. **Result: Phases 0–2 GREEN, 8/8 evals pass, no
functional breakage, ~2.7× cost.** Full report: `bmad/docs/ada-agent-sdk-overnight-report-2026-06-16.md`.

> Status: SPIKE. `runAgentSDK` is OFF by default and NOT wired into `mentions.ts`. The live listener and
> production (`dai.service`) were never touched. This is for Dan to review.

## What's here (all additive — nothing in the existing runner/registry/mentions changed)

| File | Purpose |
|---|---|
| `src/agents/sdk/schema.ts` | JSON-Schema → Zod raw-shape converter (the SDK `tool()` wants zod) |
| `src/agents/sdk/tool-bridge.ts` | Wraps a whole dai profile as one in-process MCP server; each tool routes through `executeTool()` (keeps audit logging + soft-error detection). Model sees `mcp__ada-tools__<name>`. |
| `src/agents/sdk/guard.ts` | Fail-closed `PreToolUse` hook + `canUseTool`. Reads→allow; the two authorized mutations→allow only behind explicit per-run flags; everything else (writes, Bash, unknown)→deny. |
| `src/agents/sdk/runAgentSDK.ts` | The SDK runner behind the existing `runAgent(RunOptions): RunResult` contract. OFF-by-default flag `shouldUseSdkRunner()` (`ADA_SDK_RUNNER=1`), Ada-only. |
| `scripts/ada-sdk-spike.ts` | Phase-0 driver (5 primitives). |
| `scripts/eval-ada-sdk.ts` | A/B counterpart to `eval-ada.ts` — golden questions through `runAgentSDK`. |
| `scripts/ada-sdk-qc.ts` | Self-QC battery: `read \| resume \| blocked-writes \| media-scan \| media-upload \| long`. |

## Run it (on the droplet, where the working key + tokens live)

The SDK spawns the `claude-code` CLI subprocess and needs a working `ANTHROPIC_API_KEY` + all tool tokens —
these live in `/root/dai/.env`. The **local** `.env` key is stale. So run from an isolated scratch:

```bash
# one-time: isolated scratch = copy of deployed dai + the SDK, never touches /root/dai
rsync -a --exclude=node_modules --exclude=.git --exclude=dist --exclude=.env --exclude='.env.*' \
  /root/dai/ /root/ada-sdk-spike/
cd /root/ada-sdk-spike && pnpm install && pnpm add @anthropic-ai/claude-agent-sdk && pnpm rebuild esbuild
# skills dir (clean: only ada-* skills)
mkdir -p skills-root/.claude/skills
for s in ada-media-library ada-sweetspot-namer ada-ready-to-upload ada-website-walk ada-call-insights ada-client-change-alerts; do
  ln -sfn /root/bmad/.claude/skills/$s skills-root/.claude/skills/$s; done

# run (sources the dai env)
set -a && . /root/dai/.env && set +a
node_modules/.bin/tsx scripts/ada-sdk-spike.ts
node_modules/.bin/tsx scripts/eval-ada-sdk.ts
node_modules/.bin/tsx scripts/ada-sdk-qc.ts media-scan
```

## Key facts learned in the spike

- `@anthropic-ai/claude-agent-sdk@0.3.178`. `tool(name, desc, zodRawShape, handler)`; `createSdkMcpServer({name,tools})`
  → pass under `mcpServers`. Skills via `skills: 'all'|string[]` + `settingSources:['project']` + `cwd`.
- **Deferred tool loading is on** at 90 tools — the model uses a built-in `ToolSearch` tool to find tools
  (must be allowed; it's read-only). Consider `createSdkMcpServer({alwaysLoad:true})` for a curated hot-set
  to cut `ToolSearch` turns.
- **Operational `ada-*` skills reach for `Bash`** (they're written for Claude Code). The guard denies it and
  the model adapts, but it burns turns. Production fix: a sandboxed read-only Bash, or port skills to MCP tools.
- Every dai Meta/launch/upload tool is **`client_code`-keyed**, not raw `act_` id. `act_1570076840279279` is
  not a dai client (the `AOT` client is `act_688431454265319`).

## Open decisions for Dan (see report)

1. **Skills-dir location** (spike default = clean symlink dir; permanent = vendor into dai / point at bmad checkout / consolidate). `ADA_SDK_SKILLS_CWD` overrides at runtime.
2. **Cost tuning** before any flip (hot-set + de-Bash skills) — target ≤1.5× baseline.
3. **Production guard policy** must allow Ada's real writes (tonight's denies them by design).
4. Flip = wire `shouldUseSdkRunner('ada')` into `mentions.ts`, then green droplet eval.
