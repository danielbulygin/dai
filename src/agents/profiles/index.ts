export const toolProfiles = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'ask_agent'],
  coding: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit'],
  full: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
  assistant: ['recall', 'remember', 'search_memories', 'ask_agent', 'post_message', 'reply_in_thread', 'send_as_daniel', 'read_dms', 'find_user', 'get_unread_dms', 'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings', 'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion', 'get_channel_insights', 'get_recent_mentions', 'get_monitoring_history', 'generate_briefing', 'list_events', 'search_events', 'create_event', 'update_event', 'delete_event', 'check_availability', 'search_emails', 'read_email', 'draft_email', 'send_email', 'review_my_learnings', 'correct_learning', 'delete_learning', 'browse_navigate', 'browse_click', 'browse_type', 'browse_read_page', 'browse_screenshot', 'browse_select', 'browse_close'],
  media_buyer: [
    'recall', 'remember', 'search_memories',
    'list_clients', 'get_client_targets', 'get_client_performance',
    'get_campaign_summary', 'get_campaign_performance',
    'get_adset_summary', 'get_adset_performance',
    'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
    'get_account_changes', 'get_creative_details',
    'get_alerts', 'get_learnings', 'get_briefs', 'get_concepts',
    'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
    'post_message', 'reply_in_thread',
    'log_decision',
    'search_methodology',
    'correct_learning', 'delete_learning',
    'correct_methodology', 'delete_methodology',
    'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion',
    'generate_weekly_report',
  ],
  creative_strategist: [
    'recall', 'remember', 'search_memories',
    'ask_ada',
    'get_creative_audit', 'get_creative_diversity_score',
    'search_methodology',
    'post_message', 'reply_in_thread',
    'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
    'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion',
  ],
  client_media_buyer: [
    'recall', 'remember', 'search_memories',
    'get_client_targets', 'get_client_performance',
    'get_campaign_summary', 'get_campaign_performance',
    'get_adset_summary', 'get_adset_performance',
    'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
    'get_creative_details', 'get_alerts', 'get_learnings',
    'search_methodology_safe',
    'reply_in_thread',
  ],
} as const;

export type ToolProfile = keyof typeof toolProfiles;

export type ToolName = (typeof toolProfiles)[ToolProfile][number];
