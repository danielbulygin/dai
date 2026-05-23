# Ada launch-flow wiring — handoff

Branch: `ada/phase-11-launch-flow` (built 2026-05-23 overnight while Dan slept).

Two new files are checked in:
- `src/agents/tools/ad-launch-tools.ts` — 5 thin HTTP tools wrapping BMAD `/api/ada/*`
- `src/slack/listeners/launch-actions.ts` — Block Kit button + thread-reply handlers
- `agents/ada/INSTRUCTIONS-AD-LAUNCH-SECTION.md` — the section to paste into `INSTRUCTIONS.md`

This branch does **not** modify shared files (`tool-registry.ts`, `profiles/index.ts`,
`env.ts`, `src/slack/listeners/index.ts`, `INSTRUCTIONS.md`) because those have
Maya/Piper WIP that's mid-flight. The wiring is documented below as small additive
edits you apply once Maya's work lands and you're ready to merge this branch.

## To activate the launch flow

### 1. `src/env.ts` — add `DROPLET_API_KEY`

Add inside the `envSchema` object:

```ts
DROPLET_API_KEY: z.string().optional(),
```

In your Vercel/DAI production env, set `DROPLET_API_KEY` to the same value as
`API_SECRET` in `/root/.env` on the BMAD droplet (`139.59.144.194`).

### 2. `src/agents/tool-registry.ts` — import + register 5 tools

Add to the imports at the top:

```ts
import * as adLaunchTools from './tools/ad-launch-tools.js';
```

Add this block alongside the other tool registration blocks (e.g. near the media-library
tools section):

```ts
// ---------------------------------------------------------------------------
// Ad Launch tools (Phase 11)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_client_capabilities',
    description:
      'Check whether Ada can launch real ads for a client (i.e. the client is in CLIENT_CONFIGS). Returns {upload, launch, locked_campaign_name, has_meta_config}. Call this AFTER upload_to_media_library completes — if launch=false, the client is upload-only (e.g. Sweetspot, Audibene) and you stop there. If launch=true, ask the user whether to proceed with preview_ad_launch.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string', description: 'Client code (e.g. PL, BFM, MEOW, AOT)' },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    return adLaunchTools.getClientCapabilities({ client_code: input.client_code as string });
  },
});

register({
  definition: {
    name: 'preview_ad_launch',
    description:
      'Build a launch preview for a client. No Meta side effects — resolves landing pages, generates copy via Opus, runs QC, persists a pending launch_batches row. Returns batch_id + the full preview payload that you render as a Slack Block Kit message with [Launch] [Edit landers] [Edit copy] [Cancel] buttons. For each creative, prefer NOT to pass transcript/visual_summary — the droplet falls back to the media_library_assets cache populated by the post-upload auto-fetch.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string' },
        creatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              video_id: { type: 'string' },
              filename: { type: 'string' },
              asset_id: { type: 'string' },
              media_type: { type: 'string', enum: ['video', 'image'] },
              transcript: { type: 'string' },
              visual_summary: { type: 'string' },
            },
            required: ['video_id'],
          },
        },
        mode: { type: 'string', enum: ['new_adset', 'ads_only'] },
        target_adset_id: { type: 'string' },
        brief_notion_id: { type: 'string' },
        source_drive_url: { type: 'string' },
        initiated_by: { type: 'string', description: 'Slack user ID who triggered this' },
      },
      required: ['client_code', 'creatives'],
    },
  },
  async execute(input) {
    return adLaunchTools.previewAdLaunch(input as Parameters<typeof adLaunchTools.previewAdLaunch>[0]);
  },
});

register({
  definition: {
    name: 'launch_ads',
    description:
      'Execute a previously-previewed launch. Creates PAUSED adset + PAUSED ads in the client\'s locked sandbox campaign. Idempotent — second call with same idempotency_key returns the original result. Typically called from a Slack button handler, not directly by Ada; if Ada calls it, derive idempotency_key from the user prompt timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        batch_id: { type: 'string' },
        idempotency_key: { type: 'string' },
        edits: { type: 'object' },
      },
      required: ['batch_id', 'idempotency_key'],
    },
  },
  async execute(input) {
    return adLaunchTools.launchAds(input as Parameters<typeof adLaunchTools.launchAds>[0]);
  },
});

register({
  definition: {
    name: 'pause_launch',
    description:
      'Pause a launched batch. Flips configured_status=PAUSED on the adset and every ad in the batch. This is the ONLY undo verb — Ada cannot delete anything in Meta, ever. If a user asks to "delete" or "remove" the ads, explain you can only pause; deletion is manual in Ads Manager.',
    input_schema: {
      type: 'object' as const,
      properties: {
        batch_id: { type: 'string' },
        reason: { type: 'string', description: 'Why are we pausing — user request, mistake, etc.' },
      },
      required: ['batch_id', 'reason'],
    },
  },
  async execute(input) {
    return adLaunchTools.pauseLaunch({ batch_id: input.batch_id as string, reason: input.reason as string });
  },
});

register({
  definition: {
    name: 'update_landing_page_mapping',
    description:
      'Persist a (client, keyword) → URL mapping in client_meta_configs.landing_pages. Use when the user gives a durable correction like "for PL ginger ads use /products/wellness-shot-pack as the default" — make it stick so future previews pick it up automatically. For a single URL replacement pass { client_code, keyword, url, label }. For an ordered list pass { client_code, keyword, urls: [...] }. Default source is "user_correction".',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string' },
        keyword: { type: 'string' },
        url: { type: 'string' },
        urls: { type: 'array' },
        label: { type: 'string' },
        source: { type: 'string', enum: ['user_correction', 'manual', 'mining'] },
      },
      required: ['client_code', 'keyword'],
    },
  },
  async execute(input) {
    return adLaunchTools.updateLandingPageMapping(input as Parameters<typeof adLaunchTools.updateLandingPageMapping>[0]);
  },
});
```

### 3. `src/agents/profiles/index.ts` — add to `media_buyer`

Append to the `media_buyer: [...]` array:

```ts
  'get_client_capabilities',
  'preview_ad_launch',
  'launch_ads',
  'pause_launch',
  'update_landing_page_mapping',
```

### 4. `src/slack/listeners/index.ts` — wire the new listener

Add to imports:

```ts
import { registerLaunchActions } from "./launch-actions.js";
```

Add inside `registerAllListeners(app)`:

```ts
  registerLaunchActions(app);
```

### 5. `agents/ada/INSTRUCTIONS.md` — paste the workflow section

Copy the entire content of `agents/ada/INSTRUCTIONS-AD-LAUNCH-SECTION.md` into
`INSTRUCTIONS.md` under a clear `## Ad Launch Workflow` heading. Then delete the
standalone file (it's just the staging copy).

## Smoke testing before going live

After applying the 4 wiring edits + setting `DROPLET_API_KEY`:

1. Run the existing chat harness:
   ```bash
   pnpm chat:ada
   ```
2. Type a probe: "what can you do for PL?"
   - Should call `get_client_capabilities("PL")` and report launch=true with the locked campaign name
3. Type: "what can you do for SWEETSPOT?"
   - Should report launch=false (upload-only client)
4. Type a fake launch scenario without actually uploading: "preview a launch for AOT with video_id=703292328796281, filename=test.mp4, asset_id=AOTxTEST"
   - Should call `preview_ad_launch` and return a batch_id

If those three work, the wiring is correct. Real production usage in Slack should
behave the same once `DROPLET_API_KEY` is set in DAI's production env.

## Things not yet implemented (deliberately deferred)

- **Block Kit modal handlers for Edit Landers / Edit Copy.** Stubbed with an
  ephemeral message telling the user to use thread-reply overrides. Full Slack
  View Submission handlers can be added to `launch-actions.ts` later; the pattern
  is in `insight-actions.ts`.
- **`relaunch <batch_id> override ...` thread-reply parser.** Mentioned in the
  Edit Landers stub message; needs a small handler in `messages.ts`.
- **⏸️ reaction handler for pause.** `parsePauseReply` is in `launch-actions.ts`;
  hook it into `reactions.ts` when ready (look for `:pause_button:` and call
  `handlePauseRequest`).
- **Trust threshold display (spec 11F).** The `trust_level` column exists in
  `client_meta_configs` but the Slack preview message doesn't yet render it. Add
  a "trust level N/10" line to the preview header when ready.

None of these block the basic flow from working. They're polish.

## Things I did NOT change

- `agents/_manifest.yaml`, `agents/maya/INSTRUCTIONS.md`, other Maya/Piper-related
  files — those have WIP from a parallel session
- `src/agents/registry.ts`, `src/env.ts`, `src/slack/dedicated-bots.ts`,
  `package.json`, `scripts/creative-audit.ts` — all dirty with Maya/Piper changes
- Existing Ada tools and instructions

The 5 wiring edits above are the only intersection points with shared files. They're
all additive, no risk of conflict with Maya's work.
