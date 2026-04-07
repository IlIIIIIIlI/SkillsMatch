import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force';
import * as THREE from 'three';

import { applyCategoryFilter, applyScopeFilter } from '../shared/filterState';
import type { ExtensionToWebviewMessage, SkillFilter, SkillRecord, ViewState, WebviewToExtensionMessage } from '../shared/types';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  setState(value: unknown): void;
  getState(): unknown;
};

interface SkillGraphNodeBase {
  id: string;
  name: string;
  category: string;
  tagCount: number;
}

type SkillNode2D = SkillGraphNodeBase & SimulationNodeDatum & {
  radius: number;
  vx?: number;
  vy?: number;
};

interface SkillLink {
  sourceId: string;
  targetId: string;
  sharedTags: number;
  weight: number;
}

type GraphLink2D = SkillLink & SimulationLinkDatum<SkillNode2D>;

interface SkillNode3D extends SkillGraphNodeBase {
  radius: number;
}

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById('app');
if (!rootElement) throw new Error('SkillMatch webview root was not found.');
const app = rootElement as HTMLDivElement;

const bootState = (() => {
  const raw = app.getAttribute('data-state');
  if (!raw) return undefined;
  try { return JSON.parse(raw) as ViewState; } catch { return undefined; }
})();

const isDashboard = app.getAttribute('data-dashboard') === 'true';
const graphPrefs = readGraphPrefs();
const layoutPrefs = readLayoutPrefs();

let state = (vscode.getState() as ViewState | undefined) ?? bootState;
let searchText = '';
let searchDraft = '';
let questionDraft = '';
let selectedTag: string | undefined;
let focusedNodeId: string | undefined; // 2D/3D: skill id
let expandedSkillId: string | undefined;
let skillSearchTimer: number | undefined;
let graphMode: '2d' | '3d' = '2d';
let settingsOpen = false;
let showSelectedOnly = false;
let searchIsComposing = false;
let questionIsComposing = false;
let graphPaneRatio = 0.58;
let dashboardTopHeightPx: number | undefined;
let pendingSelectionEchoKey: string | null = null;
let svgZoomScale = 1;
let graphMinSharedTags = 1;
let graphSpreadScale = 1.32;
let graphColorMode: 'category' | 'overlap' = graphPrefs.colorMode ?? 'category';
let graphCategoryColors: Record<string, string> = graphPrefs.categoryColors ?? {};
let hoveredNodeId: string | undefined;
let hoverPointer: { x: number; y: number } | undefined;
let topPanelsCollapsed = layoutPrefs.topPanelsCollapsed ?? false;
let tagPromptDraft: string | undefined;
let tagBatchSizeDraft: number | undefined;
let tagMaxSkillsDraft: number | undefined;
let tagDelayDraft: number | undefined;
let tagAutoDraft: boolean | undefined;

interface SplitterDragState {
  type: 'horizontal' | 'vertical';
  startX: number;
  startY: number;
  startValue: number;
  containerSize: number;
}

let activeSplitterDrag: SplitterDragState | undefined;

// Live D3 simulation state
let simulation: ReturnType<typeof forceSimulation<SkillNode2D>> | null = null;
let liveNodes: SkillNode2D[] = [];
let liveLinks: GraphLink2D[] = [];
let dragNode: SkillNode2D | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let svgMouseDownNode: SkillNode2D | null = null;
let svgMouseDownPos: { x: number; y: number } | null = null;
let svgWidth = 0;
let svgHeight = 0;
// Three.js sphere state
let threeRenderer: THREE.WebGLRenderer | null = null;
let threeScene: THREE.Scene | null = null;
let threeCamera: THREE.PerspectiveCamera | null = null;
let threeAnimFrame: number | null = null;
let threeNodeMeshes: Array<{ mesh: THREE.Mesh; skillId: string }> = [];
let applyThreeFocus: ((focusId?: string) => void) | null = null;
let threeResizeObserver: ResizeObserver | null = null;
let sphereIsDragging = false;
let sphereDragStart = { x: 0, y: 0 };
let sphereRotation = { x: 0.3, y: 0 };
let sphereAutoRotate = true;

// Skill-based 3D graph data (rebuilt alongside liveNodes/liveLinks)
let liveSkillNodes: SkillNode3D[] = [];
let liveSkillLinks: SkillLink[] = [];
let liveSkillPositions3D = new Map<string, THREE.Vector3>();

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'state') {
    const previousState = state;
    if (!questionDraft && message.state.recommendation.question) {
      questionDraft = message.state.recommendation.question;
    }
    if (
      previousState &&
      (
        previousState.filter.scope !== message.state.filter.scope ||
        previousState.filter.category !== message.state.filter.category ||
        previousState.filter.sourceId !== message.state.filter.sourceId
      )
    ) {
      selectedTag = undefined;
      focusedNodeId = undefined;
    }
    state = message.state;
    syncTagGenerationDraftsFromState(message.state);
    vscode.setState(state);
    if (isSelectionEchoState(previousState, message.state)) {
      pendingSelectionEchoKey = null;
      refreshGraphFocusVisibility();
      updateSkillListOnly();
      return;
    }
    pendingSelectionEchoKey = null;
    rebuildGraph();
    render();
  }
});

vscode.postMessage({ type: 'ready' });
if (state) {
  syncTagGenerationDraftsFromState(state);
}
rebuildGraph();
render();

// ── Render ──────────────────────────────────────────────────────────────────

function render(): void {
  const s = state;
  if (!s) {
    app.innerHTML = '<div style="padding:24px;opacity:0.6;font-size:12px;">Waiting for SkillMatch…</div>';
    return;
  }

  const focusedInput = captureFocusedInput();
  const selectedSkillIds = new Set(s.recommendation.selectedSkillIds);
  const visibleSkills = getDisplaySkills(s);
  const graphStats = buildSkillOverlapGraph(getBaseVisibleSkills(s));
  const graphMaxSharedTags = Math.max(1, graphStats.maxSharedTags);
  graphMinSharedTags = clamp(graphMinSharedTags, 1, graphMaxSharedTags);
  const currentOpenRouterModel = s.openRouter.availableModels.find((model) => model.id === s.openRouter.model);
  const openRouterModelTitle = currentOpenRouterModel?.name ?? s.openRouter.model;
  const tagGeneration = s.openRouter.tagGeneration;
  const tagGenerationStatus = tagGeneration.running
    ? `${tagGeneration.stopping ? 'Stopping' : 'Generating'} ${tagGeneration.completed}/${tagGeneration.total}`
    : s.openRouter.pendingTagCount > 0
      ? `${s.openRouter.pendingTagCount} skills pending`
      : 'No pending skills';
  const tagPromptValue = tagPromptDraft ?? s.openRouter.tagPrompt;
  const tagBatchSizeValue = tagBatchSizeDraft ?? s.openRouter.tagBatchSize;
  const tagMaxSkillsValue = tagMaxSkillsDraft ?? s.openRouter.tagMaxSkillsPerRun;
  const tagDelayValue = tagDelayDraft ?? s.openRouter.tagRequestDelayMs;
  const tagAutoValue = tagAutoDraft ?? s.openRouter.autoGenerateTagsOnRefresh;
  const openRouterModelOptionsHtml = s.openRouter.availableModels
    .map((model) => {
      const labelParts = [model.name];
      if (model.contextLength) labelParts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
      return `<option value="${escapeAttribute(model.id)}" ${model.id === s.openRouter.model ? 'selected' : ''}>${escapeHtml(labelParts.join(' · '))}</option>`;
    })
    .join('');
  const selectedSkill =
    visibleSkills.find((sk) => sk.id === s.selectedSkillId) ??
    s.snapshot.skills.find((sk) => sk.id === s.selectedSkillId) ??
    visibleSkills[0] ??
    s.visibleSkills[0];

  const counts = s.snapshot.counts;
  const selectedWorkspaceId = s.projectConfig.selectedWorkspaceId;
  const selectedRecommendationCount = s.recommendation.selectedSkillIds.length;
  const selectedSkillStripHtml = selectedRecommendationCount === 0
    ? '<span class="muted-copy">No skills selected yet.</span>'
    : s.recommendation.selectedSkillIds
        .map((skillId) => s.snapshot.skills.find((candidate) => candidate.id === skillId))
        .filter((skill): skill is SkillRecord => Boolean(skill))
        .map((skill) => `
          <button class="selected-skill-pill" data-action="toggle-skill" data-skill-id="${skill.id}">
            ${escapeHtml(skill.name)}
          </button>
        `)
        .join('');
  const workspaceOptionsHtml = s.projectConfig.workspaces.length === 0
    ? '<option value="">Open a workspace to apply skills</option>'
    : s.projectConfig.workspaces.map((workspace) => `
        <option value="${escapeAttribute(workspace.id)}" ${workspace.id === selectedWorkspaceId ? 'selected' : ''}>
          ${escapeHtml(workspace.name)}
        </option>
      `).join('');
  const githubUrlsHtml = s.onlineSources.githubUrls.length === 0
    ? '<span class="muted-copy">No GitHub links configured yet.</span>'
    : s.onlineSources.githubUrls
        .slice(0, 3)
        .map((url) => `<span class="pill source-link" title="${escapeAttribute(url)}">${escapeHtml(truncateMiddle(url, 44))}</span>`)
        .join('');
  const recommendationCardsHtml = s.recommendation.items.length === 0
    ? '<div class="empty compact">Ask a question to rank the best skills for the current task.</div>'
    : s.recommendation.items.map((item) => {
        const skill = s.snapshot.skills.find((candidate) => candidate.id === item.skillId);
        if (!skill) {
          return '';
        }

        const selected = s.recommendation.selectedSkillIds.includes(skill.id);
        const tags = skill.tags.slice(0, 2).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join('');
        return `<article class="recommend-card ${selected ? 'selected' : ''}">
  <div class="recommend-top">
    <button class="mini-toggle ${selected ? 'selected' : ''}" data-action="toggle-recommended-skill" data-skill-id="${skill.id}">
      ${selected ? 'Selected' : 'Select'}
    </button>
    <span class="recommend-score">${item.score}</span>
  </div>
  <button class="recommend-name" data-action="toggle-skill" data-skill-id="${skill.id}">${escapeHtml(skill.name)}</button>
  <p class="recommend-reason">${escapeHtml(item.reason)}</p>
  <div class="meta-row">
    <span class="pill">${escapeHtml(skill.scope)}</span>
    <span class="pill">${escapeHtml(skill.category)}</span>
    ${tags}
  </div>
</article>`;
      }).join('');

  // Scope tabs
  const scopeTabsHtml = (['all', 'workspace', 'global', 'online'] as const)
    .map((sc) => {
      const count = sc === 'all' ? counts.all : counts[sc];
      const active = s.filter.scope === sc;
      return `<button class="scope-tab ${active ? 'active' : ''}" data-action="scope" data-scope="${sc}">
        ${sc.charAt(0).toUpperCase() + sc.slice(1)}<span class="count">${count}</span>
      </button>`;
    })
    .join('');

  // Category strip
  const catHtml = s.snapshot.categories
    .map((cat) => {
      const active = s.filter.category === cat.name;
      const chipColor = resolvedCategoryColor(cat.name);
      return `<span class="cat-chip-group">
      <button class="cat-chip ${active ? 'active' : ''}" data-action="category" data-category="${escapeAttribute(cat.name)}">
        ${escapeHtml(cat.name)}<span class="cnt">${cat.count}</span>
      </button>
      <input
        class="cat-color-input"
        type="color"
        value="${escapeAttribute(chipColor)}"
        data-category-color="${escapeAttribute(cat.name)}"
        title="Set graph color for ${escapeAttribute(cat.name)}"
      />
    </span>`;
    })
    .join('');

  // Skill cards — inline expanded detail, no bottom drawer
  const skillCardsHtml = visibleSkills.length === 0
    ? `<div class="empty">${showSelectedOnly ? 'No selected skills match the current filters.' : 'No skills match the current filters.'}</div>`
    : visibleSkills.map((skill) => {
        const isActive = skill.id === selectedSkill?.id;
        const isExpanded = skill.id === expandedSkillId;
        const isSelected = selectedSkillIds.has(skill.id);
        const tags = skill.tags.slice(0, 3).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('');

        const expandedHtml = isExpanded ? `
<div class="card-detail">
  <div class="card-detail-actions">
    <button class="btn primary" data-action="open-skill" data-skill-id="${skill.id}">Open file</button>
    <button class="btn ${isSelected ? 'selected-inline' : ''}" data-action="toggle-recommended-skill" data-skill-id="${skill.id}">
      ${isSelected ? 'Selected for Project' : 'Select for Project'}
    </button>
    ${selectedTag ? `<button class="btn" data-action="select-tag-clear">Clear tag filter</button>` : ''}
  </div>
  <div class="tag-grid">
    ${skill.tags.map((t) => `<button class="tag ${selectedTag === t ? 'active-tag' : ''}" data-action="select-tag" data-tag="${escapeAttribute(t)}">${escapeHtml(t)}</button>`).join('')}
  </div>
  <div class="card-meta-full">
    ${buildSkillTagMetaHtml(skill)}
  </div>
</div>` : '';

        return `<article class="skill-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''} ${isSelected ? 'selected-card' : ''}" data-action="toggle-skill" data-skill-id="${skill.id}">
  <div class="card-row">
    <div class="card-main">
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(skill.description)}</p>
    </div>
    <div class="card-pills">
      <button class="mini-toggle ${isSelected ? 'selected' : ''}" data-action="toggle-recommended-skill" data-skill-id="${skill.id}">
        ${isSelected ? 'Selected' : 'Select'}
      </button>
      <span class="pill">${escapeHtml(skill.scope)}</span>
      <span class="pill">${escapeHtml(skill.category)}</span>
      ${tags}
    </div>
  </div>
  ${expandedHtml}
</article>`;
      }).join('');

  const tagFilterBadge = selectedTag
    ? `<span class="cat-chip active" style="cursor:pointer;" data-action="select-tag-clear">tag: ${escapeHtml(selectedTag)} ×</span>`
    : '';
  const colorLegendLabel = graphColorMode === 'category'
    ? 'Color = category'
    : 'Color = overlap count';
  const hasCustomCategoryColors = Object.keys(graphCategoryColors).length > 0;
  const topPanelsToggleLabel = topPanelsCollapsed ? 'Show Top' : 'Hide Top';

  app.innerHTML = `
<nav class="topbar">
  <span class="topbar-title">${isDashboard ? 'SkillMatch Dashboard' : 'SkillMatch'}</span>
  <div class="scope-tabs">${scopeTabsHtml}</div>
  <div class="topbar-sep"></div>
  <input id="skill-search" class="topbar-search" type="search" placeholder="Search skills…" value="${escapeAttribute(searchDraft)}" />
  <div class="topbar-sep"></div>
  <div class="status-dot ${s.busy ? 'busy' : ''}"></div>
  <span class="status-text">${escapeHtml(s.statusMessage ?? 'Ready')}</span>
  <button class="icon-btn" data-action="toggle-top-panels" title="${topPanelsCollapsed ? 'Show setup panels' : 'Hide setup panels'}">${topPanelsCollapsed ? '▾' : '▴'} ${topPanelsToggleLabel}</button>
  <div class="settings-wrap">
    <button class="icon-btn" data-action="toggle-settings" title="Settings">⚙</button>
    <div class="settings-popover ${settingsOpen ? 'open' : ''}">
      <button class="btn" data-action="refresh">${s.busy ? 'Refreshing…' : 'Refresh'}</button>
      <button class="btn" data-action="generate-tags" ${tagGeneration.running ? 'disabled' : ''}>${tagGeneration.running ? 'Generating…' : 'Generate AI Tags'}</button>
      ${tagGeneration.running ? `<button class="btn" data-action="stop-tag-generation">${tagGeneration.stopping ? 'Stopping…' : 'Stop Tag Generation'}</button>` : ''}
      <button class="btn" data-action="configure-key">${s.snapshot.keyConfigured ? 'Rotate OpenRouter Key' : 'Configure OpenRouter Key'}</button>
      ${s.snapshot.keyConfigured ? '<button class="btn" data-action="clear-key">Clear Key</button>' : ''}
      <button class="btn" data-action="clear-filter">Clear All Filters</button>
    </div>
  </div>
</nav>

<div
  class="dashboard-layout ${isDashboard ? 'is-dashboard' : ''}"
  style="${isDashboard ? `${dashboardTopHeightPx ? `--dashboard-top-height:${dashboardTopHeightPx}px;` : ''} --graph-pane-width:${(graphPaneRatio * 100).toFixed(1)}%;` : ''}"
>
<div class="above-fold" id="above-fold" style="${topPanelsCollapsed ? 'display:none;' : ''}">
<section class="control-deck">
  <article class="setup-card setup-card-emphasis">
    <div class="setup-kicker">OpenRouter</div>
    <h2>${escapeHtml(openRouterModelTitle)}</h2>
    <p>${escapeHtml(
      s.openRouter.keyConfigured
        ? 'Ready for AI tag generation and skill recommendation.'
        : 'Configure the OpenRouter key to enable AI ranking and enriched tags.'
    )}</p>
    <label class="setup-field">
      <span class="setup-field-label">Model for tags / ranking</span>
      <select
        id="openrouter-model-select"
        class="setup-select"
        ${s.openRouter.modelsLoading ? 'disabled' : ''}
      >
        ${openRouterModelOptionsHtml}
      </select>
    </label>
    <div class="tag-config-grid">
      <label class="setup-field">
        <span class="setup-field-label">Batch size</span>
        <input id="tag-batch-size" class="setup-input" type="number" min="1" max="25" value="${tagBatchSizeValue}" />
      </label>
      <label class="setup-field">
        <span class="setup-field-label">Max skills / run</span>
        <input id="tag-max-skills" class="setup-input" type="number" min="1" max="500" value="${tagMaxSkillsValue}" />
      </label>
      <label class="setup-field">
        <span class="setup-field-label">Delay between batches (ms)</span>
        <input id="tag-request-delay" class="setup-input" type="number" min="0" max="10000" step="50" value="${tagDelayValue}" />
      </label>
      <label class="setup-field setup-field-checkbox">
        <span class="setup-field-label">Auto generate on refresh</span>
        <input id="tag-auto-generate" type="checkbox" ${tagAutoValue ? 'checked' : ''} />
      </label>
    </div>
    <label class="setup-field">
      <span class="setup-field-label">Tag generation prompt additions</span>
      <textarea
        id="tag-prompt"
        class="setup-textarea"
        placeholder="Example: Prioritize implementation details, tool names, frameworks, and avoid generic tags."
      >${escapeHtml(tagPromptValue)}</textarea>
    </label>
    <div class="setup-meta-row">
      <span class="pill">${escapeHtml(tagGenerationStatus)}</span>
      ${tagGeneration.lastCompletedAt ? `<span class="pill">Last run ${escapeHtml(formatDateTime(tagGeneration.lastCompletedAt))}</span>` : ''}
      <span class="pill">${s.openRouter.pendingTagCount} pending</span>
    </div>
    <div class="setup-actions">
      <button class="btn primary" data-action="configure-key">${s.openRouter.keyConfigured ? 'Rotate Key' : 'Configure Key'}</button>
      <button class="btn" data-action="refresh-openrouter-models">${s.openRouter.modelsLoading ? 'Loading Models…' : 'Refresh Models'}</button>
      <button class="btn" data-action="save-tag-config">Save Tag Settings</button>
      <button class="btn" data-action="generate-tags" ${tagGeneration.running ? 'disabled' : ''}>${tagGeneration.running ? 'Generating…' : 'Generate Pending Tags'}</button>
      ${tagGeneration.running ? `<button class="btn" data-action="stop-tag-generation">${tagGeneration.stopping ? 'Stopping…' : 'Stop'}</button>` : ''}
    </div>
    <div class="setup-foot">
      ${escapeHtml(truncateMiddle(s.openRouter.baseUrl, 48))}
      ${s.openRouter.modelsError
        ? ` · model list unavailable: ${escapeHtml(truncate(s.openRouter.modelsError, 84))}`
        : s.openRouter.modelsUpdatedAt
          ? ` · ${s.openRouter.availableModels.length} models loaded`
          : ''}
      ${tagPromptValue.trim() ? ' · custom prompt active' : ''}
    </div>
  </article>

  <article class="setup-card">
    <div class="setup-kicker">LightRAG</div>
    <h2>${escapeHtml(truncateMiddle(s.lightRag.baseUrl, 34))}</h2>
    <p>${escapeHtml(s.lightRag.statusMessage ?? 'Build a searchable skills knowledge base for recommendation.')}</p>
    <div class="setup-actions">
      <button class="btn" data-action="configure-lightrag">Configure URL</button>
      <button class="btn" data-action="sync-kb">${s.lightRag.syncing ? 'Syncing…' : 'Sync KB'}</button>
    </div>
    <div class="setup-foot">${escapeHtml(s.lightRag.ready ? `Workspace ${s.lightRag.workspace}` : 'Waiting for first successful sync')}</div>
  </article>

  <article class="setup-card">
    <div class="setup-kicker">GitHub Sources</div>
    <h2>${s.onlineSources.githubUrls.length} configured</h2>
    <p>${escapeHtml(s.onlineSources.lastError ?? 'Add repo or folder links to bring external skills into the catalog.')}</p>
    <div class="setup-actions">
      <button class="btn" data-action="configure-github-sources">Configure Links</button>
      <button class="btn" data-action="refresh">${s.busy ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    <div class="setup-links">${githubUrlsHtml}</div>
  </article>
</section>

<section class="recommend-panel">
  <div class="recommend-head">
    <div>
      <span class="pane-title">Skill Match</span>
      <p class="recommend-copy">Ask in natural language. SkillMatch queries LightRAG, then uses your OpenRouter model to rank the best skills.</p>
    </div>
    <span class="pill">${escapeHtml(s.recommendation.source)}</span>
  </div>
  <div class="recommend-controls">
    <input
      id="skill-question"
      class="question-input"
      type="search"
      placeholder="Example: I need to refactor a huge React component and add tests."
      value="${escapeAttribute(questionDraft)}"
    />
    <button class="btn primary" data-action="recommend-skills">${s.recommendation.loading ? 'Matching…' : 'Find Skills'}</button>
  </div>
  <div class="recommend-subcontrols">
    <select id="project-workspace" class="project-select" ${s.projectConfig.workspaces.length === 0 ? 'disabled' : ''}>
      ${workspaceOptionsHtml}
    </select>
    <button class="btn" data-action="apply-recommended-skills" ${selectedRecommendationCount === 0 ? 'disabled' : ''}>
      Apply ${selectedRecommendationCount > 0 ? `${selectedRecommendationCount} ` : ''}to Project
    </button>
  </div>
  <div class="recommend-status">
    <span>${escapeHtml(s.recommendation.statusMessage ?? 'Ready to match skills.')}</span>
    ${s.projectConfig.lastAppliedAt ? `<span>Last applied: ${escapeHtml(new Date(s.projectConfig.lastAppliedAt).toLocaleString())}</span>` : ''}
  </div>
  ${s.recommendation.summary ? `<p class="recommend-summary">${escapeHtml(s.recommendation.summary)}</p>` : ''}
  <div class="recommend-list">${recommendationCardsHtml}</div>
</section>

<div class="cat-strip">
  ${catHtml}
  ${tagFilterBadge}
  <div class="cat-inline-tools">
    <label class="cat-inline-control" title="Choose what graph colors represent">
      <span class="cat-inline-label">Color</span>
      <select id="graph-color-mode" class="cat-inline-select">
        <option value="category" ${graphColorMode === 'category' ? 'selected' : ''}>Category</option>
        <option value="overlap" ${graphColorMode === 'overlap' ? 'selected' : ''}>Overlap</option>
      </select>
    </label>
    <span id="graph-color-legend" class="cat-chip cat-chip-muted">${escapeHtml(colorLegendLabel)}</span>
    ${hasCustomCategoryColors ? '<button class="cat-chip cat-chip-muted" data-action="reset-category-colors">Reset Colors</button>' : ''}
  </div>
</div>
</div>
${isDashboard && !topPanelsCollapsed ? '<div id="dashboard-top-splitter" class="layout-splitter vertical" title="Drag to resize top panels"></div>' : ''}

<div class="main ${isDashboard ? 'is-dashboard' : ''}" id="main-layout">
  <div class="graph-pane">
    <div class="pane-header">
      <div class="graph-header-meta">
        <span class="pane-title">Skill Overlap · ${visibleSkills.length} skills</span>
        <div class="graph-tuning">
          <label class="graph-control" title="Only connect skills that share at least this many tags">
            <span class="graph-control-label">Shared ≥</span>
            <input
              id="graph-shared-threshold"
              class="graph-range"
              type="range"
              min="1"
              max="${graphMaxSharedTags}"
              step="1"
              value="${graphMinSharedTags}"
            />
            <span id="graph-shared-threshold-value" class="graph-control-value">${graphMinSharedTags}</span>
          </label>
          <label class="graph-control" title="Spread linked skill balls farther apart or let them overlap more">
            <span class="graph-control-label">Spread</span>
            <input
              id="graph-spread-range"
              class="graph-range"
              type="range"
              min="85"
              max="185"
              step="5"
              value="${Math.round(graphSpreadScale * 100)}"
            />
            <span id="graph-spread-range-value" class="graph-control-value">${Math.round(graphSpreadScale * 100)}%</span>
          </label>
        </div>
      </div>
      <div class="view-toggle">
        <button class="view-btn ${graphMode === '2d' ? 'active' : ''}" data-action="graph-mode" data-mode="2d">2D</button>
        <button class="view-btn ${graphMode === '3d' ? 'active' : ''}" data-action="graph-mode" data-mode="3d">3D</button>
      </div>
    </div>
    <div class="graph-wrap" id="graph-wrap">
      <svg id="tag-graph" viewBox="0 0 720 480" role="img" aria-label="Skill overlap graph" style="${graphMode === '3d' ? 'display:none' : ''}"></svg>
      <div id="tag-graph-3d" style="${graphMode === '3d' ? 'display:block' : 'display:none'}"></div>
      <div id="graph-hover-tip" class="graph-hover-tip" hidden></div>
      <span class="graph-hint">${graphMode === '2d' ? 'Each ball = skill · Overlap = shared tags · Color = category · Drag nodes · Scroll to zoom · Click to focus · Double-click to reset' : 'Each ball = skill · Overlap = shared tags · Color = category · Drag to rotate · Scroll to zoom · Click to focus · Double-click to reset'}</span>
    </div>
  </div>
  ${isDashboard ? '<div id="dashboard-main-splitter" class="layout-splitter horizontal" title="Drag to resize graph and skills"></div>' : ''}

  <div class="right-pane">
    <div class="pane-header">
      <span class="pane-title">Skills · ${visibleSkills.length} shown</span>
      <div class="pane-actions">
        <span class="pill">${selectedRecommendationCount} selected</span>
        <button class="btn compact" data-action="toggle-show-selected">${showSelectedOnly ? 'Show All' : 'Only Selected'}</button>
        <button class="btn compact" data-action="apply-recommended-skills" ${selectedRecommendationCount === 0 ? 'disabled' : ''}>Apply</button>
      </div>
    </div>
  <div class="selected-strip">${selectedSkillStripHtml}</div>
    <div class="skill-list-wrap">${skillCardsHtml}</div>
  </div>
</div>`;

  bindDomEvents();
  bindResizableLayout();
  restoreFocusedInput(focusedInput);

  if (graphMode === '2d') {
    attachSvgToSimulation();
  } else {
    renderSphere(visibleSkills);
  }

  if (focusedNodeId && selectedSkill?.id) {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToSkillCard(selectedSkill.id)));
  }
}

// ── Graph: live D3 simulation ────────────────────────────────────────────────

function syncTagGenerationDraftsFromState(nextState: ViewState): void {
  if (typeof tagPromptDraft === 'undefined') {
    tagPromptDraft = nextState.openRouter.tagPrompt;
  }
  if (typeof tagBatchSizeDraft === 'undefined') {
    tagBatchSizeDraft = nextState.openRouter.tagBatchSize;
  }
  if (typeof tagMaxSkillsDraft === 'undefined') {
    tagMaxSkillsDraft = nextState.openRouter.tagMaxSkillsPerRun;
  }
  if (typeof tagDelayDraft === 'undefined') {
    tagDelayDraft = nextState.openRouter.tagRequestDelayMs;
  }
  if (typeof tagAutoDraft === 'undefined') {
    tagAutoDraft = nextState.openRouter.autoGenerateTagsOnRefresh;
  }
}

function buildSkillOverlapGraph(skills: SkillRecord[]): { skills: SkillRecord[]; links: SkillLink[]; maxSharedTags: number } {
  const MAX_GRAPH_SKILLS = 120;
  const priorityIds = new Set<string>(
    [focusedNodeId, state?.selectedSkillId].filter((value): value is string => Boolean(value))
  );
  const graphSkills = [...skills]
    .filter((skill) => skill.tags.length > 0)
    .sort((left, right) => {
      const leftPriority = priorityIds.has(left.id) ? 1 : 0;
      const rightPriority = priorityIds.has(right.id) ? 1 : 0;
      return rightPriority - leftPriority || right.tags.length - left.tags.length || left.name.localeCompare(right.name);
    })
    .slice(0, MAX_GRAPH_SKILLS);

  const tagToSkillIdx = new Map<string, number[]>();
  graphSkills.forEach((skill, index) => {
    for (const tag of skill.tags) {
      if (!tagToSkillIdx.has(tag)) tagToSkillIdx.set(tag, []);
      tagToSkillIdx.get(tag)!.push(index);
    }
  });

  const pairShared = new Map<string, number>();
  for (const indices of tagToSkillIdx.values()) {
    for (let leftIndex = 0; leftIndex < indices.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < indices.length; rightIndex += 1) {
        const key = `${indices[leftIndex]}|${indices[rightIndex]}`;
        pairShared.set(key, (pairShared.get(key) ?? 0) + 1);
      }
    }
  }

  const connectedSkillIdx = new Set<number>();
  const links: SkillLink[] = [];
  let maxSharedTags = 0;
  for (const [key, sharedTags] of pairShared) {
    const [leftIndex, rightIndex] = key.split('|').map(Number);
    const leftSkill = graphSkills[leftIndex];
    const rightSkill = graphSkills[rightIndex];
    if (!leftSkill || !rightSkill || sharedTags <= 0) continue;
    maxSharedTags = Math.max(maxSharedTags, sharedTags);
    if (sharedTags < graphMinSharedTags) continue;

    connectedSkillIdx.add(leftIndex);
    connectedSkillIdx.add(rightIndex);
    links.push({
      sourceId: leftSkill.id,
      targetId: rightSkill.id,
      sharedTags,
      weight: sharedTags / Math.max(1, Math.min(leftSkill.tags.length, rightSkill.tags.length))
    });
  }

  const overlappingSkills = graphSkills.filter((_, index) => connectedSkillIdx.has(index));
  const overlappingIds = new Set(overlappingSkills.map((skill) => skill.id));

  return {
    skills: overlappingSkills,
    links: links.filter((link) => overlappingIds.has(link.sourceId) && overlappingIds.has(link.targetId)),
    maxSharedTags
  };
}

function computeSkillLayout3D(skillNodes: SkillNode3D[], skillLinks: SkillLink[]): Map<string, THREE.Vector3> {
  if (skillNodes.length === 0) {
    return new Map();
  }

  const n = skillNodes.length;
  const maxNodeR = Math.max(...skillNodes.map((node) => node.radius), 0.1);
  const sphereRadius = Math.max(2.4, maxNodeR * 2.2 * Math.sqrt(n) / (2 * Math.sqrt(Math.PI)) * graphSpreadScale);
  const positions = skillNodes.map((_, index) => {
    const phi = Math.acos(1 - (2 * (index + 0.5)) / n);
    const theta = Math.PI * (1 + Math.sqrt(5)) * index;
    return new THREE.Vector3(
      sphereRadius * Math.sin(phi) * Math.cos(theta),
      sphereRadius * Math.cos(phi),
      sphereRadius * Math.sin(phi) * Math.sin(theta)
    );
  });
  const idxById = new Map<string, number>(skillNodes.map((node, index) => [node.id, index]));
  const maxSharedTags = Math.max(...skillLinks.map((link) => link.sharedTags), 1);
  const velocity = skillNodes.map(() => new THREE.Vector3());

  for (let iter = 0; iter < 72; iter += 1) {
    const alpha = 1 - iter / 72;

    for (let leftIndex = 0; leftIndex < n; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < n; rightIndex += 1) {
        const diff = positions[leftIndex].clone().sub(positions[rightIndex]);
        const distance = Math.max(diff.length(), 0.001);
        const combinedRadius = skillNodes[leftIndex].radius + skillNodes[rightIndex].radius;
        const repulsion = (combinedRadius * combinedRadius) / (distance * distance) * (0.05 + (graphSpreadScale - 1) * 0.03) * alpha;
        velocity[leftIndex].addScaledVector(diff.normalize(), repulsion);
        velocity[rightIndex].addScaledVector(diff.normalize(), -repulsion);
      }
    }

    for (const link of skillLinks) {
      const leftIndex = idxById.get(link.sourceId);
      const rightIndex = idxById.get(link.targetId);
      if (leftIndex === undefined || rightIndex === undefined) continue;

      const diff = positions[rightIndex].clone().sub(positions[leftIndex]);
      const distance = Math.max(diff.length(), 0.001);
      const combinedRadius = skillNodes[leftIndex].radius + skillNodes[rightIndex].radius;
      const overlapFraction = link.sharedTags / maxSharedTags;
      const targetDistance = combinedRadius * (0.54 + (1 - overlapFraction) * 0.18) * graphSpreadScale;
      const stretch = (distance - targetDistance) / distance;
      const force = stretch * 0.14 * alpha;
      velocity[leftIndex].addScaledVector(diff.normalize(), force);
      velocity[rightIndex].addScaledVector(diff.normalize(), -force);
    }

    for (let index = 0; index < n; index += 1) {
      positions[index].add(velocity[index]);
      velocity[index].multiplyScalar(0.64);
    }
  }

  return new Map(skillNodes.map((node, index) => [node.id, positions[index]]));
}

function buildLinkedSkillIdSet(skillId: string): Set<string> {
  const ids = new Set<string>([skillId]);
  for (const link of liveSkillLinks) {
    if (link.sourceId === skillId) ids.add(link.targetId);
    else if (link.targetId === skillId) ids.add(link.sourceId);
  }
  return ids;
}

function getOverlappingSkillIds2D(skillId: string): Set<string> | null {
  if (!liveNodes.some((node) => node.id === skillId)) {
    return null;
  }
  return buildLinkedSkillIdSet(skillId);
}

function getOverlappingSkillIds3D(skillId: string): Set<string> | null {
  if (!liveSkillNodes.some((node) => node.id === skillId)) {
    return null;
  }
  return buildLinkedSkillIdSet(skillId);
}

function rebuildGraph(): void {
  if (!state) return;

  const visibleSkills = getBaseVisibleSkills(state);
  let graph = buildSkillOverlapGraph(visibleSkills);
  const maxAllowedSharedTags = Math.max(graph.maxSharedTags, 1);
  const nextSharedThreshold = clamp(graphMinSharedTags, 1, maxAllowedSharedTags);
  if (nextSharedThreshold !== graphMinSharedTags) {
    graphMinSharedTags = nextSharedThreshold;
    graph = buildSkillOverlapGraph(visibleSkills);
  }

  if (simulation) {
    simulation.stop();
    simulation = null;
  }

  const previousNodesById = new Map(liveNodes.map((node) => [node.id, node]));
  const nodeCount = graph.skills.length;
  const maxTagCount = Math.max(...graph.skills.map((skill) => skill.tags.length), 1);
  const baseR = nodeCount > 60 ? 12 : nodeCount > 30 ? 14 : nodeCount > 15 ? 17 : 20;
  const scaleR = nodeCount > 60 ? 6 : nodeCount > 30 ? 8 : nodeCount > 15 ? 10 : 12;
  liveNodes = graph.skills.map((skill) => {
    const previous = previousNodesById.get(skill.id);
    return {
      id: skill.id,
      name: skill.name,
      category: skill.category,
      tagCount: skill.tags.length,
      radius: baseR + Math.sqrt(skill.tags.length / maxTagCount) * scaleR,
      x: previous?.x,
      y: previous?.y,
      vx: previous?.vx,
      vy: previous?.vy
    };
  });
  liveLinks = graph.links.map((link) => ({
    ...link,
    source: link.sourceId,
    target: link.targetId
  }));

  if (liveNodes.length > 0) {
    const maxSharedTags2D = Math.max(graph.maxSharedTags, 1);
    simulation = forceSimulation(liveNodes)
      .force('center', forceCenter(360, 240))
      .force('charge', forceManyBody<SkillNode2D>().strength((node: SkillNode2D) => -34 - node.radius * 1.25 * graphSpreadScale))
      .force(
        'link',
        forceLink<SkillNode2D, GraphLink2D>(liveLinks)
          .id((node: SkillNode2D) => node.id)
          .distance((link: GraphLink2D) => {
            const source = link.source as SkillNode2D;
            const target = link.target as SkillNode2D;
            const overlapFraction = link.sharedTags / maxSharedTags2D;
            return (source.radius + target.radius) * (0.54 + (1 - overlapFraction) * 0.18) * graphSpreadScale;
          })
          .strength((link: GraphLink2D) => Math.min(0.85, 0.18 + link.weight * 0.45))
      )
      .velocityDecay(0.42)
      .alphaDecay(0.04)
      .on('tick', () => {
        if (graphMode === '2d') drawSvgFrame();
      });
  }

  const n3d = graph.skills.length;
  const maxR3d = n3d > 60 ? 0.22 : n3d > 30 ? 0.30 : n3d > 15 ? 0.38 : 0.48;
  const minR3d = n3d > 60 ? 0.08 : n3d > 30 ? 0.11 : n3d > 15 ? 0.14 : 0.18;

  liveSkillLinks = graph.links.map((link) => ({ ...link }));
  liveSkillNodes = graph.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    tagCount: skill.tags.length,
    radius: minR3d + (skill.tags.length / maxTagCount) * (maxR3d - minR3d)
  }));
  liveSkillPositions3D = computeSkillLayout3D(liveSkillNodes, liveSkillLinks);

  if (focusedNodeId && !liveNodes.some((node) => node.id === focusedNodeId)) {
    focusedNodeId = undefined;
  }
  if (hoveredNodeId && !liveNodes.some((node) => node.id === hoveredNodeId)) {
    hoveredNodeId = undefined;
    hoverPointer = undefined;
  }
}

function attachSvgToSimulation(): void {
  const svg = document.getElementById('tag-graph') as SVGSVGElement | null;
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  svgWidth = rect.width || 720;
  svgHeight = rect.height || 480;

  if (liveNodes.length === 0) {
    svg.innerHTML = `<text x="${svgWidth / 2}" y="${svgHeight / 2}" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="12">No overlapping skills for current filter.</text>`;
    return;
  }

  // Initial draw
  drawSvgFrame();

  // Drag events
  svg.addEventListener('mousedown', onSvgMouseDown);
  svg.addEventListener('mousemove', onSvgMouseMove);
  svg.addEventListener('mouseup', onSvgMouseUp);
  svg.addEventListener('mouseleave', onSvgMouseUp);
  svg.addEventListener('wheel', onSvgWheel, { passive: false });
}

function drawSvgFrame(): void {
  const svg = document.getElementById('tag-graph') as SVGSVGElement | null;
  if (!svg || liveNodes.length === 0) return;

  const W = 720;
  const H = 480;

  const visibleNodeIds = focusedNodeId ? getOverlappingSkillIds2D(focusedNodeId) : null;
  const zoomTransform = svgZoomScale === 1
    ? ''
    : `translate(${W / 2} ${H / 2}) scale(${svgZoomScale}) translate(${-W / 2} ${-H / 2})`;

  const nodeMarkup = liveNodes.map((n) => {
    if (visibleNodeIds && !visibleNodeIds.has(n.id)) return '';
    const nx = clamp(n.x ?? W / 2, n.radius, W - n.radius);
    const ny = clamp(n.y ?? H / 2, n.radius, H - n.radius);
    const fill = graphNodeColor(n.id, n.category);
    const isHighlighted = n.id === focusedNodeId;
    const r = n.radius;
    const fontSize = Math.max(9, Math.min(12, r * 0.7));
    const labelY = ny - r - 4;
    return `<g class="graph-node" data-skill-id="${escapeAttribute(n.id)}" style="cursor:pointer">
  <circle cx="${nx}" cy="${ny}" r="${r}" fill="${fill}" fill-opacity="${isHighlighted ? 0.92 : 0.55}" stroke="${fill}" stroke-width="${isHighlighted ? 2.5 : 1}" stroke-opacity="0.9"/>
  <text x="${nx}" y="${labelY}" text-anchor="middle" fill="currentColor" font-size="${fontSize}" pointer-events="none" font-weight="${isHighlighted ? '700' : '400'}" opacity="${isHighlighted ? 1 : 0.8}">${escapeHtml(truncate(n.name, 18))}</text>
  <title>${escapeHtml(n.name)} · ${n.tagCount} tags</title>
</g>`;
  }).join('');

  svg.innerHTML = `<g class="nodes" transform="${zoomTransform}">${nodeMarkup}</g>`;

  // Re-bind click / dblclick / drag events
  svg.querySelectorAll<SVGGElement>('.graph-node').forEach((g) => {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const skillId = g.dataset.skillId;
      const node = liveNodes.find((n) => n.id === skillId);
      if (!node || !simulation) return;

      const svgEl = document.getElementById('tag-graph') as unknown as SVGSVGElement;
      const pt = svgGraphPoint(svgEl, e.clientX, e.clientY);
      dragOffsetX = (node.x ?? 0) - pt.x;
      dragOffsetY = (node.y ?? 0) - pt.y;
      node.fx = node.x;
      node.fy = node.y;
      svgMouseDownNode = node;
      svgMouseDownPos = { x: e.clientX, y: e.clientY };
      // Don't set dragNode yet — wait until actual movement in onSvgMouseMove
    });

    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      focusedNodeId = undefined;
      drawSvgFrame();
      updateSkillListOnly();
    });
  });
}

function onSvgMouseDown(_e: MouseEvent): void { /* handled per-node */ }

function onSvgMouseMove(e: MouseEvent): void {
  if (!svgMouseDownNode || !simulation) return;
  const moved = svgMouseDownPos
    ? Math.abs(e.clientX - svgMouseDownPos.x) + Math.abs(e.clientY - svgMouseDownPos.y)
    : 999;
  if (moved > 4 && !dragNode) {
    dragNode = svgMouseDownNode;
    simulation.alphaTarget(0.3).restart();
  }
  if (!dragNode) return;
  const svg = document.getElementById('tag-graph') as unknown as SVGSVGElement;
  const pt = svgGraphPoint(svg, e.clientX, e.clientY);
  dragNode.fx = pt.x + dragOffsetX;
  dragNode.fy = pt.y + dragOffsetY;
}

function onSvgMouseUp(e: MouseEvent): void {
  const wasDragging = dragNode !== null;
  if (dragNode && simulation) {
    dragNode.fx = undefined;
    dragNode.fy = undefined;
    dragNode = null;
    simulation.alphaTarget(0);
  }

  const pressedNode = svgMouseDownNode;
  svgMouseDownNode = null;
  svgMouseDownPos = null;

  if (wasDragging || !pressedNode) return;

  // Treat as click — find the g element that was pressed
  const nodeId = pressedNode.id;
  if (focusedNodeId === nodeId) {
    focusedNodeId = undefined;
  } else {
    focusedNodeId = nodeId;
    if (state) {
      expandedSkillId = nodeId;
      state = { ...state, selectedSkillId: nodeId };
      pendingSelectionEchoKey = selectionEchoKey(nodeId);
      vscode.postMessage({ type: 'selectSkill', skillId: nodeId });
    }
  }
  drawSvgFrame();
  updateSkillListOnly();
  if (focusedNodeId && state?.selectedSkillId) {
    const skillId = state.selectedSkillId;
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToSkillCard(skillId)));
  }
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: clientX, y: clientY };
  const transformed = pt.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

function svgGraphPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const basePoint = svgPoint(svg, clientX, clientY);
  const cx = 360;
  const cy = 240;
  return {
    x: cx + (basePoint.x - cx) / svgZoomScale,
    y: cy + (basePoint.y - cy) / svgZoomScale
  };
}

function onSvgWheel(e: WheelEvent): void {
  e.preventDefault();
  const nextScale = clamp(svgZoomScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.6, 2.6);
  if (nextScale === svgZoomScale) return;
  svgZoomScale = nextScale;
  drawSvgFrame();
}

// ── Graph: 3D sphere (Three.js) ──────────────────────────────────────────────

function disposeThree(): void {
  hideGraphHoverTip();
  if (threeAnimFrame !== null) {
    cancelAnimationFrame(threeAnimFrame);
    threeAnimFrame = null;
  }
  if (threeResizeObserver) {
    threeResizeObserver.disconnect();
    threeResizeObserver = null;
  }
  if (threeRenderer) {
    threeRenderer.dispose();
    threeRenderer = null;
  }
  threeScene = null;
  threeCamera = null;
  threeNodeMeshes = [];
  applyThreeFocus = null;
}

function renderSphere(_visibleSkills: SkillRecord[]): void {
  disposeThree();

  const wrap = document.getElementById('tag-graph-3d') as HTMLElement | null;
  if (!wrap) return;

  if (liveSkillNodes.length === 0) {
    wrap.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0.5;font-size:12px;">No overlapping skills for current filter.</div>';
    return;
  }

  wrap.innerHTML = '';

  // Snapshot now — render() may replace liveSkillNodes before the deferred callback fires
  const skillNodesSnap = [...liveSkillNodes];
  const skillLinksSnap = [...liveSkillLinks];

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!wrap.isConnected || threeRenderer) return;
      try {
        initThreeScene(wrap, skillNodesSnap, skillLinksSnap);
      } catch (err) {
        wrap.innerHTML = `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:red;font-size:11px;max-width:90%;text-align:center;">3D error: ${String(err)}</div>`;
      }
    });
  });
}

function initThreeScene(
  wrap: HTMLElement,
  skillNodes: SkillNode3D[],
  skillLinks: SkillLink[]
): void {
  const W = wrap.clientWidth || wrap.getBoundingClientRect().width || 600;
  const H = wrap.clientHeight || wrap.getBoundingClientRect().height || 400;

  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') ?? testCanvas.getContext('webgl');
  if (!gl) {
    wrap.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:orange;font-size:11px;text-align:center;">WebGL not available in this webview</div>';
    return;
  }

  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  threeCamera.position.z = 6;

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setSize(W, H);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  threeRenderer.setClearColor(0x000000, 0);
  wrap.appendChild(threeRenderer.domElement);

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(3, 5, 5);
  threeScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.2);
  fill.position.set(-3, -2, -3);
  threeScene.add(fill);

  const root = new THREE.Group();
  threeScene.add(root);

  const positions = liveSkillPositions3D;

  // ── Build meshes ──────────────────────────────────────────────────────────
  threeNodeMeshes = [];

  const buildMeshes = (focusId: string | undefined) => {
    // Remove old meshes from root
    while (root.children.length > 0) root.remove(root.children[0]);
    threeNodeMeshes = [];

    const visibleIds = focusId ? getOverlappingSkillIds3D(focusId) : null;
    const showCompactLabels = Boolean(focusId && visibleIds && visibleIds.size <= 14);

    skillNodes.forEach((node) => {
      const pos = positions.get(node.id);
      if (!pos) return;

      const isVisible = !visibleIds || visibleIds.has(node.id);
      if (!isVisible) return; // skip non-adjacent nodes when focused

      const nodeR = node.radius;
      const color = new THREE.Color(graphNodeColor(node.id, node.category));
      const fillColor = color.clone().lerp(new THREE.Color(0xf4f4f4), 0.42);
      const isHighlighted = node.id === focusId;
      const isHovered = node.id === hoveredNodeId;

      // Solid sphere for raycasting
      const geo = new THREE.SphereGeometry(nodeR, 20, 14);
      const mat = new THREE.MeshStandardMaterial({
        color: fillColor,
        opacity: isHighlighted ? 0.84 : isHovered ? 0.74 : 0.56,
        transparent: true,
        roughness: 0.52,
        metalness: 0.04,
        emissive: color,
        emissiveIntensity: isHighlighted ? 0.14 : isHovered ? 0.08 : 0.03
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData = { skillId: node.id };
      root.add(mesh);
      threeNodeMeshes.push({ mesh, skillId: node.id });

      const shellGeo = new THREE.SphereGeometry(nodeR * 1.02, 18, 12);
      const shellMat = new THREE.MeshBasicMaterial({
        color,
        opacity: isHighlighted ? 0.5 : isHovered ? 0.28 : 0.14,
        transparent: true,
        side: THREE.BackSide
      });
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.position.copy(pos);
      root.add(shell);

      // Highlight ring for focused node
      if (isHighlighted) {
        const ringGeo = new THREE.TorusGeometry(nodeR * 1.35, nodeR * 0.08, 8, 48);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.85, transparent: true });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        root.add(ring);
      }

      // Label sprite
      const cvs = document.createElement('canvas');
      cvs.width = 320; cvs.height = 88;
      const ctx = cvs.getContext('2d');
      if (ctx && (isHighlighted || isHovered || showCompactLabels)) {
        const lines = buildSphereLabelLines(node.id, focusId, isHighlighted || isHovered);
        ctx.fillStyle = 'rgba(18, 18, 20, 0.72)';
        roundRect(ctx, 18, 12, 284, lines.length > 1 ? 54 : 38, 18);
        ctx.fill();
        ctx.font = `${isHighlighted || isHovered ? 'bold' : 'normal'} ${lines.length > 1 ? 18 : 16}px sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lines[0] ?? truncate(node.name, 22), 160, lines.length > 1 ? 30 : 31);
        if (lines[1]) {
          ctx.font = '13px sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fillText(lines[1], 160, 52);
        }
        const tex = new THREE.CanvasTexture(cvs);
        const spriteMat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: isHighlighted ? 1 : isHovered ? 0.96 : 0.82
        });
        const sprite = new THREE.Sprite(spriteMat);
        const len = pos.length() || 1;
        sprite.position.set(
          pos.x + (pos.x / len) * (nodeR + 0.12),
          pos.y + (pos.y / len) * (nodeR + 0.12) + nodeR * 0.5,
          pos.z + (pos.z / len) * (nodeR + 0.12)
        );
        sprite.scale.set(lines.length > 1 ? 0.82 : 0.68, lines.length > 1 ? 0.22 : 0.145, 1);
        root.add(sprite);
      }
    });

  };

  applyThreeFocus = (focusId?: string) => {
    buildMeshes(focusId);
  };
  buildMeshes(focusedNodeId);

  // ── Mouse orbit + scroll zoom ─────────────────────────────────────────────
  const canvas = threeRenderer.domElement;
  canvas.style.cursor = 'grab';
  let mouseDownPos = { x: 0, y: 0 };

  canvas.addEventListener('mousedown', (e) => {
    sphereIsDragging = true;
    sphereAutoRotate = false;
    sphereDragStart = { x: e.clientX, y: e.clientY };
    mouseDownPos = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', (e) => {
    if (sphereIsDragging) {
      hideGraphHoverTip();
      sphereRotation.y += (e.clientX - sphereDragStart.x) * 0.007;
      sphereRotation.x += (e.clientY - sphereDragStart.y) * 0.007;
      sphereDragStart = { x: e.clientX, y: e.clientY };
      return;
    }

    const hoveredSkillId = pickSkillId(e.clientX, e.clientY);
    canvas.style.cursor = hoveredSkillId ? 'pointer' : 'grab';
    setHoveredSkill(
      hoveredSkillId,
      hoveredSkillId ? { x: e.clientX, y: e.clientY } : undefined
    );
  });

  const pickSkillId = (clientX: number, clientY: number): string | undefined => {
    if (!threeCamera || !threeRenderer) return undefined;

    root.rotation.x = sphereRotation.x;
    root.rotation.y = sphereRotation.y;
    root.updateMatrixWorld(true);

    const rect = threeRenderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, threeCamera);
    const hits = raycaster.intersectObjects(threeNodeMeshes.map((m) => m.mesh));
    return hits[0]?.object.userData.skillId as string | undefined;
  };

  const handleClick = (e: MouseEvent, isDouble: boolean) => {
    if (!threeCamera || !threeRenderer) return;
    const moved = Math.abs(e.clientX - mouseDownPos.x) + Math.abs(e.clientY - mouseDownPos.y);
    if (moved > 5) return;

    const skillId = pickSkillId(e.clientX, e.clientY);
    if (isDouble || !skillId) {
      // Double-click anywhere, or click on empty space → reset focus
      clearFocusedSkillLocally();
      return;
    }
    if (!state) return;

    if (focusedNodeId === skillId) {
      // Click same node again → clear focus
      clearFocusedSkillLocally();
    } else {
      expandedSkillId = skillId;
      focusSkillLocally(skillId);
    }
  };

  canvas.addEventListener('mouseup', (e) => {
    if (!sphereIsDragging) return;
    sphereIsDragging = false;
    canvas.style.cursor = 'grab';
    handleClick(e, false);
    setTimeout(() => { sphereAutoRotate = true; }, 1800);
  });

  canvas.addEventListener('dblclick', (e) => {
    handleClick(e, true);
  });

  canvas.addEventListener('mouseleave', () => {
    sphereIsDragging = false;
    canvas.style.cursor = 'grab';
    setHoveredSkill(undefined);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!threeCamera) return;
    threeCamera.position.z = Math.max(1.5, Math.min(20, threeCamera.position.z + e.deltaY * 0.01));
  }, { passive: false });

  function animate(): void {
    threeAnimFrame = requestAnimationFrame(animate);
    if (sphereAutoRotate && !sphereIsDragging) {
      sphereRotation.y += 0.003;
    }
    root.rotation.x = sphereRotation.x;
    root.rotation.y = sphereRotation.y;
    threeRenderer!.render(threeScene!, threeCamera!);
  }
  animate();

  const ro = new ResizeObserver(() => {
    if (!threeRenderer || !threeCamera) return;
    const nw = wrap.clientWidth;
    const nh = wrap.clientHeight;
    if (nw === 0 || nh === 0) return;
    threeRenderer.setSize(nw, nh);
    threeCamera.aspect = nw / nh;
    threeCamera.updateProjectionMatrix();
  });
  ro.observe(wrap);
  threeResizeObserver = ro;
}

// ── DOM events ───────────────────────────────────────────────────────────────

function bindDomEvents(): void {
  app.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const action = el.dataset.action;
      if (!action || !state) return;
      if (action !== 'toggle-skill') {
        e.stopPropagation();
      }

      switch (action) {
        case 'toggle-settings':
          settingsOpen = !settingsOpen;
          render();
          break;
        case 'toggle-top-panels':
          topPanelsCollapsed = !topPanelsCollapsed;
          persistLayoutPrefs();
          render();
          break;
        case 'refresh':
          settingsOpen = false;
          vscode.postMessage({ type: 'refresh' });
          break;
        case 'configure-key':
          settingsOpen = false;
          vscode.postMessage({ type: 'configureOpenRouterKey' });
          break;
        case 'open-openrouter-settings':
          settingsOpen = false;
          vscode.postMessage({ type: 'openOpenRouterSettings' });
          break;
        case 'refresh-openrouter-models':
          settingsOpen = false;
          vscode.postMessage({ type: 'refreshOpenRouterModels' });
          break;
        case 'save-tag-config':
          settingsOpen = false;
          vscode.postMessage({
            type: 'updateTagGenerationConfig',
            config: {
              tagPrompt: (tagPromptDraft ?? '').trim(),
              batchSize: clamp(Math.round(tagBatchSizeDraft ?? 8), 1, 25),
              maxSkillsPerRun: clamp(Math.round(tagMaxSkillsDraft ?? 24), 1, 500),
              requestDelayMs: clamp(Math.round(tagDelayDraft ?? 0), 0, 10_000),
              autoGenerateTagsOnRefresh: Boolean(tagAutoDraft)
            }
          });
          break;
        case 'stop-tag-generation':
          settingsOpen = false;
          vscode.postMessage({ type: 'stopTagGeneration' });
          break;
        case 'reset-category-colors':
          graphCategoryColors = {};
          persistGraphPrefs();
          render();
          refreshGraphFocusVisibility();
          break;
        case 'configure-lightrag':
          settingsOpen = false;
          vscode.postMessage({ type: 'configureLightRagBaseUrl' });
          break;
        case 'configure-github-sources':
          settingsOpen = false;
          vscode.postMessage({ type: 'configureGitHubSources' });
          break;
        case 'clear-key':
          settingsOpen = false;
          vscode.postMessage({ type: 'clearOpenRouterKey' });
          break;
        case 'generate-tags':
          settingsOpen = false;
          vscode.postMessage({ type: 'generateTags' });
          break;
        case 'sync-kb':
          settingsOpen = false;
          vscode.postMessage({ type: 'syncKnowledgeBase' });
          break;
        case 'recommend-skills':
          settingsOpen = false;
          vscode.postMessage({ type: 'recommendSkills', question: questionDraft });
          break;
        case 'toggle-recommended-skill':
          if (el.dataset.skillId) {
            vscode.postMessage({ type: 'toggleRecommendedSkill', skillId: el.dataset.skillId });
          }
          break;
        case 'apply-recommended-skills':
          settingsOpen = false;
          vscode.postMessage({ type: 'applyRecommendedSkills' });
          break;
        case 'toggle-show-selected':
          showSelectedOnly = !showSelectedOnly;
          rebuildGraph();
          render();
          break;
        case 'clear-filter':
          settingsOpen = false;
          selectedTag = undefined;
          focusedNodeId = undefined;
          searchText = '';
          searchDraft = '';
          vscode.postMessage({ type: 'clearFilter' });
          break;
        case 'scope':
          vscode.postMessage({
            type: 'setFilter',
            filter: applyScopeFilter(state.filter, (el.dataset.scope as SkillFilter['scope']) ?? 'all')
          });
          break;
        case 'category':
          vscode.postMessage({
            type: 'setFilter',
            filter: applyCategoryFilter(state.filter, el.dataset.category)
          });
          break;
        case 'toggle-skill':
          if (el.dataset.skillId) {
            const skillId = el.dataset.skillId;
            expandedSkillId = expandedSkillId === skillId ? undefined : skillId;
            focusSkillLocally(skillId);
          }
          break;
        case 'open-skill':
          if (el.dataset.skillId) {
            vscode.postMessage({ type: 'openSkill', skillId: el.dataset.skillId });
          }
          break;
        case 'select-tag':
          selectedTag = el.dataset.tag;
          focusedNodeId = undefined;
          rebuildGraph();
          render();
          break;
        case 'select-tag-clear':
          selectedTag = undefined;
          focusedNodeId = undefined;
          rebuildGraph();
          render();
          break;
        case 'graph-mode': {
          const newMode = el.dataset.mode as '2d' | '3d';
          if (newMode === graphMode) break;
          graphMode = newMode;
          focusedNodeId = undefined;
          disposeThree();
          render();
          break;
        }
      }
    });
  });

  // Close settings popover on outside click
  document.addEventListener('click', (e) => {
    if (settingsOpen && !(e.target as HTMLElement).closest('.settings-wrap')) {
      settingsOpen = false;
      render();
    }
  }, { once: true });

  const search = document.getElementById('skill-search') as HTMLInputElement | null;
  search?.addEventListener('input', (e) => {
    searchDraft = (e.target as HTMLInputElement).value;
    lastFocusedInput = captureElementSelection(e.target as HTMLInputElement);
    queueSearchRender();
  });
  search?.addEventListener('click', () => {
    lastFocusedInput = captureElementSelection(search);
  });
  search?.addEventListener('keyup', () => {
    lastFocusedInput = captureElementSelection(search);
  });
  search?.addEventListener('compositionstart', () => {
    searchIsComposing = true;
  });
  search?.addEventListener('compositionend', (e) => {
    searchIsComposing = false;
    searchDraft = (e.target as HTMLInputElement).value;
    lastFocusedInput = captureElementSelection(e.target as HTMLInputElement);
    queueSearchRender();
  });

  const question = document.getElementById('skill-question') as HTMLInputElement | null;
  question?.addEventListener('input', (e) => {
    questionDraft = (e.target as HTMLInputElement).value;
    lastFocusedInput = captureElementSelection(e.target as HTMLInputElement);
  });
  question?.addEventListener('click', () => {
    lastFocusedInput = captureElementSelection(question);
  });
  question?.addEventListener('keyup', () => {
    lastFocusedInput = captureElementSelection(question);
  });
  question?.addEventListener('compositionstart', () => {
    questionIsComposing = true;
  });
  question?.addEventListener('compositionend', (e) => {
    questionIsComposing = false;
    questionDraft = (e.target as HTMLInputElement).value;
    lastFocusedInput = captureElementSelection(e.target as HTMLInputElement);
  });
  question?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !questionIsComposing) {
      e.preventDefault();
      vscode.postMessage({ type: 'recommendSkills', question: questionDraft });
    }
  });

  const workspaceSelect = document.getElementById('project-workspace') as HTMLSelectElement | null;
  workspaceSelect?.addEventListener('change', (e) => {
    vscode.postMessage({
      type: 'setProjectWorkspace',
      workspaceId: (e.target as HTMLSelectElement).value || undefined
    });
  });

  const openRouterModelSelect = document.getElementById('openrouter-model-select') as HTMLSelectElement | null;
  openRouterModelSelect?.addEventListener('change', (e) => {
    const nextModel = (e.target as HTMLSelectElement).value;
    if (!nextModel || nextModel === state?.openRouter.model) return;
    vscode.postMessage({ type: 'setOpenRouterModel', model: nextModel });
  });

  const tagPromptInput = document.getElementById('tag-prompt') as HTMLTextAreaElement | null;
  tagPromptInput?.addEventListener('input', (e) => {
    tagPromptDraft = (e.target as HTMLTextAreaElement).value;
  });

  const tagBatchSizeInput = document.getElementById('tag-batch-size') as HTMLInputElement | null;
  tagBatchSizeInput?.addEventListener('input', (e) => {
    tagBatchSizeDraft = clamp(Number((e.target as HTMLInputElement).value) || 1, 1, 25);
  });

  const tagMaxSkillsInput = document.getElementById('tag-max-skills') as HTMLInputElement | null;
  tagMaxSkillsInput?.addEventListener('input', (e) => {
    tagMaxSkillsDraft = clamp(Number((e.target as HTMLInputElement).value) || 1, 1, 500);
  });

  const tagDelayInput = document.getElementById('tag-request-delay') as HTMLInputElement | null;
  tagDelayInput?.addEventListener('input', (e) => {
    tagDelayDraft = clamp(Number((e.target as HTMLInputElement).value) || 0, 0, 10_000);
  });

  const tagAutoInput = document.getElementById('tag-auto-generate') as HTMLInputElement | null;
  tagAutoInput?.addEventListener('change', (e) => {
    tagAutoDraft = (e.target as HTMLInputElement).checked;
  });

  const graphColorModeSelect = document.getElementById('graph-color-mode') as HTMLSelectElement | null;
  graphColorModeSelect?.addEventListener('change', (e) => {
    const nextMode = (e.target as HTMLSelectElement).value === 'overlap' ? 'overlap' : 'category';
    if (nextMode === graphColorMode) return;
    graphColorMode = nextMode;
    persistGraphPrefs();
    updateGraphColorLegend();
    refreshGraphFocusVisibility();
  });

  app.querySelectorAll<HTMLInputElement>('.cat-color-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      const category = input.dataset.categoryColor;
      if (!category) return;
      graphCategoryColors = {
        ...graphCategoryColors,
        [category]: (e.target as HTMLInputElement).value
      };
      persistGraphPrefs();
      if (graphColorMode === 'category') {
        refreshGraphFocusVisibility();
      }
    });
  });

  const sharedThresholdInput = document.getElementById('graph-shared-threshold') as HTMLInputElement | null;
  const sharedThresholdValue = document.getElementById('graph-shared-threshold-value');
  sharedThresholdInput?.addEventListener('input', (e) => {
    const nextValue = Number((e.target as HTMLInputElement).value);
    graphMinSharedTags = clamp(Math.round(nextValue), 1, Number(sharedThresholdInput.max));
    if (sharedThresholdValue) sharedThresholdValue.textContent = String(graphMinSharedTags);
  });
  sharedThresholdInput?.addEventListener('change', () => {
    rebuildGraph();
    render();
  });

  const spreadInput = document.getElementById('graph-spread-range') as HTMLInputElement | null;
  const spreadValue = document.getElementById('graph-spread-range-value');
  spreadInput?.addEventListener('input', (e) => {
    const nextValue = Number((e.target as HTMLInputElement).value);
    graphSpreadScale = clamp(nextValue / 100, 0.85, 1.85);
    if (spreadValue) spreadValue.textContent = `${Math.round(graphSpreadScale * 100)}%`;
  });
  spreadInput?.addEventListener('change', () => {
    rebuildGraph();
    render();
  });
}

function bindResizableLayout(): void {
  if (!isDashboard || window.matchMedia('(max-width: 900px)').matches) {
    return;
  }

  const topSplitter = document.getElementById('dashboard-top-splitter');
  const mainSplitter = document.getElementById('dashboard-main-splitter');

  topSplitter?.addEventListener('pointerdown', (event) => {
    const layout = document.querySelector('.dashboard-layout.is-dashboard') as HTMLElement | null;
    const aboveFold = document.getElementById('above-fold') as HTMLElement | null;
    if (!layout || !aboveFold) {
      return;
    }

    beginSplitterDrag(event, {
      type: 'vertical',
      element: topSplitter,
      startValue: aboveFold.getBoundingClientRect().height,
      containerSize: layout.getBoundingClientRect().height
    });
  });

  mainSplitter?.addEventListener('pointerdown', (event) => {
    const main = document.getElementById('main-layout') as HTMLElement | null;
    const graphPane = document.querySelector('.graph-pane') as HTMLElement | null;
    if (!main || !graphPane) {
      return;
    }

    beginSplitterDrag(event, {
      type: 'horizontal',
      element: mainSplitter,
      startValue: graphPane.getBoundingClientRect().width,
      containerSize: main.getBoundingClientRect().width
    });
  });
}

function beginSplitterDrag(
  event: PointerEvent,
  input: {
    type: 'horizontal' | 'vertical';
    element: HTMLElement;
    startValue: number;
    containerSize: number;
  }
): void {
  event.preventDefault();

  activeSplitterDrag = {
    type: input.type,
    startX: event.clientX,
    startY: event.clientY,
    startValue: input.startValue,
    containerSize: input.containerSize
  };

  document.body.classList.add('is-resizing', input.type === 'horizontal' ? 'horizontal-resize' : 'vertical-resize');
  input.element.classList.add('active');
  input.element.setPointerCapture?.(event.pointerId);

  const onMove = (moveEvent: PointerEvent) => {
    if (!activeSplitterDrag) {
      return;
    }

    if (activeSplitterDrag.type === 'horizontal') {
      const nextWidth = activeSplitterDrag.startValue + (moveEvent.clientX - activeSplitterDrag.startX);
      const minWidth = Math.min(320, activeSplitterDrag.containerSize * 0.4);
      const maxWidth = Math.max(minWidth + 80, activeSplitterDrag.containerSize - 280);
      graphPaneRatio = clamp(nextWidth / activeSplitterDrag.containerSize, minWidth / activeSplitterDrag.containerSize, maxWidth / activeSplitterDrag.containerSize);
    } else {
      const nextHeight = activeSplitterDrag.startValue + (moveEvent.clientY - activeSplitterDrag.startY);
      const minHeight = 220;
      const maxHeight = Math.max(minHeight + 80, activeSplitterDrag.containerSize - 260);
      dashboardTopHeightPx = clamp(nextHeight, minHeight, maxHeight);
    }

    applyDashboardLayoutVars();
  };

  const onUp = () => {
    activeSplitterDrag = undefined;
    document.body.classList.remove('is-resizing', 'horizontal-resize', 'vertical-resize');
    input.element.classList.remove('active');
    document.removeEventListener('pointermove', onMove);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp, { once: true });
}

function applyDashboardLayoutVars(): void {
  if (!isDashboard) {
    return;
  }

  const layout = document.querySelector('.dashboard-layout.is-dashboard') as HTMLElement | null;
  if (!layout) {
    return;
  }

  layout.style.setProperty('--graph-pane-width', `${(graphPaneRatio * 100).toFixed(1)}%`);
  if (typeof dashboardTopHeightPx === 'number') {
    layout.style.setProperty('--dashboard-top-height', `${dashboardTopHeightPx}px`);
  } else {
    layout.style.removeProperty('--dashboard-top-height');
  }
}

interface FocusedInputState {
  id: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

let lastFocusedInput: FocusedInputState | undefined;

function restoreFocusedInput(focusedInput?: FocusedInputState): void {
  const target = focusedInput ?? lastFocusedInput;
  if (!target) return;
  const el = document.getElementById(target.id) as HTMLInputElement | null;
  if (!el) return;
  el.focus();
  if (target.selectionStart !== null && target.selectionEnd !== null) {
    el.setSelectionRange(target.selectionStart, target.selectionEnd);
  }
  lastFocusedInput = target;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function queueSearchRender(): void {
  if (searchIsComposing) {
    return;
  }

  if (skillSearchTimer) {
    window.clearTimeout(skillSearchTimer);
  }

  skillSearchTimer = window.setTimeout(() => {
    if (searchIsComposing) {
      return;
    }

    searchText = searchDraft;
    skillSearchTimer = undefined;
    rebuildGraph();
    render();
  }, 220);
}

function captureFocusedInput(): FocusedInputState | undefined {
  if (!(document.activeElement instanceof HTMLInputElement)) {
    return lastFocusedInput;
  }

  return captureElementSelection(document.activeElement);
}

function captureElementSelection(input: HTMLInputElement): FocusedInputState {
  return {
    id: input.id,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd
  };
}

function applyLocalFilters(skills: SkillRecord[], search: string, tag?: string): SkillRecord[] {
  const q = search.trim().toLowerCase();
  return skills.filter((sk) => {
    if (tag && !sk.tags.includes(tag)) return false;
    if (!q) return true;
    return `${sk.name} ${sk.description} ${sk.sourceLabel} ${sk.tags.join(' ')}`.toLowerCase().includes(q);
  });
}

function applySelectionListTransform(
  skills: SkillRecord[],
  selectedSkillIds: ReadonlySet<string>,
  onlySelected: boolean
): SkillRecord[] {
  const filtered = onlySelected
    ? skills.filter((skill) => selectedSkillIds.has(skill.id))
    : skills;

  return [...filtered].sort((left, right) => {
    const leftSelected = selectedSkillIds.has(left.id) ? 1 : 0;
    const rightSelected = selectedSkillIds.has(right.id) ? 1 : 0;
    return rightSelected - leftSelected || left.name.localeCompare(right.name);
  });
}

function selectionEchoKey(skillId?: string): string {
  return skillId ?? '__none__';
}

function isSelectionEchoState(previousState: ViewState | undefined, nextState: ViewState): boolean {
  if (!previousState || pendingSelectionEchoKey === null) {
    return false;
  }

  return pendingSelectionEchoKey === selectionEchoKey(nextState.selectedSkillId)
    && previousState.filter.scope === nextState.filter.scope
    && previousState.filter.category === nextState.filter.category
    && previousState.filter.sourceId === nextState.filter.sourceId
    && previousState.snapshot.refreshedAt === nextState.snapshot.refreshedAt
    && previousState.visibleSkills.length === nextState.visibleSkills.length
    && previousState.visibleSkills.every((skill, index) => skill.id === nextState.visibleSkills[index]?.id)
    && previousState.recommendation.selectedSkillIds.join('|') === nextState.recommendation.selectedSkillIds.join('|')
    && previousState.busy === nextState.busy;
}

function getBaseVisibleSkills(s: ViewState): SkillRecord[] {
  return applySelectionListTransform(
    applyLocalFilters(s.visibleSkills, searchText, selectedTag),
    new Set(s.recommendation.selectedSkillIds),
    showSelectedOnly
  );
}

function getFocusedSkillIds(): Set<string> | null {
  if (!focusedNodeId) {
    return null;
  }

  if (graphMode === '2d') {
    return getOverlappingSkillIds2D(focusedNodeId);
  }

  if (!liveSkillNodes.some((node) => node.id === focusedNodeId)) {
    return null;
  }

  return getOverlappingSkillIds3D(focusedNodeId);
}

function getDisplaySkills(s: ViewState): SkillRecord[] {
  const visibleSkills = [...getBaseVisibleSkills(s)];
  const focusedSkillIds = getFocusedSkillIds();
  if (!focusedSkillIds) {
    return visibleSkills;
  }

  const focusedSkills = visibleSkills.filter((skill) => focusedSkillIds.has(skill.id));
  const activeSkillId = s.selectedSkillId;
  if (!activeSkillId || !focusedSkills.some((skill) => skill.id === activeSkillId)) {
    return focusedSkills;
  }

  return focusedSkills.sort((left, right) => {
    const leftActive = left.id === activeSkillId ? 1 : 0;
    const rightActive = right.id === activeSkillId ? 1 : 0;
    return rightActive - leftActive || left.name.localeCompare(right.name);
  });
}

function getSkillRecordById(skillId: string): SkillRecord | undefined {
  return state?.snapshot.skills.find((skill) => skill.id === skillId);
}

function getSharedTagsBetweenSkillIds(leftSkillId: string, rightSkillId: string): string[] {
  const left = getSkillRecordById(leftSkillId);
  const right = getSkillRecordById(rightSkillId);
  if (!left || !right) return [];
  const rightTags = new Set(right.tags);
  return left.tags.filter((tag) => rightTags.has(tag)).sort((a, b) => a.localeCompare(b));
}

function buildSkillTagMetaHtml(skill: SkillRecord): string {
  const meta: string[] = [
    `<span class="pill" title="${escapeAttribute(skill.sourceLabel)}">${escapeHtml(truncateMiddle(skill.sourceLabel, 52))}</span>`,
    `<span class="pill">${escapeHtml(skill.tagSource)} tags</span>`
  ];

  if (skill.tagGeneratedAt) {
    meta.push(`<span class="pill">Updated ${escapeHtml(formatDateTime(skill.tagGeneratedAt))}</span>`);
  }
  if (skill.tagModel) {
    meta.push(`<span class="pill" title="${escapeAttribute(skill.tagModel)}">${escapeHtml(truncateMiddle(skill.tagModel, 28))}</span>`);
  }
  if (skill.tagSource === 'ai') {
    meta.push(`<span class="pill">${skill.tagPromptStale ? 'Prompt changed since run' : 'Prompt current'}</span>`);
  }

  return meta.join('');
}

function buildGraphHoverTooltipHtml(skillId: string): string {
  const skill = getSkillRecordById(skillId);
  if (!skill) return '';

  const overlapCount = Math.max(0, buildLinkedSkillIdSet(skillId).size - 1);
  const sharedTagsWithFocus = focusedNodeId && focusedNodeId !== skillId
    ? getSharedTagsBetweenSkillIds(focusedNodeId, skillId)
    : [];
  const sharedTagHtml = sharedTagsWithFocus.slice(0, 4)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join('');
  const tagHtml = skill.tags.slice(0, 5)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join('');

  return `<div class="graph-hover-title">${escapeHtml(skill.name)}</div>
<div class="graph-hover-meta">
  <span class="pill">${escapeHtml(skill.category)}</span>
  <span class="pill">${skill.tags.length} tags</span>
  <span class="pill">${overlapCount} overlaps</span>
  <span class="pill">${graphColorMode === 'category' ? 'color: category' : `color: ${overlapCount} overlaps`}</span>
</div>
${sharedTagsWithFocus.length > 0
  ? `<div class="graph-hover-copy">Shared with focus</div><div class="graph-hover-tags">${sharedTagHtml}</div>`
  : ''}
<div class="graph-hover-copy">Top tags</div>
<div class="graph-hover-tags">${tagHtml}</div>`;
}

function positionGraphHoverTip(clientX: number, clientY: number): void {
  const wrap = document.getElementById('graph-wrap') as HTMLElement | null;
  const tip = document.getElementById('graph-hover-tip') as HTMLDivElement | null;
  if (!wrap || !tip || tip.hidden) return;

  const rect = wrap.getBoundingClientRect();
  const tipWidth = tip.offsetWidth || 220;
  const tipHeight = tip.offsetHeight || 96;
  const rawLeft = clientX - rect.left + 14;
  const rawTop = clientY - rect.top + 14;
  const left = clamp(rawLeft, 12, Math.max(12, rect.width - tipWidth - 12));
  const top = clamp(rawTop, 12, Math.max(12, rect.height - tipHeight - 12));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function renderGraphHoverTip(skillId: string, pointer?: { x: number; y: number }): void {
  const tip = document.getElementById('graph-hover-tip') as HTMLDivElement | null;
  if (!tip) return;

  tip.innerHTML = buildGraphHoverTooltipHtml(skillId);
  tip.hidden = false;
  if (pointer) {
    positionGraphHoverTip(pointer.x, pointer.y);
  }
}

function hideGraphHoverTip(): void {
  const tip = document.getElementById('graph-hover-tip') as HTMLDivElement | null;
  if (!tip) return;
  tip.hidden = true;
  tip.innerHTML = '';
}

function setHoveredSkill(skillId?: string, pointer?: { x: number; y: number }): void {
  const nextHoveredId = skillId && getSkillRecordById(skillId) ? skillId : undefined;
  const changed = hoveredNodeId !== nextHoveredId;
  hoveredNodeId = nextHoveredId;
  hoverPointer = nextHoveredId && pointer ? pointer : undefined;

  if (nextHoveredId) {
    renderGraphHoverTip(nextHoveredId, pointer);
  } else {
    hideGraphHoverTip();
  }

  if (changed && graphMode === '3d') {
    applyThreeFocus?.(focusedNodeId);
  }
}

function buildSphereLabelLines(skillId: string, focusId: string | undefined, emphasize: boolean): string[] {
  const skill = getSkillRecordById(skillId);
  if (!skill) return [];

  const sharedTags = focusId && focusId !== skillId
    ? getSharedTagsBetweenSkillIds(focusId, skillId)
    : [];
  const firstLine = truncate(skill.name, emphasize ? 24 : 20);

  if (!emphasize) {
    return [firstLine];
  }

  const detail = sharedTags.length > 0
    ? truncate(sharedTags.slice(0, 2).join(' · '), 28)
    : truncate(skill.tags.slice(0, 2).join(' · ') || `${skill.tags.length} tags`, 28);

  return detail ? [firstLine, detail] : [firstLine];
}

function scrollSkillListToTop(): void {
  requestAnimationFrame(() => {
    const list = document.querySelector('.skill-list-wrap') as HTMLElement | null;
    if (list) list.scrollTop = 0;
  });
}

function scrollToSkillCard(skillId: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = document.querySelector(`.skill-card[data-skill-id="${CSS.escape(skillId)}"]`) as HTMLElement | null;
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

function refreshGraphFocusVisibility(): void {
  if (graphMode === '2d') {
    hideGraphHoverTip();
    drawSvgFrame();
    return;
  }
  if (hoveredNodeId) {
    renderGraphHoverTip(hoveredNodeId, hoverPointer);
  }
  applyThreeFocus?.(focusedNodeId);
}

function updateGraphColorLegend(): void {
  const legend = document.getElementById('graph-color-legend');
  if (!legend) return;
  legend.textContent = graphColorMode === 'category'
    ? 'Color = category'
    : 'Color = overlap count';
}

function focusSkillLocally(skillId: string): void {
  if (!state) return;
  focusedNodeId = skillId;
  state = { ...state, selectedSkillId: skillId };
  pendingSelectionEchoKey = selectionEchoKey(skillId);
  vscode.postMessage({ type: 'selectSkill', skillId });
  refreshGraphFocusVisibility();
  updateSkillListOnly();
  scrollToSkillCard(skillId);
}

function clearFocusedSkillLocally(): void {
  focusedNodeId = undefined;
  if (state) {
    state = { ...state, selectedSkillId: undefined };
    pendingSelectionEchoKey = selectionEchoKey(undefined);
    vscode.postMessage({ type: 'selectSkill', skillId: undefined });
  }
  refreshGraphFocusVisibility();
  updateSkillListOnly();
}

// Update only the skill list without rebuilding the whole DOM (preserves 3D canvas)
function updateSkillListOnly(): void {
  if (!state) return;
  const currentState = state;
  const selectedSkillIds = new Set(currentState.recommendation.selectedSkillIds);
  const visibleSkills = getDisplaySkills(currentState);

  const skillCardsHtml = visibleSkills.length === 0
    ? '<div class="empty">No skills match the current filters.</div>'
    : visibleSkills.map((skill) => {
        const isActive = skill.id === currentState.selectedSkillId;
        const isExpanded = skill.id === expandedSkillId;
        const isSelected = selectedSkillIds.has(skill.id);
        const tags = skill.tags.slice(0, 3).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('');
        const expandedHtml = isExpanded ? `
<div class="card-detail">
  <div class="card-detail-actions">
    <button class="btn primary" data-action="open-skill" data-skill-id="${skill.id}">Open file</button>
    <button class="btn ${isSelected ? 'selected-inline' : ''}" data-action="toggle-recommended-skill" data-skill-id="${skill.id}">
      ${isSelected ? 'Selected for Project' : 'Select for Project'}
    </button>
    ${selectedTag ? `<button class="btn" data-action="select-tag-clear">Clear tag filter</button>` : ''}
  </div>
  <div class="tag-grid">
    ${skill.tags.map((t) => `<button class="tag ${selectedTag === t ? 'active-tag' : ''}" data-action="select-tag" data-tag="${escapeAttribute(t)}">${escapeHtml(t)}</button>`).join('')}
  </div>
  <div class="card-meta-full">
    ${buildSkillTagMetaHtml(skill)}
  </div>
</div>` : '';
        return `<article class="skill-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''} ${isSelected ? 'selected-card' : ''}" data-action="toggle-skill" data-skill-id="${skill.id}">
  <div class="card-row">
    <div class="card-main">
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(skill.description)}</p>
    </div>
    <div class="card-pills">
      <button class="mini-toggle ${isSelected ? 'selected' : ''}" data-action="toggle-recommended-skill" data-skill-id="${skill.id}">
        ${isSelected ? 'Selected' : 'Select'}
      </button>
      <span class="pill">${escapeHtml(skill.scope)}</span>
      <span class="pill">${escapeHtml(skill.category)}</span>
      ${tags}
    </div>
  </div>
  ${expandedHtml}
</article>`;
      }).join('');

  const listWrap = document.querySelector('.skill-list-wrap');
  if (listWrap) {
    listWrap.innerHTML = skillCardsHtml;
    listWrap.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const action = el.dataset.action;
        if (!action) return;
        e.stopPropagation();
        if (action === 'toggle-skill' && el.dataset.skillId) {
          const skillId = el.dataset.skillId;
          expandedSkillId = expandedSkillId === skillId ? undefined : skillId;
          focusSkillLocally(skillId);
        } else if (action === 'open-skill' && el.dataset.skillId) {
          vscode.postMessage({ type: 'openSkill', skillId: el.dataset.skillId });
        } else if (action === 'toggle-recommended-skill' && el.dataset.skillId) {
          vscode.postMessage({ type: 'toggleRecommendedSkill', skillId: el.dataset.skillId });
        } else if (action === 'select-tag' && el.dataset.tag) {
          selectedTag = el.dataset.tag;
          focusedNodeId = undefined;
          rebuildGraph();
          updateSkillListOnly();
          scrollSkillListToTop();
        } else if (action === 'select-tag-clear') {
          selectedTag = undefined;
          focusedNodeId = undefined;
          rebuildGraph();
          updateSkillListOnly();
          scrollSkillListToTop();
        }
      });
    });
  }

  // Update pane title count
  const paneTitle = document.querySelector('.right-pane .pane-title');
  if (paneTitle) paneTitle.textContent = `Skills · ${visibleSkills.length} shown`;
  const graphTitle = document.querySelector('.graph-pane .pane-title');
  if (graphTitle) graphTitle.textContent = `Skill Overlap · ${visibleSkills.length} skills`;

  // Update tag filter badge in cat-strip
  const catStrip = document.querySelector('.cat-strip');
  if (catStrip) {
    const existing = catStrip.querySelector('[data-action="select-tag-clear"]');
    if (selectedTag && !existing) {
      const badge = document.createElement('span');
      badge.className = 'cat-chip active';
      badge.style.cursor = 'pointer';
      badge.dataset.action = 'select-tag-clear';
      badge.textContent = `tag: ${selectedTag} ×`;
      badge.addEventListener('click', () => {
        selectedTag = undefined;
        focusedNodeId = undefined;
        if (graphMode === '2d') drawSvgFrame();
        rebuildGraph();
        updateSkillListOnly();
        scrollSkillListToTop();
      });
      catStrip.appendChild(badge);
    } else if (!selectedTag && existing) {
      existing.remove();
    } else if (selectedTag && existing) {
      existing.textContent = `tag: ${selectedTag} ×`;
    }
  }
}

function categoryColor(category: string): string {
  const palette: Record<string, string> = {
    Development: '#8BD3E6',
    Testing: '#FFB86C',
    Design: '#F6C451',
    Documentation: '#A4D4AE',
    DevOps: '#94A3FF',
    Data: '#5CC8A1',
    'AI/ML': '#FF8FAB',
    Security: '#F97373',
    Productivity: '#C8B6FF',
    Research: '#7DD3FC',
    Operations: '#FDBA74',
    Other: '#9CA3AF'
  };
  return palette[category] ?? palette.Other;
}

function resolvedCategoryColor(category: string): string {
  return graphCategoryColors[category] ?? categoryColor(category);
}

function graphNodeColor(skillId: string, category: string): string {
  if (graphColorMode === 'overlap') {
    return overlapColor(skillId);
  }
  return resolvedCategoryColor(category);
}

function overlapColor(skillId: string): string {
  const degrees = new Map<string, number>();
  for (const link of liveSkillLinks) {
    degrees.set(link.sourceId, (degrees.get(link.sourceId) ?? 0) + 1);
    degrees.set(link.targetId, (degrees.get(link.targetId) ?? 0) + 1);
  }

  const degree = degrees.get(skillId) ?? 0;
  const maxDegree = Math.max(1, ...degrees.values());
  const t = maxDegree <= 1 ? 0 : degree / maxDegree;
  return mixHex('#8A94A6', '#FF8A3D', t);
}

function mixHex(left: string, right: string, t: number): string {
  const clamped = clamp(t, 0, 1);
  const [lr, lg, lb] = hexToRgb(left);
  const [rr, rg, rb] = hexToRgb(right);
  const mixed = [
    Math.round(lr + (rr - lr) * clamped),
    Math.round(lg + (rg - lg) * clamped),
    Math.round(lb + (rb - lb) * clamped)
  ];
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(value: string): [number, number, number] {
  const normalized = value.replace('#', '');
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function readGraphPrefs(): {
  colorMode?: 'category' | 'overlap';
  categoryColors?: Record<string, string>;
} {
  try {
    const raw = window.localStorage.getItem('skill-map.graph-prefs.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as {
      colorMode?: 'category' | 'overlap';
      categoryColors?: Record<string, string>;
    };
    return {
      colorMode: parsed.colorMode === 'overlap' ? 'overlap' : parsed.colorMode === 'category' ? 'category' : undefined,
      categoryColors: parsed.categoryColors ?? {}
    };
  } catch {
    return {};
  }
}

function readLayoutPrefs(): {
  topPanelsCollapsed?: boolean;
} {
  try {
    const raw = window.localStorage.getItem('skillmatch.layout-prefs.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { topPanelsCollapsed?: boolean };
    return {
      topPanelsCollapsed: typeof parsed.topPanelsCollapsed === 'boolean' ? parsed.topPanelsCollapsed : undefined
    };
  } catch {
    return {};
  }
}

function persistGraphPrefs(): void {
  try {
    window.localStorage.setItem('skill-map.graph-prefs.v1', JSON.stringify({
      colorMode: graphColorMode,
      categoryColors: graphCategoryColors
    }));
  } catch {
    // Ignore persistence failures inside the webview.
  }
}

function persistLayoutPrefs(): void {
  try {
    window.localStorage.setItem('skillmatch.layout-prefs.v1', JSON.stringify({
      topPanelsCollapsed
    }));
  } catch {
    // Ignore persistence failures inside the webview.
  }
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function truncate(v: string, len: number): string {
  return v.length > len ? `${v.slice(0, len - 1)}…` : v;
}

function truncateMiddle(v: string, len: number): string {
  if (v.length <= len) return v;
  const visible = Math.max(8, len - 1);
  const head = Math.ceil(visible * 0.58);
  const tail = Math.max(4, visible - head);
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function escapeAttribute(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
