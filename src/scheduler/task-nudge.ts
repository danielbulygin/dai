import { env } from '../env.js';
import { postMessage } from '../agents/tools/slack-tools.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { logger } from '../utils/logger.js';
import { registerJob } from './index.js';

// ---------------------------------------------------------------------------
// Mid-day nudge: remind Daniel about overdue / stale tasks (2pm weekdays)
// Only fires when there's something to surface — otherwise silent.
// ---------------------------------------------------------------------------

async function runNudge(): Promise<void> {
  try {
    const { getOverdueTasks, queryTasks } = await import('../agents/tools/notion-tools.js');

    // 1. Overdue tasks assigned to Daniel
    const overdue = await getOverdueTasks('Daniel');

    // 2. Stale "In Progress" tasks (created or last edited 3+ days ago)
    const rawInProgress = await queryTasks({ status: 'In Progress', assignee: 'Daniel' });
    const inProgressTasks = JSON.parse(rawInProgress);
    const threeDaysAgo = Date.now() - 3 * 86_400_000;

    const staleTasks = Array.isArray(inProgressTasks)
      ? inProgressTasks.filter((t: { lastEditedTime?: string; createdTime?: string }) => {
          const editedAt = t.lastEditedTime ? new Date(t.lastEditedTime).getTime() : 0;
          const createdAt = t.createdTime ? new Date(t.createdTime).getTime() : 0;
          const latest = Math.max(editedAt, createdAt);
          return latest > 0 && latest < threeDaysAgo;
        })
      : [];

    if (overdue.length === 0 && staleTasks.length === 0) {
      logger.debug('Nudge check: nothing overdue or stale — skipping');
      return;
    }

    // Build conversational message
    const parts: string[] = [];

    if (overdue.length > 0) {
      const taskWord = overdue.length === 1 ? 'task' : 'tasks';
      parts.push(`${overdue.length} overdue ${taskWord}`);
    }

    if (staleTasks.length > 0) {
      const itemWord = staleTasks.length === 1 ? 'item' : 'items';
      parts.push(`${staleTasks.length} ${itemWord} in progress for 3+ days`);
    }

    let message = `Hey, quick heads up — you have ${parts.join(' and ')}. Want to review?`;

    // Add brief details
    if (overdue.length > 0) {
      message += '\n\n*Overdue:*';
      for (const task of overdue.slice(0, 5)) {
        const priority = task.priority ? ` [${task.priority}]` : '';
        message += `\n• ${task.title}${priority} — ${task.daysOverdue}d overdue`;
      }
      if (overdue.length > 5) {
        message += `\n• ...and ${overdue.length - 5} more`;
      }
    }

    if (staleTasks.length > 0) {
      message += '\n\n*Stale (In Progress 3+ days):*';
      for (const task of staleTasks.slice(0, 5)) {
        const t = task as { title: string; priority?: string };
        const priority = t.priority ? ` [${t.priority}]` : '';
        message += `\n• ${t.title}${priority}`;
      }
      if (staleTasks.length > 5) {
        message += `\n• ...and ${staleTasks.length - 5} more`;
      }
    }

    // Send via Jasmin's bot
    try {
      await getDedicatedBotClient('jasmin').chat.postMessage({
        channel: env.SLACK_OWNER_USER_ID,
        text: message,
      });
    } catch {
      await postMessage({ channel: env.SLACK_OWNER_USER_ID, text: message });
    }

    logger.info(
      { overdue: overdue.length, stale: staleTasks.length },
      'Task nudge sent',
    );
  } catch (err) {
    logger.error({ err }, 'Task nudge failed');
  }
}

export function registerNudgeJobs(): void {
  registerJob(
    'task-nudge',
    '0 14 * * 1-5', // 2pm weekdays
    'Europe/Berlin',
    runNudge,
  );
}
