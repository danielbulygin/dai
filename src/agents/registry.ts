import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { z } from 'zod';
import { type ToolProfile } from './profiles/index.js';

// ---------------------------------------------------------------------------
// Path resolution - use cwd so it works both in dev (tsx) and prod (dist/)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const AGENTS_DIR = join(PROJECT_ROOT, 'agents');

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ManifestEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  display_name: z.string(),
  icon: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
});

const ManifestSchema = z.object({
  agents: z.array(ManifestEntrySchema),
});

const AgentConfigSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  model: z.string(),
  icon: z.string(),
  profile: z.enum(['readonly', 'standard', 'coding', 'full', 'assistant', 'media_buyer']) satisfies z.ZodType<ToolProfile>,
  max_turns: z.number().int().positive(),
  channels: z.array(z.string()),
  sub_agents: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface AgentDefinition {
  config: AgentConfig;
  manifest: ManifestEntry;
  persona: string;
  instructions: string;
  /** Additional .md files from the agent directory (e.g. METRICS.md, METHODOLOGY.md) */
  extras: { name: string; content: string }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readYaml<T>(filePath: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = yaml.load(raw);
  return schema.parse(parsed);
}

function readMarkdown(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  return content.trim();
}

/**
 * Load additional .md files from an agent directory (excluding PERSONA.md,
 * INSTRUCTIONS.md, and any .skill.md files which are handled separately).
 */
function loadExtras(agentDir: string): { name: string; content: string }[] {
  const SKIP = new Set(['PERSONA.md', 'INSTRUCTIONS.md']);
  const extras: { name: string; content: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(agentDir);
  } catch {
    return extras;
  }

  for (const file of entries) {
    if (!file.endsWith('.md') || file.endsWith('.skill.md') || SKIP.has(file)) {
      continue;
    }
    const content = readMarkdown(join(agentDir, file));
    if (content) {
      extras.push({ name: file, content });
    }
  }

  return extras;
}

// ---------------------------------------------------------------------------
// Registry singleton
// ---------------------------------------------------------------------------

let registry: Map<string, AgentDefinition> | undefined;

export function loadAgentRegistry(): Map<string, AgentDefinition> {
  if (registry) {
    return registry;
  }

  const manifestPath = join(AGENTS_DIR, '_manifest.yaml');
  const manifest = readYaml(manifestPath, ManifestSchema);

  const map = new Map<string, AgentDefinition>();

  for (const entry of manifest.agents) {
    const agentDir = join(AGENTS_DIR, entry.path);
    const config = readYaml(join(agentDir, 'agent.yaml'), AgentConfigSchema);
    const persona = readMarkdown(join(agentDir, 'PERSONA.md'));
    const instructions = readMarkdown(join(agentDir, 'INSTRUCTIONS.md'));
    const extras = loadExtras(agentDir);

    map.set(entry.id, { config, manifest: entry, persona, instructions, extras });
  }

  registry = map;
  return registry;
}

export function getAgent(id: string): AgentDefinition | undefined {
  const reg = loadAgentRegistry();
  return reg.get(id);
}

export function getDefaultAgent(): AgentDefinition {
  const reg = loadAgentRegistry();
  const otto = reg.get('otto');
  if (!otto) {
    throw new Error('Default agent "otto" not found in registry');
  }
  return otto;
}
