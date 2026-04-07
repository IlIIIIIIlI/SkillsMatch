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
  tagGeneratedAt?: string;
  tagModel?: string;
  tagPromptHash?: string;
  tagPromptStale?: boolean;
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

export interface OpenRouterModelSummary {
  id: string;
  name: string;
  contextLength?: number;
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
  openRouter: OpenRouterState;
  lightRag: LightRagState;
  onlineSources: OnlineSourcesState;
  recommendation: SkillRecommendationState;
  projectConfig: ProjectConfigState;
  selectedSkillId?: string;
  busy: boolean;
  statusMessage?: string;
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'configureOpenRouterKey' }
  | { type: 'openOpenRouterSettings' }
  | { type: 'refreshOpenRouterModels' }
  | { type: 'setOpenRouterModel'; model: string }
  | {
      type: 'updateTagGenerationConfig';
      config: {
        tagPrompt?: string;
        batchSize?: number;
        maxSkillsPerRun?: number;
        requestDelayMs?: number;
        autoGenerateTagsOnRefresh?: boolean;
      };
    }
  | { type: 'stopTagGeneration' }
  | { type: 'configureLightRagBaseUrl' }
  | { type: 'configureGitHubSources' }
  | { type: 'clearOpenRouterKey' }
  | { type: 'generateTags' }
  | { type: 'syncKnowledgeBase' }
  | { type: 'recommendSkills'; question: string }
  | { type: 'toggleRecommendedSkill'; skillId: string }
  | { type: 'applyRecommendedSkills' }
  | { type: 'setProjectWorkspace'; workspaceId?: string }
  | { type: 'setFilter'; filter: SkillFilter }
  | { type: 'clearFilter' }
  | { type: 'openSkill'; skillId: string }
  | { type: 'selectSkill'; skillId?: string };

export type ExtensionToWebviewMessage =
  | { type: 'state'; state: ViewState }
  | { type: 'toast'; level: 'info' | 'error'; message: string };

export interface OpenRouterState {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  availableModels: OpenRouterModelSummary[];
  modelsLoading: boolean;
  modelsUpdatedAt?: string;
  modelsError?: string;
  pendingTagCount: number;
  tagPrompt: string;
  tagBatchSize: number;
  tagMaxSkillsPerRun: number;
  tagRequestDelayMs: number;
  autoGenerateTagsOnRefresh: boolean;
  tagGeneration: TagGenerationState;
}

export interface TagGenerationState {
  running: boolean;
  stopping: boolean;
  completed: number;
  total: number;
  startedAt?: string;
  lastCompletedAt?: string;
  lastGeneratedCount?: number;
}

export interface LightRagState {
  baseUrl: string;
  workspace: string;
  ready: boolean;
  syncing: boolean;
  syncedAt?: string;
  statusMessage?: string;
}

export interface OnlineSourcesState {
  githubUrls: string[];
  lastError?: string;
}

export interface RecommendedSkill {
  skillId: string;
  reason: string;
  score: number;
}

export interface SkillRecommendationState {
  question: string;
  loading: boolean;
  source: 'lightrag+openrouter' | 'openrouter' | 'heuristic';
  summary?: string;
  statusMessage?: string;
  items: RecommendedSkill[];
  selectedSkillIds: string[];
}

export interface ProjectWorkspaceSummary {
  id: string;
  name: string;
  fsPath: string;
}

export interface ProjectConfigState {
  workspaces: ProjectWorkspaceSummary[];
  selectedWorkspaceId?: string;
  applyRelativePath: string;
  lastAppliedAt?: string;
  lastAppliedCount?: number;
}
