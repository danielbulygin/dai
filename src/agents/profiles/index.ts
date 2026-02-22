export const toolProfiles = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'],
  coding: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit'],
  full: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
} as const;

export type ToolProfile = keyof typeof toolProfiles;

export type ToolName = (typeof toolProfiles)[ToolProfile][number];
