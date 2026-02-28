import type Anthropic from '@anthropic-ai/sdk';
import { toolProfiles, type ToolProfile } from './profiles/index.js';
import * as memoryTools from './tools/memory-tools.js';
import * as agentTools from './tools/agent-tools.js';
import * as slackTools from './tools/slack-tools.js';
import * as supabaseTools from './tools/supabase-tools.js';
import * as firefliesTools from './tools/fireflies-tools.js';
import * as notionTools from './tools/notion-tools.js';
import * as monitoringTools from './tools/monitoring-tools.js';
import * as decisionTools from './tools/decision-tools.js';
import * as clientConfigTools from './tools/client-config-tools.js';
import * as methodologyTools from './tools/methodology-tools.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContext {
  agentId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
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
      'Ask another AI agent a question and get their response. Use this to delegate tasks to specialists: otto (orchestrator), coda (developer), rex (researcher), sage (reviewer), ada (advertising).',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: {
          type: 'string',
          description:
            'ID of the agent to ask (otto, coda, rex, sage, ada)',
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
      'Read recent messages from a Slack DM or channel using Daniel\'s user token. Use to check Daniel\'s private conversations when he asks.',
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
      'Get campaign-level daily ad performance for a client. Includes status, objective, spend, impressions, reach, frequency, clicks, link_clicks, funnel stages (content_views, add_to_carts, checkouts_initiated), purchases, purchase_value, ROAS, CPA, CPM, CTR, and raw actions JSONB.',
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
      'Get ad-level daily performance with creative metrics (hook rate, hold rate, video completion). Use for creative analysis and identifying winning/losing ads.',
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
      'Get performance breakdowns by age, gender, country, placement, device, or platform. Use for device-level analysis (iOS vs Android), placement optimization, and audience insights.',
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
          description: 'Number of days (default 7)',
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
      'Query tasks from the Notion kanban board. Filter by status, assignee, and/or priority.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by task status: Backlog, To Do, In Progress, Review, Done',
        },
        assignee: {
          type: 'string',
          description: 'Filter by assignee name (e.g. Daniel, Jasmin, Otto, Franzi, Mikel)',
        },
        priority: {
          type: 'string',
          description: 'Filter by priority: Critical, High, Medium, Low',
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
      limit: input.limit as number | undefined,
    });
  },
});

register({
  definition: {
    name: 'create_task',
    description: 'Create a new task on the Notion kanban board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'The task title' },
        status: {
          type: 'string',
          description: 'Task status (default: To Do)',
        },
        assignee: { type: 'string', description: 'Who to assign the task to' },
        priority: {
          type: 'string',
          description: 'Task priority: Critical, High, Medium, Low (default: Medium)',
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
          description: 'Labels: Bug, Feature, Research, Creative, Admin, Personal',
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
    });
  },
});

register({
  definition: {
    name: 'update_task',
    description: 'Update an existing task on the Notion kanban board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string', description: 'The Notion page ID of the task to update' },
        status: { type: 'string', description: 'New status' },
        assignee: { type: 'string', description: 'New assignee' },
        priority: { type: 'string', description: 'New priority' },
        dueDate: { type: 'string', description: 'New due date (ISO format)' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'New labels (replaces existing)',
        },
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

  try {
    const result = await tool.execute(input, context);
    logger.debug({ toolName: name }, 'Tool executed successfully');
    return { result, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ toolName: name, error: msg }, 'Tool execution failed');
    return { result: `Tool error: ${msg}`, isError: true };
  }
}
