import { type PageObjectResponse } from '@notionhq/client';
import { getNotion } from '../../integrations/notion.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

type StatusFilter = { property: string; status: { equals: string }; type?: 'status' };
type SelectFilter = { property: string; select: { equals: string }; type?: 'select' };
type PropertyFilter = StatusFilter | SelectFilter;

function getKanbanDbId(): string {
  const dbId = env.NOTION_KANBAN_DB_ID;
  if (!dbId) {
    throw new Error(
      'NOTION_KANBAN_DB_ID is not set. Configure it in .env to use task management.',
    );
  }
  return dbId;
}

function extractPageData(page: PageObjectResponse) {
  const props = page.properties;

  const titleProp = props['Title'];
  const title =
    titleProp && titleProp.type === 'title'
      ? titleProp.title.map((t: { plain_text: string }) => t.plain_text).join('')
      : '';

  const statusProp = props['Status'];
  const status =
    statusProp && statusProp.type === 'status'
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

    logger.debug(
      { status: params.status, assignee: params.assignee, priority: params.priority, limit },
      'Querying Notion tasks',
    );

    const filters: PropertyFilter[] = [];

    if (params.status) {
      filters.push({ property: 'Status', status: { equals: params.status } });
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

    const response = await notion.dataSources.query({
      data_source_id: dbId,
      page_size: limit,
      ...(filter ? { filter } : {}),
    });

    const tasks = response.results
      .filter((page): page is PageObjectResponse => page.object === 'page' && 'properties' in page)
      .map(extractPageData);

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

    logger.debug(
      { title: params.title, status: params.status, assignee: params.assignee },
      'Creating Notion task',
    );

    const properties: Record<string, unknown> = {
      Title: {
        title: [{ text: { content: params.title } }],
      },
      Status: {
        status: { name: params.status ?? 'To Do' },
      },
      Priority: {
        select: { name: params.priority ?? 'Medium' },
      },
    };

    if (params.assignee) {
      properties['Assignee'] = {
        select: { name: params.assignee },
      };
    }

    if (params.dueDate) {
      properties['Due Date'] = {
        date: { start: params.dueDate },
      };
    }

    if (params.labels && params.labels.length > 0) {
      properties['Labels'] = {
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

    logger.debug(
      { pageId: params.pageId, status: params.status },
      'Updating Notion task',
    );

    const properties: Record<string, unknown> = {};

    if (params.status) {
      properties['Status'] = {
        status: { name: params.status },
      };
    }

    if (params.assignee) {
      properties['Assignee'] = {
        select: { name: params.assignee },
      };
    }

    if (params.priority) {
      properties['Priority'] = {
        select: { name: params.priority },
      };
    }

    if (params.dueDate) {
      properties['Due Date'] = {
        date: { start: params.dueDate },
      };
    }

    if (params.labels) {
      properties['Labels'] = {
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
