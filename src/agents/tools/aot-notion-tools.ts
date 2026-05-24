/**
 * AOT-shaped Notion query tools.
 *
 * Parallel to notion-tools.ts (which is wired to Jasmin's personal Kanban DB
 * and auto-provisions a specific schema). These tools read from AOT's
 * production-pipeline databases (Ad Sets, Tasks) and never mutate schema.
 *
 * Reusable across agents (Piper now, Cora and others later).
 */

import { type PageObjectResponse } from '@notionhq/client';
import { getNotion } from '../../integrations/notion.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Data source resolution
// ---------------------------------------------------------------------------
// Notion API 2025-09-03 moved queries from `databases` to `dataSources`.
// Each database has one or more data sources; we cache the lookup.

const dataSourceCache = new Map<string, string>();

async function resolveDataSourceId(databaseId: string): Promise<string> {
  const cached = dataSourceCache.get(databaseId);
  if (cached) return cached;

  const notion = getNotion();
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const sources = 'data_sources' in db ? (db as { data_sources: Array<{ id: string }> }).data_sources : [];
  if (sources.length === 0) {
    throw new Error(`Database ${databaseId} has no data sources. Has the integration been granted access?`);
  }
  const id = sources[0]!.id;
  dataSourceCache.set(databaseId, id);
  logger.info({ databaseId, dataSourceId: id }, 'Resolved AOT Notion data source');
  return id;
}

// ---------------------------------------------------------------------------
// Property extraction — AOT Tasks DB schema
// ---------------------------------------------------------------------------

interface ExtractedTask {
  task_id: string;
  url: string;
  task_name: string | null;
  status: string | null;
  stage: string | null;
  task_due_date: string | null;
  ad_delivery_date: string | null;
  ad_set_id: string | null;
  ad_set_stage: string | null;
  format: string | null;
  client_relation_ids: string[];
  ad_set_relation_ids: string[];
  assignee_user_ids: string[];
  assignee_names: string[];
  priority: string | null;
  impact_severity: string | null;
  department: string | null;
  delay_impact: string | null;
  delay_alert: string | null;
  overdue: boolean;
  blocked_by_count: number;
  downstream_blocked_count: number;
  last_edited_time: string;
}

// "Archived" stage was added 2026-05-24 as the canonical terminal state for
// ad sets that are no longer being worked on (whereas Completed = shipped,
// Cancelled = killed, On Hold = paused). All four are dead.
const DEAD_AD_SET_STAGES = new Set(['Completed', 'Cancelled', 'On Hold', 'Archived']);

// Pagination: Notion's max page_size is 100. We paginate to completion by
// default; the safety ceiling prevents a runaway query from silently
// processing tens of thousands of rows. If the ceiling is hit, the response
// surfaces `truncated_at_ceiling: true` so Piper can flag the gap explicitly.
const NOTION_PAGE_SIZE = 100;
const DEFAULT_MAX_ROWS = 2000;

async function fetchAllAotPages(args: {
  dataSourceId: string;
  filter?: unknown;
  sorts: unknown;
  maxRows: number;
}): Promise<{ pages: PageObjectResponse[]; truncated: boolean }> {
  const notion = getNotion();
  const collected: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  while (collected.length < args.maxRows) {
    const remaining = args.maxRows - collected.length;
    const pageSize = Math.min(NOTION_PAGE_SIZE, remaining);
    const response = await notion.dataSources.query({
      data_source_id: args.dataSourceId,
      page_size: pageSize,
      sorts: args.sorts as never,
      ...(args.filter ? { filter: args.filter as never } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const pages = response.results.filter(
      (page): page is PageObjectResponse => page.object === 'page' && 'properties' in page,
    );
    collected.push(...pages);
    if (!response.has_more || !response.next_cursor) {
      return { pages: collected, truncated: false };
    }
    cursor = response.next_cursor;
  }

  // We exited the loop because we hit maxRows. There may or may not be more
  // rows in Notion; we don't know without one more request. The presence of a
  // cursor at this point implies there are more, but we don't follow it.
  return { pages: collected, truncated: true };
}

function rich(text: Array<{ plain_text?: string }> | undefined): string | null {
  if (!text || text.length === 0) return null;
  return text.map((t) => t.plain_text ?? '').join('').trim() || null;
}

function rollupValue(rollup: unknown): string | null {
  if (!rollup || typeof rollup !== 'object') return null;
  const r = rollup as { type?: string; date?: { start?: string }; array?: Array<unknown>; number?: number };
  if (r.type === 'date' && r.date?.start) return r.date.start;
  if (r.type === 'array' && r.array && r.array.length > 0) {
    const first = r.array[0] as { type?: string; status?: { name?: string }; select?: { name?: string }; formula?: { string?: string; number?: number }; date?: { start?: string } };
    if (first.type === 'status' && first.status?.name) return first.status.name;
    if (first.type === 'select' && first.select?.name) return first.select.name;
    if (first.type === 'formula') return first.formula?.string ?? (first.formula?.number != null ? String(first.formula.number) : null);
    if (first.type === 'date' && first.date?.start) return first.date.start;
  }
  if (r.type === 'number' && typeof r.number === 'number') return String(r.number);
  return null;
}

function extractTask(page: PageObjectResponse): ExtractedTask {
  const props = page.properties as Record<string, { type: string; [key: string]: unknown }>;

  const getProp = (name: string): { type: string; [key: string]: unknown } | undefined => props[name];

  const title = getProp('Task name ') as { title?: Array<{ plain_text?: string }> } | undefined;
  const status = getProp('Status') as { status?: { name: string } } | undefined;
  const stage = getProp('Stage') as { status?: { name: string } } | undefined;
  const dueDate = getProp('Task Due Date') as { date?: { start: string } } | undefined;
  const priority = getProp('Priority') as { select?: { name: string } } | undefined;
  const impactSeverity = getProp('Impact Severity') as { select?: { name: string } } | undefined;
  const department = getProp('Department') as { select?: { name: string } } | undefined;
  const delayImpact = getProp('Delay Impact') as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const delayAlert = getProp('🚨 Delay Alert') as { formula?: { type: string; string?: string } } | undefined;
  const overdueCheck = getProp('Overdue Check') as { formula?: { type: string; number?: number; boolean?: boolean } } | undefined;
  const assignee = getProp('Assignee') as { people?: Array<{ id: string }> } | undefined;
  const adSet = getProp('Ad Set') as { relation?: Array<{ id: string }> } | undefined;
  const client = getProp('Client') as { relation?: Array<{ id: string }> } | undefined;
  const blockedBy = getProp('Blocked by') as { relation?: Array<{ id: string }> } | undefined;
  const downstreamBlocked = getProp('Downstream Blocked') as { rollup?: { type: string; number?: number } } | undefined;

  const adDeliveryDate = rollupValue(getProp('Ad Delivery Date')?.rollup);
  const adSetId = rollupValue(getProp('Ad Set ID')?.rollup);
  const adSetStage = rollupValue(getProp('Ad Set Stage')?.rollup);
  const format = rollupValue(getProp('Format')?.rollup);

  const overdue = overdueCheck?.formula?.type === 'number'
    ? (overdueCheck.formula.number ?? 0) === 1
    : overdueCheck?.formula?.type === 'boolean'
      ? Boolean(overdueCheck.formula.boolean)
      : false;

  return {
    task_id: page.id,
    url: page.url,
    task_name: rich(title?.title),
    status: status?.status?.name ?? null,
    stage: stage?.status?.name ?? null,
    task_due_date: dueDate?.date?.start ?? null,
    ad_delivery_date: adDeliveryDate,
    ad_set_id: adSetId,
    ad_set_stage: adSetStage,
    format,
    client_relation_ids: (client?.relation ?? []).map((r) => r.id),
    ad_set_relation_ids: (adSet?.relation ?? []).map((r) => r.id),
    assignee_user_ids: (assignee?.people ?? []).map((p) => p.id),
    assignee_names: [],
    priority: priority?.select?.name ?? null,
    impact_severity: impactSeverity?.select?.name ?? null,
    department: department?.select?.name ?? null,
    delay_impact: rich(delayImpact?.rich_text),
    delay_alert: delayAlert?.formula?.string ?? null,
    overdue,
    blocked_by_count: (blockedBy?.relation ?? []).length,
    downstream_blocked_count: downstreamBlocked?.rollup?.number ?? 0,
    last_edited_time: page.last_edited_time,
  };
}

// ---------------------------------------------------------------------------
// Filter builder
// ---------------------------------------------------------------------------

type NotionFilter =
  | { property: string; status: { equals?: string; does_not_equal?: string } }
  | { property: string; date: { before?: string; on_or_before?: string; after?: string; on_or_after?: string; is_empty?: true } }
  | { property: string; people: { contains: string } }
  | { property: string; relation: { contains: string } }
  | { property: string; formula: { number: { equals?: number; greater_than?: number } } }
  | { property: string; rollup: { number: { equals?: number; greater_than?: number; greater_than_or_equal_to?: number } } }
  | { property: string; select: { equals: string } }
  | { property: string; title: { contains?: string; equals?: string } }
  | { timestamp: 'last_edited_time'; last_edited_time: { on_or_after?: string; on_or_before?: string; after?: string; before?: string } }
  | { timestamp: 'created_time'; created_time: { on_or_after?: string; on_or_before?: string; after?: string; before?: string } }
  | { and: NotionFilter[] }
  | { or: NotionFilter[] };

const DEFAULT_FRESHNESS_WINDOW_DAYS = 90;

function freshnessFilterClause(days: number): NotionFilter | null {
  if (days <= 0) return null;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return { timestamp: 'last_edited_time', last_edited_time: { on_or_after: cutoff } };
}

function buildTaskFilter(params: {
  statusGroup?: 'active' | 'done' | 'all';
  overdueOnly?: boolean;
  dueOnOrBefore?: string;
  dueOnOrAfter?: string;
  assigneeUserId?: string;
  clientRelationId?: string;
  adSetRelationId?: string;
  taskNameContains?: string;
  freshnessWindowDays?: number;
}): NotionFilter | undefined {
  const clauses: NotionFilter[] = [];

  const group = params.statusGroup ?? 'active';
  if (group === 'active') {
    clauses.push({ property: 'Status', status: { does_not_equal: 'Done' } });
    clauses.push({ property: 'Status', status: { does_not_equal: 'Cancelled' } });
    // "Archived Task" is a soft-archive status the team uses to remove rows
    // from active views without deleting them. Treat as done for `active` queries.
    clauses.push({ property: 'Status', status: { does_not_equal: 'Archived Task' } });
    clauses.push({ property: 'Status', status: { does_not_equal: 'Complete' } });
  } else if (group === 'done') {
    clauses.push({ property: 'Status', status: { equals: 'Done' } });
  }

  if (params.overdueOnly) {
    clauses.push({ property: 'Overdue Check', formula: { number: { equals: 1 } } });
  }

  if (params.dueOnOrBefore) {
    clauses.push({ property: 'Task Due Date', date: { on_or_before: params.dueOnOrBefore } });
  }
  if (params.dueOnOrAfter) {
    clauses.push({ property: 'Task Due Date', date: { on_or_after: params.dueOnOrAfter } });
  }

  if (params.assigneeUserId) {
    clauses.push({ property: 'Assignee', people: { contains: params.assigneeUserId } });
  }
  if (params.clientRelationId) {
    clauses.push({ property: 'Client', relation: { contains: params.clientRelationId } });
  }
  if (params.adSetRelationId) {
    clauses.push({ property: 'Ad Set', relation: { contains: params.adSetRelationId } });
  }
  if (params.taskNameContains) {
    // Title property in the AOT Tasks DB has a trailing space: 'Task name '
    clauses.push({ property: 'Task name ', title: { contains: params.taskNameContains } });
  }
  const fresh = freshnessFilterClause(params.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS);
  if (fresh) clauses.push(fresh);

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

// ---------------------------------------------------------------------------
// Public tool: query_aot_tasks
// ---------------------------------------------------------------------------

export async function queryAotTasks(params: {
  status_group?: 'active' | 'done' | 'all';
  overdue_only?: boolean;
  due_on_or_before?: string;
  due_on_or_after?: string;
  assignee_user_id?: string;
  client_relation_id?: string;
  ad_set_relation_id?: string;
  client_name_contains?: string;
  task_name_contains?: string;
  exclude_dead_ad_sets?: boolean;
  freshness_window_days?: number;
  limit?: number;
}): Promise<string> {
  try {
    const maxRows = Math.min(params.limit ?? DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS);
    const dsId = await resolveDataSourceId(env.NOTION_AOT_TASKS_DB_ID);

    const filter = buildTaskFilter({
      statusGroup: params.status_group,
      overdueOnly: params.overdue_only,
      dueOnOrBefore: params.due_on_or_before,
      dueOnOrAfter: params.due_on_or_after,
      assigneeUserId: params.assignee_user_id,
      clientRelationId: params.client_relation_id,
      adSetRelationId: params.ad_set_relation_id,
      taskNameContains: params.task_name_contains,
      freshnessWindowDays: params.freshness_window_days,
    });

    logger.debug({ filter, maxRows }, 'Querying AOT Tasks DB');

    const { pages, truncated } = await fetchAllAotPages({
      dataSourceId: dsId,
      filter,
      sorts: [{ property: 'Task Due Date', direction: 'ascending' }],
      maxRows,
    });

    let tasks = pages.map(extractTask);
    const rawCount = tasks.length;

    if (params.client_name_contains) {
      const needle = params.client_name_contains.toLowerCase();
      const clientNameMap = await getClientNameMap(tasks.flatMap((t) => t.client_relation_ids));
      tasks = tasks.filter((t) =>
        t.client_relation_ids.some((id) => (clientNameMap.get(id) ?? '').toLowerCase().includes(needle)),
      );
    }

    const excludeDead = params.exclude_dead_ad_sets ?? true;
    if (excludeDead) {
      tasks = tasks.filter((t) => !t.ad_set_stage || !DEAD_AD_SET_STAGES.has(t.ad_set_stage));
    }

    const userNameMap = await getUserNameMap(tasks.flatMap((t) => t.assignee_user_ids));
    for (const task of tasks) {
      task.assignee_names = task.assignee_user_ids
        .map((id) => userNameMap.get(id))
        .filter((name): name is string => !!name);
    }

    logger.info(
      { count: tasks.length, rawCount, hadFilter: !!filter, excludedDead: excludeDead, truncated },
      'AOT Tasks query complete',
    );
    return JSON.stringify({
      count: tasks.length,
      raw_count_before_inmemory_filters: rawCount,
      truncated_at_ceiling: truncated,
      max_rows: maxRows,
      tasks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'queryAotTasks failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// AOT Ad Sets DB — extraction
// ---------------------------------------------------------------------------

interface ExtractedAdSet {
  ad_set_id: string;
  url: string;
  ad_title: string | null;
  ad_id_code: string | null;
  stage: string | null;
  format: string | null;
  department: string | null;
  ad_delivery_date: string | null;
  reported_week: string | null;
  client_relation_ids: string[];
  client_code: string | null;
  client_status: string | null;
  owner_user_ids: string[];
  owner_names: string[];
  task_assignee_name: string | null;
  active_task: string | null;
  task_progress: number | null;
  task_deadline: string | null;
  overdue_tasks_count: number;
  task_count: number;
  brief_relation_ids: string[];
  drive_folder_url: string | null;
  final_ads_folder_url: string | null;
  frameio_url: string | null;
  health_check: string | null;
  created_time: string;
  last_edited_time: string;
}

function extractAdSet(page: PageObjectResponse): ExtractedAdSet {
  const props = page.properties as Record<string, { type: string; [key: string]: unknown }>;
  const getProp = (name: string): { type: string; [key: string]: unknown } | undefined => props[name];

  const title = getProp('Ad Title') as { title?: Array<{ plain_text?: string }> } | undefined;
  const adIdFormula = getProp('Ad ID') as { formula?: { type: string; string?: string } } | undefined;
  const stage = getProp('Stage') as { status?: { name: string } } | undefined;
  const format = getProp('Format') as { select?: { name: string } } | undefined;
  const department = getProp('Department') as { select?: { name: string } } | undefined;
  const adDeliveryDate = getProp('Ad Delivery Date') as { date?: { start: string } } | undefined;
  const reportedWeek = getProp('Reported Week') as { date?: { start: string } } | undefined;
  const client = getProp('Client') as { relation?: Array<{ id: string }> } | undefined;
  const owner = getProp('Owner') as { people?: Array<{ id: string }> } | undefined;
  const tasks = getProp('Tasks') as { relation?: Array<{ id: string }> } | undefined;
  const briefs = getProp('EXT | Client Briefs') as { relation?: Array<{ id: string }> } | undefined;
  const taskProgress = getProp('Task Progress') as { formula?: { type: string; number?: number } } | undefined;
  const taskDeadline = getProp('Task Deadline') as { formula?: { type: string; date?: { start?: string } } } | undefined;
  const activeTask = getProp('Active Task') as { formula?: { type: string; string?: string } } | undefined;
  const taskAssignee = getProp('Task Assignee') as { formula?: { type: string; string?: string } } | undefined;
  const overdueCount = getProp('Overdue Tasks Count') as { rollup?: { type: string; number?: number } } | undefined;
  const driveFolder = getProp('Drive Folder') as { url?: string | null } | undefined;
  const finalAdsFolder = getProp('Final Ads Folder') as { url?: string | null } | undefined;
  const frameioUrl = getProp('Frame.io Link / Figma Link') as { url?: string | null } | undefined;
  const healthCheck = getProp('Health Check') as { formula?: { type: string; string?: string } } | undefined;

  const clientCode = rollupValue(getProp('Client-Code-Rollup')?.rollup);
  const clientStatus = rollupValue(getProp('Client Status')?.rollup);

  return {
    ad_set_id: page.id,
    url: page.url,
    ad_title: rich(title?.title),
    ad_id_code: adIdFormula?.formula?.string ?? null,
    stage: stage?.status?.name ?? null,
    format: format?.select?.name ?? null,
    department: department?.select?.name ?? null,
    ad_delivery_date: adDeliveryDate?.date?.start ?? null,
    reported_week: reportedWeek?.date?.start ?? null,
    client_relation_ids: (client?.relation ?? []).map((r) => r.id),
    client_code: clientCode,
    client_status: clientStatus,
    owner_user_ids: (owner?.people ?? []).map((p) => p.id),
    owner_names: [],
    task_assignee_name: taskAssignee?.formula?.string ?? null,
    active_task: activeTask?.formula?.string ?? null,
    task_progress: taskProgress?.formula?.number ?? null,
    task_deadline: taskDeadline?.formula?.date?.start ?? null,
    overdue_tasks_count: overdueCount?.rollup?.number ?? 0,
    task_count: (tasks?.relation ?? []).length,
    brief_relation_ids: (briefs?.relation ?? []).map((r) => r.id),
    drive_folder_url: driveFolder?.url ?? null,
    final_ads_folder_url: finalAdsFolder?.url ?? null,
    frameio_url: frameioUrl?.url ?? null,
    health_check: healthCheck?.formula?.string ?? null,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  };
}

function buildAdSetFilter(params: {
  stage?: string;
  clientRelationId?: string;
  ownerUserId?: string;
  format?: string;
  deliveryOnOrBefore?: string;
  deliveryOnOrAfter?: string;
  hasOverdueTasks?: boolean;
  freshnessWindowDays?: number;
}): NotionFilter | undefined {
  const clauses: NotionFilter[] = [];

  if (params.stage) {
    clauses.push({ property: 'Stage', status: { equals: params.stage } });
  }
  if (params.clientRelationId) {
    clauses.push({ property: 'Client', relation: { contains: params.clientRelationId } });
  }
  if (params.ownerUserId) {
    clauses.push({ property: 'Owner', people: { contains: params.ownerUserId } });
  }
  if (params.format) {
    clauses.push({ property: 'Format', select: { equals: params.format } });
  }
  if (params.deliveryOnOrBefore) {
    clauses.push({ property: 'Ad Delivery Date', date: { on_or_before: params.deliveryOnOrBefore } });
  }
  if (params.deliveryOnOrAfter) {
    clauses.push({ property: 'Ad Delivery Date', date: { on_or_after: params.deliveryOnOrAfter } });
  }
  if (params.hasOverdueTasks) {
    // Overdue Tasks Count is a rollup (function=sum aggregating to a number).
    // Notion requires the rollup filter nested under `rollup.number`, not flat.
    clauses.push({ property: 'Overdue Tasks Count', rollup: { number: { greater_than: 0 } } });
  }
  const fresh = freshnessFilterClause(params.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS);
  if (fresh) clauses.push(fresh);

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

// ---------------------------------------------------------------------------
// Public tool: query_aot_adsets
// ---------------------------------------------------------------------------

export async function queryAotAdSets(params: {
  stage?: string;
  exclude_dead_ad_sets?: boolean;
  client_relation_id?: string;
  client_name_contains?: string;
  owner_user_id?: string;
  format?: string;
  delivery_on_or_before?: string;
  delivery_on_or_after?: string;
  has_overdue_tasks?: boolean;
  freshness_window_days?: number;
  sort_by?: 'delivery_date_asc' | 'delivery_date_desc' | 'last_edited_desc' | 'created_desc';
  limit?: number;
}): Promise<string> {
  try {
    const maxRows = Math.min(params.limit ?? DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS);
    const dsId = await resolveDataSourceId(env.NOTION_AOT_ADSETS_DB_ID);

    const filter = buildAdSetFilter({
      stage: params.stage,
      clientRelationId: params.client_relation_id,
      ownerUserId: params.owner_user_id,
      format: params.format,
      deliveryOnOrBefore: params.delivery_on_or_before,
      deliveryOnOrAfter: params.delivery_on_or_after,
      hasOverdueTasks: params.has_overdue_tasks,
      freshnessWindowDays: params.freshness_window_days,
    });

    const sortBy = params.sort_by ?? 'delivery_date_asc';
    const sorts: Array<{ property?: string; timestamp?: string; direction: 'ascending' | 'descending' }> =
      sortBy === 'delivery_date_asc'
        ? [{ property: 'Ad Delivery Date', direction: 'ascending' }]
        : sortBy === 'delivery_date_desc'
          ? [{ property: 'Ad Delivery Date', direction: 'descending' }]
          : sortBy === 'last_edited_desc'
            ? [{ timestamp: 'last_edited_time', direction: 'descending' }]
            : [{ timestamp: 'created_time', direction: 'descending' }];

    logger.debug({ filter, maxRows, sortBy }, 'Querying AOT Ad Sets DB');

    const { pages, truncated } = await fetchAllAotPages({
      dataSourceId: dsId,
      filter,
      sorts,
      maxRows,
    });

    let adsets = pages.map(extractAdSet);
    const rawCount = adsets.length;

    if (params.client_name_contains) {
      const needle = params.client_name_contains.toLowerCase();
      const clientNameMap = await getClientNameMap(adsets.flatMap((a) => a.client_relation_ids));
      adsets = adsets.filter((a) =>
        a.client_relation_ids.some((id) => (clientNameMap.get(id) ?? '').toLowerCase().includes(needle)),
      );
    }

    const excludeDead = params.exclude_dead_ad_sets ?? true;
    if (excludeDead) {
      adsets = adsets.filter((a) => !a.stage || !DEAD_AD_SET_STAGES.has(a.stage));
    }

    const ownerNameMap = await getUserNameMap(adsets.flatMap((a) => a.owner_user_ids));
    for (const a of adsets) {
      a.owner_names = a.owner_user_ids
        .map((id) => ownerNameMap.get(id))
        .filter((name): name is string => !!name);
    }

    logger.info(
      { count: adsets.length, rawCount, hadFilter: !!filter, excludedDead: excludeDead, truncated },
      'AOT Ad Sets query complete',
    );
    return JSON.stringify({
      count: adsets.length,
      raw_count_before_inmemory_filters: rawCount,
      truncated_at_ceiling: truncated,
      max_rows: maxRows,
      adsets,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'queryAotAdSets failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Client name resolution (best-effort, cached)
// ---------------------------------------------------------------------------

const clientNameCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// User ID → display name resolution (cached, best-effort)
// ---------------------------------------------------------------------------

const userNameCache = new Map<string, string>();
const userResolveFailures = new Set<string>();

async function getUserNameMap(userIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds)).filter(
    (id) => !userNameCache.has(id) && !userResolveFailures.has(id),
  );
  if (unique.length === 0) return userNameCache;

  const notion = getNotion();
  await Promise.all(
    unique.map(async (id) => {
      try {
        const user = (await notion.users.retrieve({ user_id: id })) as { name?: string | null };
        if (user.name) {
          userNameCache.set(id, user.name);
        } else {
          userResolveFailures.add(id);
        }
      } catch (err) {
        userResolveFailures.add(id);
        logger.warn({ userId: id, err: (err as Error).message }, 'Failed to resolve Notion user');
      }
    }),
  );
  return userNameCache;
}

async function getClientNameMap(pageIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(pageIds)).filter((id) => !clientNameCache.has(id));
  if (unique.length === 0) return clientNameCache;

  const notion = getNotion();
  await Promise.all(
    unique.map(async (id) => {
      try {
        const page = (await notion.pages.retrieve({ page_id: id })) as PageObjectResponse;
        const props = page.properties as Record<string, { type: string; [key: string]: unknown }>;
        // The Client DB likely has a title property — find the one with type=title
        const titleEntry = Object.entries(props).find(([, p]) => p.type === 'title');
        if (titleEntry) {
          const t = titleEntry[1] as { title?: Array<{ plain_text?: string }> };
          const name = rich(t.title);
          if (name) clientNameCache.set(id, name);
        }
      } catch (err) {
        logger.warn({ pageId: id, err: (err as Error).message }, 'Failed to resolve client page');
      }
    }),
  );
  return clientNameCache;
}

// ---------------------------------------------------------------------------
// Count tools — sidestep the 60K char per-tool runtime cap
// ---------------------------------------------------------------------------
// Same filter semantics as queryAotTasks / queryAotAdSets, but return only
// aggregates (total + optional group_by buckets). When no group_by is
// requested, the row payload isn't parsed at all — we just count pages.

export type TaskGroupBy =
  | 'status'
  | 'stage'
  | 'ad_set_stage'
  | 'assignee'
  | 'client'
  | 'priority'
  | 'department'
  | 'format'
  | 'overdue';

export type AdSetGroupBy =
  | 'stage'
  | 'client'
  | 'owner'
  | 'format'
  | 'department'
  | 'client_status'
  | 'health_check';

function bumpBucket(buckets: Map<string, number>, key: string | null): void {
  const k = key ?? '(none)';
  buckets.set(k, (buckets.get(k) ?? 0) + 1);
}

function bucketsToSorted(buckets: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    Array.from(buckets.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

export async function countAotTasks(params: {
  status_group?: 'active' | 'done' | 'all';
  overdue_only?: boolean;
  due_on_or_before?: string;
  due_on_or_after?: string;
  assignee_user_id?: string;
  client_relation_id?: string;
  ad_set_relation_id?: string;
  client_name_contains?: string;
  task_name_contains?: string;
  exclude_dead_ad_sets?: boolean;
  freshness_window_days?: number;
  group_by?: TaskGroupBy;
  limit?: number;
}): Promise<string> {
  try {
    const maxRows = Math.min(params.limit ?? DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS);
    const dsId = await resolveDataSourceId(env.NOTION_AOT_TASKS_DB_ID);

    const filter = buildTaskFilter({
      statusGroup: params.status_group,
      overdueOnly: params.overdue_only,
      dueOnOrBefore: params.due_on_or_before,
      dueOnOrAfter: params.due_on_or_after,
      assigneeUserId: params.assignee_user_id,
      clientRelationId: params.client_relation_id,
      adSetRelationId: params.ad_set_relation_id,
      taskNameContains: params.task_name_contains,
      freshnessWindowDays: params.freshness_window_days,
    });

    const { pages, truncated } = await fetchAllAotPages({
      dataSourceId: dsId,
      filter,
      sorts: [{ property: 'Task Due Date', direction: 'ascending' }],
      maxRows,
    });

    const needInMemoryFiltering =
      !!params.client_name_contains || (params.exclude_dead_ad_sets ?? true);
    const needGroupExtract = !!params.group_by;

    // Fast path: no in-memory filtering, no grouping — just count pages.
    if (!needInMemoryFiltering && !needGroupExtract) {
      logger.info({ total: pages.length, truncated }, 'AOT Tasks count complete (fast path)');
      return JSON.stringify({
        total: pages.length,
        raw_count_before_inmemory_filters: pages.length,
        truncated_at_ceiling: truncated,
        max_rows: maxRows,
      });
    }

    let tasks = pages.map(extractTask);
    const rawCount = tasks.length;

    if (params.client_name_contains) {
      const needle = params.client_name_contains.toLowerCase();
      const clientNameMap = await getClientNameMap(tasks.flatMap((t) => t.client_relation_ids));
      tasks = tasks.filter((t) =>
        t.client_relation_ids.some((id) => (clientNameMap.get(id) ?? '').toLowerCase().includes(needle)),
      );
    }

    const excludeDead = params.exclude_dead_ad_sets ?? true;
    if (excludeDead) {
      tasks = tasks.filter((t) => !t.ad_set_stage || !DEAD_AD_SET_STAGES.has(t.ad_set_stage));
    }

    const result: {
      total: number;
      raw_count_before_inmemory_filters: number;
      truncated_at_ceiling: boolean;
      max_rows: number;
      group_by?: TaskGroupBy;
      groups?: Record<string, number>;
      multi_value_group?: boolean;
    } = {
      total: tasks.length,
      raw_count_before_inmemory_filters: rawCount,
      truncated_at_ceiling: truncated,
      max_rows: maxRows,
    };

    if (params.group_by) {
      const buckets = new Map<string, number>();
      let multiValue = false;

      if (params.group_by === 'assignee') {
        multiValue = true;
        const allUserIds = tasks.flatMap((t) => t.assignee_user_ids);
        const userNameMap = await getUserNameMap(allUserIds);
        for (const t of tasks) {
          if (t.assignee_user_ids.length === 0) {
            bumpBucket(buckets, '(unassigned)');
          } else {
            for (const uid of t.assignee_user_ids) {
              bumpBucket(buckets, userNameMap.get(uid) ?? `user:${uid.slice(0, 8)}`);
            }
          }
        }
      } else if (params.group_by === 'client') {
        multiValue = true;
        const allClientIds = tasks.flatMap((t) => t.client_relation_ids);
        const clientNameMap = await getClientNameMap(allClientIds);
        for (const t of tasks) {
          if (t.client_relation_ids.length === 0) {
            bumpBucket(buckets, '(no client)');
          } else {
            for (const cid of t.client_relation_ids) {
              bumpBucket(buckets, clientNameMap.get(cid) ?? `client:${cid.slice(0, 8)}`);
            }
          }
        }
      } else if (params.group_by === 'overdue') {
        for (const t of tasks) bumpBucket(buckets, t.overdue ? 'overdue' : 'not_overdue');
      } else {
        const field = params.group_by;
        for (const t of tasks) bumpBucket(buckets, t[field]);
      }

      result.group_by = params.group_by;
      result.groups = bucketsToSorted(buckets);
      if (multiValue) result.multi_value_group = true;
    }

    logger.info(
      { total: tasks.length, rawCount, groupBy: params.group_by, truncated },
      'AOT Tasks count complete',
    );
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'countAotTasks failed');
    return JSON.stringify({ error: msg });
  }
}

export async function countAotAdSets(params: {
  stage?: string;
  exclude_dead_ad_sets?: boolean;
  client_relation_id?: string;
  client_name_contains?: string;
  owner_user_id?: string;
  format?: string;
  delivery_on_or_before?: string;
  delivery_on_or_after?: string;
  has_overdue_tasks?: boolean;
  freshness_window_days?: number;
  group_by?: AdSetGroupBy;
  limit?: number;
}): Promise<string> {
  try {
    const maxRows = Math.min(params.limit ?? DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS);
    const dsId = await resolveDataSourceId(env.NOTION_AOT_ADSETS_DB_ID);

    const filter = buildAdSetFilter({
      stage: params.stage,
      clientRelationId: params.client_relation_id,
      ownerUserId: params.owner_user_id,
      format: params.format,
      deliveryOnOrBefore: params.delivery_on_or_before,
      deliveryOnOrAfter: params.delivery_on_or_after,
      hasOverdueTasks: params.has_overdue_tasks,
      freshnessWindowDays: params.freshness_window_days,
    });

    const { pages, truncated } = await fetchAllAotPages({
      dataSourceId: dsId,
      filter,
      sorts: [{ property: 'Ad Delivery Date', direction: 'ascending' }],
      maxRows,
    });

    const needInMemoryFiltering =
      !!params.client_name_contains || (params.exclude_dead_ad_sets ?? true);
    const needGroupExtract = !!params.group_by;

    if (!needInMemoryFiltering && !needGroupExtract) {
      logger.info({ total: pages.length, truncated }, 'AOT Ad Sets count complete (fast path)');
      return JSON.stringify({
        total: pages.length,
        raw_count_before_inmemory_filters: pages.length,
        truncated_at_ceiling: truncated,
        max_rows: maxRows,
      });
    }

    let adsets = pages.map(extractAdSet);
    const rawCount = adsets.length;

    if (params.client_name_contains) {
      const needle = params.client_name_contains.toLowerCase();
      const clientNameMap = await getClientNameMap(adsets.flatMap((a) => a.client_relation_ids));
      adsets = adsets.filter((a) =>
        a.client_relation_ids.some((id) => (clientNameMap.get(id) ?? '').toLowerCase().includes(needle)),
      );
    }

    const excludeDead = params.exclude_dead_ad_sets ?? true;
    if (excludeDead) {
      adsets = adsets.filter((a) => !a.stage || !DEAD_AD_SET_STAGES.has(a.stage));
    }

    const result: {
      total: number;
      raw_count_before_inmemory_filters: number;
      truncated_at_ceiling: boolean;
      max_rows: number;
      group_by?: AdSetGroupBy;
      groups?: Record<string, number>;
      multi_value_group?: boolean;
    } = {
      total: adsets.length,
      raw_count_before_inmemory_filters: rawCount,
      truncated_at_ceiling: truncated,
      max_rows: maxRows,
    };

    if (params.group_by) {
      const buckets = new Map<string, number>();
      let multiValue = false;

      if (params.group_by === 'owner') {
        multiValue = true;
        const userNameMap = await getUserNameMap(adsets.flatMap((a) => a.owner_user_ids));
        for (const a of adsets) {
          if (a.owner_user_ids.length === 0) {
            bumpBucket(buckets, '(unowned)');
          } else {
            for (const uid of a.owner_user_ids) {
              bumpBucket(buckets, userNameMap.get(uid) ?? `user:${uid.slice(0, 8)}`);
            }
          }
        }
      } else if (params.group_by === 'client') {
        multiValue = true;
        // Prefer the client_code rollup when present (cheaper, already on the row).
        // Fall back to resolving relation IDs to names.
        const needsName = adsets.some((a) => !a.client_code && a.client_relation_ids.length > 0);
        const clientNameMap = needsName
          ? await getClientNameMap(adsets.flatMap((a) => a.client_relation_ids))
          : new Map<string, string>();
        for (const a of adsets) {
          if (a.client_code) {
            bumpBucket(buckets, a.client_code);
          } else if (a.client_relation_ids.length === 0) {
            bumpBucket(buckets, '(no client)');
          } else {
            for (const cid of a.client_relation_ids) {
              bumpBucket(buckets, clientNameMap.get(cid) ?? `client:${cid.slice(0, 8)}`);
            }
          }
        }
      } else {
        const field = params.group_by;
        for (const a of adsets) bumpBucket(buckets, a[field]);
      }

      result.group_by = params.group_by;
      result.groups = bucketsToSorted(buckets);
      if (multiValue) result.multi_value_group = true;
    }

    logger.info(
      { total: adsets.length, rawCount, groupBy: params.group_by, truncated },
      'AOT Ad Sets count complete',
    );
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'countAotAdSets failed');
    return JSON.stringify({ error: msg });
  }
}
