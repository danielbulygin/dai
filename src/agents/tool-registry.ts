import type Anthropic from '@anthropic-ai/sdk';
import { toolProfiles, type ToolProfile } from './profiles/index.js';
import * as memoryTools from './tools/memory-tools.js';
import * as agentTools from './tools/agent-tools.js';
import * as slackTools from './tools/slack-tools.js';
import * as supabaseTools from './tools/supabase-tools.js';
import * as firefliesTools from './tools/fireflies-tools.js';
import * as notionTools from './tools/notion-tools.js';
import * as aotNotionTools from './tools/aot-notion-tools.js';
import * as monitoringTools from './tools/monitoring-tools.js';
import * as decisionTools from './tools/decision-tools.js';
import * as clientConfigTools from './tools/client-config-tools.js';
import * as methodologyTools from './tools/methodology-tools.js';
import * as googleTools from './tools/google-tools.js';
import * as browserTools from './tools/browser-tools.js';
import * as creativeTools from './tools/creative-tools.js';
import * as metaApiTools from './tools/meta-api-tools.js';
import { auditDatasetHealth } from './tools/dataset-health-tools.js';
import * as mediaLibraryTools from './tools/media-library-tools.js';
import * as adLaunchTools from './tools/ad-launch-tools.js';
import * as triplewhaleTools from './tools/triplewhale-tools.js';
import * as reportTools from '../reports/index.js';
import * as methodologySanitizer from '../client-agents/methodology-sanitizer.js';
import { logger } from '../utils/logger.js';
import { logToolCall, logWrite, fetchRecentActions } from './action-log.js';
import * as piperMovesTools from './tools/piper-moves-tools.js';
import * as piperBrainTools from './tools/piper-brain-tools.js';
import * as piperCommentsTools from './tools/piper-comments-tools.js';
import * as cadenceTools from './tools/cadence-tools.js';
import * as cadenceReadTools from './tools/cadence-read-tools.js';
import { getSupabase } from '../integrations/supabase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContext {
  agentId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  clientScope?: {
    clientCode: string;
  };
}

export interface RegisteredTool {
  definition: Anthropic.Tool;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, RegisteredTool>();

function register(tool: RegisteredTool): void {
  REGISTRY.set(tool.definition.name, tool);
}

// ---------------------------------------------------------------------------
// Memory tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'recall',
    description:
      'Search memory for past observations and learnings relevant to a query. Returns ranked results from conversation history and accumulated knowledge. When client_code is provided, client-specific learnings are boosted to the top.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory',
        },
        client_code: {
          type: 'string',
          description: 'Client code to boost client-specific results (e.g. "press_london", "ninepine")',
        },
      },
      required: ['query'],
    },
  },
  async execute(input, context) {
    const result = await memoryTools.recall({
      query: input.query as string,
      agent_id: context.agentId,
      client_code: input.client_code as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'remember',
    description:
      'Save an important observation, preference, or learning to long-term memory. Use for information worth recalling in future conversations. Use client_code to tag account-specific knowledge.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember',
        },
        category: {
          type: 'string',
          description:
            'Category for the memory (e.g. "user_preference", "decision", "observation", "workflow", "account_knowledge")',
        },
        client_code: {
          type: 'string',
          description: 'Client code if this learning is account-specific (e.g. "press_london", "ninepine"). Omit for global learnings.',
        },
      },
      required: ['content', 'category'],
    },
  },
  async execute(input, context) {
    const result = await memoryTools.remember({
      content: input.content as string,
      category: input.category as string,
      agent_id: context.agentId,
      client_code: input.client_code as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'search_memories',
    description:
      'Search accumulated learnings by topic. Returns memories with confidence scores. When client_code is provided, client-specific results are sorted first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to search for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
        client_code: {
          type: 'string',
          description: 'Client code to prioritize client-specific results (e.g. "press_london")',
        },
      },
      required: ['topic'],
    },
  },
  async execute(input) {
    const result = await memoryTools.searchMemories({
      topic: input.topic as string,
      limit: input.limit as number | undefined,
      client_code: input.client_code as string | undefined,
    });
    return JSON.stringify(result);
  },
});

// ---------------------------------------------------------------------------
// Agent delegation tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'ask_agent',
    description:
      'Ask another AI agent a question and get their response. Use this to delegate tasks to specialists: otto (orchestrator), coda (developer), rex (researcher), sage (reviewer), ada (advertising), maya (creative strategy).',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: {
          type: 'string',
          description:
            'ID of the agent to ask (otto, coda, rex, sage, ada, maya)',
        },
        question: {
          type: 'string',
          description: 'The question or task for the agent',
        },
        context: {
          type: 'string',
          description: 'Additional context to help the agent (optional)',
        },
      },
      required: ['agent_id', 'question'],
    },
  },
  async execute(input) {
    const result = await agentTools.askAgent({
      agent_id: input.agent_id as string,
      question: input.question as string,
      context: input.context as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'ask_ada',
    description:
      'Ask Ada (media buyer agent) for account performance data, winning patterns, fatigue signals, audience insights, or any advertising analysis. Always call this before generating creative concepts. Maya\'s primary data source.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description:
            'The question for Ada. Be specific: include client name, metric, time period. E.g. "Current performance snapshot for Ninepine, including top performers and fatigue signals"',
        },
        client_code: {
          type: 'string',
          description: 'Client code for context (e.g. "ninepine", "press_london")',
        },
      },
      required: ['question'],
    },
  },
  async execute(input) {
    const question = input.question as string;
    const clientCode = input.client_code as string | undefined;
    const context = clientCode ? `Client: ${clientCode}` : undefined;
    const result = await agentTools.askAgent({
      agent_id: 'ada',
      question,
      context,
    });
    return JSON.stringify(result);
  },
});

// ---------------------------------------------------------------------------
// Creative tools (Maya)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_creative_audit',
    description:
      'Get the latest creative audit for a client. Returns format distribution (spend %), angle distribution, gap matrix (untested/underweight combos), and top performers per coordinate. Use this to ground concept proposals in data: "Your account is 70% Talking Head — here are gaps worth testing."',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g. "ninepine", "press_london", "laori")',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    return creativeTools.getCreativeAudit({
      clientCode: input.client_code as string,
    });
  },
});

register({
  definition: {
    name: 'get_creative_diversity_score',
    description:
      'Calculate creative diversity score (0-100) for a client. Returns Shannon entropy for format/angle distribution, concentration risk warnings (any format/angle >60% of spend), gap analysis (untested combos), and recommended gaps to test next. Use after get_creative_audit for actionable diversity insights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g. "ninepine", "press_london", "laori")',
        },
        days: {
          type: 'number',
          description: 'Lookback window in days (default 7)',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    return creativeTools.getCreativeDiversityScore({
      clientCode: input.client_code as string,
      days: input.days as number | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Meta API tools (direct Facebook Insights API — hourly/intraday data)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'audit_dataset_health',
    description:
      "Audit a client's Meta pixel/dataset health — the data foundation underneath all tracking. Call this when asked about pixel health, tracking setup, event match quality (EMQ), advanced matching, CAPI vs pixel, data restrictions/flags (health & wellness), or when bottom-funnel events look wrong and you need to rule out the dataset itself. Returns per pixel: automatic advanced matching on/off + fields, restricted-use flag, first-party cookie status, last-fired time, per-event counts for the last ~24h (are core funnel events firing?), SERVER vs BROWSER split (are both CAPI and the browser pixel alive?), and which customer-info match keys flow on Purchase events (the EMQ inputs). Includes a warnings list with plain-language findings.",
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g. "PL", "BFM", "LA")',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input, context) {
    return auditDatasetHealth({
      clientCode: (context.clientScope?.clientCode ?? input.client_code) as string,
    });
  },
});

register({
  definition: {
    name: 'query_meta_insights',
    description:
      'Query the Facebook Marketing API directly for real-time insights. Use this for HOURLY/INTRADAY data that is NOT available in the Supabase daily tables. Supports hourly breakdowns (e.g. "how much was spent by 11am yesterday?"), real-time spend checks, and dimensional breakdowns at any time granularity. For standard daily analysis, prefer the Supabase tools (get_client_performance, get_campaign_summary, etc.) which are faster and pre-aggregated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g. "ninepine", "press_london", "laori")',
        },
        date_start: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (inclusive)',
        },
        date_end: {
          type: 'string',
          description: 'End date YYYY-MM-DD (inclusive)',
        },
        level: {
          type: 'string',
          enum: ['account', 'campaign', 'adset', 'ad'],
          description: 'Aggregation level (default: account)',
        },
        time_increment: {
          type: 'string',
          enum: ['hourly', 'daily', 'all_days'],
          description: 'Time granularity. Use "hourly" for intraday data — returns spend per hour in the advertiser timezone. Use "daily" for day-by-day. Use "all_days" (default) for aggregate over the date range.',
        },
        campaign_id: {
          type: 'string',
          description: 'Optional: filter to a specific campaign ID',
        },
        adset_id: {
          type: 'string',
          description: 'Optional: filter to a specific adset ID',
        },
        breakdowns: {
          type: 'string',
          description: 'Optional comma-separated breakdowns: age, gender, country, publisher_platform, platform_position, device_platform, impression_device. Do NOT combine with hourly time_increment (hourly already uses a breakdown).',
        },
        fields: {
          type: 'string',
          description: 'Optional comma-separated fields override. Default: spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,actions,action_values,cost_per_action_type',
        },
        limit: {
          type: 'number',
          description: 'Max rows per page (default: API default ~25)',
        },
      },
      required: ['client_code', 'date_start', 'date_end'],
    },
  },
  async execute(input, context) {
    return metaApiTools.queryMetaInsights({
      clientCode: (context.clientScope?.clientCode ?? input.client_code) as string,
      dateStart: input.date_start as string,
      dateEnd: input.date_end as string,
      level: input.level as 'account' | 'campaign' | 'adset' | 'ad' | undefined,
      timeIncrement: input.time_increment as 'hourly' | 'daily' | 'all_days' | undefined,
      campaignId: input.campaign_id as string | undefined,
      adsetId: input.adset_id as string | undefined,
      breakdowns: input.breakdowns as string | undefined,
      fields: input.fields as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'query_meta_creatives',
    description:
      'Query the Facebook Marketing API directly for ad CREATIVE CONFIGURATION — Instagram identity (instagram_actor_id, effective_instagram_actor_id), page identity, link URL, call-to-action, video_id/image_hash, and the full object_story_spec. Use this when you need creative SETUP details that the Supabase tables do not store (e.g. "which ads in this campaign link to the wrong Instagram profile?", "what page is this ad running under?", "does this ad point to the right landing page?"). For creative METADATA (ad copy, transcripts, AI tags, fatigue), prefer get_creative_details — it is faster and pre-aggregated. Must scope by campaign_id, adset_id, or explicit ad_ids — account-wide queries are blocked.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g. "laori", "ninepine", "press_london")',
        },
        campaign_id: {
          type: 'string',
          description: 'Filter to all ads inside this campaign',
        },
        adset_id: {
          type: 'string',
          description: 'Filter to all ads inside this adset',
        },
        ad_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to an explicit list of ad IDs',
        },
        effective_status: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by effective_status (e.g. ["ACTIVE"], ["ACTIVE","PAUSED"]). Default: all.',
        },
        fields: {
          type: 'string',
          description: 'Optional comma-separated fields override. Default includes id, name, status, creative{instagram_actor_id, effective_instagram_actor_id, page_id, object_story_spec, link_url, video_id, image_url, title, body, call_to_action_type, ...}.',
        },
        limit: {
          type: 'number',
          description: 'Max rows per page (default 100). Paging is collected automatically up to 500.',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input, context) {
    return metaApiTools.queryMetaCreatives({
      clientCode: (context.clientScope?.clientCode ?? input.client_code) as string,
      campaignId: input.campaign_id as string | undefined,
      adsetId: input.adset_id as string | undefined,
      adIds: input.ad_ids as string[] | undefined,
      effectiveStatus: input.effective_status as string[] | undefined,
      fields: input.fields as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'check_ads_in_meta',
    description:
      'For each AOT ad_id_code (e.g. PLx3942, ADBNx3475), check whether it has been uploaded to the client\'s Meta ad account by searching ad-set names AND ad names. Returns found=true if the code appears in either an ad set name OR an ad name (status-agnostic — paused, archived, and active all count as "uploaded successfully"). Use this to reconcile open "Upload and Configure Campaign" tasks against Meta reality: if found=true the Notion task is stale (close it); if found=false the upload is genuinely owed. Returns matched_adsets and matched_ads with id, name, effective_status, and parent IDs. Naming convention is reliable: every ad/ad-set carries its ad_id_code in the name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code (e.g., PL, ADBN, NP). Used to look up the ad_account_id in Supabase.',
        },
        ad_id_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of ad_id_codes to check (e.g., ["PLx3942", "PLx3943"]). Max 50 per call.',
        },
      },
      required: ['client_code', 'ad_id_codes'],
    },
  },
  async execute(input, context) {
    return await metaApiTools.checkAdsInMeta({
      clientCode: (context.clientScope?.clientCode ?? input.client_code) as string,
      adIdCodes: input.ad_id_codes as string[],
    });
  },
});

// ---------------------------------------------------------------------------
// Media Library tools (Google Drive -> Meta Business Media Library)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'scan_media_library_folder',
    description:
      'Scan a Google Drive folder to preview media files before uploading to the Meta Business Media Library. Returns file list with naming status (which files need ad ID prefix), auto-detected client code, and target Business Manager routing. Use this FIRST when someone shares a Google Drive folder link, before calling upload_to_media_library.',
    input_schema: {
      type: 'object' as const,
      properties: {
        drive_url: {
          type: 'string',
          description: 'Google Drive folder URL (e.g. https://drive.google.com/drive/folders/abc123)',
        },
      },
      required: ['drive_url'],
    },
  },
  async execute(input) {
    return mediaLibraryTools.scanMediaLibraryFolder({
      drive_url: input.drive_url as string,
    });
  },
});

register({
  definition: {
    name: 'upload_to_media_library',
    description:
      'Rename files in Google Drive (prepend ad ID prefix) and upload them to the Meta Business Media Library. Routes to the correct Business Manager AND access token based on client code: TL and LA go to Growth Squad, all others go to Ads on Tap. Dedups by content hash and by title — pre-warmed files come back as skipped_title/skipped_hash with their cached video_id/image_hash in seconds. Always call scan_media_library_folder first to preview what will happen. If the result has a top-level `error`, some or all files failed: report the per-file errors and hints and do NOT proceed to preview/launch. This operation can take several minutes for large video files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        drive_url: {
          type: 'string',
          description: 'Google Drive folder URL',
        },
        client_code: {
          type: 'string',
          description: 'Client code (e.g. TL, LA, NP, MEOW). Determines which Business Manager to upload to.',
        },
        expected_asset_id: {
          type: 'string',
          description:
            'Authoritative ad-set asset id (e.g. "TLx4086") from the Notion ad set. When set, unprefixed files get THIS id prepended, and files carrying a DIFFERENT id fail with asset_id_conflict instead of being uploaded. Always pass it when uploading for a known ad set.',
        },
      },
      required: ['drive_url', 'client_code'],
    },
  },
  async execute(input) {
    return mediaLibraryTools.uploadToMediaLibrary({
      drive_url: input.drive_url as string,
      client_code: input.client_code as string,
      expected_asset_id: input.expected_asset_id as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'check_preupload_status',
    description:
      'Check whether the hourly background pre-upload worker has already uploaded + analyzed an ad set\'s final ads (Media Library upload, AssemblyAI transcript, Gemini visual analysis all done in the background). Call this FIRST when starting an upload/launch run for an ad code (e.g. "FPLx4099"). If pre_warmed=true: the slow work is done — still run scan + upload (they finish in seconds because every file dedups to skipped_title and returns its cached video_id) but SKIP the poll_analysis wait and go straight to preview. If flags are present (e.g. ss_name_invalid, ambiguous_subfolders, asset_id_conflict), surface them to the user before proceeding — the background worker was blocked for a reason a human needs to resolve. folder_url is the finals folder the worker resolved (useful when the Notion Final Ads Folder property is empty). media_assets lists the cached Meta ids + per-asset analysis state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ad codes to check, e.g. ["FPLx4099", "LAx3870"]',
        },
      },
      required: ['asset_ids'],
    },
  },
  async execute(input) {
    return mediaLibraryTools.checkPreuploadStatus({
      asset_ids: input.asset_ids as string[],
    });
  },
});

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
        concept: {
          type: 'string',
          description:
            "Ad-set concept/angle name for clients who name ad sets by concept (Sweetspot/SS), e.g. 'Auction-Win-Dirk', 'Is-This-A-Scam', 'Stop-Paying-Retail'. Derive it from the Drive folder / brief title in Rebecka's hyphenated Title-Case style (drop filler like 'The'/'with': folder 'The Auction Win with Dirk' → 'Auction-Win-Dirk'). The server appends the asset id automatically, rendering e.g. 'Auction-Win-Dirk // STSPx3938'. WINS over Notion-title naming, so ONLY pass it for Sweetspot — never for clients whose ad sets are named from a Notion ad-set DB (BFM, SLB, TL, etc.).",
        },
        brief_notion_id: { type: 'string' },
        source_drive_url: { type: 'string' },
        initiated_by: { type: 'string', description: 'Slack user ID who triggered this' },
        geo_tier: {
          type: 'string',
          enum: ['US', 'T1', 'T2'],
          description:
            "REQUIRED for tiered clients (currently BFM only). Three buckets: US (US-only), T1 (16 countries: AE, AT, AU, AX, CA, CH, CZ, DE, DK, GB, IE, NL, NO, NZ, SE, US — wealthy/anglo + DACH + Nordics + ME), T2 (17 countries: BE, CL, ES, FI, FR, GR, IL, IT, JP, MX, PE, PL, PT, RO, SG, TR, TW — LATAM + South Europe + Asia + Israel). Always ASK the user which tier before previewing on BFM — never guess. For non-tiered clients (PL, AOT, MEOW, SLB, URV), omit this; their geo is fixed in CLIENT_CONFIGS.",
        },
        scheduled_for: {
          type: 'string',
          description:
            "Optional ISO 8601 timestamp with explicit timezone offset (NO colon in offset). Format: 'YYYY-MM-DDTHH:MM:SS-0400' (e.g. '2026-05-25T06:00:00-0400' = next Monday 06:00 EDT). Per Dan 2026-05-23, Ada NEVER flips adsets ACTIVE — every adset is created PAUSED whether or not this is set. When set, the timestamp is stamped on the Meta adset as metadata (start_time field) so the user has a clear reminder of when they meant to manually activate it. Meta only honors start_time after the user manually flips status to ACTIVE. BFM's typical workflow is upload Friday → stamp intended Monday 06:00 ET as metadata → user flips Monday morning. Guards: rejected if in the past, <5min ahead, or >30 days out. Use client's timezone — BFM is America/New_York so always -0400 (EDT Mar-Nov) or -0500 (EST Nov-Mar).",
        },
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

register({
  definition: {
    name: 'qc_copy',
    description:
      "Run the client's voice-QC pass (Stella for LA/LA2, Steven for AB/ADBN, Alex for TL — the same *-qc skills, ported server-side) on generated copy BEFORE you show a launch preview at Gate 3. Returns a per-creative verdict (ship/revise/block) with compliance flags (cited rule IDs), voice flags (verbatim client precedents), and suggested `rewrites`. Apply the rewrites by passing them as edits.ad_overrides to launch_ads. ALWAYS run this for LA/LA2/AB/ADBN/TL after preview_ad_launch and before asking the user to confirm — never show raw Opus copy with known-fixable flags. Clients without a QC skill pass through with verdict=ship + a note (expected, not an error). Pass either the generated creatives copy or a batch_id.",
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string' },
        creatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              asset_id: { type: 'string' },
              video_id: { type: 'string' },
              image_hash: { type: 'string' },
              media_type: { type: 'string', enum: ['video', 'image'] },
              primary_text: { type: 'string' },
              headline: { type: 'string' },
              description: { type: 'string' },
              hook: { type: 'string' },
              sku_hint: { type: 'string' },
              language: { type: 'string' },
            },
          },
        },
        batch_id: { type: 'string', description: 'Pull copy from a preview instead of passing creatives' },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    return adLaunchTools.qcCopy(input as Parameters<typeof adLaunchTools.qcCopy>[0]);
  },
});

register({
  definition: {
    name: 'verify_launch',
    description:
      'Post-launch structural verification — MANDATORY after every launch_ads, never skip. A 200 from launch only means the API call worked; this confirms the adset landed in the locked sandbox campaign, effective_status is CAMPAIGN_PAUSED, the name has no `// null //` artifacts, page+IG match config, each creative has a lander+headline+primary_text, and url_tags carries the TripleWhale tw_adid macro. Returns verdict 🟢 OK / 🟡 WARN / 🔴 FAIL + findings. Pass { batch_id } (preferred) or { adset_id, client_code }. Surface any FAIL to the user — do not try to auto-fix.',
    input_schema: {
      type: 'object' as const,
      properties: {
        batch_id: { type: 'string' },
        adset_id: { type: 'string' },
        client_code: { type: 'string' },
      },
    },
  },
  async execute(input) {
    return adLaunchTools.verifyLaunch(input as Parameters<typeof adLaunchTools.verifyLaunch>[0]);
  },
});

register({
  definition: {
    name: 'poll_analysis',
    description:
      'Check whether uploaded videos have finished transcript + visual analysis. Run after upload_to_media_library and BEFORE preview_ad_launch — without analysis, copy generation returns usable=false. Non-blocking by default (timeout_seconds=0, a single snapshot); pass a small timeout_seconds (≤180) to wait briefly for in-flight work. Returns { ready, ready_count, total, by_video_id }. If some videos are not yet terminal, wait and re-poll rather than previewing against a cold cache.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string' },
        meta_video_ids: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number', description: '0 = snapshot (default); up to 180 to wait briefly' },
      },
      required: ['client_code', 'meta_video_ids'],
    },
  },
  async execute(input) {
    return adLaunchTools.pollAnalysis(input as Parameters<typeof adLaunchTools.pollAnalysis>[0]);
  },
});

register({
  definition: {
    name: 'set_adset_marker',
    description:
      'Prepend a visible (🔴 <ACTION>) marker to an adset name on Meta so anyone in Ads Manager sees a pending action before flipping it ACTIVE. Use at Gate 4 when a launch used a fallback landing page (marker "SWAP LP"), needs a copy edit, or is pending approval. Cleared manually in Ads Manager — there is no programmatic clear by design. Idempotent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string' },
        adset_id: { type: 'string' },
        marker_text: { type: 'string', description: 'e.g. SWAP LP, NEEDS COPY EDIT, PENDING APPROVAL' },
      },
      required: ['client_code', 'adset_id', 'marker_text'],
    },
  },
  async execute(input) {
    return adLaunchTools.setAdsetMarker(input as Parameters<typeof adLaunchTools.setAdsetMarker>[0]);
  },
});

// ---------------------------------------------------------------------------
// Slack tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'post_message',
    description:
      'Post a message to a Slack channel. Use for proactive communication like notifications, reminders, or follow-ups.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID to post to',
        },
        text: {
          type: 'string',
          description: 'Message text (supports Slack mrkdwn formatting)',
        },
        thread_ts: {
          type: 'string',
          description: 'Thread timestamp to reply in (optional)',
        },
      },
      required: ['channel', 'text'],
    },
  },
  async execute(input) {
    const result = await slackTools.postMessage({
      channel: input.channel as string,
      text: input.text as string,
      thread_ts: input.thread_ts as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'reply_in_thread',
    description: 'Reply to a specific Slack thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID',
        },
        thread_ts: {
          type: 'string',
          description: 'Thread timestamp to reply to',
        },
        text: {
          type: 'string',
          description: 'Reply text (supports Slack mrkdwn formatting)',
        },
      },
      required: ['channel', 'thread_ts', 'text'],
    },
  },
  async execute(input) {
    const result = await slackTools.replyInThread({
      channel: input.channel as string,
      thread_ts: input.thread_ts as string,
      text: input.text as string,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'search_slack_messages',
    description:
      'Search messages across every Slack channel the workspace can see — internal AND external (client-facing) channels. Use this for ground-truth research that Notion never captures: client feedback and revision notes, approvals, delivery confirmations ("delivered", "sent to client", "we shipped X"), go-live confirmations, and any "what did the client actually say" question. Results include thread replies; when a match has a thread_ts, use read_slack_thread to pull the full conversation. Supports Slack search modifiers in the query: in:#channel, from:@user, after:YYYY-MM-DD, "exact phrase".',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query. May include Slack modifiers, e.g. `Laori delivered after:2026-05-25` or `"sent to client" in:#internal-brainfm`.',
        },
        count: {
          type: 'number',
          description: 'Max results to return (default 20).',
        },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    const result = await slackTools.searchSlackMessages({
      query: input.query as string,
      count: input.count as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'read_slack_channel',
    description:
      'Read recent messages from a specific Slack channel (by channel ID, or by #name which is resolved). Use after search_slack_messages to get the surrounding context of a delivery/approval message, or to scan a known client channel directly. NOTE: thread replies are NOT included in channel history — a returned message with a reply_count has a hidden conversation under it; pull it with read_slack_thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Channel ID (e.g. C0B5SA7SZLZ) or #name (e.g. #internal-brainfm).',
        },
        limit: {
          type: 'number',
          description: 'Number of recent messages to return (default 30).',
        },
        oldest: {
          type: 'string',
          description: 'Only messages at/after this Slack ts (optional).',
        },
      },
      required: ['channel'],
    },
  },
  async execute(input) {
    const result = await slackTools.readSlackChannel({
      channel: input.channel as string,
      limit: input.limit as number | undefined,
      oldest: input.oldest as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'read_slack_thread',
    description:
      'Read a full Slack thread — the parent message plus every reply. Client feedback, revision notes, and approvals routinely live in thread replies under a delivery post, and those replies are invisible to read_slack_channel and only partially surfaced by search. Use the thread_ts from a search match, or the ts of a channel-history message that shows a reply_count.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Channel ID (e.g. C0A6B4X8WP3) or #name (e.g. #audibene-ads-on-tap).',
        },
        thread_ts: {
          type: 'string',
          description: 'Timestamp of the thread parent message (e.g. "1779977032.288949").',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (default 50).',
        },
      },
      required: ['channel', 'thread_ts'],
    },
  },
  async execute(input) {
    const result = await slackTools.readSlackThread({
      channel: input.channel as string,
      thread_ts: input.thread_ts as string,
      limit: input.limit as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'send_as_daniel',
    description:
      'Send a Slack message as Daniel (using his user token). This posts from Daniel\'s account, not the bot. IMPORTANT: Only use when Daniel explicitly asks you to send a message on his behalf. Always confirm the exact message content with Daniel before sending.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID to post to',
        },
        text: {
          type: 'string',
          description: 'Message text (supports Slack mrkdwn formatting)',
        },
        thread_ts: {
          type: 'string',
          description: 'Thread timestamp to reply in (optional)',
        },
      },
      required: ['channel', 'text'],
    },
  },
  async execute(input) {
    const result = await slackTools.sendAsDaniel({
      channel: input.channel as string,
      text: input.text as string,
      thread_ts: input.thread_ts as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'read_dms',
    description:
      'Read recent messages from a Slack DM or channel using Daniel\'s user token. Use to check Daniel\'s private conversations when he asks. Use find_user first to get the DM channel ID if you only have a person\'s name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel or DM ID to read from',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch (default 20)',
        },
      },
      required: ['channel'],
    },
  },
  async execute(input) {
    const result = await slackTools.readDMs({
      channel: input.channel as string,
      limit: input.limit as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'find_user',
    description:
      'Look up a Slack user by name. Returns their user ID, real name, and DM channel ID. Use this when you need to find someone\'s DM channel to read messages or send as Daniel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name to search for (first name, last name, display name, or username)',
        },
      },
      required: ['name'],
    },
  },
  async execute(input) {
    const result = await slackTools.findUser({
      name: input.name as string,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'get_unread_dms',
    description:
      'Scan all of Daniel\'s DM and group DM conversations for unread messages. Returns conversations with unread messages, participant names, and message content. Does NOT mark messages as read. Use this to triage Daniel\'s inbox or check what he\'s missed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of conversations to return (default 15)',
        },
      },
      required: [],
    },
  },
  async execute(input) {
    const result = await slackTools.getUnreadDMs({
      limit: input.limit as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a Slack message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID',
        },
        timestamp: {
          type: 'string',
          description: 'Message timestamp to react to',
        },
        name: {
          type: 'string',
          description: 'Emoji name without colons (e.g. "thumbsup")',
        },
      },
      required: ['channel', 'timestamp', 'name'],
    },
  },
  async execute(input) {
    const result = await slackTools.addReaction({
      channel: input.channel as string,
      timestamp: input.timestamp as string,
      name: input.name as string,
    });
    return JSON.stringify(result);
  },
});

// ---------------------------------------------------------------------------
// Supabase tools (BMAD data)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'list_clients',
    description:
      'List all active advertising clients with their codes, currencies, and conversion goals.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async execute() {
    return await supabaseTools.listClients();
  },
});

register({
  definition: {
    name: 'get_client_performance',
    description:
      'Get account-level daily ad performance metrics for a client. Includes spend, impressions, reach, frequency, clicks, link_clicks, funnel stages (content_views, add_to_carts, checkouts_initiated), purchases, purchase_value, revenue, ROAS, CPA, CPM, CTR, and raw actions JSONB.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "ninepine", "press_london")',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back (default 7)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getClientPerformance({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_campaign_performance',
    description:
      'Get campaign-level DAILY performance (one row per campaign per day). Large result set — prefer get_campaign_summary first for an overview, then use this for daily trends of specific campaigns. Limit days to 3-7 for broad queries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back (default 7)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getCampaignPerformance({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_alerts',
    description:
      'Get anomaly alerts and automated investigations for ad accounts. Includes root causes and recommended actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (optional — omit for all clients)',
        },
        severity: {
          type: 'string',
          description: 'Filter by severity: critical, warning, or insight',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back (default 7)',
        },
      },
    },
  },
  async execute(input) {
    return await supabaseTools.getAlerts({
      clientCode: input.clientCode as string | undefined,
      severity: input.severity as string | undefined,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_learnings',
    description:
      'Get accumulated ad performance learnings by client and category (market, campaign, ad, creative, seasonality).',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (optional)',
        },
        category: {
          type: 'string',
          description:
            'Category filter: market, campaign, ad, creative, seasonality',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20)',
        },
      },
    },
  },
  async execute(input) {
    return await supabaseTools.getLearnings({
      clientCode: input.clientCode as string | undefined,
      category: input.category as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_briefs',
    description: 'Get creative briefs for a client, optionally filtered by status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        status: {
          type: 'string',
          description:
            'Filter by status: draft, review, approved, in_production, completed',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getBriefs({
      clientCode: input.clientCode as string,
      status: input.status as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_concepts',
    description:
      'Get creative concepts with dial settings for a client, optionally filtered by status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        status: {
          type: 'string',
          description: 'Filter by status (optional)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getConcepts({
      clientCode: input.clientCode as string,
      status: input.status as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_adset_performance',
    description:
      'Get ad set level daily performance metrics for a client. Use to drill down from campaign level into ad sets for optimization decisions (kill/scale/pause).',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "ninepine")',
        },
        campaignId: {
          type: 'string',
          description: 'Optional campaign ID to filter by',
        },
        days: {
          type: 'number',
          description: 'Number of days (default 7)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getAdsetPerformance({
      clientCode: input.clientCode as string,
      campaignId: input.campaignId as string | undefined,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_ad_performance',
    description:
      'Get ad-level DAILY performance with creative metrics (hook rate, hold rate, video completion). ALWAYS pass campaignId or adsetId — full account queries are very large. Prefer get_ad_summary first for a compact overview.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        campaignId: {
          type: 'string',
          description: 'Optional campaign ID filter',
        },
        adsetId: {
          type: 'string',
          description: 'Optional ad set ID filter',
        },
        days: {
          type: 'number',
          description: 'Number of days (default 7)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getAdPerformance({
      clientCode: input.clientCode as string,
      campaignId: input.campaignId as string | undefined,
      adsetId: input.adsetId as string | undefined,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_breakdowns',
    description:
      'Get performance breakdowns by age, gender, country, placement, device, or platform. Use for device-level analysis (iOS vs Android), placement optimization, and audience insights. Supports long date ranges (YTD) — set days explicitly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        breakdownType: {
          type: 'string',
          enum: ['age', 'gender', 'country', 'placement', 'device', 'platform'],
          description: 'Type of breakdown',
        },
        entityType: {
          type: 'string',
          enum: ['account', 'campaign', 'adset', 'ad'],
          description: 'Level of breakdown (default: account)',
        },
        entityId: {
          type: 'string',
          description: 'Optional campaign/adset/ad ID',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back. Default 7. For YTD queries, calculate days from Jan 1 to today. ALWAYS set explicitly.',
        },
        aggregate: {
          type: 'boolean',
          description: 'Aggregate totals by breakdown value (e.g. totals per country). Auto-enabled for >14 days. Set true for YTD/long-range queries.',
        },
      },
      required: ['clientCode', 'breakdownType'],
    },
  },
  async execute(input) {
    return await supabaseTools.getBreakdowns({
      clientCode: input.clientCode as string,
      breakdownType: input.breakdownType as string,
      entityType: input.entityType as string | undefined,
      entityId: input.entityId as string | undefined,
      aggregate: input.aggregate as boolean | undefined,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_account_changes',
    description:
      'Get recent account activity log — budget changes, ad creation, status changes. Use to understand "what changed" when diagnosing performance shifts (Root Cause: You).',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        days: {
          type: 'number',
          description: 'Number of days (default 7)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getAccountChanges({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_weather_daily',
    description:
      'Get daily country-level weather (mean/max/min temperature °C, cloud cover %, sunshine hours, precipitation mm, max wind km/h) from BMAD. Currently populated for DE only (Open-Meteo, population-weighted across top 10 cities). Use to correlate weather with performance for weather-sensitive clients like Laori (non-alcoholic drinks — warmer/sunnier days drive demand). Combine with daily spend/ROAS from get_campaign_performance or get_client_performance (groupBy=date) to compute correlations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        countryCode: {
          type: 'string',
          description: 'ISO-2 country code (e.g. "DE"). Default "DE". Only DE is currently populated.',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back from today. Default 90. Ignored if startDate/endDate provided.',
        },
        startDate: {
          type: 'string',
          description: 'Optional ISO date (YYYY-MM-DD) for the start of the range.',
        },
        endDate: {
          type: 'string',
          description: 'Optional ISO date (YYYY-MM-DD) for the end of the range. Defaults to today.',
        },
      },
      required: [],
    },
  },
  async execute(input) {
    return await supabaseTools.getWeatherDaily({
      countryCode: input.countryCode as string | undefined,
      days: input.days as number | undefined,
      startDate: input.startDate as string | undefined,
      endDate: input.endDate as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_creative_details',
    description:
      'Get creative metadata — ad copy, headlines, video transcripts, AI tags, fatigue status, performance scores. Use for creative analysis without needing to see the actual media.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code',
        },
        creativeId: {
          type: 'string',
          description: 'Optional specific creative ID',
        },
        adId: {
          type: 'string',
          description: 'Optional specific ad ID',
        },
        onlyFatigued: {
          type: 'boolean',
          description: 'Only return fatigued creatives',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getCreativeDetails({
      clientCode: input.clientCode as string,
      creativeId: input.creativeId as string | undefined,
      adId: input.adId as string | undefined,
      onlyFatigued: input.onlyFatigued as boolean | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Triple Whale blended profitability (e-com truth source Meta doesn't have)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_triplewhale_summary',
    description:
      'Get blended profitability metrics from Triple Whale for an e-commerce client: NET PROFIT (totalNetProfit = Order Revenue - Returns - all Expenses - Blended Ad Spend), Gross Profit, Order Revenue, COGS, Custom Expenses, Blended Ad Spend/ROAS/CPA, POAS, per-channel spend (FB/Google). This is the business-truth layer above Meta ROAS — TW blends Shopify orders, all ad channels and the client\'s cost inputs. Currently mapped: LA (Laori), PL (Press London). For Laori, net profit is the number the client reports on weekly — ALWAYS include it when discussing Laori performance. Each metric returns `current` and `previous` (the preceding window of equal length) so period-over-period deltas need no second call. Default window: last 7 full days ending yesterday (today is partial in TW). Pass startDate/endDate for exact windows (e.g. Fri-Sun weekend reads). Pass extra TW metricIds via metricIds if you need something beyond the default profitability set.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "LA" for Laori, "PL" for Press London)',
        },
        days: {
          type: 'number',
          description: 'Window length in days, ending yesterday. Default 7. Ignored if startDate/endDate provided.',
        },
        startDate: {
          type: 'string',
          description: 'Optional ISO date (YYYY-MM-DD) for the start of the window.',
        },
        endDate: {
          type: 'string',
          description: 'Optional ISO date (YYYY-MM-DD) for the end of the window (inclusive). Defaults to yesterday.',
        },
        metricIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional Triple Whale metricIds to include beyond the default profitability set (e.g. "shopifyAov", "totalRefunds", "tiktok_complete_payment_roas").',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await triplewhaleTools.getTriplewhaleSummary({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
      startDate: input.startDate as string | undefined,
      endDate: input.endDate as string | undefined,
      metricIds: input.metricIds as string[] | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Domo / Salesforce funnel data (downstream metrics Meta doesn't have)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_domo_funnel',
    description:
      'Get Salesforce funnel data from Domo — downstream metrics that Meta/Google don\'t have: appointments (opportunities_sf), CPA from Salesforce, CR2 (lead-to-appointment rate), lead quality (first care share, degree of suffering, prescription share), autoclose rate. Data is from Domo CSV exports uploaded manually. Use groupBy to control aggregation: "date" for daily trends, "ad" for per-ad, "campaign" for per-campaign, "adset" for per-adset, "account" for single total. IMPORTANT: The same creative can exist across multiple campaigns with different ad_ids — use adName with the creative name (e.g. "SENSATION-IMAGE-4x5-ADBNx3431v1") to search across all campaigns rather than filtering by a single adId. Do NOT search by ACT code (account-level, not ad-level). Returns computed metrics: cpa_sf, cr2, autoclose_rate, first_care_share, severe_suffering_share, rx_share, data_completeness.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "AB" for Audibene)',
        },
        days: {
          type: 'number',
          description: 'Number of days to look back (default 30)',
        },
        campaignId: {
          type: 'string',
          description: 'Optional campaign ID filter',
        },
        adsetId: {
          type: 'string',
          description: 'Optional ad set ID filter',
        },
        adId: {
          type: 'string',
          description: 'Optional ad ID filter (numeric Meta ad ID). Prefer adName over adId since the same creative has different ad_ids in different campaigns.',
        },
        adName: {
          type: 'string',
          description: 'Search ad name (case-insensitive partial match). Use the creative name to find all instances across campaigns — e.g. "SENSATION-IMAGE-4x5-ADBNx3431v1" for a specific ad, or "SENSATION" for all variants. Do NOT use ACT codes (they are account-level, shared across many creatives).',
        },
        groupBy: {
          type: 'string',
          enum: ['date', 'ad', 'campaign', 'adset', 'account'],
          description: 'How to aggregate: "date" (daily trend), "ad" (per-ad totals), "campaign", "adset", "account" (single total). Default: "date".',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getDomoFunnel({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
      campaignId: input.campaignId as string | undefined,
      adsetId: input.adsetId as string | undefined,
      adId: input.adId as string | undefined,
      adName: input.adName as string | undefined,
      groupBy: input.groupBy as string | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Summary tools (server-side aggregation — 1 row per entity)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_campaign_summary',
    description:
      'Get aggregated campaign-level summary (one row per campaign). Use FIRST to see all campaigns at a glance — includes totals, computed rates, and last-3-day recency metrics. For daily trends of a specific campaign, use get_campaign_performance after.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "NP", "PL", "JVA")',
        },
        days: {
          type: 'number',
          description: 'Number of days to aggregate (default 30)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getCampaignSummary({
      clientCode: input.clientCode as string,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_adset_summary',
    description:
      'Get aggregated ad set summary (one row per ad set). Pass campaignId to focus on a specific campaign\'s ad sets. For daily trends, use get_adset_performance with campaignId filter after.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "NP", "PL", "JVA")',
        },
        campaignId: {
          type: 'string',
          description: 'Optional campaign ID to filter ad sets',
        },
        days: {
          type: 'number',
          description: 'Number of days to aggregate (default 30)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getAdsetSummary({
      clientCode: input.clientCode as string,
      campaignId: input.campaignId as string | undefined,
      days: input.days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_ad_summary',
    description:
      'Get aggregated ad-level summary with creative metrics (one row per ad). REQUIRES campaignId or adsetId — will error without one. Use get_campaign_summary first to identify campaigns, then drill down here.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code (e.g. "NP", "PL", "JVA")',
        },
        campaignId: {
          type: 'string',
          description: 'Campaign ID to filter ads (required unless adsetId provided)',
        },
        adsetId: {
          type: 'string',
          description: 'Ad set ID to filter ads (required unless campaignId provided)',
        },
        days: {
          type: 'number',
          description: 'Number of days to aggregate (default 30)',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await supabaseTools.getAdSummary({
      clientCode: input.clientCode as string,
      campaignId: input.campaignId as string | undefined,
      adsetId: input.adsetId as string | undefined,
      days: input.days as number | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Client config tools (BMAD YAML files)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_client_targets',
    description:
      'Get the full KPI targets, benchmarks, anomaly thresholds, and analysis config for a client. Includes primary KPI, target values, category-specific targets, funnel benchmarks, budget, and markets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        clientCode: {
          type: 'string',
          description: 'Client code from list_clients (e.g. "NP", "PL", "SS")',
        },
      },
      required: ['clientCode'],
    },
  },
  async execute(input) {
    return await clientConfigTools.getClientTargets({
      clientCode: input.clientCode as string,
    });
  },
});

// ---------------------------------------------------------------------------
// Fireflies meeting tools (DAI Supabase)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'search_meetings',
    description:
      'Search meeting transcripts by keyword. Returns ranked results across titles, summaries, and full transcripts. Supports date range and speaker filters.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (keywords to find in meeting content)',
        },
        fromDate: {
          type: 'string',
          description: 'Start date filter (ISO 8601, e.g. "2025-01-01")',
        },
        toDate: {
          type: 'string',
          description: 'End date filter (ISO 8601)',
        },
        speaker: {
          type: 'string',
          description: 'Filter by speaker name',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20)',
        },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    return await firefliesTools.searchMeetings({
      query: input.query as string,
      fromDate: input.fromDate as string | undefined,
      toDate: input.toDate as string | undefined,
      speaker: input.speaker as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_meeting_summary',
    description:
      'Get the full summary, action items, and metadata for a specific meeting by its Fireflies ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        meetingId: {
          type: 'string',
          description: 'Fireflies meeting ID',
        },
      },
      required: ['meetingId'],
    },
  },
  async execute(input) {
    return await firefliesTools.getMeetingSummary({
      meetingId: input.meetingId as string,
    });
  },
});

register({
  definition: {
    name: 'get_meeting_transcript',
    description:
      'Get the sentence-level transcript of a meeting. Optionally filter by speaker name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        meetingId: {
          type: 'string',
          description: 'Fireflies meeting ID',
        },
        speaker: {
          type: 'string',
          description: 'Filter sentences by speaker name (partial match)',
        },
      },
      required: ['meetingId'],
    },
  },
  async execute(input) {
    return await firefliesTools.getMeetingTranscript({
      meetingId: input.meetingId as string,
      speaker: input.speaker as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'list_recent_meetings',
    description:
      'List recent meetings in chronological order. Useful for "what meetings did I have this week?" queries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look back (default 7)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20)',
        },
        speaker: {
          type: 'string',
          description: 'Filter by speaker name',
        },
      },
    },
  },
  async execute(input) {
    return await firefliesTools.listRecentMeetings({
      days: input.days as number | undefined,
      limit: input.limit as number | undefined,
      speaker: input.speaker as string | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Notion tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'query_tasks',
    description:
      'Query tasks from the Notion kanban board. Filter by status, assignee, priority, type, or parent project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by task status: To Do, In Progress, Blocked, Done',
        },
        assignee: {
          type: 'string',
          description: 'Filter by assignee name (e.g. Daniel, Jasmin, Ada, Otto, Coda, Rex, Sage)',
        },
        priority: {
          type: 'string',
          description: 'Filter by priority: Urgent, High, Medium, Low',
        },
        type: {
          type: 'string',
          description: 'Filter by type: Task, Project',
        },
        parentId: {
          type: 'string',
          description: 'Filter tasks by parent project page ID',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return (default 20)',
        },
      },
    },
  },
  async execute(input) {
    return await notionTools.queryTasks({
      status: input.status as string | undefined,
      assignee: input.assignee as string | undefined,
      priority: input.priority as string | undefined,
      type: input.type as string | undefined,
      parentId: input.parentId as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'create_task',
    description: 'Create a new task or project on the Notion kanban board. Always populate all fields.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'The task title' },
        status: {
          type: 'string',
          description: 'Task status: To Do, In Progress, Blocked, Done (default: To Do)',
        },
        assignee: { type: 'string', description: 'Who to assign to (e.g. Daniel, Jasmin, Ada, Otto, Coda, Rex, Sage)' },
        priority: {
          type: 'string',
          description: 'Task priority: Urgent, High, Medium, Low (default: Medium)',
        },
        dueDate: {
          type: 'string',
          description: 'Due date in ISO format (e.g. 2025-01-15)',
        },
        description: {
          type: 'string',
          description: 'Task description (added as page content)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels: personal, work, dai, bmad, agency, follow-up, waiting',
        },
        type: {
          type: 'string',
          description: 'Item type: Task (default) or Project',
        },
        parentId: {
          type: 'string',
          description: 'Parent project page ID (links task to a project)',
        },
      },
      required: ['title'],
    },
  },
  async execute(input) {
    return await notionTools.createTask({
      title: input.title as string,
      status: input.status as string | undefined,
      assignee: input.assignee as string | undefined,
      priority: input.priority as string | undefined,
      dueDate: input.dueDate as string | undefined,
      description: input.description as string | undefined,
      labels: input.labels as string[] | undefined,
      type: input.type as string | undefined,
      parentId: input.parentId as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'update_task',
    description: 'Update an existing task or project on the Notion kanban board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string', description: 'The Notion page ID of the task to update' },
        status: { type: 'string', description: 'New status: To Do, In Progress, Blocked, Done' },
        assignee: { type: 'string', description: 'New assignee (e.g. Daniel, Jasmin, Ada, Otto, Coda, Rex, Sage)' },
        priority: { type: 'string', description: 'New priority: Urgent, High, Medium, Low' },
        dueDate: { type: 'string', description: 'New due date (ISO format)' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'New labels: personal, work, dai, bmad, agency, follow-up, waiting',
        },
        type: { type: 'string', description: 'Item type: Task or Project' },
        parentId: { type: 'string', description: 'Parent project page ID' },
      },
      required: ['pageId'],
    },
  },
  async execute(input) {
    return await notionTools.updateTask({
      pageId: input.pageId as string,
      status: input.status as string | undefined,
      assignee: input.assignee as string | undefined,
      priority: input.priority as string | undefined,
      dueDate: input.dueDate as string | undefined,
      labels: input.labels as string[] | undefined,
      type: input.type as string | undefined,
      parentId: input.parentId as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'add_task_comment',
    description: 'Add a comment to a Notion task page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string', description: 'The Notion page ID to comment on' },
        comment: { type: 'string', description: 'The comment text to add' },
      },
      required: ['pageId', 'comment'],
    },
  },
  async execute(input) {
    return await notionTools.addTaskComment({
      pageId: input.pageId as string,
      comment: input.comment as string,
    });
  },
});

register({
  definition: {
    name: 'search_notion',
    description: 'Search across the entire Notion workspace for pages matching a query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query' },
        limit: { type: 'number', description: 'Maximum results (default 10)' },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    return await notionTools.searchNotion({
      query: input.query as string,
      limit: input.limit as number | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// AOT-shaped Notion tools (production pipeline)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'query_aot_tasks',
    description:
      'Query the AOT production-pipeline Tasks Notion database. Each task is linked to an Ad Set and a Client. Returns task name, status, stage, due date, ad set info, assignee display names (assignee_names) alongside their Notion user IDs, priority, impact severity, overdue flag, and the live Delay Alert formula text. Default returns active tasks (not Done/Cancelled) and excludes tasks on dead ad sets (Completed/Cancelled/On Hold), sorted by due date ascending. **Default freshness window is 90 days** on last_edited_time — tasks nobody has touched in 3+ months are treated as zombies and filtered out. This is what the team usually cares about (recent actionable work). For forensic audits of old data, explicitly pass `freshness_window_days: 0`. **Pagination is automatic**: the tool fetches every matching page up to a 5000-row safety ceiling, so results are complete by default. The response includes `truncated_at_ceiling: true` ONLY if the ceiling was hit — in that case, narrow the filter and re-query. Always cite assignees by their assignee_names, not the user IDs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status_group: {
          type: 'string',
          enum: ['active', 'done', 'all'],
          description: 'active = exclude Done/Cancelled/Complete/Archived Task (default — these are all terminal statuses the team uses interchangeably), done = only Done, all = everything including archived/soft-archived rows',
        },
        overdue_only: {
          type: 'boolean',
          description: 'Only return tasks where the live Overdue Check formula is true.',
        },
        due_on_or_before: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) — tasks with due dates on or before this date',
        },
        due_on_or_after: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) — tasks with due dates on or after this date',
        },
        assignee_user_id: {
          type: 'string',
          description: 'Notion user ID (without the user:// prefix) to filter by assignee',
        },
        client_relation_id: {
          type: 'string',
          description: 'Notion page ID of a client to filter by',
        },
        ad_set_relation_id: {
          type: 'string',
          description: 'Notion page ID of an ad set to filter by',
        },
        client_name_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the client name (resolved in-memory after fetch — use for ad-hoc filtering when you do not know the client page ID)',
        },
        task_name_contains: {
          type: 'string',
          description: 'Substring of the task name (case-insensitive). Pushed down as a Notion title.contains filter. Common values: "upload" (find upload-and-configure tasks), "QC", "brief", "send to client".',
        },
        exclude_dead_ad_sets: {
          type: 'boolean',
          description: 'Exclude tasks whose Ad Set Stage rollup is Completed, Cancelled, or On Hold. Default true (filters out year-old zombie tasks on dead ad sets). Set false to inspect raw task state.',
        },
        freshness_window_days: {
          type: 'number',
          description: 'Only return tasks whose Notion last_edited_time is within the last N days. Default 90 (filters out abandoned tasks nobody has touched in 3+ months — the dominant source of database noise). Pass 0 to disable and return tasks of any age (forensic/zombie audits only — expect large result sets and likely truncation).',
        },
        limit: {
          type: 'number',
          description: 'Optional cap on total tasks returned. Default and max = 5000 (the safety ceiling). Pagination is automatic, so leaving this unset returns ALL matching tasks. Set a lower value only if you explicitly want a sample (e.g. "first 10 by due date").',
        },
      },
    },
  },
  async execute(input) {
    return await aotNotionTools.queryAotTasks({
      status_group: input.status_group as 'active' | 'done' | 'all' | undefined,
      overdue_only: input.overdue_only as boolean | undefined,
      due_on_or_before: input.due_on_or_before as string | undefined,
      due_on_or_after: input.due_on_or_after as string | undefined,
      assignee_user_id: input.assignee_user_id as string | undefined,
      client_relation_id: input.client_relation_id as string | undefined,
      ad_set_relation_id: input.ad_set_relation_id as string | undefined,
      client_name_contains: input.client_name_contains as string | undefined,
      task_name_contains: input.task_name_contains as string | undefined,
      exclude_dead_ad_sets: input.exclude_dead_ad_sets as boolean | undefined,
      freshness_window_days: input.freshness_window_days as number | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'query_aot_adsets',
    description:
      'Query the AOT production-pipeline Ad Sets Notion database. An ad set is the unit of work that travels through stages (Concept → Brief → Production → Editing → QC → Media Buying → Done). Returns ad_id_code (e.g. ADBNx3475), ad_title, stage, format, ad_delivery_date, client_code + client_status, owner_names (resolved from Notion user IDs), the currently-active task name (active_task) and its assignee (task_assignee_name), task_progress (0-1), overdue_tasks_count, task_count, brief_relation_ids, drive_folder_url, final_ads_folder_url, frameio_url, and health_check. Default excludes ad sets in dead stages (Completed/Cancelled/On Hold). **Default freshness window is 90 days** on last_edited_time — ad sets nobody has touched in 3+ months are treated as zombies and filtered out. For forensic audits of old data, explicitly pass `freshness_window_days: 0`. Use this for cadence reads ("what is each client producing this week"), capacity gaps ("what is in concept vs production"), and overdue-ad-set surfacing. Use query_aot_tasks when you need the per-task detail underneath. **Pagination is automatic**: the tool fetches every matching page up to a 5000-row safety ceiling, so results are complete by default. The response includes `truncated_at_ceiling: true` ONLY if the ceiling was hit — in that case, narrow the filter and re-query. Always cite owners by owner_names, not user IDs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        stage: {
          type: 'string',
          description: 'Filter by exact Stage status name (e.g., "Concept", "Brief", "Production", "Editing", "QC", "Media Buying", "Done"). Omit to return ad sets across all active stages.',
        },
        exclude_dead_ad_sets: {
          type: 'boolean',
          description: 'Exclude ad sets whose Stage is Completed, Cancelled, or On Hold. Default true. Set false to inspect dead/archived ad sets.',
        },
        client_relation_id: {
          type: 'string',
          description: 'Notion page ID of a client to filter by',
        },
        client_name_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the client name (resolved in-memory after fetch — use for ad-hoc filtering when you do not know the client page ID)',
        },
        client_code: {
          type: 'string',
          description: 'Exact client CODE, e.g. "FPL", "LA", "ADBN", "JVA". Use this when someone references a client by its short code rather than name (e.g. "the FPL ad set"). client_code is the same code embedded in ad_id_code.',
        },
        ad_id_code_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the ad-set\'s ad_id_code, e.g. "FPLx4099" for one specific ad set, or "FPL" for all of that client\'s. Use this to resolve a reference to a specific ad set by its code.',
        },
        owner_user_id: {
          type: 'string',
          description: 'Notion user ID (without the user:// prefix) to filter by ad-set owner',
        },
        format: {
          type: 'string',
          description: 'Filter by Format select value (e.g., "UGC", "Static", "Video Ad", "Motion Graphic", "Special Project")',
        },
        delivery_on_or_before: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) — ad sets with Ad Delivery Date on or before this date',
        },
        delivery_on_or_after: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) — ad sets with Ad Delivery Date on or after this date',
        },
        has_overdue_tasks: {
          type: 'boolean',
          description: 'Only return ad sets where the Overdue Tasks Count rollup is greater than 0. Use this to surface ad sets actually slipping vs ad sets with stale tasks already filtered out.',
        },
        freshness_window_days: {
          type: 'number',
          description: 'Only return ad sets whose Notion last_edited_time is within the last N days. Default 90 (filters out abandoned ad sets nobody has touched in 3+ months — the dominant source of database noise). Pass 0 to disable and return ad sets of any age (forensic audits only).',
        },
        sort_by: {
          type: 'string',
          enum: ['delivery_date_asc', 'delivery_date_desc', 'last_edited_desc', 'created_desc'],
          description: 'Sort order. Default delivery_date_asc (next-delivery first).',
        },
        limit: {
          type: 'number',
          description: 'Optional cap on total ad sets returned. Default and max = 5000 (the safety ceiling). Pagination is automatic, so leaving this unset returns ALL matching ad sets. Set a lower value only if you explicitly want a sample.',
        },
      },
    },
  },
  async execute(input) {
    return await aotNotionTools.queryAotAdSets({
      stage: input.stage as string | undefined,
      exclude_dead_ad_sets: input.exclude_dead_ad_sets as boolean | undefined,
      client_relation_id: input.client_relation_id as string | undefined,
      client_name_contains: input.client_name_contains as string | undefined,
      client_code: input.client_code as string | undefined,
      ad_id_code_contains: input.ad_id_code_contains as string | undefined,
      owner_user_id: input.owner_user_id as string | undefined,
      format: input.format as string | undefined,
      delivery_on_or_before: input.delivery_on_or_before as string | undefined,
      delivery_on_or_after: input.delivery_on_or_after as string | undefined,
      has_overdue_tasks: input.has_overdue_tasks as boolean | undefined,
      freshness_window_days: input.freshness_window_days as number | undefined,
      sort_by: input.sort_by as 'delivery_date_asc' | 'delivery_date_desc' | 'last_edited_desc' | 'created_desc' | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'count_aot_tasks',
    description:
      'Count AOT Tasks matching the same filters as query_aot_tasks, without returning row payloads. Use this whenever you only need an aggregate ("how many overdue across all clients", "how many active tasks per client", "how many tasks on Audibene this week") — it sidesteps the runtime payload cap that query_aot_tasks hits on large result sets. Returns `total`, `truncated_at_ceiling`, and (if `group_by` is set) a `groups` object mapping bucket → count, sorted by count desc. For `group_by` = `assignee` or `client`, a task with N assignees/clients is counted in each bucket, so group sums may exceed `total` — the response includes `multi_value_group: true` when this can happen. Tasks with no assignee → `(unassigned)`; no client → `(no client)`; null property values → `(none)`. Filter semantics, freshness defaults, and dead-ad-set exclusion match query_aot_tasks exactly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status_group: {
          type: 'string',
          enum: ['active', 'done', 'all'],
          description: 'active = exclude Done/Cancelled/Complete/Archived Task (default), done = only Done, all = everything',
        },
        overdue_only: {
          type: 'boolean',
          description: 'Only count tasks where the live Overdue Check formula is true.',
        },
        due_on_or_before: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        due_on_or_after: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        assignee_user_id: { type: 'string', description: 'Notion user ID to filter by assignee' },
        client_relation_id: { type: 'string', description: 'Notion page ID of a client to filter by' },
        ad_set_relation_id: { type: 'string', description: 'Notion page ID of an ad set to filter by' },
        client_name_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the client name (resolved in-memory after fetch)',
        },
        task_name_contains: {
          type: 'string',
          description: 'Substring of the task name (case-insensitive, pushed down as title.contains).',
        },
        exclude_dead_ad_sets: {
          type: 'boolean',
          description: 'Exclude tasks on Completed/Cancelled/On Hold ad sets. Default true.',
        },
        freshness_window_days: {
          type: 'number',
          description: 'Only count tasks with last_edited_time in the last N days. Default 90. Pass 0 to disable.',
        },
        group_by: {
          type: 'string',
          enum: ['status', 'stage', 'ad_set_stage', 'assignee', 'client', 'priority', 'department', 'format', 'overdue'],
          description: 'Optional grouping dimension. Returns `groups: { bucket_name: count }` sorted desc. Omit for a single `total`.',
        },
        limit: {
          type: 'number',
          description: 'Cap on rows scanned. Default and max = 5000. Lower this only for sampling.',
        },
      },
    },
  },
  async execute(input) {
    return await aotNotionTools.countAotTasks({
      status_group: input.status_group as 'active' | 'done' | 'all' | undefined,
      overdue_only: input.overdue_only as boolean | undefined,
      due_on_or_before: input.due_on_or_before as string | undefined,
      due_on_or_after: input.due_on_or_after as string | undefined,
      assignee_user_id: input.assignee_user_id as string | undefined,
      client_relation_id: input.client_relation_id as string | undefined,
      ad_set_relation_id: input.ad_set_relation_id as string | undefined,
      client_name_contains: input.client_name_contains as string | undefined,
      task_name_contains: input.task_name_contains as string | undefined,
      exclude_dead_ad_sets: input.exclude_dead_ad_sets as boolean | undefined,
      freshness_window_days: input.freshness_window_days as number | undefined,
      group_by: input.group_by as aotNotionTools.TaskGroupBy | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'count_aot_adsets',
    description:
      'Count AOT Ad Sets matching the same filters as query_aot_adsets, without returning row payloads. Use this whenever you only need an aggregate ("how many ad sets in Editing across all clients", "stage distribution for Audibene", "owner workload for Press London") — it sidesteps the runtime payload cap that query_aot_adsets hits on large result sets. Returns `total`, `truncated_at_ceiling`, and (if `group_by` is set) a `groups` object mapping bucket → count, sorted by count desc. For `group_by` = `owner` or `client`, ad sets with N owners/clients are counted in each bucket, so group sums may exceed `total` — `multi_value_group: true` flags this. `group_by: "client"` uses the cheap client_code rollup when available and only resolves names for rows missing it. Filter semantics and dead-stage exclusion match query_aot_adsets exactly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        stage: {
          type: 'string',
          description: 'Filter by exact Stage status name (e.g. "Concept", "Brief", "Production", "Editing", "QC", "Media Buying").',
        },
        exclude_dead_ad_sets: {
          type: 'boolean',
          description: 'Exclude ad sets in Completed/Cancelled/On Hold stages. Default true.',
        },
        client_relation_id: { type: 'string', description: 'Notion page ID of a client to filter by' },
        client_name_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the client name (resolved in-memory after fetch)',
        },
        owner_user_id: { type: 'string', description: 'Notion user ID to filter by ad-set owner' },
        format: { type: 'string', description: 'Filter by Format select value' },
        delivery_on_or_before: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        delivery_on_or_after: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        has_overdue_tasks: {
          type: 'boolean',
          description: 'Only count ad sets where Overdue Tasks Count rollup > 0.',
        },
        freshness_window_days: {
          type: 'number',
          description: 'Only count ad sets with last_edited_time in the last N days. Default 90. Pass 0 to disable.',
        },
        group_by: {
          type: 'string',
          enum: ['stage', 'client', 'owner', 'format', 'department', 'client_status', 'health_check'],
          description: 'Optional grouping dimension. Returns `groups: { bucket_name: count }` sorted desc. Omit for a single `total`.',
        },
        limit: {
          type: 'number',
          description: 'Cap on rows scanned. Default and max = 5000. Lower this only for sampling.',
        },
      },
    },
  },
  async execute(input) {
    return await aotNotionTools.countAotAdSets({
      stage: input.stage as string | undefined,
      exclude_dead_ad_sets: input.exclude_dead_ad_sets as boolean | undefined,
      client_relation_id: input.client_relation_id as string | undefined,
      client_name_contains: input.client_name_contains as string | undefined,
      owner_user_id: input.owner_user_id as string | undefined,
      format: input.format as string | undefined,
      delivery_on_or_before: input.delivery_on_or_before as string | undefined,
      delivery_on_or_after: input.delivery_on_or_after as string | undefined,
      has_overdue_tasks: input.has_overdue_tasks as boolean | undefined,
      freshness_window_days: input.freshness_window_days as number | undefined,
      group_by: input.group_by as aotNotionTools.AdSetGroupBy | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'update_aot_task_status',
    description:
      "Set a single AOT task's Status in Notion. SCOPED WRITE — any real status on the Tasks DB is allowed: 'Not Started', 'Blocked', 'In Progress', 'Done', 'Cancelled', 'Archived Task'. Every write is logged to piper_actions with a reverse_action so it can be undone. " +
      'RULES: (1) Only call this when a human in the channel has explicitly asked you to (e.g. "close that task", "mark NPx3647 done", "unblock those two and set them In Progress") — never write speculatively or as part of a digest. ONE exception: at Gate 4 of the launch flow, after a verified launch, marking the "Upload and Configure" task Done is part of the standard post-launch follow-ups (the Gate-3/4 human confirmation covers it). (2) State exactly what you are about to change BEFORE calling, and report the before→after + how to undo AFTER. (3) Do not touch tasks on live/On-Hold ad sets unless the user is explicit — On Hold means paused, not dead. (4) Re-opening (Done → In Progress etc.) is allowed but deserves extra care: confirm the task really is back in play. Use the task_id (Notion page id) returned by query_aot_tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task page id (the `task_id` field from query_aot_tasks). A notion.so URL or dashed id also works.',
        },
        new_status: {
          type: 'string',
          description: "New status. Must be one of: 'Not Started', 'Blocked', 'In Progress', 'Done', 'Cancelled', 'Archived Task'.",
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason for the change (logged for audit).',
        },
      },
      required: ['task_id', 'new_status', 'reason'],
    },
  },
  async execute(input, context) {
    const result = await aotNotionTools.updateAotTaskStatus({
      task_id: input.task_id as string,
      new_status: input.new_status as string,
    });
    if (result.ok && result.before !== result.after) {
      logWrite({
        context,
        toolName: 'update_aot_task_status',
        targetSystem: 'notion',
        targetId: result.task_id ?? (input.task_id as string),
        before: { Status: result.before },
        after: { Status: result.after },
        reverse: result.reverse,
        summary: `${result.task_name ?? result.task_id}: Status ${result.before} → ${result.after} (${input.reason as string})`,
      });
    }
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'update_aot_task_due_date',
    description:
      "Set a single AOT task's 'Task Due Date' in Notion. SCOPED WRITE — same discipline as update_aot_task_status: every write is logged to piper_actions with a reverse_action so it can be undone. " +
      'RULES: (1) Only call this when a human in the channel has explicitly asked you to move a date (e.g. "push BFMx3948 to today", "set the due date to Friday") — never write speculatively or as part of a digest. (2) State exactly what you are about to change BEFORE calling, and report the before→after + how to undo AFTER. (3) Date must be YYYY-MM-DD. Use the task_id (Notion page id) returned by query_aot_tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task page id (the `task_id` field from query_aot_tasks). A notion.so URL or dashed id also works.',
        },
        new_due_date: {
          type: 'string',
          description: 'New due date in YYYY-MM-DD format.',
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason for the change (logged for audit).',
        },
      },
      required: ['task_id', 'new_due_date', 'reason'],
    },
  },
  async execute(input, context) {
    const result = await aotNotionTools.updateAotTaskDueDate({
      task_id: input.task_id as string,
      new_due_date: input.new_due_date as string,
    });
    if (result.ok && result.before !== result.after) {
      logWrite({
        context,
        toolName: 'update_aot_task_due_date',
        targetSystem: 'notion',
        targetId: result.task_id ?? (input.task_id as string),
        before: { 'Task Due Date': result.before },
        after: { 'Task Due Date': result.after },
        reverse: result.reverse,
        summary: `${result.task_name ?? result.task_id}: Task Due Date ${result.before ?? '(none)'} → ${result.after} (${input.reason as string})`,
      });
    }
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'create_aot_task',
    description:
      'Create a NEW task in the AOT Tasks DB, linked to an existing ad set. SCOPED WRITE — logged to piper_actions with a reverse_action (archiving the created task), so it is undoable. The Client relation is copied from the ad set automatically; `details` lines become bullets in the task page body; assignee is resolved by name from the Notion workspace (errors instead of guessing on ambiguity). ' +
      'RULES: (1) Only on explicit human request — never create tasks speculatively, as part of a digest, or as a side effect of reconciliation. (2) DRAFT FIRST, ALWAYS: post the full draft (task name, ad set, assignee, due date, body bullets) in the channel and wait for an explicit go ("yes", "confirmed", "go ahead") BEFORE calling this tool. A request to "create tasks" is a request for a draft; only the confirmation is a request to write. (3) After creating, report each created task with its Notion URL and the undo. (4) Setting the assignee at creation is allowed; REASSIGNING existing tasks is still gated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_name: {
          type: 'string',
          description: 'Title of the new task, e.g. "Design Corrections Rev 1".',
        },
        ad_set_id: {
          type: 'string',
          description: 'Notion page id of the ad set to link (the `ad_set_id` from query_aot_adsets / get_adset_case; a notion.so URL also works).',
        },
        assignee_name: {
          type: 'string',
          description: 'Person to assign, by name as it appears in Notion (e.g. "Glaira"). Resolved case-insensitively; fails with candidates listed if ambiguous.',
        },
        due_date: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format (optional).',
        },
        status: {
          type: 'string',
          description: "Initial status (default 'Not Started').",
        },
        details: {
          type: 'string',
          description: 'Task body content — one bullet per line (leading "-"/"•" stripped). Put the actual correction/feedback points here so the doer never has to hunt for them.',
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason for the creation (logged for audit), e.g. "Steven design feedback 06-01, confirmed by Dan".',
        },
      },
      required: ['task_name', 'ad_set_id', 'reason'],
    },
  },
  async execute(input, context) {
    const result = await aotNotionTools.createAotTask({
      task_name: input.task_name as string,
      ad_set_id: input.ad_set_id as string,
      assignee_name: input.assignee_name as string | undefined,
      due_date: input.due_date as string | undefined,
      status: input.status as string | undefined,
      details: input.details as string | undefined,
    });
    if (result.ok) {
      logWrite({
        context,
        toolName: 'create_aot_task',
        targetSystem: 'notion',
        targetId: result.task_id ?? '',
        before: null,
        after: {
          task_name: result.task_name,
          ad_set: result.ad_set_title,
          assignee: result.assignee_name ?? null,
          due_date: (input.due_date as string | undefined) ?? null,
        },
        reverse: result.reverse,
        summary: `Created task "${result.task_name}" on ${result.ad_set_title ?? input.ad_set_id}${result.assignee_name ? ` → ${result.assignee_name}` : ''}${input.due_date ? `, due ${input.due_date as string}` : ''} (${input.reason as string})`,
      });
    }
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'update_aot_ad_set_stage',
    description:
      "Set an AOT ad set's 'Stage' in Notion (the Ad Sets DB status property). SCOPED WRITE — every write is logged to piper_actions with a reverse_action so it can be undone. Allowed stages: 'Concept', 'Production', 'Revision', 'Launch', 'Completed', 'On Hold', 'Cancelled', 'Archived'. " +
      'RULES: (1) The ONE sanctioned automatic use: at Gate 4 of the launch flow, after a launch is verified and the "Upload and Configure" task is marked Done, flip the parent ad set to \'Completed\' — this is part of the standard post-launch follow-ups, no extra human ask needed beyond the Gate-4 confirmation. (2) Any OTHER stage change requires an explicit human request in the channel — never write speculatively. (3) State what you are changing BEFORE calling, and report before→after + how to undo AFTER. (4) \'On Hold\' means paused, not dead — never move an On-Hold ad set without an explicit ask. Use the ad_set_id (Notion page id) returned by query_aot_adsets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ad_set_id: {
          type: 'string',
          description: 'The ad-set page id (the `ad_set_id` field from query_aot_adsets). A notion.so URL or dashed id also works.',
        },
        new_stage: {
          type: 'string',
          description: "New stage. Must be one of: 'Concept', 'Production', 'Revision', 'Launch', 'Completed', 'On Hold', 'Cancelled', 'Archived'.",
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason for the change (logged for audit), e.g. "launched + verified, batch <id>".',
        },
      },
      required: ['ad_set_id', 'new_stage', 'reason'],
    },
  },
  async execute(input, context) {
    const result = await aotNotionTools.updateAotAdSetStage({
      ad_set_id: input.ad_set_id as string,
      new_stage: input.new_stage as string,
    });
    if (result.ok && result.before !== result.after) {
      logWrite({
        context,
        toolName: 'update_aot_ad_set_stage',
        targetSystem: 'notion',
        targetId: result.ad_set_id ?? (input.ad_set_id as string),
        before: { Stage: result.before },
        after: { Stage: result.after },
        reverse: result.reverse,
        summary: `${result.ad_id_code ?? result.ad_title ?? result.ad_set_id}: Stage ${result.before} → ${result.after} (${input.reason as string})`,
      });
    }
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'inspect_piper_actions',
    description:
      'Inspect the audit log of recent dai-agent tool calls (agent_actions view / piper_actions table — covers EVERY agent: Ada, Piper, Maya, client-scoped; filter by agent_id). Useful for self-audit ("what have I done for Press London this week"), debugging ("which tool failed and why"), verifying another agent\'s claimed action actually happened, and answering "why did you say X" by retracing the calls that produced an earlier answer. Returns rows ordered by timestamp desc with id, timestamp, agent_id, session_id, tool_name, params (jsonb), result_summary (truncated to ~800 chars), status, duration_ms, error. **Eventually consistent**: rows are inserted fire-and-forget so a call made in the same turn (within ~1 second) may not yet be visible. For "did my last call get logged?" verification, call this tool in a *later* turn rather than the same one. Skips logging itself to avoid recursion.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours_back: {
          type: 'number',
          description: 'How far back to look. Default 24, max effectively unlimited but rows are capped by limit.',
        },
        agent_id: {
          type: 'string',
          description: 'Filter to one agent (e.g. "piper", "ada", "maya"). Omit to see all agents.',
        },
        tool_name: {
          type: 'string',
          description: 'Filter to one tool name (e.g. "query_aot_tasks", "count_aot_adsets").',
        },
        status: {
          type: 'string',
          enum: ['success', 'failed'],
          description: 'Filter to only successes or only failures.',
        },
        limit: {
          type: 'number',
          description: 'Max rows returned. Default 50, max 500.',
        },
      },
    },
  },
  async execute(input) {
    const rows = await fetchRecentActions({
      hoursBack: input.hours_back as number | undefined,
      agentId: input.agent_id as string | undefined,
      toolName: input.tool_name as string | undefined,
      status: input.status as 'success' | 'failed' | undefined,
      limit: input.limit as number | undefined,
    });
    return JSON.stringify({ count: rows.length, rows });
  },
});

register({
  definition: {
    name: 'get_my_moves',
    description:
      'THE tool for "my moves" / "what are X\'s moves" / "what should I work on" questions. Reads the Tier-1 "My Real Moves" list straight from the SQL brain (piper_my_moves RPC): each person\'s ranked, de-zombied, <=10-item list of tasks that are actually theirs to act on NOW (derived_status in_progress/ready on an alive ad set, future-dated work stripped). Rows come PRE-RANKED from the brain (gate proximity -> due date -> ad-set delivery date) with a freshness stamp — render them in order, do NOT recompute, re-rank, or second-guess against query_aot_tasks. Each row carries task_url and ad_set_url; hyperlink every task name and ad-set code (<url|CODE>). `person` accepts a slug ("zyra"), a display-name fragment ("Zyr", case-insensitive), or a Slack user ID (with or without <@...> wrapping). Omit `person` to get the all-people summary counts (moves/overdue/in_progress per person).',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: {
          type: 'string',
          description: 'Who to fetch moves for: slug ("zyra"), display-name fragment ("Fabio"), or Slack ID ("U097RJ2KMEU" / "<@U097RJ2KMEU>"). Omit for the all-people summary.',
        },
      },
    },
  },
  async execute(input) {
    return await piperMovesTools.getMyMoves({
      person: input.person as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_recovery_plan',
    description:
      'THE tool for "how do we get back on track" / "recovery plan" / "unfuck the pipeline" / "what do we tackle first" questions. Reads piper_recovery_plays() — deterministic, capacity-aware play candidates for every client behind contract: per play the deficit (sets/week vs contract), the play type (clear_approvals / clear_qc / finish_edits = DRAIN nearly-done work first; write_briefs / intake = REFILL the pipeline), volume, effort estimate (empirical lead times), and a capacity-based owner suggestion with a least-loaded alternate. Pre-ranked: every behind client\'s top play first, drain before refill — render in order, never re-rank. Plays are PROPOSALS addressed to Dan/Vanessa/leads who relay them; NEVER instruct a doer directly. Pass exclude_person ("Manuel") to re-plan as if that person is unavailable — the "if he can\'t, find another solution" loop. Cite the freshness note and the pipeline-debt summary number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        exclude_person: {
          type: 'string',
          description: 'Re-plan as if this person is unavailable (slug or name fragment, e.g. "manuel"). Swaps them out of every owner suggestion.',
        },
      },
    },
  },
  async execute(input) {
    return await piperMovesTools.getRecoveryPlan({
      exclude_person: input.exclude_person as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'log_pipeline_correction',
    description:
      'File a human correction to the pipeline data into piper_event_log (actor=\'human-correction\') — the My Real Moves correction loop. Use when a doer contradicts their list and the fix is NOT one of your scoped Notion writes: "not mine" (ownership is gated — file it for the weekly ownership review), "blocked on the client" (pair with setting Status Blocked), "already done elsewhere", or any other data correction. This writes an event-log row only; it never touches Notion. Provide task_id (Notion task page id from query_aot_tasks / get_my_moves) OR ad_set_code (e.g. "TLx4101"), the kind, the reporter (who said it), and their words as the note. Never argue with a doer about their own task — apply the matching scoped write or file the correction, and thank them either way.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'Notion task page id the correction targets (preferred when the correction is about a task).',
        },
        ad_set_code: {
          type: 'string',
          description: 'Ad-set code (e.g. "TLx4101") when the correction targets a whole ad set rather than one task.',
        },
        kind: {
          type: 'string',
          enum: ['not_mine', 'already_done', 'blocked_external', 'other'],
          description: 'not_mine = ownership wrong (gated — filed for weekly review); already_done = work finished but data disagrees; blocked_external = held by client/outside party; other = anything else.',
        },
        note: {
          type: 'string',
          description: 'What the person said / what is wrong, in their words.',
        },
        reporter: {
          type: 'string',
          description: 'Who reported the correction (display name or Slack ID).',
        },
      },
      required: ['kind', 'note', 'reporter'],
    },
  },
  async execute(input) {
    return await piperMovesTools.logPipelineCorrection({
      task_id: input.task_id as string | undefined,
      ad_set_code: input.ad_set_code as string | undefined,
      kind: input.kind as piperMovesTools.CorrectionKind,
      note: input.note as string,
      reporter: input.reporter as string,
    });
  },
});

register({
  definition: {
    name: 'get_pipeline_summary',
    description:
      'THE default for "state of X" / "how\'s the pipeline" / "what\'s going on at <client>" questions. Reads the precomputed SQL brain (piper_pipeline_summary + piper_bucket_rollup RPCs): per-client live/working/sitting/external/data-gap set counts, REAL overdue tasks (de-zombied by the engine), gate-done-7d, avg coverage %, plus the per-bucket working/sitting rollup — all stamped with a freshness timestamp. Clients come sorted worst-first. Render these numbers VERBATIM and always cite the freshness ("brain as of HH:MM UTC"). Do NOT recompute pipeline state from query_aot_tasks / query_aot_adsets / count_aot_* for any covered client — the brain already separated real work from zombies and stamped confidence. Pass `client` (case-insensitive code, e.g. "TL") to filter to one client; omit for the whole pipeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: {
          type: 'string',
          description: 'Optional client code to filter to (case-insensitive, e.g. "TL", "adbn"). Omit for all clients.',
        },
      },
    },
  },
  async execute(input) {
    return await piperBrainTools.getPipelineSummary({
      client: input.client as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_adset_case',
    description:
      'ONE call answers "what\'s going on with <ad-set code>" — the full brain case file for a single ad set (piper_adset_case RPC): bucket + motion, frontier task + holder, days at frontier vs the bucket median, blocker, open tasks, recent events, predicted ship, data confidence, AND a deterministic suggested ping (pickup / client_chase / overdue_nudge) with a prewritten one-line message addressed to the right person. Render the payload directly; NEVER spelunk with query_aot_tasks for a set the brain covers. Always include the suggested ping (when present), the confidence, and the freshness ("derived state as of HH:MM UTC"). The code is normalized for you ("tlx4101" → "TLx4101"). If the set isn\'t in the brain (found=false), THEN fall back to query_aot_adsets against live Notion.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ad_set_code: {
          type: 'string',
          description: 'The ad-set code, any casing ("TLx4101", "tlx4101", "MEOW3880").',
        },
      },
      required: ['ad_set_code'],
    },
  },
  async execute(input) {
    return await piperBrainTools.getAdsetCase({
      ad_set_code: input.ad_set_code as string,
    });
  },
});

register({
  definition: {
    name: 'get_adset_comments',
    description:
      'Read the Notion page comment thread on a single ad set — the real decision + feedback history that the brain and the task properties do NOT carry. A large share of what actually happened to an ad set lives ONLY in the page comments: client revision relays (Stella/Alex/Steven feedback), reshoot debates, product/shipping-delay updates ("the products can\'t be shipped, still waiting for the limited edition bottles"), QC notes, and final "let\'s progress" / sign-off calls. Returns comments chronologically with author, date, and text (mentions already resolved to @Name). Use this on ANY deep-dive ("what\'s going on with LAx3871", "why is X stuck", "what was the feedback on Y") ALONGSIDE get_adset_case — the case file gives the mechanical state, the comments give the human story. The code is normalized for you ("lax3871" → "LAx3871"). Live read = freshness is now. Returns OPEN page-level comments only (resolved + block-level not included).',
    input_schema: {
      type: 'object' as const,
      properties: {
        ad_set_code: {
          type: 'string',
          description: 'The ad-set code, any casing ("LAx3871", "lax3871", "TLx4101").',
        },
        max: {
          type: 'number',
          description: 'Max comments to return (default 40, most recent kept). 1-100.',
        },
      },
      required: ['ad_set_code'],
    },
  },
  async execute(input) {
    return await piperCommentsTools.getAdsetComments({
      ad_set_code: input.ad_set_code as string,
      max: input.max as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'query_piper_state',
    description:
      'Forensic-grade filtered read over the derived brain state: piper_task_state joined to piper_ad_set_state, filterable by client (code, case-insensitive), person (owner_person_id slug, e.g. "zyra"), ad_set_code, and status (derived_status: in_progress / ready / ready* / waiting / done). Each row carries derived_status, canonical_type, raw_status, owner, due_derived, plus the ad-set\'s bucket, motion, and data_confidence; the response carries a freshness timestamp (max updated_at). Limit 200 rows. Use ONLY when get_pipeline_summary / get_adset_case / get_my_moves don\'t cover the slice you need (e.g. "every waiting raw.deliver task for TL"). Cite the freshness note in your answer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: 'Client code filter, case-insensitive (e.g. "TL").' },
        person: { type: 'string', description: 'Owner person_id slug filter (e.g. "zyra", "nina").' },
        ad_set_code: { type: 'string', description: 'Single ad-set code filter (normalized for you).' },
        status: { type: 'string', description: 'derived_status filter: in_progress, ready, ready*, waiting, done.' },
      },
    },
  },
  async execute(input) {
    return await piperBrainTools.queryPiperState({
      client: input.client as string | undefined,
      person: input.person as string | undefined,
      ad_set_code: input.ad_set_code as string | undefined,
      status: input.status as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'remember_cadence_target',
    description:
      'Save or update a client\'s contracted cadence target. Stored in client_cadence_targets (bmad Supabase) and read by Phase 2 cadence intelligence to compute "tracking X% of target". Only the fields you pass are updated — omitted fields preserve their existing value. Use this when the user tells you a contracted number ("Audibene is 4 ad sets per week", "Press London concept queue should stay above 12"). ads_per_week is the contracted weekly throughput; concept_queue_target is the minimum concept-stage depth before brief-writing slips; max_cycle_days is the concept→done end-to-end SLA in days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string', description: 'Client code, case-insensitive (e.g. "ADBN", "PL", "BFM"). Required.' },
        ads_per_week: { type: 'number', description: 'Contracted ad sets shipped per week.' },
        concept_queue_target: { type: 'number', description: 'Minimum concept-stage depth.' },
        max_cycle_days: { type: 'number', description: 'Max concept→done cycle time in days.' },
        notes: { type: 'string', description: 'Free-text context (who set this, source, caveats).' },
      },
      required: ['client_code'],
    },
  },
  async execute(input, context) {
    return cadenceTools.rememberCadenceTarget({
      client_code: input.client_code as string,
      ads_per_week: input.ads_per_week as number | undefined,
      concept_queue_target: input.concept_queue_target as number | undefined,
      max_cycle_days: input.max_cycle_days as number | undefined,
      notes: input.notes as string | undefined,
      updated_by: context.userId,
    });
  },
});

register({
  definition: {
    name: 'get_cadence_targets',
    description:
      'Read per-client cadence targets from client_cadence_targets. Omit client_code to get all clients. Returns ads_per_week / concept_queue_target / max_cycle_days plus the audit trail (updated_at, updated_by). Use this whenever computing whether a client is tracking against their contracted cadence.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: { type: 'string', description: 'Optional client code to filter by (case-insensitive). Omit for all.' },
      },
    },
  },
  async execute(input) {
    return cadenceTools.getCadenceTargets({ client_code: input.client_code as string | undefined });
  },
});

register({
  definition: {
    name: 'get_cadence_read',
    description:
      'Phase 2 headline read: compute one client\'s cadence vs contracted target over a window (default 28 days). Returns target (ads_per_week/concept_queue_target/max_cycle_days), throughput (shipped_in_window, actual_per_week, tracking_pct), concept_queue (depth/target/gap), and in_flight count. "Shipped" is task-side: an ad set counts as shipped when all its tasks are terminal and max(task last_edited) is within the window — NOT when the ad set\'s coarse Stage column hits Completed. Use whenever the user asks "are we on track for X", "how is Audibene tracking", "what\'s the cadence on Y", or building a per-client digest. Pair with get_cadence_targets if the target is missing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'Client code, case-insensitive (e.g. "ADBN", "BFM"). Required.',
        },
        window_days: {
          type: 'number',
          description: 'Lookback window in days. Default 28 (4 weeks).',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    return cadenceReadTools.getCadenceRead({
      client_code: input.client_code as string,
      window_days: input.window_days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'get_cadence_read_all',
    description:
      'Pipeline-wide cadence digest: for every client with a stored cadence target, compute shipped/actual_per_week/tracking_pct in the window. Returns results sorted by tracking_pct ascending (worst-tracking first) so the digest leads with what\'s slipping. Use for morning digests, "how is everyone tracking", or cross-client review.',
    input_schema: {
      type: 'object' as const,
      properties: {
        window_days: {
          type: 'number',
          description: 'Lookback window in days. Default 28.',
        },
      },
    },
  },
  async execute(input) {
    return cadenceReadTools.getCadenceReadAll({
      window_days: input.window_days as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'inspect_data_quality',
    description:
      'Read recent data-quality probe snapshots from piper_data_quality_snapshots. Each piper-sync run writes one row per metric (six metrics: tasks_null_ad_set_code, tasks_past_due_not_done, adsets_no_client, adsets_past_delivery_not_dead, adsets_inactive_client_not_dead, tasks_archived_on_live_adset). Returns the latest snapshot per metric by default; pass `trend=true` to get a daily series for the last 14 days. Use this when the user asks "is the data clean", "what\'s broken in Notion", or to surface drift in the morning digest.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: { type: 'string', description: 'Optional single metric name to filter to.' },
        trend: { type: 'boolean', description: 'If true, returns daily series for last 14 days instead of just the latest.' },
      },
    },
  },
  async execute(input) {
    const supabase = getSupabase();
    const metric = input.metric as string | undefined;
    const trend = input.trend === true;
    if (trend) {
      const since = new Date(Date.now() - 14 * 86400_000).toISOString();
      let q = supabase
        .from('piper_data_quality_snapshots')
        .select('metric, count, snapshot_at')
        .gte('snapshot_at', since)
        .order('snapshot_at', { ascending: true });
      if (metric) q = q.eq('metric', metric);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ count: (data ?? []).length, rows: data ?? [] });
    }
    // Latest per metric — DISTINCT ON not exposed through PostgREST; use RPC-less workaround:
    // pull last 200 rows ordered desc and group client-side.
    let q = supabase
      .from('piper_data_quality_snapshots')
      .select('metric, count, sample_ids, snapshot_at')
      .order('snapshot_at', { ascending: false })
      .limit(200);
    if (metric) q = q.eq('metric', metric);
    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    const latestByMetric = new Map<string, unknown>();
    for (const row of (data ?? []) as Array<{ metric: string }>) {
      if (!latestByMetric.has(row.metric)) latestByMetric.set(row.metric, row);
    }
    return JSON.stringify({ count: latestByMetric.size, latest: Array.from(latestByMetric.values()) });
  },
});

// ---------------------------------------------------------------------------
// Channel monitoring tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'get_channel_insights',
    description:
      'Analyze buffered Slack channel messages on demand. Returns structured triage: blockers on Daniel, urgent items, notable updates, and suggested actions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async execute() {
    const result = await monitoringTools.getChannelInsights();
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'get_recent_mentions',
    description:
      'Get recent Slack messages that mention Daniel or are flagged as high priority. Useful for catching up on what needs attention.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: {
          type: 'number',
          description: 'Number of hours to look back (default 24)',
        },
      },
    },
  },
  async execute(input) {
    const result = await monitoringTools.getRecentMentions({
      hours: input.hours as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'get_monitoring_history',
    description:
      'Get historical channel monitoring insights from the last N hours. Shows blockers, urgent items, and suggested actions from past analyses.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: {
          type: 'number',
          description: 'Number of hours to look back (default 24)',
        },
        highPriorityOnly: {
          type: 'boolean',
          description: 'Only return insights with blockers or urgent items (default false)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
    },
  },
  async execute(input) {
    return await monitoringTools.getMonitoringHistory({
      hours: input.hours as number | undefined,
      highPriorityOnly: input.highPriorityOnly as boolean | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'generate_briefing',
    description:
      'Generate a briefing on demand. Gathers data from channel monitoring, Notion tasks, recent meetings, and mentions, then produces a formatted summary. Returns the briefing text (also DMs it to Daniel).',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['morning', 'eod'],
          description: 'Type of briefing: "morning" for start-of-day overview, "eod" for end-of-day summary (default: morning)',
        },
      },
    },
  },
  async execute(input) {
    return await monitoringTools.generateBriefing({
      type: input.type as 'morning' | 'eod' | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Decision tracking tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'log_decision',
    description:
      'Log a media buying decision (kill, scale, pause, iterate, launch) for outcome tracking. The system will automatically evaluate the decision after a few days by comparing metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account_code: {
          type: 'string',
          description: 'Client/account code (e.g. "ninepine", "press_london")',
        },
        decision_type: {
          type: 'string',
          enum: ['kill', 'scale', 'pause', 'iterate', 'launch'],
          description: 'Type of decision made',
        },
        target: {
          type: 'string',
          description: 'What was acted on (ad set name, campaign name, etc.)',
        },
        rationale: {
          type: 'string',
          description: 'Why this decision was made — key metrics and reasoning',
        },
        metrics_snapshot: {
          type: 'object',
          description: 'Current metrics at time of decision (spend, ROAS, CPA, etc.)',
        },
      },
      required: ['account_code', 'decision_type', 'target', 'rationale'],
    },
  },
  async execute(input, context) {
    const result = await decisionTools.logDecisionTool({
      account_code: input.account_code as string,
      decision_type: input.decision_type as string,
      target: input.target as string,
      rationale: input.rationale as string,
      metrics_snapshot: input.metrics_snapshot as Record<string, unknown> | undefined,
      agent_id: context.agentId,
    });
    return JSON.stringify(result);
  },
});

// ---------------------------------------------------------------------------
// Methodology knowledge tools (DAI Supabase)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'search_methodology',
    description:
      'Search extracted media buying methodology knowledge from meeting transcripts. Contains global rules, account-specific insights, decision examples, creative patterns, and methodology steps. Use to ground analysis in proven patterns and past decisions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search query (e.g. "frequency fatigue", "hook rate creative")',
        },
        type: {
          type: 'string',
          enum: ['rule', 'insight', 'decision', 'creative_pattern', 'methodology'],
          description: 'Filter by knowledge type: rule (global principles), insight (account-specific), decision (kill/scale/pause examples), creative_pattern, methodology (analytical workflows)',
        },
        accountCode: {
          type: 'string',
          description: 'Filter by account code (e.g. "ninepine", "press_london"). Also returns global entries.',
        },
        category: {
          type: 'string',
          description: 'Filter by subcategory (e.g. "what_works", "quirk", "kill", "scale")',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20)',
        },
      },
    },
  },
  async execute(input) {
    return await methodologyTools.searchMethodology({
      query: input.query as string | undefined,
      type: input.type as string | undefined,
      accountCode: input.accountCode as string | undefined,
      category: input.category as string | undefined,
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'search_methodology_safe',
    description:
      'Search media buying methodology knowledge. Returns global best practices and account-specific insights. Results show title, type, category, and confidence — no raw evidence.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search query (e.g. "frequency fatigue", "hook rate creative")',
        },
        type: {
          type: 'string',
          enum: ['rule', 'insight', 'decision', 'creative_pattern', 'methodology'],
          description: 'Filter by knowledge type',
        },
        category: {
          type: 'string',
          description: 'Filter by subcategory (e.g. "what_works", "quirk", "kill", "scale")',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20)',
        },
      },
    },
  },
  async execute(input, context) {
    const clientCode = context.clientScope?.clientCode;
    if (!clientCode) {
      return JSON.stringify({ error: 'search_methodology_safe requires client scope' });
    }
    return await methodologySanitizer.searchMethodologySafe({
      query: input.query as string | undefined,
      type: input.type as string | undefined,
      category: input.category as string | undefined,
      limit: input.limit as number | undefined,
      clientCode,
    });
  },
});

// ---------------------------------------------------------------------------
// Knowledge correction tools (learnings + methodology_knowledge)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'correct_learning',
    description:
      'Update an existing learning record to fix mistakes — wrong client_code, incorrect content, bad category, or confidence. Use when you discover a learning is misattributed or contains errors. Search for the learning first with search_memories or recall to get its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The learning ID to update',
        },
        content: {
          type: 'string',
          description: 'Corrected content text (optional — only if content itself is wrong)',
        },
        client_code: {
          type: 'string',
          description: 'Corrected client/account code (e.g. "audibene", "ninepine")',
        },
        category: {
          type: 'string',
          description: 'Corrected category',
        },
        confidence: {
          type: 'number',
          description: 'Updated confidence score (0-1)',
        },
      },
      required: ['id'],
    },
  },
  async execute(input) {
    const result = await memoryTools.updateLearning({
      id: input.id as string,
      content: input.content as string | undefined,
      client_code: input.client_code as string | undefined,
      category: input.category as string | undefined,
      confidence: input.confidence as number | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'delete_learning',
    description:
      'Delete a learning that is wrong, obsolete, or duplicated. Use sparingly — prefer correct_learning to fix mistakes. Search for the learning first to get its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The learning ID to delete',
        },
      },
      required: ['id'],
    },
  },
  async execute(input) {
    const result = await memoryTools.removeLearning({
      id: input.id as string,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'correct_methodology',
    description:
      'Update a methodology knowledge record to fix mistakes — wrong account_code, incorrect title, bad category or type. Use when you discover a methodology insight is misattributed. Search with search_methodology first to get the record ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The methodology knowledge record ID (UUID)',
        },
        account_code: {
          type: 'string',
          description: 'Corrected account code (e.g. "audibene", "ninepine")',
        },
        title: {
          type: 'string',
          description: 'Corrected title text',
        },
        category: {
          type: 'string',
          description: 'Corrected category',
        },
        type: {
          type: 'string',
          enum: ['rule', 'insight', 'decision', 'creative_pattern', 'methodology'],
          description: 'Corrected type',
        },
      },
      required: ['id'],
    },
  },
  async execute(input) {
    const result = await methodologyTools.updateMethodologyKnowledge({
      id: input.id as string,
      account_code: input.account_code as string | undefined,
      title: input.title as string | undefined,
      category: input.category as string | undefined,
      type: input.type as string | undefined,
    });
    return JSON.stringify(result);
  },
});

register({
  definition: {
    name: 'delete_methodology',
    description:
      'Delete a methodology knowledge record that is wrong, obsolete, or duplicated. Use sparingly — prefer correct_methodology to fix mistakes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The methodology knowledge record ID (UUID) to delete',
        },
      },
      required: ['id'],
    },
  },
  async execute(input) {
    const result = await methodologyTools.deleteMethodologyKnowledge({
      id: input.id as string,
    });
    return JSON.stringify(result);
  },
});

// ---------------------------------------------------------------------------
// Google Calendar & Gmail tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'list_events',
    description:
      'List calendar events for a date range. Returns events from a single Google account (default: work).',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: {
          type: 'string',
          description: 'Start date (ISO 8601, e.g. "2026-02-28" or "2026-02-28T09:00:00")',
        },
        endDate: {
          type: 'string',
          description: 'End date (ISO 8601). If omitted, shows events for startDate only.',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal'],
          description: 'Google account to query (default: work)',
        },
      },
      required: ['startDate'],
    },
  },
  async execute(input) {
    return await googleTools.listEvents({
      startDate: input.startDate as string,
      endDate: input.endDate as string | undefined,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'search_events',
    description:
      'Search calendar events by keyword across both Google accounts (work + personal). Results are merged and sorted by start time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (matches event title, description, location)',
        },
        startDate: {
          type: 'string',
          description: 'Start of search window (ISO 8601). Default: 30 days ago.',
        },
        endDate: {
          type: 'string',
          description: 'End of search window (ISO 8601). Default: 90 days from now.',
        },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    return await googleTools.searchEvents({
      query: input.query as string,
      startDate: input.startDate as string | undefined,
      endDate: input.endDate as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'create_event',
    description:
      'Create a calendar event. If attendees are provided, invitations are sent automatically. Always confirm with Daniel before creating events with attendees.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Event title' },
        startTime: {
          type: 'string',
          description: 'Event start time (ISO 8601, e.g. "2026-02-28T14:00:00")',
        },
        endTime: {
          type: 'string',
          description: 'Event end time (ISO 8601, e.g. "2026-02-28T15:00:00")',
        },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses of attendees',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal'],
          description: 'Google account (default: work)',
        },
      },
      required: ['summary', 'startTime', 'endTime'],
    },
  },
  async execute(input) {
    return await googleTools.createEvent({
      summary: input.summary as string,
      startTime: input.startTime as string,
      endTime: input.endTime as string,
      description: input.description as string | undefined,
      location: input.location as string | undefined,
      attendees: input.attendees as string[] | undefined,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'update_event',
    description:
      'Update an existing calendar event. Only the fields you provide will be changed — omitted fields stay as they are. Use list_events or search_events first to get the event ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'The event ID to update (from list_events or search_events)' },
        summary: { type: 'string', description: 'New event title' },
        startTime: {
          type: 'string',
          description: 'New start time (ISO 8601, e.g. "2026-03-11T11:30:00")',
        },
        endTime: {
          type: 'string',
          description: 'New end time (ISO 8601, e.g. "2026-03-11T15:00:00")',
        },
        description: { type: 'string', description: 'New event description' },
        location: { type: 'string', description: 'New event location' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of attendee emails (replaces existing attendees)',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal'],
          description: 'Google account (default: work)',
        },
      },
      required: ['eventId'],
    },
  },
  async execute(input) {
    return await googleTools.updateEvent({
      eventId: input.eventId as string,
      summary: input.summary as string | undefined,
      startTime: input.startTime as string | undefined,
      endTime: input.endTime as string | undefined,
      description: input.description as string | undefined,
      location: input.location as string | undefined,
      attendees: input.attendees as string[] | undefined,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'delete_event',
    description:
      'Delete a calendar event. Always confirm with Daniel before deleting. Use list_events or search_events first to get the event ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'The event ID to delete (from list_events or search_events)' },
        account: {
          type: 'string',
          enum: ['work', 'personal'],
          description: 'Google account (default: work)',
        },
      },
      required: ['eventId'],
    },
  },
  async execute(input) {
    return await googleTools.deleteEvent({
      eventId: input.eventId as string,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'check_availability',
    description:
      'Check free/busy status across both Google calendars (work + personal). Returns busy slots and whether the time window is free.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startTime: {
          type: 'string',
          description: 'Start of window to check (ISO 8601)',
        },
        endTime: {
          type: 'string',
          description: 'End of window to check (ISO 8601)',
        },
      },
      required: ['startTime', 'endTime'],
    },
  },
  async execute(input) {
    return await googleTools.checkAvailability({
      startTime: input.startTime as string,
      endTime: input.endTime as string,
    });
  },
});

register({
  definition: {
    name: 'search_emails',
    description:
      'Search emails by query, sender, and date range. Returns metadata (subject, from, date, snippet) for matching emails from a single account.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (Gmail search syntax supported)',
        },
        from: {
          type: 'string',
          description: 'Filter by sender email or name',
        },
        after: {
          type: 'string',
          description: 'Only emails after this date (YYYY/MM/DD)',
        },
        before: {
          type: 'string',
          description: 'Only emails before this date (YYYY/MM/DD)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum emails to return (default 10)',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal', 'jasmin'],
          description: 'Google account (default: work)',
        },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    return await googleTools.searchEmails({
      query: input.query as string,
      from: input.from as string | undefined,
      after: input.after as string | undefined,
      before: input.before as string | undefined,
      maxResults: input.maxResults as number | undefined,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'read_email',
    description:
      'Read a full email thread by thread ID. Returns all messages with headers and body text (truncated at 3000 chars per message).',
    input_schema: {
      type: 'object' as const,
      properties: {
        threadId: {
          type: 'string',
          description: 'Gmail thread ID (from search_emails results)',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal', 'jasmin'],
          description: 'Google account (default: work)',
        },
      },
      required: ['threadId'],
    },
  },
  async execute(input) {
    return await googleTools.readEmail({
      threadId: input.threadId as string,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'draft_email',
    description:
      'Create an email draft. NEVER sends directly — always creates a draft for Daniel to review and send manually. Use threadId to draft a reply to an existing thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC email address' },
        threadId: {
          type: 'string',
          description: 'Thread ID to reply to (from search_emails or read_email)',
        },
        account: {
          type: 'string',
          enum: ['work', 'personal', 'jasmin'],
          description: 'Google account to create draft in (default: work)',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  async execute(input) {
    return await googleTools.draftEmail({
      to: input.to as string,
      subject: input.subject as string,
      body: input.body as string,
      cc: input.cc as string | undefined,
      threadId: input.threadId as string | undefined,
      account: input.account as string | undefined,
    });
  },
});

register({
  definition: {
    name: 'send_email',
    description:
      'Send an email. From Jasmin\'s own account: sends directly. From Daniel\'s accounts (work/personal): creates a draft and posts an approval request in Slack — Daniel must click Send. Default account is jasmin.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC email address' },
        threadId: {
          type: 'string',
          description: 'Thread ID to reply to (from search_emails or read_email)',
        },
        account: {
          type: 'string',
          enum: ['jasmin', 'work', 'personal'],
          description:
            'Account to send from. jasmin = send directly from Jasmin\'s email. work/personal = draft + Slack approval. Default: jasmin.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  async execute(input) {
    return await googleTools.sendEmail({
      to: input.to as string,
      subject: input.subject as string,
      body: input.body as string,
      cc: input.cc as string | undefined,
      threadId: input.threadId as string | undefined,
      account: input.account as string | undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Jasmin: review learned preferences
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'review_my_learnings',
    description:
      'Show Daniel all learned preferences Jasmin has stored. Groups by category with IDs, confidence, and last updated dates. Use when Daniel asks "what have you learned about me?" or "show my preferences".',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter (e.g. "communication", "scheduling", "briefing")',
        },
      },
      required: [],
    },
  },
  async execute(input) {
    const { getLearnings } = await import('../memory/learnings.js');
    const allPrefs = await getLearnings('jasmin', undefined, 100);
    const prefs = allPrefs.filter((l) => l.category.startsWith('preference_'));

    const categoryFilter = input.category as string | undefined;
    const filtered = categoryFilter
      ? prefs.filter((l) => l.category === `preference_${categoryFilter}`)
      : prefs;

    if (filtered.length === 0) {
      return JSON.stringify({ message: 'No learned preferences found.', count: 0 });
    }

    // Group by category
    const grouped: Record<string, Array<{ id: string; content: string; confidence: number; updated_at: string }>> = {};
    for (const pref of filtered) {
      const cat = pref.category.replace('preference_', '');
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        id: pref.id,
        content: pref.content,
        confidence: pref.confidence,
        updated_at: pref.updated_at,
      });
    }

    return JSON.stringify({ count: filtered.length, categories: grouped });
  },
});

// ---------------------------------------------------------------------------
// Browser tools (Playwright)
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'browse_navigate',
    description:
      'Navigate to a URL in a headless browser. Returns the page title, visible text content, and interactive elements with CSS selectors you can use in subsequent browse_click/browse_type calls.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (must be http or https)',
        },
      },
      required: ['url'],
    },
  },
  async execute(input, context) {
    return await browserTools.browseNavigate({
      url: input.url as string,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_click',
    description:
      'Click an element on the current page by CSS selector or visible text. Returns the updated page summary after clicking. Use selectors from browse_navigate/browse_read_page results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click (from previous page summary)',
        },
        text: {
          type: 'string',
          description: 'Visible text of the element to click (alternative to selector)',
        },
      },
    },
  },
  async execute(input, context) {
    return await browserTools.browseClick({
      selector: input.selector as string | undefined,
      text: input.text as string | undefined,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_type',
    description:
      'Type text into an input field on the current page. Use the selector from browse_navigate/browse_read_page results. Optionally submit (press Enter) after typing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the input field',
        },
        text: {
          type: 'string',
          description: 'Text to type into the field',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing (default: false)',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Clear the field before typing (default: false)',
        },
      },
      required: ['selector', 'text'],
    },
  },
  async execute(input, context) {
    return await browserTools.browseType({
      selector: input.selector as string,
      text: input.text as string,
      submit: input.submit as boolean | undefined,
      clearFirst: input.clearFirst as boolean | undefined,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_read_page',
    description:
      'Read the full text content and interactive elements of the current page. Use when you need more content than browse_navigate returned, or to re-read after interactions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        maxLength: {
          type: 'number',
          description: 'Maximum text length to extract (default: 12000)',
        },
      },
    },
  },
  async execute(input, context) {
    return await browserTools.browseReadPage({
      maxLength: input.maxLength as number | undefined,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_screenshot',
    description:
      'Take a PNG screenshot of the current page. Returns the image for visual inspection. Prefer browse_read_page for text content — use screenshots only when visual layout matters.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page (default: false, viewport only)',
        },
      },
    },
  },
  async execute(input, context) {
    return await browserTools.browseScreenshot({
      fullPage: input.fullPage as boolean | undefined,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_select',
    description:
      'Select an option from a dropdown (<select>) element on the current page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the <select> element',
        },
        value: {
          type: 'string',
          description: 'The option value or visible text to select',
        },
      },
      required: ['selector', 'value'],
    },
  },
  async execute(input, context) {
    return await browserTools.browseSelect({
      selector: input.selector as string,
      value: input.value as string,
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

register({
  definition: {
    name: 'browse_close',
    description:
      'Close the current browser session and free resources. Always call this when you are done browsing.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async execute(_input, context) {
    return await browserTools.browseClose({
      agentId: context.agentId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });
  },
});

// ---------------------------------------------------------------------------
// Report tools
// ---------------------------------------------------------------------------

register({
  definition: {
    name: 'generate_weekly_report',
    description:
      'Generate an in-depth weekly performance report for a client. Runs a multi-stage pipeline: data gathering from BMAD, math-only condensation, then Opus narrative generation. Returns the formatted report text ready for review.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_code: {
          type: 'string',
          description: 'BMAD client code (e.g., NP, LA, JVA)',
        },
        days: {
          type: 'number',
          description: 'Number of days to cover (default: 7)',
        },
      },
      required: ['client_code'],
    },
  },
  async execute(input) {
    try {
      const result = await reportTools.generateReport(
        input.client_code as string,
        input.days as number | undefined,
      );
      return result.reportText;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg, clientCode: input.client_code }, 'generate_weekly_report failed');
      return JSON.stringify({ error: msg });
    }
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get Claude API tool definitions for an agent profile.
 * Returns only tools whose names are listed in the profile.
 */
export function getToolsForProfile(
  profile: ToolProfile,
): { definitions: Anthropic.Tool[]; executors: Map<string, RegisteredTool['execute']> } {
  const allowedNames = toolProfiles[profile] as readonly string[];
  const definitions: Anthropic.Tool[] = [];
  const executors = new Map<string, RegisteredTool['execute']>();

  for (const name of allowedNames) {
    const tool = REGISTRY.get(name);
    if (tool) {
      definitions.push(tool.definition);
      executors.set(name, tool.execute);
    }
  }

  return { definitions, executors };
}

/**
 * Execute a tool by name.
 */
// BMAD tools that accept clientCode — enforced when clientScope is set
const SCOPED_BMAD_TOOLS = new Set([
  'get_client_targets', 'get_client_performance',
  'get_campaign_summary', 'get_campaign_performance',
  'get_adset_summary', 'get_adset_performance',
  'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
  'get_creative_details', 'get_alerts', 'get_learnings',
  'get_domo_funnel',
  'get_triplewhale_summary',
  'query_meta_insights',
  'query_meta_creatives',
]);

/**
 * Detect the registry-wide soft-failure convention in a tool's string result:
 * a JSON object with a truthy top-level `error`, or a `summary.failed` count
 * above zero (batch tools like upload_to_media_library). Returns the error
 * string for the audit log, or undefined when the result looks healthy.
 * Deliberately conservative: anything unparseable counts as healthy.
 */
function detectSoftError(result: string): string | undefined {
  if (!result || result[0] !== '{') return undefined;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
    const summary = parsed.summary as Record<string, unknown> | undefined;
    if (summary && typeof summary.failed === 'number' && summary.failed > 0) {
      return `summary.failed=${summary.failed} of ${summary.total ?? '?'}`;
    }
  } catch {
    // Not JSON — plain-text results are never soft failures.
  }
  return undefined;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ result: string; isError: boolean }> {
  const tool = REGISTRY.get(name);
  if (!tool) {
    logger.warn({ toolName: name }, 'Unknown tool requested');
    return { result: `Unknown tool: ${name}`, isError: true };
  }

  // Belt-and-suspenders: override clientCode for BMAD tools when client-scoped
  if (context.clientScope && SCOPED_BMAD_TOOLS.has(name)) {
    input.clientCode = context.clientScope.clientCode;
  }

  // Override memory tools agentId when client-scoped
  if (context.clientScope) {
    if (name === 'remember') {
      input.client_code = context.clientScope.clientCode;
    }
    if (name === 'recall') {
      input.client_code = context.clientScope.clientCode;
    }
  }

  const startedAt = Date.now();
  try {
    const result = await tool.execute(input, context);
    const durationMs = Date.now() - startedAt;
    // Most tools report failures by RETURNING {"error": ...} JSON instead of
    // throwing (so the agent can read the details). Without this sniff those
    // calls land in piper_actions as status='success' — the 2026-06-11 TLx4086
    // upload failure was invisible to "show me failed Ada actions" exactly
    // because of that. Soft failures keep isError=false (the agent still gets
    // the full JSON); only the audit-log status changes.
    const softError = detectSoftError(result);
    logger.debug({ toolName: name, durationMs, softError }, 'Tool executed');
    // Skip self-logging the audit-log read tool to avoid recursive noise.
    if (name !== 'inspect_piper_actions') {
      logToolCall({
        toolName: name,
        context,
        params: input,
        result,
        status: softError ? 'failed' : 'success',
        durationMs,
        error: softError,
      });
    }
    return { result, isError: false };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ toolName: name, error: msg, durationMs }, 'Tool execution failed');
    if (name !== 'inspect_piper_actions') {
      logToolCall({
        toolName: name,
        context,
        params: input,
        result: `Tool error: ${msg}`,
        status: 'failed',
        durationMs,
        error: msg,
      });
    }
    return { result: `Tool error: ${msg}`, isError: true };
  }
}
