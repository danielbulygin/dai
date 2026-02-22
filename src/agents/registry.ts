import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { z } from 'zod';
import { type ToolProfile } from './profiles/index.js';

// ---------------------------------------------------------------------------
// Path resolution - resolve relative to project root via import.meta.url
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
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
  profile: z.enum(['readonly', 'standard', 'coding', 'full']) satisfies z.ZodType<ToolProfile>,
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

    map.set(entry.id, { config, manifest: entry, persona, instructions });
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
