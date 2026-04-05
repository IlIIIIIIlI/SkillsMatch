export type SkillScope = 'global' | 'workspace' | 'online';
export type SkillOrigin = 'local' | 'github';
export type SkillTagSource = 'ai' | 'heuristic' | 'none';

export interface SkillRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: SkillScope;
  origin: SkillOrigin;
  category: string;
  tags: string[];
  tagSource: SkillTagSource;
  sourceId: string;
  sourceLabel: string;
  location: string;
  manifestPath: string;
  repositoryUrl?: string;
  rawUrl?: string;
  workspaceFolderName?: string;
  relativePath?: string;
  lastSyncedAt: string;
}

export interface SkillInsight {
  category: string;
  tags: string[];
  source: 'ai' | 'heuristic';
  model?: string;
  generatedAt: string;
}

export interface SkillCounts {
  all: number;
  global: number;
  workspace: number;
  online: number;
  categories: number;
  sources: number;
}

export interface SkillCategorySummary {
  name: string;
  count: number;
}

export interface SkillSourceSummary {
  id: string;
  label: string;
  scope: SkillScope;
  count: number;
}

export interface SkillSnapshot {
  refreshedAt: string;
  keyConfigured: boolean;
  counts: SkillCounts;
  skills: SkillRecord[];
  categories: SkillCategorySummary[];
  sources: SkillSourceSummary[];
}

export interface SkillFilter {
  scope: 'all' | SkillScope;
  category?: string;
  sourceId?: string;
}

export interface TagGraphNode {
  id: string;
  label: string;
  count: number;
  category: string;
  skillIds: string[];
}

export interface TagGraphLink {
  source: string;
  target: string;
  overlap: number;
  weight: number;
}

export interface TagGraph {
  nodes: TagGraphNode[];
  links: TagGraphLink[];
}

export interface ViewState {
  snapshot: SkillSnapshot;
  filter: SkillFilter;
  visibleSkills: SkillRecord[];
  graph: TagGraph;
  selectedSkillId?: string;
  busy: boolean;
  statusMessage?: string;
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'configureOpenRouterKey' }
  | { type: 'clearOpenRouterKey' }
  | { type: 'generateTags' }
  | { type: 'setFilter'; filter: SkillFilter }
  | { type: 'clearFilter' }
  | { type: 'openSkill'; skillId: string }
  | { type: 'selectSkill'; skillId?: string };

export type ExtensionToWebviewMessage =
  | { type: 'state'; state: ViewState }
  | { type: 'toast'; level: 'info' | 'error'; message: string };
