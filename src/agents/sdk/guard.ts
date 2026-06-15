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
  'count_aot_tasks', 'count_aot_adsets', 'check_ads_in_meta',
  // launch READ-side (no Meta mutation)
  'preview_ad_launch', 'verify_launch', 'qc_copy', 'poll_analysis',
  'scan_media_library_folder', 'check_preupload_status',
  // reports
  'generate_weekly_report',
]);

/** Safe built-in read tools that skills may use. */
const BUILTIN_READS = new Set<string>([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'TodoWrite',
]);

/** dai's two authorized external mutations — gated behind per-run flags. */
const LAUNCH_MUTATIONS = new Set<string>([
  'launch_ads', 'set_adset_marker', 'pause_launch', 'update_landing_page_mapping',
]);
const UPLOAD_MUTATION = 'upload_to_media_library';

/** Built-ins that must never run in the spike. */
const FORBIDDEN_BUILTINS = new Set<string>([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task',
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
    if (!clientCode || !policy.testClientCodes.includes(clientCode)) {
      return {
        ...base,
        decision: 'deny',
        reason: `client_code ${clientCode ?? '(none)'} not in test allow-list ${JSON.stringify(policy.testClientCodes)}`,
      };
    }
    return { ...base, decision: 'allow', reason: `authorized launch on test client ${clientCode}` };
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
