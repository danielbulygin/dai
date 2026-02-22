import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const AGENTS_DIR = join(PROJECT_ROOT, "agents");
const SHARED_SKILLS_DIR = join(AGENTS_DIR, "_skills");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  tags: string[];
  content: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single skill from a .skill.md file.
 * Parses YAML frontmatter (name, description, tags) and extracts the
 * markdown body as content.
 */
export function loadSkill(filePath: string): Skill {
  const raw = readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  const frontmatter = data as Record<string, unknown>;

  const name = typeof frontmatter["name"] === "string"
    ? frontmatter["name"]
    : "";

  const description = typeof frontmatter["description"] === "string"
    ? frontmatter["description"]
    : "";

  const rawTags = Array.isArray(frontmatter["tags"])
    ? frontmatter["tags"]
    : [];
  const tags = rawTags.filter((t): t is string => typeof t === "string");

  logger.debug({ filePath, name }, "Loaded skill");

  return {
    name,
    description,
    tags,
    content: content.trim(),
  };
}

/**
 * Load all skills applicable to an agent:
 * 1. Agent-specific skills from agents/<agentId>/*.skill.md
 * 2. Shared skills from agents/_skills/*.skill.md
 *
 * Returns the combined list (agent-specific first, then shared).
 */
export function loadSkillsForAgent(agentId: string): Skill[] {
  const skills: Skill[] = [];

  // Agent-specific skills
  const agentDir = join(AGENTS_DIR, agentId);
  if (existsSync(agentDir)) {
    const agentSkills = loadSkillsFromDir(agentDir);
    skills.push(...agentSkills);
  }

  // Shared skills
  if (existsSync(SHARED_SKILLS_DIR)) {
    const sharedSkills = loadSkillsFromDir(SHARED_SKILLS_DIR);
    skills.push(...sharedSkills);
  }

  logger.debug(
    { agentId, count: skills.length },
    "Loaded skills for agent",
  );

  return skills;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadSkillsFromDir(dir: string): Skill[] {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    logger.warn({ dir }, "Could not read skills directory");
    return skills;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".skill.md")) {
      continue;
    }

    const filePath = join(dir, entry);
    try {
      const skill = loadSkill(filePath);
      skills.push(skill);
    } catch (error) {
      logger.warn(
        { error, filePath },
        "Failed to load skill file, skipping",
      );
    }
  }

  return skills;
}
