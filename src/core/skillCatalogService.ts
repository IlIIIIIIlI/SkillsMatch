import * as vscode from 'vscode';

import type { SkillFilter, SkillInsight, SkillRecord, SkillSnapshot, ViewState } from '../shared/types';
import { buildHeuristicInsight } from './classification';
import { AI_CACHE_KEY, ONLINE_CACHE_KEY, OPENROUTER_SECRET_KEY } from './constants';
import { discoverLocalSkills } from './localSkillDiscovery';
import { OpenRouterClient } from './openRouterClient';
import { discoverOnlineSkills } from './onlineSkillDiscovery';
import { buildTagGraph } from './tagGraph';
import { hashText, toErrorMessage } from './utils';

interface OnlineCacheEntry {
  refreshedAt: string;
  skills: SkillRecord[];
}

interface AiCacheEntry {
  category: string;
  tags: string[];
  model?: string;
  generatedAt: string;
}

export class SkillCatalogService {
  private readonly changeEmitter = new vscode.EventEmitter<ViewState>();
  private readonly state: ViewState = {
    snapshot: emptySnapshot(false),
    filter: { scope: 'all' },
    visibleSkills: [],
    graph: { nodes: [], links: [] },
    busy: false
  };
  private currentRefresh?: Promise<void>;
  private backgroundTagTask?: Promise<void>;

  public readonly onDidChangeState = this.changeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getState(): ViewState {
    return this.state;
  }

  public async initialize(): Promise<void> {
    await this.refresh({ announce: false, reason: 'startup' });
  }

  public async refresh(options: { announce: boolean; reason: 'startup' | 'manual' }): Promise<void> {
    if (this.currentRefresh) {
      return this.currentRefresh;
    }

    this.currentRefresh = this.performRefresh(options).finally(() => {
      this.currentRefresh = undefined;
    });

    return this.currentRefresh;
  }

  public async configureOpenRouterKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Configure OpenRouter API Key',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-or-v1-...'
    });

    if (!value) {
      return;
    }

    await this.context.secrets.store(OPENROUTER_SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('OpenRouter API key stored in VS Code SecretStorage.');
    this.recomputeDerivedState({ keyConfigured: true, statusMessage: 'OpenRouter API key configured.' });

    if (this.readSettings().autoGenerateTagsOnRefresh) {
      void this.generateTags({ announce: true });
    }
  }

  public async clearOpenRouterKey(): Promise<void> {
    await this.context.secrets.delete(OPENROUTER_SECRET_KEY);
    this.recomputeDerivedState({ keyConfigured: false, statusMessage: 'OpenRouter API key cleared.' });
    vscode.window.showInformationMessage('OpenRouter API key cleared.');
  }

  public async generateTags(options: { announce: boolean }): Promise<void> {
    const apiKey = await this.context.secrets.get(OPENROUTER_SECRET_KEY);
    if (!apiKey) {
      vscode.window.showWarningMessage('Configure an OpenRouter API key before generating tags.');
      return;
    }

    if (this.backgroundTagTask) {
      return this.backgroundTagTask;
    }

    const settings = this.readSettings();
    const aiCache = this.readAiCache();
    const pending = this.state.snapshot.skills.filter((skill) => {
      const cacheKey = createInsightCacheKey(skill);
      return !(cacheKey in aiCache);
    });

    if (pending.length === 0) {
      if (options.announce) {
        vscode.window.showInformationMessage('All current skills already have cached AI tags.');
      }
      return;
    }

    const task = Promise.resolve(vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Skill Map is generating AI tags',
        cancellable: false
      },
      async (progress) => {
        this.setBusy(true, `Generating AI tags for ${pending.length} skills...`);

        const client = new OpenRouterClient({
          apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          batchSize: settings.batchSize
        });

        const insights = await client.enrichSkills(pending, (completed, total) => {
          progress.report({ increment: total === 0 ? 0 : 100 / total, message: `${completed}/${total}` });
        });

        const mergedCache = { ...aiCache };
        for (const skill of pending) {
          const insight = insights.get(skill.id);
          if (!insight) {
            continue;
          }

          mergedCache[createInsightCacheKey(skill)] = {
            category: insight.category,
            tags: insight.tags,
            generatedAt: insight.generatedAt,
            model: settings.model
          };
        }

        await this.context.globalState.update(AI_CACHE_KEY, mergedCache);
        this.recomputeDerivedState({
          keyConfigured: true,
          statusMessage: `Generated AI tags for ${pending.length} skills.`
        });

        if (options.announce) {
          vscode.window.showInformationMessage(`Generated AI tags for ${pending.length} skills.`);
        }
      }
    ));

    this.backgroundTagTask = task
      .catch((error: unknown) => {
        vscode.window.showErrorMessage(`Skill Map failed to generate tags: ${toErrorMessage(error)}`);
      })
      .finally(() => {
        this.backgroundTagTask = undefined;
        this.setBusy(false);
      });

    return this.backgroundTagTask;
  }

  public setFilter(filter: SkillFilter): void {
    this.state.filter = filter;
    this.recomputeDerivedState();
  }

  public clearFilter(): void {
    this.state.filter = { scope: 'all' };
    this.recomputeDerivedState({ selectedSkillId: undefined });
  }

  public selectSkill(skillId?: string): void {
    this.state.selectedSkillId = skillId;
    this.emitState();
  }

  public async openSkill(skillId: string): Promise<void> {
    const skill = this.state.snapshot.skills.find((candidate) => candidate.id === skillId);
    if (!skill) {
      return;
    }

    this.state.selectedSkillId = skill.id;
    this.emitState();

    if (skill.origin === 'local') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(skill.manifestPath));
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(skill.location));
  }

  private async performRefresh(options: { announce: boolean; reason: 'startup' | 'manual' }): Promise<void> {
    this.setBusy(true, 'Refreshing skills...');

    try {
      const keyConfigured = Boolean(await this.context.secrets.get(OPENROUTER_SECRET_KEY));
      const settings = this.readSettings();
      const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        name: folder.name,
        fsPath: folder.uri.fsPath
      }));

      const localSkills = await discoverLocalSkills(workspaceFolders, settings.additionalGlobalPaths);
      let onlineSkills: SkillRecord[] = [];
      let statusMessage = 'Catalog refreshed.';

      try {
        onlineSkills = await discoverOnlineSkills(settings.timeoutMs);
        await this.context.globalState.update(ONLINE_CACHE_KEY, {
          refreshedAt: new Date().toISOString(),
          skills: onlineSkills
        } satisfies OnlineCacheEntry);
      } catch (error) {
        const cached = this.context.globalState.get<OnlineCacheEntry | undefined>(ONLINE_CACHE_KEY);
        onlineSkills = cached?.skills ?? [];
        statusMessage = onlineSkills.length > 0
          ? `Online refresh failed, using cached skills: ${toErrorMessage(error)}`
          : `Online refresh failed: ${toErrorMessage(error)}`;
      }

      const skills = [...localSkills, ...onlineSkills];
      this.state.snapshot = this.buildSnapshot(skills, keyConfigured);
      this.recomputeDerivedState({
        keyConfigured,
        statusMessage
      });

      if (options.announce && options.reason === 'manual') {
        vscode.window.showInformationMessage(
          `Skill Map refreshed ${skills.length} skills (${localSkills.length} local, ${onlineSkills.length} online).`
        );
      }

      if (keyConfigured && settings.autoGenerateTagsOnRefresh) {
        void this.generateTags({ announce: false });
      }
    } catch (error) {
      const message = `Skill Map refresh failed: ${toErrorMessage(error)}`;
      this.recomputeDerivedState({ statusMessage: message });
      vscode.window.showErrorMessage(message);
    } finally {
      this.setBusy(false);
    }
  }

  private buildSnapshot(skills: SkillRecord[], keyConfigured: boolean): SkillSnapshot {
    const aiCache = this.readAiCache();
    const enrichedSkills: SkillRecord[] = skills.map((skill): SkillRecord => {
      const insight = aiCache[createInsightCacheKey(skill)] ?? toAiCacheEntry(buildHeuristicInsight(skill));

      return {
        ...skill,
        category: insight.category,
        tags: insight.tags,
        tagSource: aiCache[createInsightCacheKey(skill)] ? 'ai' : 'heuristic'
      };
    });

    const categories = aggregateCategories(enrichedSkills);
    const sources = aggregateSources(enrichedSkills);

    return {
      refreshedAt: new Date().toISOString(),
      keyConfigured,
      counts: {
        all: enrichedSkills.length,
        global: enrichedSkills.filter((skill) => skill.scope === 'global').length,
        workspace: enrichedSkills.filter((skill) => skill.scope === 'workspace').length,
        online: enrichedSkills.filter((skill) => skill.scope === 'online').length,
        categories: categories.length,
        sources: sources.length
      },
      skills: enrichedSkills.sort((left, right) => left.name.localeCompare(right.name)),
      categories,
      sources
    };
  }

  private recomputeDerivedState(options?: {
    keyConfigured?: boolean;
    statusMessage?: string;
    selectedSkillId?: string;
  }): void {
    if (typeof options?.keyConfigured === 'boolean') {
      this.state.snapshot = {
        ...this.state.snapshot,
        keyConfigured: options.keyConfigured
      };
    }

    if (typeof options?.selectedSkillId !== 'undefined') {
      this.state.selectedSkillId = options.selectedSkillId;
    }

    const visibleSkills = this.state.snapshot.skills.filter((skill) => matchesFilter(skill, this.state.filter));
    this.state.visibleSkills = visibleSkills;
    this.state.graph = buildTagGraph(visibleSkills, this.readSettings().maxTags);
    this.state.statusMessage = options?.statusMessage ?? this.state.statusMessage;

    if (this.state.selectedSkillId && !visibleSkills.some((skill) => skill.id === this.state.selectedSkillId)) {
      this.state.selectedSkillId = undefined;
    }

    this.emitState();
  }

  private emitState(): void {
    this.changeEmitter.fire({
      snapshot: this.state.snapshot,
      filter: this.state.filter,
      visibleSkills: this.state.visibleSkills,
      graph: this.state.graph,
      selectedSkillId: this.state.selectedSkillId,
      busy: this.state.busy,
      statusMessage: this.state.statusMessage
    });
  }

  private setBusy(busy: boolean, statusMessage?: string): void {
    this.state.busy = busy;
    if (statusMessage) {
      this.state.statusMessage = statusMessage;
    }
    this.emitState();
  }

  private readSettings(): {
    baseUrl: string;
    model: string;
    batchSize: number;
    additionalGlobalPaths: string[];
    timeoutMs: number;
    maxTags: number;
    autoGenerateTagsOnRefresh: boolean;
  } {
    const config = vscode.workspace.getConfiguration('skillMap');
    return {
      baseUrl: config.get<string>('openRouter.baseUrl', 'https://openrouter.ai/api/v1'),
      model: config.get<string>('openRouter.model', 'openai/gpt-4.1-mini'),
      batchSize: config.get<number>('openRouter.batchSize', 8),
      autoGenerateTagsOnRefresh: config.get<boolean>('openRouter.autoGenerateTagsOnRefresh', true),
      additionalGlobalPaths: config.get<string[]>('scan.additionalGlobalPaths', []),
      timeoutMs: config.get<number>('onlineSources.timeoutMs', 12000),
      maxTags: config.get<number>('visualization.maxTags', 36)
    };
  }

  private readAiCache(): Record<string, AiCacheEntry> {
    return this.context.globalState.get<Record<string, AiCacheEntry>>(AI_CACHE_KEY, {});
  }
}

function aggregateCategories(skills: SkillRecord[]) {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function aggregateSources(skills: SkillRecord[]) {
  const counts = new Map<string, { label: string; scope: SkillRecord['scope']; count: number }>();
  for (const skill of skills) {
    const bucket = counts.get(skill.sourceId) ?? {
      label: skill.sourceLabel,
      scope: skill.scope,
      count: 0
    };
    bucket.count += 1;
    counts.set(skill.sourceId, bucket);
  }

  return [...counts.entries()]
    .map(([id, value]) => ({
      id,
      label: value.label,
      scope: value.scope,
      count: value.count
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function createInsightCacheKey(skill: Pick<SkillRecord, 'name' | 'description'>): string {
  return hashText(`${skill.name}\n${skill.description}`);
}

function emptySnapshot(keyConfigured: boolean): SkillSnapshot {
  return {
    refreshedAt: new Date(0).toISOString(),
    keyConfigured,
    counts: {
      all: 0,
      global: 0,
      workspace: 0,
      online: 0,
      categories: 0,
      sources: 0
    },
    skills: [],
    categories: [],
    sources: []
  };
}

function matchesFilter(skill: SkillRecord, filter: SkillFilter): boolean {
  if (filter.scope !== 'all' && skill.scope !== filter.scope) {
    return false;
  }

  if (filter.category && skill.category !== filter.category) {
    return false;
  }

  if (filter.sourceId && skill.sourceId !== filter.sourceId) {
    return false;
  }

  return true;
}

function toAiCacheEntry(insight: SkillInsight): AiCacheEntry {
  return {
    category: insight.category,
    tags: insight.tags,
    generatedAt: insight.generatedAt,
    model: insight.model
  };
}
