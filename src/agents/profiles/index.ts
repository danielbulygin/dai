export const toolProfiles = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'ask_agent'],
  coding: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit'],
  full: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
  assistant: ['recall', 'remember', 'search_memories', 'ask_agent', 'post_message', 'reply_in_thread', 'send_as_daniel', 'read_dms', 'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings', 'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion', 'get_channel_insights', 'get_recent_mentions', 'get_monitoring_history', 'generate_briefing'],
  media_buyer: [
    'recall', 'remember', 'search_memories',
    'list_clients', 'get_client_targets', 'get_client_performance', 'get_campaign_performance',
    'get_adset_performance', 'get_ad_performance', 'get_breakdowns',
    'get_account_changes', 'get_creative_details',
    'get_alerts', 'get_learnings', 'get_briefs', 'get_concepts',
    'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
    'post_message', 'reply_in_thread',
    'log_decision',
    'search_methodology',
    'correct_learning', 'delete_learning',
    'correct_methodology', 'delete_methodology',
  ],
} as const;

export type ToolProfile = keyof typeof toolProfiles;

export type ToolName = (typeof toolProfiles)[ToolProfile][number];
