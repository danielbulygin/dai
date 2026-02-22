import { logger } from "../../utils/logger.js";
import { getAgent } from "../registry.js";

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

  logger.info(
    {
      agent_id: params.agent_id,
      question: params.question.slice(0, 100),
    },
    "askAgent request logged (stub)",
  );

  return {
    response:
      `Agent delegation will be processed by the orchestrator. ` +
      `Question for ${agent.config.display_name}: "${params.question}"`,
    agent_id: params.agent_id,
  };
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

  logger.info(
    {
      agent_id: params.agent_id,
      task: params.task.slice(0, 100),
      hasContext: !!params.context,
    },
    "delegateTo request logged (stub)",
  );

  return {
    result:
      `Agent delegation will be processed by the orchestrator. ` +
      `Task for ${agent.config.display_name}: "${params.task}"`,
    agent_id: params.agent_id,
  };
}
