export interface LocalSourcePattern {
  id: string;
  label: string;
  pattern: string;
}

export interface WorkspaceSourcePattern {
  id: string;
  label: string;
  relativePath: string;
}

export interface GitHubSkillSourceDescriptor {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch?: string;
  type: 'official' | 'community' | 'configured';
  strategy: 'tree' | 'contents' | 'direct';
  includePrefixes: string[];
  directManifestPath?: string;
  sourceUrl?: string;
  singleSkillFallback?: {
    title: string;
    readmePath: string;
    description: string;
  };
}

export const GLOBAL_SOURCE_PATTERNS: LocalSourcePattern[] = [
  {
    id: 'claude-global',
    label: 'Claude Global',
    pattern: '~/.claude/skills'
  },
  {
    id: 'claude-marketplaces',
    label: 'Claude Plugins Marketplace',
    pattern: '~/.claude/plugins/marketplaces/*/plugins/*/skills'
  },
  {
    id: 'copilot-global',
    label: 'Copilot Global',
    pattern: '~/.copilot/skills'
  },
  {
    id: 'cursor-global',
    label: 'Cursor Global',
    pattern: '~/.cursor/skills'
  },
  {
    id: 'gemini-global',
    label: 'Gemini Global',
    pattern: '~/.gemini/antigravity/skills'
  },
  {
    id: 'opencode-global',
    label: 'OpenCode Global',
    pattern: '~/.config/opencode/skill'
  },
  {
    id: 'codex-global',
    label: 'Codex Global',
    pattern: '~/.codex/skills'
  },
  {
    id: 'codex-system',
    label: 'Codex System',
    pattern: '/etc/codex/skills'
  }
];

export const WORKSPACE_SOURCE_PATTERNS: WorkspaceSourcePattern[] = [
  {
    id: 'workspace-claude',
    label: 'Claude Workspace',
    relativePath: '.claude/skills'
  },
  {
    id: 'workspace-github',
    label: 'GitHub Workspace',
    relativePath: '.github/skills'
  },
  {
    id: 'workspace-cursor',
    label: 'Cursor Workspace',
    relativePath: '.cursor/skills'
  },
  {
    id: 'workspace-agent',
    label: 'Agent Workspace',
    relativePath: '.agent/skills'
  },
  {
    id: 'workspace-opencode',
    label: 'OpenCode Workspace',
    relativePath: '.opencode/skill'
  },
  {
    id: 'workspace-codex',
    label: 'Codex Workspace',
    relativePath: '.codex/skills'
  }
];

export const OPENROUTER_SECRET_KEY = 'skillMap.openRouter.apiKey';
export const ONLINE_CACHE_KEY = 'skillMap.onlineCache';
export const AI_CACHE_KEY = 'skillMap.aiCache';
export const LIGHTRAG_SYNC_CACHE_KEY = 'skillMap.lightRagSyncCache';

export const ALLOWED_CATEGORIES = [
  'Development',
  'Testing',
  'Design',
  'Documentation',
  'DevOps',
  'Data',
  'AI/ML',
  'Security',
  'Productivity',
  'Research',
  'Operations',
  'Other'
] as const;
