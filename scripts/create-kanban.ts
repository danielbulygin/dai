/**
 * Create the DAI Task Board in Notion using the DAI integration's NOTION_TOKEN.
 * This ensures the integration has automatic access to the database.
 *
 * Usage: npx tsx scripts/create-kanban.ts
 *
 * Outputs the database ID to set as NOTION_KANBAN_DB_ID.
 */

import { Client } from '@notionhq/client';

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error('NOTION_TOKEN is not set');
  process.exit(1);
}

const notion = new Client({ auth: token });

async function main() {
  // Find a top-level page to use as parent, or create at workspace level
  // Internal integrations need a parent page — search for one we have access to
  const searchResult = await notion.search({
    filter: { property: 'object', value: 'page' },
    page_size: 1,
  });

  if (searchResult.results.length === 0) {
    console.error(
      'No pages accessible to this integration. Share at least one page with the integration first.',
    );
    process.exit(1);
  }

  const parentPage = searchResult.results[0];
  const parentId = parentPage.id;
  console.log(`Using parent page: ${parentId}`);

  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentId },
    title: [{ type: 'text', text: { content: 'DAI Task Board' } }],
    description: [
      {
        type: 'text',
        text: {
          content:
            'Personal task board managed by Jasmin and DAI agents. Used for Daniel\'s tasks, agent tasks, and cross-agent coordination.',
        },
      },
    ],
    properties: {
      Title: { title: {} },
      Status: {
        status: {
          options: [
            { name: 'To Do', color: 'default' },
            { name: 'In Progress', color: 'blue' },
            { name: 'Blocked', color: 'orange' },
            { name: 'Done', color: 'green' },
          ],
          groups: [
            { name: 'To do', option_ids: [] },
            { name: 'In progress', option_ids: [] },
            { name: 'Complete', option_ids: [] },
          ],
        },
      },
      Assignee: {
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
      Priority: {
        select: {
          options: [
            { name: 'Low', color: 'green' },
            { name: 'Medium', color: 'yellow' },
            { name: 'High', color: 'orange' },
            { name: 'Urgent', color: 'red' },
          ],
        },
      },
      'Due Date': { date: {} },
      Labels: {
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
  });

  console.log('\n✅ DAI Task Board created!');
  console.log(`Database ID: ${db.id}`);
  console.log(`URL: https://www.notion.so/${db.id.replace(/-/g, '')}`);
  console.log(`\nSet this in .env:\nNOTION_KANBAN_DB_ID=${db.id}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
