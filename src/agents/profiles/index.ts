export const toolProfiles = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'],
  coding: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit'],
  full: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
  assistant: ['recall', 'remember', 'search_memories', 'ask_agent', 'post_message', 'reply_in_thread', 'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings', 'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion', 'get_channel_insights', 'get_recent_mentions', 'get_monitoring_history', 'generate_briefing'],
} as const;

export type ToolProfile = keyof typeof toolProfiles;

export type ToolName = (typeof toolProfiles)[ToolProfile][number];
