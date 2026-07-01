/**
 * Permission guard for the Agent-SDK Ada spike.
 *
 * This is the runtime safety layer that replaces dai's bespoke fabricated-write
 * guards with the SDK's declarative `PreToolUse` hook + `canUseTool`. It is
 * deliberately FAIL-CLOSED:
 *
 *   - read / analysis tools            → ALLOW
 *   - dai's two authorized mutations   → ALLOW only behind explicit per-run
 *     (paused launch, media upload)      flags AND a test-client allow-list
 *   - every other write (Notion, Slack
 *     posts, task writes, memory writes,
 *     learning edits, deletes)         → DENY
 *   - dangerous built-ins (Bash/Write/
 *     Edit/NotebookEdit/Task)          → DENY
 *   - anything unrecognised            → DENY
 *
 * The PreToolUse hook is the authoritative decision (so a headless run never
 * hangs on a human prompt); `canUseTool` mirrors the same policy as a second
 * layer for anything the hook doesn't match.
 *
 * Tool names arriving here are MCP-qualified (`mcp__ada-tools__launch_ads`);
 * `bareToolName()` strips the prefix.
 *
 * IMPORTANT (overnight-spike scope): the test Meta account `act_1570076840279279`
 * is targeted by dai launch/upload tools via `client_code`, NOT a raw `act_` id.
 * So the gate keys off `client_code ∈ testClientCodes`. If no client maps to the
 * test account, `testClientCodes` stays empty and EVERY mutation is denied —
 * which is the safe default and exactly the rail-4a fallback.
 */
import type { CanUseTool, HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export interface GuardPolicy {
  /**
   * PRODUCTION mode: allow Ada's full legitimate write allow-list (PRODUCTION_WRITES)
   * — exactly the writes current Ada already performs (Slack posts, Notion task/stage
   * writes, learning/decision edits, paused-bank launches, media uploads). Deletes and
   * anything NOT on the allow-list stay denied. Default false (spike = deny-all-writes).
   */
  allowProductionWrites: boolean;
  /**
   * Fine-grained option: allow ONLY the scoped Notion task-mirror writes
   * (NOTION_TASK_WRITES — task status, ad-set stage, due date, comment, create/update
   * task) without the rest of the production write surface. Reversible Notion writes
   * only; grants NO Slack/memory/learning/launch/upload/delete autonomy. Independent of
   * allowProductionWrites. NOTE: the web /launch/ada chat now runs with the broader
   * allowProductionWrites (full Slack-Ada parity, Dan 2026-06-20); this flag is kept
   * for any future write-limited surface. Default false.
   */
  allowNotionTaskWrites: boolean;
  /** Master enable for dai's two authorized external mutations. Default false. */
  allowTestMutations: boolean;
  /** Enable the paused-launch verbs (launch_ads/set_adset_marker/pause_launch/update_landing_page_mapping). */
  allowPausedLaunch: boolean;
  /** Enable upload_to_media_library. */
  allowMediaUpload: boolean;
  /** client_codes that resolve to the TEST account/BM. Empty = deny all client-targeted mutations. */
  testClientCodes: string[];
  /** Telemetry callback fired on every decision (used to PROVE the guard fired). */
  onDecision?: (d: GuardDecision) => void;
}

export interface GuardDecision {
  tool: string;
  bareName: string;
  decision: 'allow' | 'deny';
  reason: string;
  clientCode?: string;
}

export function defaultPolicy(overrides: Partial<GuardPolicy> = {}): GuardPolicy {
  return {
    allowProductionWrites: false,
    allowNotionTaskWrites: false,
    allowTestMutations: false,
    allowPausedLaunch: false,
    allowMediaUpload: false,
    testClientCodes: [],
    ...overrides,
  };
}

// --- Tool classification ----------------------------------------------------

/** Read / analysis tools — always safe. (preview_ad_launch has no Meta side effects.) */
const READ_TOOLS = new Set<string>([
  // memory / search
  'recall', 'search_memories', 'search_methodology', 'search_methodology_safe',
  // client + performance reads
  'list_clients', 'get_client_targets', 'get_client_performance', 'get_client_capabilities',
  'get_campaign_summary', 'get_campaign_performance',
  'get_adset_summary', 'get_adset_performance',
  'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
  'get_account_changes', 'get_creative_details',
  'get_alerts', 'get_learnings', 'get_briefs', 'get_concepts',
  'get_domo_funnel', 'get_weather_daily', 'get_triplewhale_summary',
  'query_meta_insights', 'query_meta_creatives', 'audit_dataset_health',
  // meetings
  'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
  // notion reads
  'query_tasks', 'search_notion', 'query_aot_tasks', 'query_aot_adsets',
  'count_aot_tasks', 'count_aot_adsets', 'check_ads_in_meta', 'get_ready_to_upload_backlog',
  // launch READ-side (no Meta mutation)
  'preview_ad_launch', 'verify_launch', 'qc_copy', 'poll_analysis',
  'scan_media_library_folder', 'check_preupload_status',
  // reports
  'generate_weekly_report',
]);

/**
 * Safe built-in read tools that skills may use. `ToolSearch` is the SDK's
 * deferred-tool-discovery tool — with 60+ MCP tools the harness loads schemas
 * lazily and the model calls `ToolSearch` to find tools. It has no side effects
 * (it only surfaces schemas); the guard still gates the actual execution that
 * follows. Denying it cripples tool discovery, so it must be allowed.
 */
const BUILTIN_READS = new Set<string>([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'TodoWrite',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ExitPlanMode',
]);

/** dai's two authorized external mutations — gated behind per-run flags. */
const LAUNCH_MUTATIONS = new Set<string>([
  'launch_ads', 'set_adset_marker', 'pause_launch', 'update_landing_page_mapping',
]);
const UPLOAD_MUTATION = 'upload_to_media_library';

/** Built-ins that must never run (arbitrary code / file mutation / sub-agents). */
const FORBIDDEN_BUILTINS = new Set<string>([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task',
]);

/**
 * HARD DELETE RAIL — these (and anything matching the delete/destroy/purge/remove
 * pattern) are NEVER allowed autonomously, in ANY mode, regardless of flags.
 * Enforces the standing never-delete-without-explicit-ask rule.
 */
const DELETE_TOOLS = new Set<string>([
  'delete_learning', 'delete_methodology', 'delete_memory',
  'delete_task', 'delete_event', 'delete_concept', 'delete_brief',
]);
const DELETE_PATTERN = /(^|_)(delete|destroy|purge|remove)(s|d)?(_|$)/i;
function isDeleteTool(bare: string): boolean {
  return DELETE_TOOLS.has(bare) || DELETE_PATTERN.test(bare);
}

/**
 * Ada's legitimate PRODUCTION writes — the explicit allow-list. Airtight: anything
 * not in this set is denied. This is exactly the write surface current Ada already
 * uses (media_buyer profile), so it grants NO new autonomy.
 *   - launch_ads / upload_to_media_library create only PAUSED-bank objects by
 *     construction: SafeMetaAPI verifies the parent bank campaign is PAUSED before
 *     creating anything (it raises SafetyError otherwise), so nothing can ever spend.
 *   - deletes are deliberately EXCLUDED — they are hard-blocked above.
 */
const PRODUCTION_WRITES = new Set<string>([
  // memory / decisions / learnings (non-destructive edits only)
  'remember', 'log_decision', 'correct_learning', 'correct_methodology',
  // Slack
  'post_message', 'reply_in_thread',
  // Notion
  'create_task', 'update_task', 'add_task_comment',
  'update_aot_task_status', 'update_aot_ad_set_stage',
  // Meta launch / media library (paused-bank only, via SafeMetaAPI)
  'launch_ads', 'pause_launch', 'set_adset_marker', 'update_landing_page_mapping',
  'upload_to_media_library',
]);

/**
 * SCOPED Notion task-mirror writes — the reversible subset enabled for the web
 * /launch/ada chat (gated by policy.allowNotionTaskWrites). All non-destructive
 * Notion task/stage writes; deletes (delete_task) are still hard-blocked by the
 * delete rail above, and Slack/memory/launch/upload are NOT in this set.
 */
const NOTION_TASK_WRITES = new Set<string>([
  'update_aot_task_status', 'update_aot_ad_set_stage', 'update_aot_task_due_date',
  'create_aot_task', 'create_task', 'update_task', 'add_task_comment',
]);

export function bareToolName(name: string): string {
  // mcp__<server>__<tool> → <tool>
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  if (m) return m[1]!;
  // Generic fallback: strip leading mcp__<server>__
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) return parts.slice(2).join('__');
  return name;
}

function readClientCode(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const cc = (input as Record<string, unknown>).client_code;
    if (typeof cc === 'string') return cc.toUpperCase();
  }
  return undefined;
}

/** The core policy decision. Pure function — easy to unit-test. */
export function decide(
  toolName: string,
  input: unknown,
  policy: GuardPolicy,
): GuardDecision {
  const bare = bareToolName(toolName);
  const clientCode = readClientCode(input);
  const base = { tool: toolName, bareName: bare, clientCode };

  if (READ_TOOLS.has(bare) || BUILTIN_READS.has(bare)) {
    return { ...base, decision: 'allow', reason: 'read/analysis tool' };
  }

  if (FORBIDDEN_BUILTINS.has(bare)) {
    return { ...base, decision: 'deny', reason: `forbidden built-in (${bare})` };
  }

  // HARD delete rail — never autonomous, in ANY mode, regardless of flags.
  if (isDeleteTool(bare)) {
    return { ...base, decision: 'deny', reason: `delete tool hard-blocked — never autonomous (${bare})` };
  }

  // PRODUCTION write allow-list (airtight: explicit set only; everything else falls
  // through to deny). launch_ads/upload are allow-listed here in production mode and
  // are paused-bank-only by SafeMetaAPI construction.
  if (policy.allowProductionWrites && PRODUCTION_WRITES.has(bare)) {
    return { ...base, decision: 'allow', reason: `production write allow-listed (${bare})` };
  }

  // SCOPED Notion task writes — enabled for the web /launch/ada chat so Ada can mark
  // upload tasks Done / move stages / comment / create-update tasks directly (Dan,
  // 2026-06-20). Reversible Notion writes only; checked independently of
  // allowProductionWrites so it does NOT un-gate launch/upload/Slack/memory.
  if (policy.allowNotionTaskWrites && NOTION_TASK_WRITES.has(bare)) {
    return { ...base, decision: 'allow', reason: `notion task write allow-listed (${bare})` };
  }

  // upload_to_media_library — authorized mutation (b)
  if (bare === UPLOAD_MUTATION) {
    if (policy.allowTestMutations && policy.allowMediaUpload) {
      return { ...base, decision: 'allow', reason: 'authorized media upload (rail 4b) — flag on' };
    }
    return { ...base, decision: 'deny', reason: 'media upload not enabled for this run' };
  }

  // launch verbs — authorized mutation (a), test-client only
  if (LAUNCH_MUTATIONS.has(bare)) {
    if (!policy.allowTestMutations || !policy.allowPausedLaunch) {
      return { ...base, decision: 'deny', reason: 'paused-launch mutations not enabled for this run' };
    }
    // SCRATCH TEST PATCH (2026-06-16): launch_ads/pause_launch carry batch_id, not
    // client_code, so readClientCode() returns undefined and the test allow-list could
    // NEVER match (every test-mode launch was denied). Until the branch resolves
    // client_code from the batch row, allow launch verbs in test mode whenever a test
    // allow-list is configured (this harness only ever previews AOT batches, and
    // SafeMetaAPI still verifies the parent bank campaign is PAUSED before any create).
    if (clientCode && !policy.testClientCodes.includes(clientCode)) {
      return {
        ...base,
        decision: 'deny',
        reason: `client_code ${clientCode} not in test allow-list ${JSON.stringify(policy.testClientCodes)}`,
      };
    }
    if (!clientCode && policy.testClientCodes.length === 0) {
      return { ...base, decision: 'deny', reason: 'launch verb without client_code and empty test allow-list (fail-closed)' };
    }
    return { ...base, decision: 'allow', reason: `authorized launch (test mode; client ${clientCode ?? 'from-batch'})` };
  }

  // Everything else (Notion writes, Slack posts, task writes, memory writes,
  // learning/methodology edits, deletes, unknown tools) → DENY, fail-closed.
  return { ...base, decision: 'deny', reason: 'write/unknown tool blocked (read-only spike)' };
}

// --- SDK adapters -----------------------------------------------------------

/** PreToolUse hook callback enforcing the policy (authoritative, no human prompt). */
export function makePreToolUseHook(policy: GuardPolicy): HookCallback {
  return async (input) => {
    const hi = input as PreToolUseHookInput;
    const d = decide(hi.tool_name, hi.tool_input, policy);
    policy.onDecision?.(d);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: d.decision,
        permissionDecisionReason: d.reason,
      },
    };
  };
}

/** canUseTool — second layer, same policy, fail-closed. */
export function makeCanUseTool(policy: GuardPolicy): CanUseTool {
  return async (toolName, input) => {
    const d = decide(toolName, input, policy);
    policy.onDecision?.(d);
    if (d.decision === 'allow') {
      return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
    }
    return { behavior: 'deny', message: d.reason };
  };
}
