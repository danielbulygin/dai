export const toolProfiles = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'ask_agent'],
  coding: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit'],
  full: [
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit',
    // Investigation surface — see the note on media_buyer below.
    'meta_graph_get', 'look_at_media', 'read_repo_file', 'grep_repo',
    'run_analysis_script',
    'search_corpus', 'read_corpus_memory',
  ],
  assistant: ['recall', 'remember', 'search_memories', 'ask_agent', 'post_message', 'reply_in_thread', 'send_as_daniel', 'read_dms', 'find_user', 'get_unread_dms', 'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings', 'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion', 'get_channel_insights', 'get_recent_mentions', 'get_monitoring_history', 'generate_briefing', 'list_events', 'search_events', 'create_event', 'update_event', 'delete_event', 'check_availability', 'search_emails', 'read_email', 'draft_email', 'send_email', 'review_my_learnings', 'correct_learning', 'delete_learning', 'browse_navigate', 'browse_click', 'browse_type', 'browse_read_page', 'browse_screenshot', 'browse_select', 'browse_close'],
  media_buyer: [
    'recall', 'remember', 'search_memories',
    'list_clients', 'get_client_targets', 'get_client_performance',
    'get_campaign_summary', 'get_campaign_performance',
    'get_adset_summary', 'get_adset_performance',
    'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
    'get_account_changes', 'get_creative_details',
    'get_alerts', 'get_learnings', 'get_briefs', 'get_concepts',
    'get_domo_funnel', 'get_weather_daily', 'get_triplewhale_summary',
    'query_meta_insights', 'query_meta_creatives', 'audit_dataset_health',
    'get_pixel_event_stats', 'get_custom_conversions',
    'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
    'post_message', 'reply_in_thread',
    'log_decision',
    'search_methodology',
    'correct_learning', 'delete_learning',
    'correct_methodology', 'delete_methodology',
    'query_tasks', 'create_task', 'update_task', 'add_task_comment', 'search_notion',
    'query_aot_tasks', 'query_aot_adsets', 'count_aot_tasks', 'count_aot_adsets', 'get_ready_to_upload_backlog',
    'generate_weekly_report',
    'scan_media_library_folder', 'upload_to_media_library', 'check_preupload_status',
    'get_client_capabilities', 'preview_ad_launch', 'launch_ads',
    'pause_launch', 'update_landing_page_mapping',
    'qc_copy', 'verify_launch', 'poll_analysis', 'set_adset_marker',
    'update_aot_task_status', 'update_aot_ad_set_stage',
    'lookup_dead_end',
    // Investigation surface (read-only): raw Graph reads, vision over arbitrary
    // bytes, repo reads. DELIBERATELY NOT in client_media_buyer — client-facing
    // Tinkers users do not get raw Graph reads until a per-tenant token IS the
    // enforced boundary. Today the tenant boundary is app code sitting on a
    // service-role key with an agency env-token fallback, so a client-facing
    // agent holding an open Graph read would be one app-code bug away from
    // reading another tenant's account. See project_tinkers_ada_write_parity.
    'meta_graph_get', 'look_at_media', 'read_repo_file', 'grep_repo',
    // Compute over fetched data (Vercel Sandbox: no credentials in, no network
    // out). Internal-only for the same reason as the investigation surface.
    'run_analysis_script',
    // The AOT Memory corpus (org truths + client learnings + Ada's own).
    // Internal-only: the store's RLS scopes are agency-internal knowledge.
    'search_corpus', 'read_corpus_memory',
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
    'get_rival_reports',
    'get_client_targets', 'get_client_performance',
    'get_campaign_summary', 'get_campaign_performance',
    'get_adset_summary', 'get_adset_performance',
    'get_ad_summary', 'get_ad_performance', 'get_breakdowns',
    'get_creative_details', 'get_learnings',
    'query_meta_insights', 'query_meta_creatives',
    'get_pixel_event_stats', 'get_custom_conversions',
    'search_methodology_safe',
    'reply_in_thread',
    // Investigation reads. Withheld until the tenant boundary was the TOKEN
    // plus the tool's own pin rather than app code alone; both now hold and
    // are proven by scripts/tenancy-probe.ts, which reads another client's
    // account by name and by bare object id and is refused both times.
    //   meta_graph_get      — already forced-scope, and refuses any account
    //                         the client was not granted, refuses agency-wide
    //                         nodes outright, and asks Meta who owns a bare id.
    //   get_account_changes — what changed and when, the read a "why did this
    //                         move" question dies without. Forced-scope above.
    //   run_analysis_script — compute instead of estimate. Safe by
    //                         construction: no credentials in, no egress out.
    // Still withheld: look_at_media (pin unverified), search_corpus and
    // read_corpus_memory (the store holds other clients' knowledge), grep_repo
    // and read_repo_file (our own source).
    'meta_graph_get', 'get_account_changes', 'run_analysis_script',
    // Built-ins, declared here the way `readonly`/`standard` declare them: the dai
    // registry holds no entry for either, so getToolsForProfile skips them and this
    // line carries INTENT, not the gate. The gate is guard.ts BUILTIN_READS (allow)
    // plus CLIENT_WEB_SEARCH_ENABLED in runAgentSDK. Public facts only - the prompt
    // rule forbids pointing them at the customer's own account, which is what the
    // scoped tools are for.
    'WebSearch', 'WebFetch',
  ],
  production_manager: [
    'recall', 'remember', 'search_memories',
    'list_clients',
    'query_aot_tasks', 'query_aot_adsets', 'count_aot_tasks', 'count_aot_adsets', 'check_ads_in_meta', 'search_notion',
    'get_my_moves', 'log_pipeline_correction', 'get_recovery_plan',
    'get_pipeline_summary', 'get_adset_case', 'get_adset_comments', 'query_piper_state',
    'inspect_piper_actions',
    'remember_cadence_target', 'get_cadence_targets', 'inspect_data_quality',
    'get_cadence_read', 'get_cadence_read_all',
    'search_meetings', 'get_meeting_summary', 'get_meeting_transcript', 'list_recent_meetings',
    'search_slack_messages', 'read_slack_channel', 'read_slack_thread',
    'update_aot_task_status', 'update_aot_task_due_date', 'create_aot_task',
    'post_message', 'reply_in_thread',
  ],
} as const;

export type ToolProfile = keyof typeof toolProfiles;

export type ToolName = (typeof toolProfiles)[ToolProfile][number];
