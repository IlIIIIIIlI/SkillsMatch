import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force';

import { applyCategoryFilter, applyScopeFilter, applySourceFilter } from '../shared/filterState';
import { filterSourceSummaries } from '../shared/sourceSearch';
import type { ExtensionToWebviewMessage, SkillFilter, SkillRecord, TagGraphLink, TagGraphNode, ViewState, WebviewToExtensionMessage } from '../shared/types';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  setState(value: unknown): void;
  getState(): unknown;
};

type GraphNode = TagGraphNode & SimulationNodeDatum & { radius: number };
type GraphLink = TagGraphLink & SimulationLinkDatum<GraphNode>;

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById('app');

if (!rootElement) {
  throw new Error('Skill Map webview root was not found.');
}

const app = rootElement as HTMLDivElement;

const bootState = (() => {
  const raw = app.getAttribute('data-state');
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ViewState;
  } catch {
    return undefined;
  }
})();

let state = (vscode.getState() as ViewState | undefined) ?? bootState;
let searchText = '';
let searchDraft = '';
let sourceSearchText = '';
let sourceSearchDraft = '';
let selectedTag: string | undefined;
let skillSearchTimer: number | undefined;
let sourceSearchTimer: number | undefined;
const graphMarkupCache = new Map<string, string>();

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'state') {
    state = message.state;
    vscode.setState(state);
    render();
  }
});

vscode.postMessage({ type: 'ready' });
render();

function render(): void {
  const currentState = state;
  if (!currentState) {
    app.innerHTML = '<div class="shell"><div class="empty">Waiting for Skill Map state…</div></div>';
    return;
  }

  const focusedInput = captureFocusedInput();

  const visibleSkills = applyLocalFilters(currentState.visibleSkills, searchText, selectedTag);
  const selectedSkill =
    visibleSkills.find((skill) => skill.id === currentState.selectedSkillId) ??
    visibleSkills[0] ??
    currentState.visibleSkills[0];

  const keyLabel = currentState.snapshot.keyConfigured ? 'OpenRouter connected' : 'OpenRouter not configured';
  const activeFilterLabel = describeFilter(currentState.filter);
  const categoryChips = currentState.snapshot.categories
    .map((category) => {
      const isActive = currentState.filter.category === category.name;
      return `<button class="chip ${isActive ? 'active' : ''}" data-action="category" data-category="${escapeAttribute(category.name)}">${escapeHtml(category.name)} <strong>${category.count}</strong></button>`;
    })
    .join('');

  const matchingSources = filterSourceSummaries(currentState.snapshot.sources, currentState.filter, sourceSearchText);
  const visibleSources = matchingSources.slice(0, sourceSearchText ? 60 : 24);
  const sourceChips = visibleSources
    .map((source) => {
      const isActive = currentState.filter.sourceId === source.id;
      const displayLabel = truncateMiddle(source.label, 64);
      return `<button class="chip ${isActive ? 'active' : ''}" data-action="source" data-source="${escapeAttribute(source.id)}" data-scope="${source.scope}" title="${escapeAttribute(source.label)}">${escapeHtml(displayLabel)} <strong>${source.count}</strong></button>`;
    })
    .join('');

  const skillCards = visibleSkills.length === 0
    ? '<div class="empty">No skills match the current category, source, search, or tag filters.</div>'
    : visibleSkills
        .map((skill) => {
          const isActive = skill.id === selectedSkill?.id;
          const tags = skill.tags.slice(0, 4).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join('');
          return `<article class="skill-card ${isActive ? 'active' : ''}" data-action="select-skill" data-skill-id="${skill.id}">
  <h3>${escapeHtml(skill.name)}</h3>
  <p>${escapeHtml(skill.description)}</p>
  <div class="meta-row">
    <span class="pill">${escapeHtml(skill.scope)}</span>
    <span class="pill">${escapeHtml(skill.category)}</span>
    <span class="pill">${escapeHtml(skill.tagSource)}</span>
  </div>
  <div class="meta-row">${tags}</div>
</article>`;
        })
        .join('');

  const detailHtml = selectedSkill
    ? `<div class="detail">
  <header>
    <div class="meta-row">
      <span class="pill">${escapeHtml(selectedSkill.scope)}</span>
      <span class="pill">${escapeHtml(selectedSkill.category)}</span>
      <span class="pill" title="${escapeAttribute(selectedSkill.sourceLabel)}">${escapeHtml(truncateMiddle(selectedSkill.sourceLabel, 64))}</span>
    </div>
    <h2>${escapeHtml(selectedSkill.name)}</h2>
    <p>${escapeHtml(selectedSkill.description)}</p>
  </header>
  <div class="toolbar">
    <button class="primary" data-action="open-skill" data-skill-id="${selectedSkill.id}">Open Skill</button>
    <button data-action="select-tag-clear">Clear Tag Highlight</button>
  </div>
  <div class="tag-grid">
    ${selectedSkill.tags.map((tag) => `<button class="tag" data-action="select-tag" data-tag="${escapeAttribute(tag)}">${escapeHtml(tag)}</button>`).join('')}
  </div>
</div>`
    : '<div class="detail-empty">Choose a skill to inspect its description, tags, and source.</div>';

  app.innerHTML = `<div class="shell">
  <section class="hero">
    <div class="section-head">
      <div>
        <h1>Skill Map</h1>
        <p>Find local, workspace, and online skills in one sidebar, classify them from their descriptions, and inspect tag overlap as circles.</p>
      </div>
      <div class="status">${escapeHtml(currentState.statusMessage ?? 'Ready')}</div>
    </div>
    <div class="toolbar">
      <button class="primary" data-action="refresh">${currentState.busy ? 'Refreshing…' : 'Refresh'}</button>
      <button data-action="configure-key">${currentState.snapshot.keyConfigured ? 'Rotate Key' : 'Configure Key'}</button>
      <button data-action="generate-tags">Generate AI Tags</button>
      <button data-action="clear-filter">Clear Filters</button>
      <button data-action="clear-key">Clear Key</button>
      <span class="chip">${escapeHtml(keyLabel)}</span>
      <span class="chip">Filter: ${escapeHtml(activeFilterLabel)}</span>
      ${selectedTag ? `<span class="chip active">Tag: ${escapeHtml(selectedTag)}</span>` : ''}
    </div>
    <div class="metrics">
      ${renderMetric('All', currentState.snapshot.counts.all)}
      ${renderMetric('Workspace', currentState.snapshot.counts.workspace)}
      ${renderMetric('Global', currentState.snapshot.counts.global)}
      ${renderMetric('Online', currentState.snapshot.counts.online)}
      ${renderMetric('Categories', currentState.snapshot.counts.categories)}
      ${renderMetric('Visible', visibleSkills.length)}
    </div>
  </section>

  <div class="grid">
    <section class="filters">
      <div class="section-head">
        <h2>Classification</h2>
        <span class="status">Description-driven categories and source filters</span>
      </div>
      <div class="chip-row">
        <button class="chip ${currentState.filter.scope === 'all' ? 'active' : ''}" data-action="scope" data-scope="all">All</button>
        <button class="chip ${currentState.filter.scope === 'workspace' ? 'active' : ''}" data-action="scope" data-scope="workspace">Workspace</button>
        <button class="chip ${currentState.filter.scope === 'global' ? 'active' : ''}" data-action="scope" data-scope="global">Global</button>
        <button class="chip ${currentState.filter.scope === 'online' ? 'active' : ''}" data-action="scope" data-scope="online">Online</button>
      </div>
      <div class="section-head" style="margin-top: 14px;">
        <h2>Categories</h2>
        <span class="status">${currentState.snapshot.categories.length} groups</span>
      </div>
      <div class="chip-row">${categoryChips}</div>
      <div class="section-head" style="margin-top: 14px;">
        <h2>Sources</h2>
        <span class="status">${visibleSources.length}/${matchingSources.length} shown · ${currentState.snapshot.sources.length} total</span>
      </div>
      <input id="source-search" class="search" type="search" placeholder="Search sources by label or path" value="${escapeAttribute(sourceSearchDraft)}" />
      <div class="chip-row">${sourceChips}</div>
    </section>

    <div class="content-grid">
      <div class="stack">
        <section class="visual">
          <div class="section-head">
            <h2>Tag Overlap</h2>
            <span class="status">Circle size = tag frequency, line weight = shared skills</span>
          </div>
          <div class="graph-wrap">
            <svg id="tag-graph" viewBox="0 0 720 420" role="img" aria-label="Skill tag overlap graph"></svg>
          </div>
          <div class="legend">${buildLegend(currentState.visibleSkills)}</div>
        </section>

        <section class="list">
          <div class="section-head">
            <h2>Skills</h2>
            <span class="status">${visibleSkills.length} shown</span>
          </div>
          <input id="skill-search" class="search" type="search" placeholder="Search by name, description, tag, or source" value="${escapeAttribute(searchDraft)}" />
          <div class="skill-list">${skillCards}</div>
        </section>
      </div>

      <aside class="detail">
        <div class="section-head">
          <h2>Selected Skill</h2>
          <span class="status" title="${selectedSkill ? escapeAttribute(selectedSkill.sourceLabel) : ''}">${selectedSkill ? escapeHtml(truncateMiddle(selectedSkill.sourceLabel, 56)) : 'Nothing selected'}</span>
        </div>
        ${detailHtml}
      </aside>
    </div>
  </div>
</div>`;

  bindDomEvents();
  restoreFocusedInput(focusedInput);
  renderGraph(document.getElementById('tag-graph') as SVGSVGElement | null, filterGraphForVisible(currentState, visibleSkills));
}

function bindDomEvents(): void {
  app.querySelectorAll<HTMLElement>('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      if (!action || !state) {
        return;
      }

      switch (action) {
        case 'refresh':
          vscode.postMessage({ type: 'refresh' });
          break;
        case 'configure-key':
          vscode.postMessage({ type: 'configureOpenRouterKey' });
          break;
        case 'clear-key':
          vscode.postMessage({ type: 'clearOpenRouterKey' });
          break;
        case 'generate-tags':
          vscode.postMessage({ type: 'generateTags' });
          break;
        case 'clear-filter':
          if (skillSearchTimer) {
            window.clearTimeout(skillSearchTimer);
            skillSearchTimer = undefined;
          }
          if (sourceSearchTimer) {
            window.clearTimeout(sourceSearchTimer);
            sourceSearchTimer = undefined;
          }
          selectedTag = undefined;
          searchText = '';
          searchDraft = '';
          sourceSearchText = '';
          sourceSearchDraft = '';
          vscode.postMessage({ type: 'clearFilter' });
          break;
        case 'scope':
          vscode.postMessage({
            type: 'setFilter',
            filter: applyScopeFilter(state.filter, (element.dataset.scope as SkillFilter['scope']) ?? 'all')
          });
          break;
        case 'category':
          vscode.postMessage({
            type: 'setFilter',
            filter: applyCategoryFilter(state.filter, element.dataset.category)
          });
          break;
        case 'source':
          if (!element.dataset.source) {
            break;
          }
          if (
            element.dataset.scope !== 'workspace' &&
            element.dataset.scope !== 'global' &&
            element.dataset.scope !== 'online'
          ) {
            break;
          }
          vscode.postMessage({
            type: 'setFilter',
            filter: applySourceFilter(state.filter, element.dataset.source, element.dataset.scope)
          });
          break;
        case 'select-skill':
          if (element.dataset.skillId) {
            state = { ...state, selectedSkillId: element.dataset.skillId };
            vscode.postMessage({ type: 'selectSkill', skillId: element.dataset.skillId });
            render();
          }
          break;
        case 'open-skill':
          if (element.dataset.skillId) {
            vscode.postMessage({ type: 'openSkill', skillId: element.dataset.skillId });
          }
          break;
        case 'select-tag':
          selectedTag = element.dataset.tag;
          render();
          break;
        case 'select-tag-clear':
          selectedTag = undefined;
          render();
          break;
      }
    });
  });

  const search = document.getElementById('skill-search') as HTMLInputElement | null;
  search?.addEventListener('input', (event) => {
    searchDraft = (event.target as HTMLInputElement).value;
    if (skillSearchTimer) {
      window.clearTimeout(skillSearchTimer);
    }
    skillSearchTimer = window.setTimeout(() => {
      searchText = searchDraft;
      skillSearchTimer = undefined;
      render();
    }, 150);
  });

  const sourceSearch = document.getElementById('source-search') as HTMLInputElement | null;
  sourceSearch?.addEventListener('input', (event) => {
    sourceSearchDraft = (event.target as HTMLInputElement).value;
    if (sourceSearchTimer) {
      window.clearTimeout(sourceSearchTimer);
    }
    sourceSearchTimer = window.setTimeout(() => {
      sourceSearchText = sourceSearchDraft;
      sourceSearchTimer = undefined;
      render();
    }, 150);
  });
}

function renderMetric(label: string, value: number): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function applyLocalFilters(skills: SkillRecord[], search: string, tag?: string): SkillRecord[] {
  const normalizedSearch = search.trim().toLowerCase();

  return skills.filter((skill) => {
    if (tag && !skill.tags.includes(tag)) {
      return false;
    }

    if (!normalizedSearch) {
      return true;
    }

    const haystack = `${skill.name} ${skill.description} ${skill.sourceLabel} ${skill.tags.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

function describeFilter(filter: SkillFilter): string {
  const parts: string[] = [filter.scope];
  if (filter.category) {
    parts.push(filter.category);
  }
  if (filter.sourceId) {
    parts.push('source');
  }
  return parts.join(' / ');
}

function buildLegend(skills: SkillRecord[]): string {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([category, count]) => `<span class="pill">${escapeHtml(category)} · ${count}</span>`)
    .join('');
}

function renderGraph(svg: SVGSVGElement | null, graph: { nodes: TagGraphNode[]; links: TagGraphLink[] }): void {
  if (!svg) {
    return;
  }

  const graphKey = buildGraphRenderKey(graph);
  const cachedMarkup = graphMarkupCache.get(graphKey);
  if (cachedMarkup) {
    svg.innerHTML = cachedMarkup;
    bindGraphNodeEvents(svg);
    return;
  }

  const width = 720;
  const height = 420;
  const nodes: GraphNode[] = graph.nodes.map((node) => ({
    ...node,
    radius: 18 + Math.sqrt(node.count) * 12
  }));
  const links: GraphLink[] = graph.links.map((link) => ({ ...link }));

  if (nodes.length === 0) {
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="currentColor" opacity="0.72">No tags available for the current filter.</text>`;
    return;
  }

  const simulation = forceSimulation(nodes)
    .force('center', forceCenter(width / 2, height / 2))
    .force('charge', forceManyBody<GraphNode>().strength(-80))
    .force('collide', forceCollide<GraphNode>().radius((node: GraphNode) => node.radius + 4))
    .force(
      'link',
      forceLink<GraphNode, GraphLink>(links)
        .id((node: GraphNode) => node.id)
        .distance((link: GraphLink) => Math.max(40, 160 - link.overlap * 10))
        .strength((link: GraphLink) => Math.min(1, 0.15 + link.weight * 0.7))
    );

  for (let tick = 0; tick < 160; tick += 1) {
    simulation.tick();
  }
  simulation.stop();

  const linkMarkup = links
    .map((link) => {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      return `<line x1="${source.x ?? width / 2}" y1="${source.y ?? height / 2}" x2="${target.x ?? width / 2}" y2="${target.y ?? height / 2}" stroke="var(--vscode-textLink-foreground)" stroke-opacity="${Math.min(0.55, 0.18 + link.weight * 0.4)}" stroke-width="${1 + link.overlap}"></line>`;
    })
    .join('');

  const nodeMarkup = nodes
    .map((node) => {
      const fill = categoryColor(node.category);
      const fontSize = Math.max(10, Math.min(14, node.radius / 2.4));
      const shouldShowLabel = node.radius > 24;
      return `<g class="graph-node" data-tag="${escapeAttribute(node.label)}">
  <circle cx="${node.x ?? width / 2}" cy="${node.y ?? height / 2}" r="${node.radius}" fill="${fill}" fill-opacity="0.72" stroke="${fill}" stroke-width="1.5"></circle>
  ${shouldShowLabel ? `<text x="${node.x ?? width / 2}" y="${(node.y ?? height / 2) + 3}" text-anchor="middle" fill="currentColor" font-size="${fontSize}" pointer-events="none">${escapeHtml(truncate(node.label, 18))}</text>` : ''}
  <title>${escapeHtml(`${node.label} · ${node.count} skills`)}</title>
</g>`;
    })
    .join('');

  const markup = `${linkMarkup}${nodeMarkup}`;
  cacheGraphMarkup(graphKey, markup);
  svg.innerHTML = markup;
  bindGraphNodeEvents(svg);
}

function bindGraphNodeEvents(svg: SVGSVGElement): void {
  svg.querySelectorAll<SVGGElement>('.graph-node').forEach((node) => {
    node.addEventListener('click', () => {
      selectedTag = node.dataset.tag;
      render();
    });
  });
}

function filterGraphForVisible(currentState: ViewState, visibleSkills: SkillRecord[]) {
  const visibleIds = new Set(visibleSkills.map((skill) => skill.id));
  const nodes = currentState.graph.nodes.filter((node) => node.skillIds.some((skillId) => visibleIds.has(skillId)));
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const links = currentState.graph.links.filter((link) => selectedNodeIds.has(link.source) && selectedNodeIds.has(link.target));
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

function captureFocusedInput():
  | { id: string; selectionStart: number | null; selectionEnd: number | null }
  | undefined {
  if (!(document.activeElement instanceof HTMLInputElement) || !document.activeElement.id) {
    return undefined;
  }

  return {
    id: document.activeElement.id,
    selectionStart: document.activeElement.selectionStart,
    selectionEnd: document.activeElement.selectionEnd
  };
}

function restoreFocusedInput(
  focusedInput: { id: string; selectionStart: number | null; selectionEnd: number | null } | undefined
): void {
  if (!focusedInput) {
    return;
  }

  const input = document.getElementById(focusedInput.id) as HTMLInputElement | null;
  if (!input) {
    return;
  }

  input.focus();
  if (focusedInput.selectionStart !== null && focusedInput.selectionEnd !== null) {
    input.setSelectionRange(focusedInput.selectionStart, focusedInput.selectionEnd);
  }
}

function buildGraphRenderKey(graph: { nodes: TagGraphNode[]; links: TagGraphLink[] }): string {
  const nodeKey = graph.nodes
    .map((node) => `${node.id}:${node.count}:${node.category}`)
    .sort()
    .join('|');
  const linkKey = graph.links
    .map((link) => `${link.source}:${link.target}:${link.overlap}:${link.weight}`)
    .sort()
    .join('|');
  return `${nodeKey}__${linkKey}`;
}

function cacheGraphMarkup(graphKey: string, markup: string): void {
  graphMarkupCache.set(graphKey, markup);
  if (graphMarkupCache.size <= 12) {
    return;
  }

  const oldestKey = graphMarkupCache.keys().next().value;
  if (oldestKey) {
    graphMarkupCache.delete(oldestKey);
  }
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 1))}…` : value;
}

function truncateMiddle(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }

  const visible = Math.max(8, length - 1);
  const head = Math.ceil(visible * 0.58);
  const tail = Math.max(4, visible - head);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
