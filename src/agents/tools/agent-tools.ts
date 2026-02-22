import { logger } from "../../utils/logger.js";
import { getAgent } from "../registry.js";
import { runAgent } from "../runner.js";

const DELEGATION_CHANNEL = "internal-delegation";
const DELEGATION_USER = "system";

export async function askAgent(params: {
  agent_id: string;
  question: string;
  context?: string;
}): Promise<{ response: string; agent_id: string }> {
  const agent = getAgent(params.agent_id);

  if (!agent) {
    logger.warn(
      { agent_id: params.agent_id },
      "askAgent called for unknown agent",
    );
    return {
      response: `Agent "${params.agent_id}" not found in registry.`,
      agent_id: params.agent_id,
    };
  }

  const userMessage = params.context
    ? `Context: ${params.context}\n\nQuestion: ${params.question}`
    : params.question;

  logger.info(
    {
      agent_id: params.agent_id,
      question: params.question.slice(0, 100),
    },
    `askAgent delegating to ${agent.config.display_name}`,
  );

  const startMs = Date.now();

  try {
    const result = await runAgent({
      agentId: params.agent_id,
      userMessage,
      userId: DELEGATION_USER,
      channelId: DELEGATION_CHANNEL,
    });

    const elapsedMs = Date.now() - startMs;

    logger.info(
      {
        agent_id: params.agent_id,
        elapsedMs,
        responseLength: result.response.length,
      },
      `askAgent delegation to ${agent.config.display_name} completed in ${elapsedMs}ms`,
    );

    return {
      response: result.response,
      agent_id: params.agent_id,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;

    logger.error(
      { err, agent_id: params.agent_id, elapsedMs },
      `askAgent delegation to ${agent.config.display_name} failed after ${elapsedMs}ms`,
    );

    return {
      response: `Delegation to "${params.agent_id}" failed: ${err instanceof Error ? err.message : String(err)}`,
      agent_id: params.agent_id,
    };
  }
}

export async function delegateTo(params: {
  agent_id: string;
  task: string;
  context?: string;
}): Promise<{ result: string; agent_id: string }> {
  const agent = getAgent(params.agent_id);

  if (!agent) {
    logger.warn(
      { agent_id: params.agent_id },
      "delegateTo called for unknown agent",
    );
    return {
      result: `Agent "${params.agent_id}" not found in registry.`,
      agent_id: params.agent_id,
    };
  }

  const userMessage = params.context
    ? `Context: ${params.context}\n\nTask: ${params.task}`
    : `Task: ${params.task}`;

  logger.info(
    {
      agent_id: params.agent_id,
      task: params.task.slice(0, 100),
      hasContext: !!params.context,
    },
    `delegateTo delegating to ${agent.config.display_name}`,
  );

  const startMs = Date.now();

  try {
    const result = await runAgent({
      agentId: params.agent_id,
      userMessage,
      userId: DELEGATION_USER,
      channelId: DELEGATION_CHANNEL,
    });

    const elapsedMs = Date.now() - startMs;

    logger.info(
      {
        agent_id: params.agent_id,
        elapsedMs,
        responseLength: result.response.length,
      },
      `delegateTo delegation to ${agent.config.display_name} completed in ${elapsedMs}ms`,
    );

    return {
      result: result.response,
      agent_id: params.agent_id,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;

    logger.error(
      { err, agent_id: params.agent_id, elapsedMs },
      `delegateTo delegation to ${agent.config.display_name} failed after ${elapsedMs}ms`,
    );

    return {
      result: `Delegation to "${params.agent_id}" failed: ${err instanceof Error ? err.message : String(err)}`,
      agent_id: params.agent_id,
    };
  }
}
