import { type PageObjectResponse } from '@notionhq/client';
import { getNotion } from '../../integrations/notion.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

type SelectFilter = { property: string; select: { equals: string } };
type RelationFilter = { property: string; relation: { contains: string } };
type DateBeforeFilter = { property: string; date: { before: string } };
type StatusNotEqualsFilter = { property: string; select: { does_not_equal: string } };
type PropertyFilter = SelectFilter | RelationFilter | DateBeforeFilter | StatusNotEqualsFilter;

function getKanbanDbId(): string {
  const dbId = env.NOTION_KANBAN_DB_ID;
  if (!dbId) {
    throw new Error(
      'NOTION_KANBAN_DB_ID is not set. Configure it in .env to use task management.',
    );
  }
  return dbId;
}

// ---------------------------------------------------------------------------
// Data source ID resolution
// ---------------------------------------------------------------------------
// Notion SDK v5.9.0 (API 2025-09-03) moved properties and query from
// `databases` to `dataSources`. The database ID and data source ID are
// different — we must resolve the data source ID from the database first.

let cachedDataSourceId: string | null = null;

async function getDataSourceId(): Promise<string> {
  if (cachedDataSourceId) return cachedDataSourceId;

  const dbId = getKanbanDbId();
  const notion = getNotion();
  const db = await notion.databases.retrieve({ database_id: dbId });

  const dataSources = 'data_sources' in db ? (db as { data_sources: Array<{ id: string }> }).data_sources : [];
  if (dataSources.length === 0) {
    throw new Error(
      `Database ${dbId} has no data sources. Ensure the Notion integration has access to this database.`,
    );
  }

  cachedDataSourceId = dataSources[0].id;
  logger.info({ databaseId: dbId, dataSourceId: cachedDataSourceId }, 'Resolved Notion data source ID');
  return cachedDataSourceId;
}

// ---------------------------------------------------------------------------
// Schema auto-discovery & provisioning
// ---------------------------------------------------------------------------

// Logical field -> expected Notion property type
const REQUIRED_PROPERTIES: Record<string, { type: string; config: unknown }> = {
  Status: {
    type: 'select',
    config: {
      select: {
        options: [
          { name: 'To Do', color: 'default' },
          { name: 'In Progress', color: 'blue' },
          { name: 'Blocked', color: 'orange' },
          { name: 'Done', color: 'green' },
        ],
      },
    },
  },
  Assignee: {
    type: 'select',
    config: {
      select: {
        options: [
          { name: 'Daniel', color: 'blue' },
          { name: 'Jasmin', color: 'purple' },
          { name: 'Ada', color: 'orange' },
          { name: 'Otto', color: 'green' },
          { name: 'Coda', color: 'pink' },
          { name: 'Rex', color: 'yellow' },
          { name: 'Sage', color: 'gray' },
        ],
      },
    },
  },
  Priority: {
    type: 'select',
    config: {
      select: {
        options: [
          { name: 'Low', color: 'green' },
          { name: 'Medium', color: 'yellow' },
          { name: 'High', color: 'orange' },
          { name: 'Urgent', color: 'red' },
        ],
      },
    },
  },
  'Due Date': { type: 'date', config: { date: {} } },
  Labels: {
    type: 'multi_select',
    config: {
      multi_select: {
        options: [
          { name: 'personal', color: 'blue' },
          { name: 'work', color: 'orange' },
          { name: 'dai', color: 'purple' },
          { name: 'bmad', color: 'pink' },
          { name: 'agency', color: 'green' },
          { name: 'follow-up', color: 'yellow' },
          { name: 'waiting', color: 'gray' },
        ],
      },
    },
  },
  Type: {
    type: 'select',
    config: {
      select: {
        options: [
          { name: 'Task', color: 'default' },
          { name: 'Project', color: 'purple' },
        ],
      },
    },
  },
};

// Cache: maps logical field name -> actual property name in the database
let schemaMap: Record<string, string> | null = null;
let titlePropName: string | null = null;

/**
 * Fetch the data source schema, build a map from logical names to actual property names,
 * and auto-create any missing properties.
 */
async function ensureSchema(): Promise<{ titleProp: string; propMap: Record<string, string> }> {
  if (schemaMap && titlePropName) {
    return { titleProp: titlePropName, propMap: schemaMap };
  }

  const dsId = await getDataSourceId();
  const notion = getNotion();

  // Use dataSources.retrieve — this is where properties live in SDK v5.9.0
  const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
  const existingProps = 'properties' in ds ? (ds as { properties: Record<string, { type: string }> }).properties : {};

  // Find the title property (whatever it's called)
  let foundTitle = 'Name';
  for (const [name, prop] of Object.entries(existingProps)) {
    if (prop.type === 'title') {
      foundTitle = name;
      break;
    }
  }

  // Build map of existing properties by type
  const existingByName = new Map<string, string>();
  for (const [name, prop] of Object.entries(existingProps)) {
    existingByName.set(name, prop.type);
  }

  // Check each required property and create if missing
  const map: Record<string, string> = {};
  const propsToCreate: Record<string, unknown> = {};

  for (const [logicalName, spec] of Object.entries(REQUIRED_PROPERTIES)) {
    const existingType = existingByName.get(logicalName);
    if (existingType) {
      map[logicalName] = logicalName;
    } else {
      // Property doesn't exist — queue for creation
      propsToCreate[logicalName] = spec.config;
    }
  }

  // Check if "Parent" relation property exists — if not, create it dynamically
  const hasParent = existingByName.has('Parent');
  if (hasParent) {
    map['Parent'] = 'Parent';
  }
  // "Sub-items" is auto-created by Notion as the reverse of Parent
  if (existingByName.has('Sub-items')) {
    map['Sub-items'] = 'Sub-items';
  }

  // Create missing properties via dataSources.update
  if (Object.keys(propsToCreate).length > 0) {
    logger.info(
      { properties: Object.keys(propsToCreate) },
      'Auto-creating missing Notion data source properties',
    );
    try {
      await notion.dataSources.update({
        data_source_id: dsId,
        properties: propsToCreate as Parameters<typeof notion.dataSources.update>[0]['properties'],
      });

      // Re-fetch schema after creation to confirm properties exist
      const dsAfter = await notion.dataSources.retrieve({ data_source_id: dsId });
      const propsAfter = 'properties' in dsAfter ? (dsAfter as { properties: Record<string, { type: string }> }).properties : {};
      for (const [name, prop] of Object.entries(propsAfter)) {
        if (prop.type !== 'title') {
          map[name] = name;
        }
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to auto-create Notion properties');
      // Return partial map for this call but don't cache — next call will retry
      return { titleProp: foundTitle, propMap: map };
    }
  }

  // Create "Parent" relation property if missing (must be separate API call)
  if (!hasParent) {
    const dbId = getKanbanDbId();
    logger.info('Auto-creating Parent relation property');
    try {
      await notion.dataSources.update({
        data_source_id: dsId,
        properties: {
          Parent: {
            relation: {
              database_id: dbId,
              type: 'dual_property',
              dual_property: { synced_property_name: 'Sub-items' },
            },
          },
        } as Parameters<typeof notion.dataSources.update>[0]['properties'],
      });
      map['Parent'] = 'Parent';
      map['Sub-items'] = 'Sub-items';
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to auto-create Parent relation property',
      );
    }
  }

  // Only cache on full success
  schemaMap = map;
  titlePropName = foundTitle;

  logger.info(
    { titleProp: foundTitle, mappedProperties: Object.keys(map), created: Object.keys(propsToCreate) },
    'Notion schema verified',
  );

  return { titleProp: foundTitle, propMap: map };
}

/** Reset cached schema (useful after manual DB changes) */
export function resetSchemaCache(): void {
  schemaMap = null;
  titlePropName = null;
  cachedDataSourceId = null;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function extractPageData(page: PageObjectResponse, titleProp: string) {
  const props = page.properties;

  // Title — use discovered property name
  const tp = props[titleProp];
  const title =
    tp && tp.type === 'title'
      ? tp.title.map((t: { plain_text: string }) => t.plain_text).join('')
      : '';

  const statusProp = props['Status'];
  const status =
    statusProp && statusProp.type === 'select'
      ? statusProp.select?.name ?? null
      : statusProp && statusProp.type === 'status'
        ? statusProp.status?.name ?? null
        : null;

  const assigneeProp = props['Assignee'];
  const assignee =
    assigneeProp && assigneeProp.type === 'select'
      ? assigneeProp.select?.name ?? null
      : null;

  const priorityProp = props['Priority'];
  const priority =
    priorityProp && priorityProp.type === 'select'
      ? priorityProp.select?.name ?? null
      : null;

  const dueDateProp = props['Due Date'];
  const dueDate =
    dueDateProp && dueDateProp.type === 'date'
      ? dueDateProp.date?.start ?? null
      : null;

  const labelsProp = props['Labels'];
  const labels =
    labelsProp && labelsProp.type === 'multi_select'
      ? labelsProp.multi_select.map((l: { name: string }) => l.name)
      : [];

  const typeProp = props['Type'];
  const type =
    typeProp && typeProp.type === 'select'
      ? typeProp.select?.name ?? 'Task'
      : 'Task';

  const parentProp = props['Parent'];
  const parentRelations = parentProp && parentProp.type === 'relation' ? parentProp.relation : [];
  const parentId = parentRelations.length > 0 ? (parentRelations[0] as { id: string }).id : null;

  const subItemsProp = props['Sub-items'];
  const subItemIds =
    subItemsProp && subItemsProp.type === 'relation'
      ? subItemsProp.relation.map((r: { id: string }) => r.id)
      : [];

  return {
    id: page.id,
    title,
    status,
    assignee,
    priority,
    dueDate,
    labels,
    type,
    parentId,
    subItemIds,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    url: page.url,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function queryTasks(params: {
  status?: string;
  assignee?: string;
  priority?: string;
  type?: string;
  parentId?: string;
  limit?: number;
}): Promise<string> {
  try {
    const limit = params.limit ?? 20;
    const dsId = await getDataSourceId();
    const notion = getNotion();
    const { titleProp } = await ensureSchema();

    logger.debug(
      { status: params.status, assignee: params.assignee, priority: params.priority, type: params.type, limit },
      'Querying Notion tasks',
    );

    const filters: PropertyFilter[] = [];

    if (params.status) {
      filters.push({ property: 'Status', select: { equals: params.status } });
    }
    if (params.assignee) {
      filters.push({ property: 'Assignee', select: { equals: params.assignee } });
    }
    if (params.priority) {
      filters.push({ property: 'Priority', select: { equals: params.priority } });
    }
    if (params.type) {
      filters.push({ property: 'Type', select: { equals: params.type } });
    }
    if (params.parentId) {
      filters.push({ property: 'Parent', relation: { contains: params.parentId } });
    }

    let filter: PropertyFilter | { and: PropertyFilter[] } | undefined;
    if (filters.length === 1) {
      filter = filters[0];
    } else if (filters.length > 1) {
      filter = { and: filters };
    }

    const response = await notion.dataSources.query({
      data_source_id: dsId,
      page_size: limit,
      ...(filter ? { filter } : {}),
    });

    const tasks = response.results
      .filter((page): page is PageObjectResponse => page.object === 'page' && 'properties' in page)
      .map((page) => extractPageData(page, titleProp));

    logger.debug({ count: tasks.length }, 'Queried Notion tasks');
    return JSON.stringify(tasks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'queryTasks failed');
    return JSON.stringify({ error: msg });
  }
}

export async function createTask(params: {
  title: string;
  status?: string;
  assignee?: string;
  priority?: string;
  dueDate?: string;
  description?: string;
  labels?: string[];
  type?: string;
  parentId?: string;
}): Promise<string> {
  try {
    const dsId = await getDataSourceId();
    const notion = getNotion();
    const { titleProp, propMap } = await ensureSchema();

    logger.debug(
      { title: params.title, status: params.status, assignee: params.assignee, type: params.type },
      'Creating Notion task',
    );

    const properties: Record<string, unknown> = {
      [titleProp]: {
        title: [{ text: { content: params.title } }],
      },
    };

    // Only set properties that exist in the database
    if (propMap['Status']) {
      properties[propMap['Status']] = {
        select: { name: params.status ?? 'To Do' },
      };
    }

    if (propMap['Priority']) {
      properties[propMap['Priority']] = {
        select: { name: params.priority ?? 'Medium' },
      };
    }

    if (params.assignee && propMap['Assignee']) {
      properties[propMap['Assignee']] = {
        select: { name: params.assignee },
      };
    }

    if (params.dueDate && propMap['Due Date']) {
      properties[propMap['Due Date']] = {
        date: { start: params.dueDate },
      };
    }

    if (params.labels && params.labels.length > 0 && propMap['Labels']) {
      properties[propMap['Labels']] = {
        multi_select: params.labels.map((name) => ({ name })),
      };
    }

    if (propMap['Type']) {
      properties[propMap['Type']] = {
        select: { name: params.type ?? 'Task' },
      };
    }

    if (params.parentId && propMap['Parent']) {
      properties[propMap['Parent']] = {
        relation: [{ id: params.parentId }],
      };
    }

    const children: Array<{
      object: 'block';
      type: 'paragraph';
      paragraph: { rich_text: Array<{ type: 'text'; text: { content: string } }> };
    }> = [];

    if (params.description) {
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: params.description } }],
        },
      });
    }

    const response = await notion.pages.create({
      parent: { data_source_id: dsId },
      properties: properties as Parameters<typeof notion.pages.create>[0]['properties'],
      ...(children.length > 0 ? { children } : {}),
    });

    const result = {
      id: response.id,
      url: 'url' in response ? response.url : null,
    };

    logger.debug({ pageId: result.id }, 'Created Notion task');
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'createTask failed');
    return JSON.stringify({ error: msg });
  }
}

export async function updateTask(params: {
  pageId: string;
  status?: string;
  assignee?: string;
  priority?: string;
  dueDate?: string;
  labels?: string[];
  type?: string;
  parentId?: string;
}): Promise<string> {
  try {
    const notion = getNotion();
    const { propMap } = await ensureSchema();

    logger.debug(
      { pageId: params.pageId, status: params.status },
      'Updating Notion task',
    );

    const properties: Record<string, unknown> = {};

    if (params.status && propMap['Status']) {
      properties[propMap['Status']] = {
        select: { name: params.status },
      };
    }

    if (params.assignee && propMap['Assignee']) {
      properties[propMap['Assignee']] = {
        select: { name: params.assignee },
      };
    }

    if (params.priority && propMap['Priority']) {
      properties[propMap['Priority']] = {
        select: { name: params.priority },
      };
    }

    if (params.dueDate && propMap['Due Date']) {
      properties[propMap['Due Date']] = {
        date: { start: params.dueDate },
      };
    }

    if (params.labels && propMap['Labels']) {
      properties[propMap['Labels']] = {
        multi_select: params.labels.map((name) => ({ name })),
      };
    }

    if (params.type && propMap['Type']) {
      properties[propMap['Type']] = {
        select: { name: params.type },
      };
    }

    if (params.parentId && propMap['Parent']) {
      properties[propMap['Parent']] = {
        relation: [{ id: params.parentId }],
      };
    }

    await notion.pages.update({
      page_id: params.pageId,
      properties: properties as Parameters<typeof notion.pages.update>[0]['properties'],
    });

    logger.debug({ pageId: params.pageId }, 'Updated Notion task');
    return JSON.stringify({ success: true, pageId: params.pageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'updateTask failed');
    return JSON.stringify({ error: msg });
  }
}

export async function getProjectSummary(projectPageId: string): Promise<{
  title: string;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  totalTasks: number;
  doneCount: number;
  overdueCount: number;
  nextDueDate: string | null;
}> {
  const dsId = await getDataSourceId();
  const notion = getNotion();
  const { titleProp } = await ensureSchema();

  // Fetch the project page itself
  const projectPage = await notion.pages.retrieve({ page_id: projectPageId }) as PageObjectResponse;
  const projectData = extractPageData(projectPage, titleProp);

  // Fetch sub-items
  const response = await notion.dataSources.query({
    data_source_id: dsId,
    page_size: 100,
    filter: { property: 'Parent', relation: { contains: projectPageId } },
  });

  const subItems = response.results
    .filter((page): page is PageObjectResponse => page.object === 'page' && 'properties' in page)
    .map((page) => extractPageData(page, titleProp));

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const doneCount = subItems.filter((t) => t.status === 'Done').length;
  const overdueCount = subItems.filter(
    (t) => t.dueDate && t.dueDate < todayStr && t.status !== 'Done',
  ).length;

  const upcomingDueDates = subItems
    .filter((t) => t.dueDate && t.dueDate >= todayStr && t.status !== 'Done')
    .map((t) => t.dueDate!)
    .sort();

  return {
    title: projectData.title,
    status: projectData.status,
    priority: projectData.priority,
    dueDate: projectData.dueDate,
    totalTasks: subItems.length,
    doneCount,
    overdueCount,
    nextDueDate: upcomingDueDates[0] ?? null,
  };
}

export async function getOverdueTasks(assignee?: string): Promise<Array<{
  id: string;
  title: string;
  status: string | null;
  assignee: string | null;
  priority: string | null;
  dueDate: string;
  daysOverdue: number;
  type: string;
  url: string;
}>> {
  const dsId = await getDataSourceId();
  const notion = getNotion();
  const { titleProp } = await ensureSchema();

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

  const filters: PropertyFilter[] = [
    { property: 'Due Date', date: { before: todayStr } },
    { property: 'Status', select: { does_not_equal: 'Done' } },
  ];

  if (assignee) {
    filters.push({ property: 'Assignee', select: { equals: assignee } });
  }

  const response = await notion.dataSources.query({
    data_source_id: dsId,
    page_size: 50,
    filter: { and: filters },
  });

  const todayMs = new Date(todayStr).getTime();

  return response.results
    .filter((page): page is PageObjectResponse => page.object === 'page' && 'properties' in page)
    .map((page) => {
      const data = extractPageData(page, titleProp);
      const daysOverdue = Math.floor((todayMs - new Date(data.dueDate!).getTime()) / 86_400_000);
      return {
        id: data.id,
        title: data.title,
        status: data.status,
        assignee: data.assignee,
        priority: data.priority,
        dueDate: data.dueDate!,
        daysOverdue,
        type: data.type,
        url: data.url,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export async function addTaskComment(params: {
  pageId: string;
  comment: string;
}): Promise<string> {
  try {
    const notion = getNotion();

    const prefixedComment = `[Jasmin] ${params.comment}`;

    logger.debug(
      { pageId: params.pageId },
      'Adding comment to Notion task',
    );

    await notion.comments.create({
      parent: { page_id: params.pageId },
      rich_text: [
        {
          type: 'text',
          text: { content: prefixedComment },
        },
      ],
    });

    logger.debug({ pageId: params.pageId }, 'Added comment to Notion task');
    return JSON.stringify({ success: true, pageId: params.pageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'addTaskComment failed');
    return JSON.stringify({ error: msg });
  }
}

export async function searchNotion(params: {
  query: string;
  limit?: number;
}): Promise<string> {
  try {
    const limit = params.limit ?? 10;
    const notion = getNotion();

    logger.debug(
      { query: params.query, limit },
      'Searching Notion workspace',
    );

    const response = await notion.search({
      query: params.query,
      page_size: limit,
    });

    const results = response.results
      .filter((page): page is PageObjectResponse => page.object === 'page' && 'url' in page && 'properties' in page)
      .map((page) => {
        let title = '';
        const props = page.properties;
        // Try common title property names
        for (const key of ['Title', 'Name', 'title', 'name']) {
          const prop = props[key];
          if (prop && prop.type === 'title') {
            title = prop.title.map((t: { plain_text: string }) => t.plain_text).join('');
            break;
          }
        }

        return {
          id: page.id,
          title,
          url: page.url,
          type: page.object,
          createdTime: page.created_time,
          lastEditedTime: page.last_edited_time,
        };
      });

    logger.debug({ count: results.length }, 'Notion search completed');
    return JSON.stringify(results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'searchNotion failed');
    return JSON.stringify({ error: msg });
  }
}
