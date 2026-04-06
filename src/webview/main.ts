import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force';
import * as THREE from 'three';

import { applyCategoryFilter, applyScopeFilter } from '../shared/filterState';
import type { ExtensionToWebviewMessage, SkillFilter, SkillRecord, TagGraphLink, TagGraphNode, ViewState, WebviewToExtensionMessage } from '../shared/types';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  setState(value: unknown): void;
  getState(): unknown;
};

type GraphNode = TagGraphNode & SimulationNodeDatum & { radius: number; vx?: number; vy?: number };
type GraphLink = TagGraphLink & SimulationLinkDatum<GraphNode>;

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById('app');
if (!rootElement) throw new Error('Skill Map webview root was not found.');
const app = rootElement as HTMLDivElement;

const bootState = (() => {
  const raw = app.getAttribute('data-state');
  if (!raw) return undefined;
  try { return JSON.parse(raw) as ViewState; } catch { return undefined; }
})();

const isDashboard = app.getAttribute('data-dashboard') === 'true';

let state = (vscode.getState() as ViewState | undefined) ?? bootState;
let searchText = '';
let searchDraft = '';
let questionDraft = '';
let selectedTag: string | undefined;
let expandedSkillId: string | undefined;
let skillSearchTimer: number | undefined;
let graphMode: '2d' | '3d' = '2d';
let settingsOpen = false;

// Live D3 simulation state
let simulation: ReturnType<typeof forceSimulation<GraphNode>> | null = null;
let liveNodes: GraphNode[] = [];
let liveLinks: GraphLink[] = [];
let dragNode: GraphNode | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let svgWidth = 0;
let svgHeight = 0;
// Three.js sphere state
let threeRenderer: THREE.WebGLRenderer | null = null;
let threeScene: THREE.Scene | null = null;
let threeCamera: THREE.PerspectiveCamera | null = null;
let threeAnimFrame: number | null = null;
let threeNodeMeshes: Array<{ mesh: THREE.Mesh; label: string }> = [];
let sphereIsDragging = false;
let sphereDragStart = { x: 0, y: 0 };
let sphereRotation = { x: 0.3, y: 0 };
let sphereAutoRotate = true;

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'state') {
    if (!questionDraft && message.state.recommendation.question) {
      questionDraft = message.state.recommendation.question;
    }
    state = message.state;
    vscode.setState(state);
    rebuildGraph();
    render();
  }
});

vscode.postMessage({ type: 'ready' });
render();
rebuildGraph();

// ── Render ──────────────────────────────────────────────────────────────────

function render(): void {
  const s = state;
  if (!s) {
    app.innerHTML = '<div style="padding:24px;opacity:0.6;font-size:12px;">Waiting for Skill Map…</div>';
    return;
  }

  const visibleSkills = applyLocalFilters(s.visibleSkills, searchText, selectedTag);
  const selectedSkill =
    s.snapshot.skills.find((sk) => sk.id === s.selectedSkillId) ??
    visibleSkills.find((sk) => sk.id === s.selectedSkillId) ??
    visibleSkills[0] ??
    s.visibleSkills[0];

  const counts = s.snapshot.counts;
  const selectedWorkspaceId = s.projectConfig.selectedWorkspaceId;
  const selectedRecommendationCount = s.recommendation.selectedSkillIds.length;
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
      return `<button class="cat-chip ${active ? 'active' : ''}" data-action="category" data-category="${escapeAttribute(cat.name)}">
        ${escapeHtml(cat.name)}<span class="cnt">${cat.count}</span>
      </button>`;
    })
    .join('');

  // Skill cards — inline expanded detail, no bottom drawer
  const skillCardsHtml = visibleSkills.length === 0
    ? '<div class="empty">No skills match the current filters.</div>'
    : visibleSkills.map((skill) => {
        const isActive = skill.id === selectedSkill?.id;
        const isExpanded = skill.id === expandedSkillId;
        const tags = skill.tags.slice(0, 3).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('');

        const expandedHtml = isExpanded ? `
<div class="card-detail">
  <div class="card-detail-actions">
    <button class="btn primary" data-action="open-skill" data-skill-id="${skill.id}">Open file</button>
    ${selectedTag ? `<button class="btn" data-action="select-tag-clear">Clear tag filter</button>` : ''}
  </div>
  <div class="tag-grid">
    ${skill.tags.map((t) => `<button class="tag ${selectedTag === t ? 'active-tag' : ''}" data-action="select-tag" data-tag="${escapeAttribute(t)}">${escapeHtml(t)}</button>`).join('')}
  </div>
  <div class="card-meta-full">
    <span class="pill" title="${escapeAttribute(skill.sourceLabel)}">${escapeHtml(truncateMiddle(skill.sourceLabel, 52))}</span>
    <span class="pill">${escapeHtml(skill.tagSource)} tags</span>
  </div>
</div>` : '';

        return `<article class="skill-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''}" data-action="toggle-skill" data-skill-id="${skill.id}">
  <div class="card-row">
    <div class="card-main">
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(skill.description)}</p>
    </div>
    <div class="card-pills">
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

  app.innerHTML = `
<nav class="topbar">
  <span class="topbar-title">${isDashboard ? 'Skill Map Dashboard' : 'Skill Map'}</span>
  <div class="scope-tabs">${scopeTabsHtml}</div>
  <div class="topbar-sep"></div>
  <input id="skill-search" class="topbar-search" type="search" placeholder="Search skills…" value="${escapeAttribute(searchDraft)}" />
  <div class="topbar-sep"></div>
  <div class="status-dot ${s.busy ? 'busy' : ''}"></div>
  <span class="status-text">${escapeHtml(s.statusMessage ?? 'Ready')}</span>
  <div class="settings-wrap">
    <button class="icon-btn" data-action="toggle-settings" title="Settings">⚙</button>
    <div class="settings-popover ${settingsOpen ? 'open' : ''}">
      <button class="btn" data-action="refresh">${s.busy ? 'Refreshing…' : 'Refresh'}</button>
      <button class="btn" data-action="generate-tags">Generate AI Tags</button>
      <button class="btn" data-action="configure-key">${s.snapshot.keyConfigured ? 'Rotate OpenRouter Key' : 'Configure OpenRouter Key'}</button>
      ${s.snapshot.keyConfigured ? '<button class="btn" data-action="clear-key">Clear Key</button>' : ''}
      <button class="btn" data-action="clear-filter">Clear All Filters</button>
    </div>
  </div>
</nav>

<section class="control-deck">
  <article class="setup-card setup-card-emphasis">
    <div class="setup-kicker">OpenRouter</div>
    <h2>${escapeHtml(s.openRouter.model)}</h2>
    <p>${escapeHtml(
      s.openRouter.keyConfigured
        ? 'Ready for AI tag generation and skill recommendation.'
        : 'Configure the OpenRouter key to enable AI ranking and enriched tags.'
    )}</p>
    <div class="setup-actions">
      <button class="btn primary" data-action="configure-key">${s.openRouter.keyConfigured ? 'Rotate Key' : 'Configure Key'}</button>
      <button class="btn" data-action="open-openrouter-settings">Model Settings</button>
    </div>
    <div class="setup-foot">${escapeHtml(truncateMiddle(s.openRouter.baseUrl, 48))}</div>
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
      <p class="recommend-copy">Ask in natural language. Skill Map queries LightRAG, then uses your OpenRouter model to rank the best skills.</p>
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
</div>

<div class="main">
  <div class="graph-pane">
    <div class="pane-header">
      <span class="pane-title">Tag Overlap · ${visibleSkills.length} skills</span>
      <div class="view-toggle">
        <button class="view-btn ${graphMode === '2d' ? 'active' : ''}" data-action="graph-mode" data-mode="2d">2D</button>
        <button class="view-btn ${graphMode === '3d' ? 'active' : ''}" data-action="graph-mode" data-mode="3d">3D</button>
      </div>
    </div>
    <div class="graph-wrap" id="graph-wrap">
      <svg id="tag-graph" viewBox="0 0 720 480" role="img" aria-label="Skill tag overlap graph" style="${graphMode === '3d' ? 'display:none' : ''}"></svg>
      <div id="tag-graph-3d" style="${graphMode === '3d' ? 'display:block' : 'display:none'}"></div>
      <span class="graph-hint">${graphMode === '2d' ? 'Drag nodes · Click to filter' : 'Drag to rotate · Scroll to zoom · Click to filter'}</span>
    </div>
  </div>

  <div class="right-pane">
    <div class="pane-header">
      <span class="pane-title">Skills · ${visibleSkills.length} shown</span>
    </div>
    <div class="skill-list-wrap">${skillCardsHtml}</div>
  </div>
</div>`;

  bindDomEvents();
  restoreFocusedInput();

  if (graphMode === '2d') {
    attachSvgToSimulation();
  } else {
    renderSphere(visibleSkills);
  }
}

// ── Graph: live D3 simulation ────────────────────────────────────────────────

function rebuildGraph(): void {
  if (!state) return;

  const visibleSkills = applyLocalFilters(state.visibleSkills, searchText, selectedTag);
  const graph = filterGraphForVisible(state, visibleSkills);

  if (simulation) {
    simulation.stop();
    simulation = null;
  }

  liveNodes = graph.nodes.map((n) => ({
    ...n,
    radius: 14 + Math.sqrt(n.count) * 10,
    x: undefined,
    y: undefined
  }));
  liveLinks = graph.links.map((l) => ({ ...l }));

  if (liveNodes.length === 0) return;

  simulation = forceSimulation(liveNodes)
    .force('center', forceCenter(360, 240))
    .force('charge', forceManyBody<GraphNode>().strength(-120))
    .force('collide', forceCollide<GraphNode>().radius((n: GraphNode) => n.radius + 5))
    .force(
      'link',
      forceLink<GraphNode, GraphLink>(liveLinks)
        .id((n: GraphNode) => n.id)
        .distance((l: GraphLink) => Math.max(50, 140 - l.overlap * 8))
        .strength((l: GraphLink) => Math.min(1, 0.1 + l.weight * 0.6))
    )
    .alphaDecay(0.02)
    .on('tick', () => {
      if (graphMode === '2d') drawSvgFrame();
    });
}

function attachSvgToSimulation(): void {
  const svg = document.getElementById('tag-graph') as SVGSVGElement | null;
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  svgWidth = rect.width || 720;
  svgHeight = rect.height || 480;

  if (liveNodes.length === 0) {
    svg.innerHTML = `<text x="${svgWidth / 2}" y="${svgHeight / 2}" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="12">No tags for current filter.</text>`;
    return;
  }

  // Initial draw
  drawSvgFrame();

  // Drag events
  svg.addEventListener('mousedown', onSvgMouseDown);
  svg.addEventListener('mousemove', onSvgMouseMove);
  svg.addEventListener('mouseup', onSvgMouseUp);
  svg.addEventListener('mouseleave', onSvgMouseUp);
}

function drawSvgFrame(): void {
  const svg = document.getElementById('tag-graph') as SVGSVGElement | null;
  if (!svg || liveNodes.length === 0) return;

  const W = 720;
  const H = 480;

  const linkMarkup = liveLinks.map((l) => {
    const s = l.source as GraphNode;
    const t = l.target as GraphNode;
    const sx = clamp(s.x ?? W / 2, 0, W);
    const sy = clamp(s.y ?? H / 2, 0, H);
    const tx = clamp(t.x ?? W / 2, 0, W);
    const ty = clamp(t.y ?? H / 2, 0, H);
    const opacity = Math.min(0.5, 0.12 + l.weight * 0.38);
    const width = 0.8 + l.overlap * 0.6;
    return `<line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="var(--vscode-textLink-foreground)" stroke-opacity="${opacity}" stroke-width="${width}"/>`;
  }).join('');

  const nodeMarkup = liveNodes.map((n) => {
    const nx = clamp(n.x ?? W / 2, n.radius, W - n.radius);
    const ny = clamp(n.y ?? H / 2, n.radius, H - n.radius);
    const fill = categoryColor(n.category);
    const isHighlighted = selectedTag === n.label;
    const isDimmed = selectedTag !== undefined && !isHighlighted;
    const fontSize = Math.max(9, Math.min(13, n.radius / 2.2));
    const showLabel = n.radius > 20;
    return `<g class="graph-node" data-tag="${escapeAttribute(n.label)}" style="cursor:pointer;opacity:${isDimmed ? 0.2 : 1}">
  <circle cx="${nx}" cy="${ny}" r="${n.radius}" fill="${fill}" fill-opacity="${isHighlighted ? 0.95 : 0.7}" stroke="${fill}" stroke-width="${isHighlighted ? 2.5 : 1.5}"/>
  ${showLabel ? `<text x="${nx}" y="${ny + 4}" text-anchor="middle" fill="currentColor" font-size="${fontSize}" pointer-events="none" font-weight="${isHighlighted ? '600' : '400'}">${escapeHtml(truncate(n.label, 16))}</text>` : ''}
  <title>${escapeHtml(n.label)} · ${n.count} skills</title>
</g>`;
  }).join('');

  svg.innerHTML = `<g class="links">${linkMarkup}</g><g class="nodes">${nodeMarkup}</g>`;

  // Re-bind click events
  svg.querySelectorAll<SVGGElement>('.graph-node').forEach((g) => {
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = g.dataset.tag;
      if (!tag) return;
      selectedTag = selectedTag === tag ? undefined : tag;
      rebuildGraph();
      render();
    });
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const tag = g.dataset.tag;
      const node = liveNodes.find((n) => n.label === tag);
      if (!node || !simulation) return;
      dragNode = node;
      simulation.alphaTarget(0.3).restart();
      const svgEl = document.getElementById('tag-graph') as unknown as SVGSVGElement;
      const pt = svgPoint(svgEl, e.clientX, e.clientY);
      dragOffsetX = (node.x ?? 0) - pt.x;
      dragOffsetY = (node.y ?? 0) - pt.y;
      node.fx = node.x;
      node.fy = node.y;
    });
  });
}

function onSvgMouseDown(_e: MouseEvent): void { /* handled per-node */ }

function onSvgMouseMove(e: MouseEvent): void {
  if (!dragNode || !simulation) return;
  const svg = document.getElementById('tag-graph') as unknown as SVGSVGElement;
  const pt = svgPoint(svg, e.clientX, e.clientY);
  dragNode.fx = pt.x + dragOffsetX;
  dragNode.fy = pt.y + dragOffsetY;
}

function onSvgMouseUp(): void {
  if (!dragNode || !simulation) return;
  dragNode.fx = undefined;
  dragNode.fy = undefined;
  dragNode = null;
  simulation.alphaTarget(0);
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

// ── Graph: 3D sphere (Three.js) ──────────────────────────────────────────────

function disposeThree(): void {
  if (threeAnimFrame !== null) {
    cancelAnimationFrame(threeAnimFrame);
    threeAnimFrame = null;
  }
  if (threeRenderer) {
    threeRenderer.dispose();
    threeRenderer = null;
  }
  threeScene = null;
  threeCamera = null;
  threeNodeMeshes = [];
}

function renderSphere(_visibleSkills: SkillRecord[]): void {
  disposeThree();

  const wrap = document.getElementById('tag-graph-3d') as HTMLElement | null;
  if (!wrap) return;

  if (liveNodes.length === 0) {
    wrap.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0.5;font-size:12px;">No tags for current filter.</div>';
    return;
  }

  wrap.innerHTML = '';

  const W = wrap.clientWidth || 600;
  const H = wrap.clientHeight || 400;

  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  threeCamera.position.z = 7;

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setSize(W, H);
  threeRenderer.setPixelRatio(window.devicePixelRatio);
  threeRenderer.setClearColor(0x000000, 0);
  wrap.appendChild(threeRenderer.domElement);

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(4, 6, 6);
  threeScene.add(dir);

  const root = new THREE.Group();
  threeScene.add(root);

  // ── Layout: force-directed in 3D space ──────────────────────────────────
  // Nodes start on a Fibonacci sphere, then we pull overlapping pairs closer.
  const n = liveNodes.length;
  const maxCount = Math.max(...liveNodes.map((nd) => nd.count), 1);

  // Build overlap lookup: key = sorted ids, value = overlap count
  const overlapMap = new Map<string, number>();
  for (const link of liveLinks) {
    const src = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source as string;
    const tgt = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target as string;
    overlapMap.set([src, tgt].sort().join('||'), link.overlap);
  }

  // Initial positions on a sphere of radius DIST
  const DIST = 2.8;
  type Pos3 = { x: number; y: number; z: number };
  const positions = new Map<string, Pos3>();

  liveNodes.forEach((node, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    positions.set(node.id, {
      x: DIST * Math.sin(phi) * Math.cos(theta),
      y: DIST * Math.cos(phi),
      z: DIST * Math.sin(phi) * Math.sin(theta)
    });
  });

  // Simple spring relaxation: pull overlapping nodes together, push non-overlapping apart
  const nodeIds = liveNodes.map((nd) => nd.id);
  for (let iter = 0; iter < 80; iter++) {
    const forces = new Map<string, Pos3>(nodeIds.map((id) => [id, { x: 0, y: 0, z: 0 }]));

    // Repulsion between all pairs
    for (let a = 0; a < nodeIds.length; a++) {
      for (let b = a + 1; b < nodeIds.length; b++) {
        const idA = nodeIds[a];
        const idB = nodeIds[b];
        const pA = positions.get(idA)!;
        const pB = positions.get(idB)!;
        const dx = pA.x - pB.x;
        const dy = pA.y - pB.y;
        const dz = pA.z - pB.z;
        const dist2 = dx * dx + dy * dy + dz * dz + 0.001;
        const dist = Math.sqrt(dist2);

        const key = [idA, idB].sort().join('||');
        const overlap = overlapMap.get(key) ?? 0;

        // Target distance: closer for high overlap, farther for none
        // nodeR for each node
        const rA = 0.15 + (liveNodes[a].count / maxCount) * 0.45;
        const rB = 0.15 + (liveNodes[b].count / maxCount) * 0.45;
        const targetDist = overlap > 0
          ? Math.max(rA + rB - (overlap / maxCount) * (rA + rB) * 0.85, rA * 0.3 + rB * 0.3)
          : rA + rB + 0.6 + (1 - overlap / maxCount) * 1.2;

        const f = (dist - targetDist) * 0.08 / dist;
        const fx = dx * f;
        const fy = dy * f;
        const fz = dz * f;

        const fA = forces.get(idA)!;
        const fB = forces.get(idB)!;
        fA.x -= fx; fA.y -= fy; fA.z -= fz;
        fB.x += fx; fB.y += fy; fB.z += fz;
      }
    }

    // Apply forces
    for (const id of nodeIds) {
      const p = positions.get(id)!;
      const f = forces.get(id)!;
      p.x += f.x;
      p.y += f.y;
      p.z += f.z;
    }
  }

  // ── Build meshes ──────────────────────────────────────────────────────────
  threeNodeMeshes = [];

  liveNodes.forEach((node) => {
    const pos = positions.get(node.id)!;
    const nodeR = 0.15 + (node.count / maxCount) * 0.45;
    const color = new THREE.Color(categoryColor(node.category));
    const isHighlighted = selectedTag === node.label;
    const isDimmed = selectedTag !== undefined && !isHighlighted;

    // Outer wireframe shell
    const wireGeo = new THREE.SphereGeometry(nodeR, 18, 14);
    const wireMat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      opacity: isDimmed ? 0.06 : (isHighlighted ? 0.9 : 0.45),
      transparent: true
    });
    const wireMesh = new THREE.Mesh(wireGeo, wireMat);
    wireMesh.position.set(pos.x, pos.y, pos.z);
    wireMesh.userData = { tag: node.label };
    root.add(wireMesh);
    threeNodeMeshes.push({ mesh: wireMesh, label: node.label });

    // Translucent fill — this is what creates the visible overlap when spheres intersect
    const fillGeo = new THREE.SphereGeometry(nodeR, 18, 14);
    const fillMat = new THREE.MeshPhongMaterial({
      color,
      opacity: isDimmed ? 0.02 : (isHighlighted ? 0.35 : 0.13),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const fillMesh = new THREE.Mesh(fillGeo, fillMat);
    fillMesh.position.set(pos.x, pos.y, pos.z);
    root.add(fillMesh);

    // Canvas label sprite
    const cvs = document.createElement('canvas');
    cvs.width = 256; cvs.height = 56;
    const ctx = cvs.getContext('2d');
    if (ctx) {
      ctx.font = 'bold 20px sans-serif';
      ctx.fillStyle = isDimmed ? 'rgba(255,255,255,0.2)' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(node.label, 20), 128, 28);
      const tex = new THREE.CanvasTexture(cvs);
      const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: isDimmed ? 0.15 : 0.88 });
      const sprite = new THREE.Sprite(spriteMat);
      const labelOffset = nodeR + 0.12;
      const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || 1;
      sprite.position.set(
        pos.x + (pos.x / len) * labelOffset,
        pos.y + (pos.y / len) * labelOffset + nodeR * 0.5,
        pos.z + (pos.z / len) * labelOffset
      );
      sprite.scale.set(0.65, 0.145, 1);
      root.add(sprite);
    }
  });

  // ── Mouse orbit + scroll zoom ─────────────────────────────────────────────
  const canvas = threeRenderer.domElement;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('mousedown', (e) => {
    sphereIsDragging = true;
    sphereAutoRotate = false;
    sphereDragStart = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!sphereIsDragging) return;
    sphereRotation.y += (e.clientX - sphereDragStart.x) * 0.007;
    sphereRotation.x += (e.clientY - sphereDragStart.y) * 0.007;
    sphereDragStart = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!sphereIsDragging) return;
    sphereIsDragging = false;
    canvas.style.cursor = 'grab';

    // Click detection (barely moved = click)
    const moved = Math.abs(e.clientX - sphereDragStart.x) + Math.abs(e.clientY - sphereDragStart.y);
    if (moved < 5 && threeCamera && threeRenderer) {
      const rect = threeRenderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, threeCamera);
      const hits = raycaster.intersectObjects(threeNodeMeshes.map((m) => m.mesh));
      if (hits.length > 0) {
        const tag = hits[0].object.userData.tag as string | undefined;
        if (tag) {
          selectedTag = selectedTag === tag ? undefined : tag;
          rebuildGraph();
          render();
          return;
        }
      }
    }
    setTimeout(() => { sphereAutoRotate = true; }, 1800);
  });

  canvas.addEventListener('mouseleave', () => {
    sphereIsDragging = false;
    canvas.style.cursor = 'grab';
  });

  // Scroll to zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!threeCamera) return;
    threeCamera.position.z = Math.max(2, Math.min(20, threeCamera.position.z + e.deltaY * 0.01));
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
}

// ── DOM events ───────────────────────────────────────────────────────────────

function bindDomEvents(): void {
  app.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const action = el.dataset.action;
      if (!action || !state) return;

      switch (action) {
        case 'toggle-settings':
          settingsOpen = !settingsOpen;
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
        case 'clear-filter':
          settingsOpen = false;
          selectedTag = undefined;
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
            state = { ...state, selectedSkillId: skillId };
            vscode.postMessage({ type: 'selectSkill', skillId });
            render();
          }
          break;
        case 'open-skill':
          if (el.dataset.skillId) {
            vscode.postMessage({ type: 'openSkill', skillId: el.dataset.skillId });
          }
          break;
        case 'select-tag':
          selectedTag = el.dataset.tag;
          rebuildGraph();
          render();
          break;
        case 'select-tag-clear':
          selectedTag = undefined;
          rebuildGraph();
          render();
          break;
        case 'graph-mode': {
          const newMode = el.dataset.mode as '2d' | '3d';
          if (newMode === graphMode) break;
          graphMode = newMode;
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
    lastFocusedInputId = 'skill-search';
    searchDraft = (e.target as HTMLInputElement).value;
    if (skillSearchTimer) window.clearTimeout(skillSearchTimer);
    skillSearchTimer = window.setTimeout(() => {
      searchText = searchDraft;
      skillSearchTimer = undefined;
      rebuildGraph();
      render();
    }, 150);
  });

  const question = document.getElementById('skill-question') as HTMLInputElement | null;
  question?.addEventListener('input', (e) => {
    lastFocusedInputId = 'skill-question';
    questionDraft = (e.target as HTMLInputElement).value;
  });
  question?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
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
}

let lastFocusedInputId: string | undefined;

function restoreFocusedInput(): void {
  if (!lastFocusedInputId) return;
  const el = document.getElementById(lastFocusedInputId) as HTMLInputElement | null;
  el?.focus();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyLocalFilters(skills: SkillRecord[], search: string, tag?: string): SkillRecord[] {
  const q = search.trim().toLowerCase();
  return skills.filter((sk) => {
    if (tag && !sk.tags.includes(tag)) return false;
    if (!q) return true;
    return `${sk.name} ${sk.description} ${sk.sourceLabel} ${sk.tags.join(' ')}`.toLowerCase().includes(q);
  });
}

function filterGraphForVisible(s: ViewState, visibleSkills: SkillRecord[]) {
  const ids = new Set(visibleSkills.map((sk) => sk.id));
  const nodes = s.graph.nodes.filter((n) => n.skillIds.some((id) => ids.has(id)));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = s.graph.links.filter((l) => nodeIds.has(l.source as string) && nodeIds.has(l.target as string));
  return { nodes, links };
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

function escapeAttribute(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
