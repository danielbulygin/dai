import { type PageObjectResponse } from '@notionhq/client';
import { getNotion } from '../../integrations/notion.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

type SelectFilter = { property: string; select: { equals: string } };
type PropertyFilter = SelectFilter;

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
};

// Cache: maps logical field name -> actual property name in the database
let schemaMap: Record<string, string> | null = null;
let titlePropName: string | null = null;

/**
 * Fetch the database schema, build a map from logical names to actual property names,
 * and auto-create any missing properties.
 */
async function ensureSchema(): Promise<{ titleProp: string; propMap: Record<string, string> }> {
  if (schemaMap && titlePropName) {
    return { titleProp: titlePropName, propMap: schemaMap };
  }

  const dbId = getKanbanDbId();
  const notion = getNotion();

  const db = await notion.databases.retrieve({ database_id: dbId });
  const existingProps = 'properties' in db ? db.properties : {};

  // Find the title property (whatever it's called)
  let foundTitle = 'Name';
  for (const [name, prop] of Object.entries(existingProps)) {
    if ((prop as { type: string }).type === 'title') {
      foundTitle = name;
      break;
    }
  }

  // Build map of existing properties by type
  const existingByName = new Map<string, string>();
  for (const [name, prop] of Object.entries(existingProps)) {
    existingByName.set(name, (prop as { type: string }).type);
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

  // Create missing properties in one API call
  if (Object.keys(propsToCreate).length > 0) {
    logger.info(
      { properties: Object.keys(propsToCreate) },
      'Auto-creating missing Notion database properties',
    );
    try {
      await notion.databases.update({
        database_id: dbId,
        properties: propsToCreate as Parameters<typeof notion.databases.update>[0]['properties'],
      });

      // Re-fetch schema after creation to confirm properties exist
      const dbAfter = await notion.databases.retrieve({ database_id: dbId });
      const propsAfter = 'properties' in dbAfter ? dbAfter.properties : {};
      for (const [name, prop] of Object.entries(propsAfter)) {
        const propType = (prop as { type: string }).type;
        if (propType !== 'title') {
          map[name] = name;
        }
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to auto-create Notion properties');
    }
  } else {
    // All required properties exist (except possibly Status)
    // map was already populated above
  }

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

  return {
    id: page.id,
    title,
    status,
    assignee,
    priority,
    dueDate,
    labels,
    createdTime: page.created_time,
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
  limit?: number;
}): Promise<string> {
  try {
    const limit = params.limit ?? 20;
    const dbId = getKanbanDbId();
    const notion = getNotion();
    const { titleProp } = await ensureSchema();

    logger.debug(
      { status: params.status, assignee: params.assignee, priority: params.priority, limit },
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

    let filter: PropertyFilter | { and: PropertyFilter[] } | undefined;
    if (filters.length === 1) {
      filter = filters[0];
    } else if (filters.length > 1) {
      filter = { and: filters };
    }

    const response = await notion.databases.query({
      database_id: dbId,
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
}): Promise<string> {
  try {
    const dbId = getKanbanDbId();
    const notion = getNotion();
    const { titleProp, propMap } = await ensureSchema();

    logger.debug(
      { title: params.title, status: params.status, assignee: params.assignee },
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
      parent: { database_id: dbId },
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
