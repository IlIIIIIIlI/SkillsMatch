import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type {
  OpenRouterModelSummary,
  ProjectWorkspaceSummary,
  RecommendedSkill,
  SkillFilter,
  SkillInsight,
  SkillRecord,
  SkillRecommendationState,
  SkillSnapshot,
  ViewState
} from '../shared/types';
import { buildHeuristicInsight } from './classification';
import {
  AI_CACHE_KEY,
  LIGHTRAG_SYNC_CACHE_KEY,
  ONLINE_CACHE_KEY,
  OPENROUTER_SECRET_KEY
} from './constants';
import { parseConfiguredGitHubSourceUrls, splitGitHubSourceInput } from './githubSourceConfig';
import { LightRagClient } from './lightRagClient';
import { discoverLocalSkills } from './localSkillDiscovery';
import { OpenRouterClient } from './openRouterClient';
import { discoverOnlineSkills } from './onlineSkillDiscovery';
import { buildAppliedSkillDirectoryName, resolveProjectApplyPath } from './projectSkillConfig';
import {
  buildKnowledgeBaseFileSource,
  buildLightRagWorkspaceId,
  buildSkillKnowledgeDocument,
  extractSkillIdFromKnowledgeBaseFileSource,
  loadSkillManifestContent,
  synthesizeSkillManifest
} from './skillKnowledgeBase';
import { buildTagGraph } from './tagGraph';
import { hashText, mapLimit, toErrorMessage } from './utils';

interface OnlineCacheEntry {
  refreshedAt: string;
  sourceUrls: string[];
  skills: SkillRecord[];
}

interface AiCacheEntry {
  category: string;
  tags: string[];
  model?: string;
  generatedAt: string;
  promptHash?: string;
}

interface LightRagSyncCacheEntry {
  snapshotHash: string;
  syncedAt: string;
  skillCount: number;
}

interface RefreshSettings {
  baseUrl: string;
  model: string;
  batchSize: number;
  maxSkillsPerRun: number;
  requestDelayMs: number;
  tagPrompt: string;
  additionalGlobalPaths: string[];
  timeoutMs: number;
  maxTags: number;
  autoGenerateTagsOnRefresh: boolean;
  githubUrls: string[];
  lightRagBaseUrl: string;
  lightRagAutoSyncOnRefresh: boolean;
  lightRagSyncTimeoutMs: number;
  projectApplyRelativePath: string;
}

export class SkillCatalogService {
  private readonly changeEmitter = new vscode.EventEmitter<ViewState>();
  private readonly state: ViewState = emptyViewState();
  private currentRefresh?: Promise<void>;
  private openRouterModelsTask?: Promise<void>;
  private backgroundTagTask?: Promise<void>;
  private backgroundTagAbortController?: AbortController;
  private knowledgeBaseSyncTask?: Promise<void>;
  private recommendationTask?: Promise<void>;

  public readonly onDidChangeState = this.changeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getState(): ViewState {
    return this.state;
  }

  public async initialize(): Promise<void> {
    this.refreshRuntimeState(false);
    await this.refresh({ announce: false, reason: 'startup' });
    void this.refreshOpenRouterModels({ announce: false });
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
    this.refreshRuntimeState(true);
    vscode.window.showInformationMessage('OpenRouter API key stored in VS Code SecretStorage.');
    this.recomputeDerivedState({ statusMessage: 'OpenRouter API key configured.' });
    void this.refreshOpenRouterModels({ announce: false });

    if (this.readSettings().autoGenerateTagsOnRefresh) {
      void this.generateTags({ announce: true });
    }
  }

  public async openOpenRouterSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'skillMap.openRouter');
  }

  public async refreshOpenRouterModels(options: { announce: boolean }): Promise<void> {
    if (this.openRouterModelsTask) {
      return this.openRouterModelsTask;
    }

    const task = (async () => {
      this.state.openRouter = {
        ...this.state.openRouter,
        modelsLoading: true,
        modelsError: undefined
      };
      this.emitState();

      try {
        const settings = this.readSettings();
        const apiKey = await this.context.secrets.get(OPENROUTER_SECRET_KEY) ?? undefined;
        const models = await OpenRouterClient.listModels({
          baseUrl: settings.baseUrl,
          apiKey
        });
        const currentModel = settings.model;
        const nextModels = ensureCurrentModel(models, currentModel);

        this.state.openRouter = {
          ...this.state.openRouter,
          baseUrl: settings.baseUrl,
          model: currentModel,
          availableModels: nextModels,
          modelsLoading: false,
          modelsUpdatedAt: new Date().toISOString(),
          modelsError: undefined
        };
        this.emitState();

        if (options.announce) {
          vscode.window.showInformationMessage(`Loaded ${nextModels.length} OpenRouter models.`);
        }
      } catch (error) {
        const message = toErrorMessage(error);
        this.state.openRouter = {
          ...this.state.openRouter,
          modelsLoading: false,
          modelsError: message
        };
        this.emitState();

        if (options.announce) {
          vscode.window.showWarningMessage(`OpenRouter model list failed: ${message}`);
        }
      }
    })().finally(() => {
      this.openRouterModelsTask = undefined;
    });

    this.openRouterModelsTask = task;
    return task;
  }

  public async setOpenRouterModel(model: string): Promise<void> {
    const nextModel = model.trim();
    if (!nextModel) {
      return;
    }

    await vscode.workspace.getConfiguration('skillMap').update('openRouter.model', nextModel, vscode.ConfigurationTarget.Global);
    this.refreshRuntimeState(this.state.openRouter.keyConfigured);
    this.recomputeDerivedState({ statusMessage: `OpenRouter model set to ${nextModel}. Run Generate AI Tags to refresh cached tags.` });
  }

  public async updateTagGenerationConfig(input: {
    tagPrompt?: string;
    batchSize?: number;
    maxSkillsPerRun?: number;
    requestDelayMs?: number;
    autoGenerateTagsOnRefresh?: boolean;
  }): Promise<void> {
    const config = vscode.workspace.getConfiguration('skillMap');

    if (typeof input.tagPrompt === 'string') {
      await config.update('openRouter.tagPrompt', input.tagPrompt, vscode.ConfigurationTarget.Global);
    }
    if (typeof input.batchSize === 'number') {
      await config.update('openRouter.batchSize', clampNumber(input.batchSize, 1, 25), vscode.ConfigurationTarget.Global);
    }
    if (typeof input.maxSkillsPerRun === 'number') {
      await config.update('openRouter.maxSkillsPerRun', clampNumber(input.maxSkillsPerRun, 1, 500), vscode.ConfigurationTarget.Global);
    }
    if (typeof input.requestDelayMs === 'number') {
      await config.update('openRouter.requestDelayMs', clampNumber(input.requestDelayMs, 0, 10_000), vscode.ConfigurationTarget.Global);
    }
    if (typeof input.autoGenerateTagsOnRefresh === 'boolean') {
      await config.update('openRouter.autoGenerateTagsOnRefresh', input.autoGenerateTagsOnRefresh, vscode.ConfigurationTarget.Global);
    }

    this.refreshRuntimeState(this.state.openRouter.keyConfigured);
    this.recomputeDerivedState({ statusMessage: 'Tag generation settings updated.' });
  }

  public stopTagGeneration(): void {
    if (!this.backgroundTagTask || !this.backgroundTagAbortController) {
      return;
    }

    this.state.openRouter = {
      ...this.state.openRouter,
      tagGeneration: {
        ...this.state.openRouter.tagGeneration,
        stopping: true
      }
    };
    this.emitState();
    this.backgroundTagAbortController.abort();
  }

  public async configureLightRagBaseUrl(): Promise<void> {
    const settings = this.readSettings();
    const value = await vscode.window.showInputBox({
      title: 'Configure LightRAG Base URL',
      ignoreFocusOut: true,
      value: settings.lightRagBaseUrl,
      placeHolder: 'http://127.0.0.1:9621'
    });

    if (typeof value === 'undefined') {
      return;
    }

    const nextValue = value.trim() || 'http://127.0.0.1:9621';
    await vscode.workspace.getConfiguration('skillMap').update('lightRag.baseUrl', nextValue, vscode.ConfigurationTarget.Global);
    this.refreshRuntimeState(this.state.openRouter.keyConfigured);
    this.recomputeDerivedState({ statusMessage: `LightRAG base URL set to ${nextValue}.` });
  }

  public async configureGitHubSources(): Promise<void> {
    const settings = this.readSettings();
    const value = await vscode.window.showInputBox({
      title: 'Configure GitHub Skill Sources',
      ignoreFocusOut: true,
      value: settings.githubUrls.join(', '),
      prompt: 'Enter comma, space, or newline-separated GitHub repo, folder, or direct SKILL.md URLs.'
    });

    if (typeof value === 'undefined') {
      return;
    }

    const nextUrls = splitGitHubSourceInput(value);
    await vscode.workspace.getConfiguration('skillMap').update(
      'onlineSources.githubUrls',
      nextUrls,
      vscode.ConfigurationTarget.Global
    );

    this.refreshRuntimeState(this.state.openRouter.keyConfigured);
    this.recomputeDerivedState({
      statusMessage: nextUrls.length > 0
        ? `Configured ${nextUrls.length} GitHub source(s).`
        : 'GitHub sources cleared.'
    });
  }

  public async clearOpenRouterKey(): Promise<void> {
    await this.context.secrets.delete(OPENROUTER_SECRET_KEY);
    this.refreshRuntimeState(false);
    this.recomputeDerivedState({ statusMessage: 'OpenRouter API key cleared.' });
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
    const promptHash = createTagPromptHash(settings.tagPrompt);
    const pending = this.state.snapshot.skills
      .filter((skill) => shouldGenerateTagsForSkill(skill, aiCache, settings, promptHash))
      .slice(0, settings.maxSkillsPerRun);

    if (pending.length === 0) {
      if (options.announce) {
        vscode.window.showInformationMessage(`All current skills already have cached AI tags for ${settings.model}.`);
      }
      return;
    }

    const abortController = new AbortController();
    this.backgroundTagAbortController = abortController;
    const task = Promise.resolve(vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SkillMatch is generating AI tags',
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          abortController.abort();
        });

        this.state.openRouter = {
          ...this.state.openRouter,
          tagGeneration: {
            ...this.state.openRouter.tagGeneration,
            running: true,
            stopping: false,
            completed: 0,
            total: pending.length,
            startedAt: new Date().toISOString()
          }
        };
        this.setBusy(true, `Generating AI tags for ${pending.length} skills...`);

        const client = new OpenRouterClient({
          apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          batchSize: settings.batchSize,
          tagPrompt: settings.tagPrompt
        });

        const mergedCache = { ...aiCache };
        let completed = 0;
        await client.enrichSkills(pending, {
          signal: abortController.signal,
          delayMs: settings.requestDelayMs,
          onProgress: (nextCompleted, total) => {
            completed = nextCompleted;
            progress.report({ increment: total === 0 ? 0 : 100 / total, message: `${nextCompleted}/${total}` });
            this.state.openRouter = {
              ...this.state.openRouter,
              tagGeneration: {
                ...this.state.openRouter.tagGeneration,
                completed: nextCompleted,
                total
              }
            };
            this.emitState();
          },
          onBatch: async (batch, batchInsights) => {
            for (const skill of batch) {
              const insight = batchInsights.get(skill.id);
              if (!insight) {
                continue;
              }

              mergedCache[createInsightCacheKey(skill)] = {
                category: insight.category,
                tags: insight.tags,
                generatedAt: insight.generatedAt,
                model: settings.model,
                promptHash
              };
            }

            await this.context.globalState.update(AI_CACHE_KEY, mergedCache);
            this.state.snapshot = this.buildSnapshot(this.state.snapshot.skills, this.state.snapshot.keyConfigured);
            this.recomputeDerivedState({
              statusMessage: `Generating AI tags... ${completed}/${pending.length}`
            });
          }
        });

        this.state.openRouter = {
          ...this.state.openRouter,
          pendingTagCount: countPendingTagGeneration(this.state.snapshot.skills, mergedCache, settings, promptHash),
          tagGeneration: {
            running: false,
            stopping: false,
            completed: pending.length,
            total: pending.length,
            startedAt: this.state.openRouter.tagGeneration.startedAt,
            lastCompletedAt: new Date().toISOString(),
            lastGeneratedCount: pending.length
          }
        };
        this.recomputeDerivedState({
          statusMessage: `Generated AI tags for ${pending.length} skills.`
        });

        if (options.announce) {
          vscode.window.showInformationMessage(`Generated AI tags for ${pending.length} skills.`);
        }
      }
    ));

    this.backgroundTagTask = task
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          const { completed, total, startedAt } = this.state.openRouter.tagGeneration;
          this.state.openRouter = {
            ...this.state.openRouter,
            pendingTagCount: countPendingTagGeneration(this.state.snapshot.skills, this.readAiCache(), settings, promptHash),
            tagGeneration: {
              running: false,
              stopping: false,
              completed,
              total,
              startedAt,
              lastCompletedAt: new Date().toISOString(),
              lastGeneratedCount: completed
            }
          };
          this.recomputeDerivedState({
            statusMessage: `Tag generation stopped after ${completed}/${total} skills.`
          });
          if (options.announce) {
            vscode.window.showInformationMessage(`Tag generation stopped after ${completed}/${total} skills.`);
          }
          return;
        }

        this.state.openRouter = {
          ...this.state.openRouter,
          tagGeneration: {
            ...this.state.openRouter.tagGeneration,
            running: false,
            stopping: false
          }
        };
        this.emitState();
        vscode.window.showErrorMessage(`SkillMatch failed to generate tags: ${toErrorMessage(error)}`);
      })
      .finally(() => {
        this.backgroundTagTask = undefined;
        this.backgroundTagAbortController = undefined;
        this.setBusy(false);
      });

    return this.backgroundTagTask;
  }

  public async syncKnowledgeBase(options: { announce: boolean; force?: boolean }): Promise<void> {
    if (this.knowledgeBaseSyncTask) {
      return this.knowledgeBaseSyncTask;
    }

    const task = this.performKnowledgeBaseSync(options).finally(() => {
      this.knowledgeBaseSyncTask = undefined;
    });

    this.knowledgeBaseSyncTask = task;
    return task;
  }

  public async recommendSkills(question: string): Promise<void> {
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length < 3) {
      this.state.recommendation = {
        ...this.state.recommendation,
        question: trimmedQuestion,
        loading: false,
        statusMessage: 'Describe the task in a bit more detail to match skills.',
        items: [],
        selectedSkillIds: [],
        summary: undefined,
        source: 'heuristic'
      };
      this.emitState();
      return;
    }

    if (this.recommendationTask) {
      return this.recommendationTask;
    }

    this.state.recommendation = {
      ...this.state.recommendation,
      question: trimmedQuestion,
      loading: true,
      statusMessage: 'Matching skills with LightRAG and OpenRouter...',
      items: [],
      selectedSkillIds: [],
      summary: undefined
    };
    this.emitState();

    this.recommendationTask = this.performRecommendation(trimmedQuestion)
      .finally(() => {
        this.recommendationTask = undefined;
      });

    return this.recommendationTask;
  }

  public async applyRecommendedSkills(): Promise<void> {
    const selectedIds = this.state.recommendation.selectedSkillIds.length > 0
      ? this.state.recommendation.selectedSkillIds
      : this.state.selectedSkillId
        ? [this.state.selectedSkillId]
        : [];

    if (selectedIds.length === 0) {
      vscode.window.showWarningMessage('Choose at least one skill before applying it to the current project.');
      return;
    }

    const targetWorkspace = this.resolveSelectedWorkspace();
    if (!targetWorkspace) {
      vscode.window.showWarningMessage('Open a workspace folder before applying skills to a project.');
      return;
    }

    const settings = this.readSettings();
    const targetRoot = resolveProjectApplyPath(targetWorkspace.fsPath, settings.projectApplyRelativePath);
    const selectedSkills = selectedIds
      .map((skillId) => this.state.snapshot.skills.find((skill) => skill.id === skillId))
      .filter((skill): skill is SkillRecord => Boolean(skill));

    if (selectedSkills.length === 0) {
      vscode.window.showWarningMessage('The selected skills are no longer available in the catalog. Refresh and try again.');
      return;
    }

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(targetRoot, { recursive: true });

    const manifests = await mapLimit(selectedSkills, 4, async (skill) => {
      try {
        return {
          skill,
          content: await loadSkillManifestContent(skill, settings.timeoutMs)
        };
      } catch {
        return {
          skill,
          content: synthesizeSkillManifest(skill)
        };
      }
    });

    for (const entry of manifests) {
      const skillDir = path.join(targetRoot, buildAppliedSkillDirectoryName(entry.skill));
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), entry.content, 'utf8');
    }

    await fs.writeFile(
      path.join(targetRoot, 'selection.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: 'SkillMatch',
        question: this.state.recommendation.question,
        skills: selectedSkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          sourceLabel: skill.sourceLabel,
          location: skill.location
        }))
      }, null, 2),
      'utf8'
    );

    await this.refresh({ announce: false, reason: 'manual' });
    this.state.projectConfig = {
      ...this.state.projectConfig,
      lastAppliedAt: new Date().toISOString(),
      lastAppliedCount: selectedSkills.length
    };
    this.recomputeDerivedState({
      statusMessage: `Applied ${selectedSkills.length} skill(s) to ${path.relative(targetWorkspace.fsPath, targetRoot)}.`
    });
    vscode.window.showInformationMessage(`Applied ${selectedSkills.length} skill(s) to ${targetWorkspace.name}.`);
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

  public toggleRecommendedSkill(skillId: string): void {
    const nextSelection = new Set(this.state.recommendation.selectedSkillIds);
    if (nextSelection.has(skillId)) {
      nextSelection.delete(skillId);
    } else {
      nextSelection.add(skillId);
    }

    this.state.recommendation = {
      ...this.state.recommendation,
      selectedSkillIds: [...nextSelection]
    };
    this.emitState();
  }

  public setProjectWorkspace(workspaceId?: string): void {
    this.state.projectConfig = {
      ...this.state.projectConfig,
      selectedWorkspaceId: workspaceId
    };
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
      this.refreshRuntimeState(keyConfigured);

      const settings = this.readSettings();
      const workspaceFolders = this.readWorkspaceFolders();
      const localSkills = await discoverLocalSkills(
        workspaceFolders.map((folder) => ({ name: folder.name, fsPath: folder.fsPath })),
        settings.additionalGlobalPaths
      );

      const { sources: githubSources, errors: githubConfigErrors } = parseConfiguredGitHubSourceUrls(settings.githubUrls);
      let onlineSkills: SkillRecord[] = [];
      let onlineErrorMessage: string | undefined;
      let statusMessage = githubConfigErrors.length > 0
        ? `Ignored ${githubConfigErrors.length} invalid GitHub source(s).`
        : 'Catalog refreshed.';

      if (githubSources.length > 0) {
        try {
          onlineSkills = await discoverOnlineSkills(githubSources, settings.timeoutMs);
          await this.context.globalState.update(ONLINE_CACHE_KEY, {
            refreshedAt: new Date().toISOString(),
            sourceUrls: settings.githubUrls,
            skills: onlineSkills
          } satisfies OnlineCacheEntry);
        } catch (error) {
          const cached = this.context.globalState.get<OnlineCacheEntry | undefined>(ONLINE_CACHE_KEY);
          const canUseCached = cached && sameStringArray(cached.sourceUrls, settings.githubUrls);
          onlineSkills = canUseCached ? cached.skills : [];
          onlineErrorMessage = toErrorMessage(error);
          statusMessage = onlineSkills.length > 0
            ? `GitHub sync failed, using cached skills: ${onlineErrorMessage}`
            : `GitHub sync failed: ${onlineErrorMessage}`;

          if (options.reason === 'manual') {
            void this.offerGitHubRecoveryOptions(statusMessage);
          }
        }
      }

      const skills = [...localSkills, ...onlineSkills];
      this.state.snapshot = this.buildSnapshot(skills, keyConfigured);
      this.state.onlineSources = {
        githubUrls: settings.githubUrls,
        lastError: onlineErrorMessage ?? (githubConfigErrors.length > 0 ? githubConfigErrors.join('\n') : undefined)
      };
      this.recomputeDerivedState({
        statusMessage
      });

      if (options.announce && options.reason === 'manual') {
        vscode.window.showInformationMessage(
          `SkillMatch refreshed ${skills.length} skills (${localSkills.length} local, ${onlineSkills.length} online).`
        );
      }

      if (keyConfigured && settings.autoGenerateTagsOnRefresh) {
        void this.generateTags({ announce: false });
      }

      if (settings.lightRagAutoSyncOnRefresh) {
        void this.syncKnowledgeBase({ announce: false });
      }
    } catch (error) {
      const message = `SkillMatch refresh failed: ${toErrorMessage(error)}`;
      this.recomputeDerivedState({ statusMessage: message });
      vscode.window.showErrorMessage(message);
    } finally {
      this.setBusy(false);
    }
  }

  private async performKnowledgeBaseSync(options: { announce: boolean; force?: boolean }): Promise<void> {
    const settings = this.readSettings();
    const snapshotHash = createSnapshotHash(this.state.snapshot.skills);
    const syncCache = this.readLightRagSyncCache();
    const cacheEntry = syncCache[this.state.lightRag.workspace];

    if (!options.force && cacheEntry?.snapshotHash === snapshotHash && this.state.lightRag.ready) {
      return;
    }

    this.state.lightRag = {
      ...this.state.lightRag,
      syncing: true,
      statusMessage: 'Syncing skills into LightRAG...'
    };
    this.emitState();

    try {
      const client = new LightRagClient({
        baseUrl: settings.lightRagBaseUrl,
        workspace: this.state.lightRag.workspace,
        timeoutMs: settings.timeoutMs
      });

      await client.getStatus();
      await client.clearDocuments();

      const documents = await mapLimit(this.state.snapshot.skills, 4, async (skill) => {
        let manifestContent: string | undefined;
        try {
          manifestContent = await loadSkillManifestContent(skill, settings.timeoutMs);
        } catch {
          manifestContent = undefined;
        }

        return {
          fileSource: buildKnowledgeBaseFileSource(skill),
          text: buildSkillKnowledgeDocument(skill, manifestContent)
        };
      });

      if (documents.length > 0) {
        const insertResult = await client.insertTexts(
          documents.map((entry) => entry.text),
          documents.map((entry) => entry.fileSource)
        );

        if (insertResult.trackId) {
          await client.waitForTrack(insertResult.trackId, documents.length, settings.lightRagSyncTimeoutMs);
        }
      }

      const nextCache = {
        ...syncCache,
        [this.state.lightRag.workspace]: {
          snapshotHash,
          syncedAt: new Date().toISOString(),
          skillCount: this.state.snapshot.skills.length
        }
      };
      await this.context.globalState.update(LIGHTRAG_SYNC_CACHE_KEY, nextCache);

      this.state.lightRag = {
        ...this.state.lightRag,
        ready: true,
        syncing: false,
        syncedAt: nextCache[this.state.lightRag.workspace]?.syncedAt,
        statusMessage: `LightRAG synced ${this.state.snapshot.skills.length} skills.`
      };
      this.emitState();

      if (options.announce) {
        vscode.window.showInformationMessage(`LightRAG synced ${this.state.snapshot.skills.length} skills.`);
      }
    } catch (error) {
      const message = `LightRAG sync failed: ${toErrorMessage(error)}`;
      this.state.lightRag = {
        ...this.state.lightRag,
        ready: false,
        syncing: false,
        statusMessage: message
      };
      this.emitState();

      if (options.announce) {
        const choice = await vscode.window.showWarningMessage(message, 'Configure LightRAG URL');
        if (choice === 'Configure LightRAG URL') {
          await this.configureLightRagBaseUrl();
        }
      }
    }
  }

  private async performRecommendation(question: string): Promise<void> {
    const settings = this.readSettings();
    const apiKey = await this.context.secrets.get(OPENROUTER_SECRET_KEY);
    const openRouterClient = apiKey
      ? new OpenRouterClient({
          apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          batchSize: settings.batchSize,
          tagPrompt: settings.tagPrompt
        })
      : undefined;

    let source: SkillRecommendationState['source'] = 'heuristic';
    let summary = '';
    let statusMessage = '';
    let candidates = rankSkillsLexically(question, this.state.snapshot.skills).slice(0, 12);
    let retrievalContext = '';

    try {
      await this.syncKnowledgeBase({ announce: false });
      const client = new LightRagClient({
        baseUrl: settings.lightRagBaseUrl,
        workspace: this.state.lightRag.workspace,
        timeoutMs: settings.timeoutMs
      });
      const query = await client.query(question);
      retrievalContext = query.response;

      const candidateIds = uniqueStrings(
        query.references
          .map((reference) => extractSkillIdFromKnowledgeBaseFileSource(reference.filePath))
          .filter((skillId): skillId is string => Boolean(skillId))
      );

      if (candidateIds.length > 0) {
        const matched = candidateIds
          .map((skillId) => this.state.snapshot.skills.find((skill) => skill.id === skillId))
          .filter((skill): skill is SkillRecord => Boolean(skill));
        if (matched.length > 0) {
          candidates = matched;
          source = 'lightrag+openrouter';
        }
      }
    } catch (error) {
      statusMessage = `LightRAG retrieval unavailable, falling back to direct ranking: ${toErrorMessage(error)}`;
      source = 'openrouter';
    }

    let items: RecommendedSkill[] = [];
    if (openRouterClient) {
      try {
        const response = await openRouterClient.recommendSkills({
          question,
          retrievedContext: retrievalContext,
          candidates
        });

        items = response.skills
          .map((entry) => {
            const skill = this.state.snapshot.skills.find((candidate) => candidate.id === entry.id);
            if (!skill) {
              return undefined;
            }

            return {
              skillId: skill.id,
              reason: entry.reason,
              score: entry.score
            } satisfies RecommendedSkill;
          })
          .filter((entry): entry is RecommendedSkill => Boolean(entry));
        summary = response.summary?.trim() ?? '';
        if (!statusMessage) {
          statusMessage = source === 'lightrag+openrouter'
            ? 'Ranked with LightRAG retrieval + OpenRouter.'
            : 'Ranked with OpenRouter over the current catalog.';
        }
      } catch (error) {
        source = 'heuristic';
        statusMessage = `OpenRouter ranking failed, using heuristic matches: ${toErrorMessage(error)}`;
      }
    } else {
      source = 'heuristic';
      statusMessage = 'OpenRouter key not configured, showing heuristic matches.';
    }

    if (items.length === 0) {
      const fallback = rankSkillsLexically(question, this.state.snapshot.skills).slice(0, 6);
      items = fallback.map((skill, index) => ({
        skillId: skill.id,
        score: Math.max(50, 96 - index * 9),
        reason: buildHeuristicReason(question, skill)
      }));
      if (!summary) {
        summary = 'These skills overlap most with the request keywords and current catalog metadata.';
      }
    }

    const selectedSkillIds = items.slice(0, Math.min(4, items.length)).map((entry) => entry.skillId);
    this.state.recommendation = {
      question,
      loading: false,
      source,
      summary: summary || undefined,
      statusMessage,
      items,
      selectedSkillIds
    };
    if (items[0]) {
      this.state.selectedSkillId = items[0].skillId;
    }
    this.emitState();
  }

  private buildSnapshot(skills: SkillRecord[], keyConfigured: boolean): SkillSnapshot {
    const aiCache = this.readAiCache();
    const settings = this.readSettings();
    const promptHash = createTagPromptHash(settings.tagPrompt);
    const enrichedSkills: SkillRecord[] = skills.map((skill): SkillRecord => {
      const cached = aiCache[createInsightCacheKey(skill)];
      const insight = cached ?? toAiCacheEntry(buildHeuristicInsight(skill));

      return {
        ...skill,
        category: insight.category,
        tags: insight.tags,
        tagSource: cached ? 'ai' : 'heuristic',
        tagGeneratedAt: cached?.generatedAt,
        tagModel: cached?.model,
        tagPromptHash: cached?.promptHash,
        tagPromptStale: cached ? hasPromptMismatch(cached, settings.tagPrompt, promptHash) || cached.model !== settings.model : false
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
    statusMessage?: string;
    selectedSkillId?: string;
  }): void {
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

    this.state.recommendation = {
      ...this.state.recommendation,
      items: this.state.recommendation.items.filter((entry) =>
        this.state.snapshot.skills.some((skill) => skill.id === entry.skillId)
      ),
      selectedSkillIds: this.state.recommendation.selectedSkillIds.filter((skillId) =>
        this.state.snapshot.skills.some((skill) => skill.id === skillId)
      )
    };

    this.emitState();
  }

  private emitState(): void {
    this.changeEmitter.fire({
      snapshot: this.state.snapshot,
      filter: this.state.filter,
      visibleSkills: this.state.visibleSkills,
      graph: this.state.graph,
      openRouter: this.state.openRouter,
      lightRag: this.state.lightRag,
      onlineSources: this.state.onlineSources,
      recommendation: this.state.recommendation,
      projectConfig: this.state.projectConfig,
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

  private refreshRuntimeState(keyConfigured: boolean): void {
    const settings = this.readSettings();
    const workspaces = this.readWorkspaceFolders();
    const pendingTagCount = countPendingTagGeneration(
      this.state.snapshot.skills,
      this.readAiCache(),
      settings,
      createTagPromptHash(settings.tagPrompt)
    );
    const selectedWorkspaceId = workspaces.some((workspace) => workspace.id === this.state.projectConfig.selectedWorkspaceId)
      ? this.state.projectConfig.selectedWorkspaceId
      : workspaces[0]?.id;

    this.state.snapshot = {
      ...this.state.snapshot,
      keyConfigured
    };
    this.state.openRouter = {
      baseUrl: settings.baseUrl,
      model: settings.model,
      keyConfigured,
      availableModels: ensureCurrentModel(this.state.openRouter.availableModels, settings.model),
      modelsLoading: this.state.openRouter.modelsLoading,
      modelsUpdatedAt: this.state.openRouter.modelsUpdatedAt,
      modelsError: this.state.openRouter.modelsError,
      pendingTagCount,
      tagPrompt: settings.tagPrompt,
      tagBatchSize: settings.batchSize,
      tagMaxSkillsPerRun: settings.maxSkillsPerRun,
      tagRequestDelayMs: settings.requestDelayMs,
      autoGenerateTagsOnRefresh: settings.autoGenerateTagsOnRefresh,
      tagGeneration: this.state.openRouter.tagGeneration
    };
    this.state.onlineSources = {
      ...this.state.onlineSources,
      githubUrls: settings.githubUrls
    };
    this.state.projectConfig = {
      ...this.state.projectConfig,
      workspaces,
      selectedWorkspaceId,
      applyRelativePath: settings.projectApplyRelativePath
    };
    this.state.lightRag = {
      ...this.state.lightRag,
      baseUrl: settings.lightRagBaseUrl,
      workspace: buildLightRagWorkspaceId(workspaces.map((workspace) => workspace.id))
    };
  }

  private readSettings(): RefreshSettings {
    const config = vscode.workspace.getConfiguration('skillMap');
    return {
      baseUrl: config.get<string>('openRouter.baseUrl', 'https://openrouter.ai/api/v1'),
      model: config.get<string>('openRouter.model', 'openai/gpt-4.1-mini'),
      batchSize: config.get<number>('openRouter.batchSize', 8),
      maxSkillsPerRun: config.get<number>('openRouter.maxSkillsPerRun', 24),
      requestDelayMs: config.get<number>('openRouter.requestDelayMs', 0),
      tagPrompt: config.get<string>('openRouter.tagPrompt', ''),
      autoGenerateTagsOnRefresh: config.get<boolean>('openRouter.autoGenerateTagsOnRefresh', true),
      additionalGlobalPaths: config.get<string[]>('scan.additionalGlobalPaths', []),
      timeoutMs: config.get<number>('onlineSources.timeoutMs', 12000),
      maxTags: config.get<number>('visualization.maxTags', 36),
      githubUrls: config.get<string[]>('onlineSources.githubUrls', []),
      lightRagBaseUrl: config.get<string>('lightRag.baseUrl', 'http://127.0.0.1:9621'),
      lightRagAutoSyncOnRefresh: config.get<boolean>('lightRag.autoSyncOnRefresh', true),
      lightRagSyncTimeoutMs: config.get<number>('lightRag.syncTimeoutMs', 120000),
      projectApplyRelativePath: config.get<string>('project.applyRelativePath', '.codex/skills/skillmatch-curated')
    };
  }

  private readAiCache(): Record<string, AiCacheEntry> {
    return this.context.globalState.get<Record<string, AiCacheEntry>>(AI_CACHE_KEY, {});
  }

  private readLightRagSyncCache(): Record<string, LightRagSyncCacheEntry> {
    return this.context.globalState.get<Record<string, LightRagSyncCacheEntry>>(LIGHTRAG_SYNC_CACHE_KEY, {});
  }

  private readWorkspaceFolders(): ProjectWorkspaceSummary[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      id: folder.uri.toString(),
      name: folder.name,
      fsPath: folder.uri.fsPath
    }));
  }

  private resolveSelectedWorkspace(): ProjectWorkspaceSummary | undefined {
    return this.state.projectConfig.workspaces.find((workspace) => workspace.id === this.state.projectConfig.selectedWorkspaceId)
      ?? this.state.projectConfig.workspaces[0];
  }

  private async offerGitHubRecoveryOptions(message: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(message, 'Configure GitHub Links', 'Retry Refresh');
    if (choice === 'Configure GitHub Links') {
      await this.configureGitHubSources();
      return;
    }

    if (choice === 'Retry Refresh') {
      await this.refresh({ announce: true, reason: 'manual' });
    }
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

function emptyViewState(): ViewState {
  return {
    snapshot: emptySnapshot(false),
    filter: { scope: 'all' },
    visibleSkills: [],
    graph: { nodes: [], links: [] },
    openRouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      keyConfigured: false,
      availableModels: [{ id: 'openai/gpt-4.1-mini', name: 'openai/gpt-4.1-mini' }],
      modelsLoading: false,
      pendingTagCount: 0,
      tagPrompt: '',
      tagBatchSize: 8,
      tagMaxSkillsPerRun: 24,
      tagRequestDelayMs: 0,
      autoGenerateTagsOnRefresh: true,
      tagGeneration: {
        running: false,
        stopping: false,
        completed: 0,
        total: 0
      }
    },
    lightRag: {
      baseUrl: 'http://127.0.0.1:9621',
      workspace: buildLightRagWorkspaceId([]),
      ready: false,
      syncing: false
    },
    onlineSources: {
      githubUrls: []
    },
    recommendation: {
      question: '',
      loading: false,
      source: 'heuristic',
      items: [],
      selectedSkillIds: []
    },
    projectConfig: {
      workspaces: [],
      applyRelativePath: '.codex/skills/skillmatch-curated'
    },
    busy: false
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

function createTagPromptHash(prompt: string): string {
  return hashText(prompt.trim());
}

function shouldGenerateTagsForSkill(
  skill: Pick<SkillRecord, 'name' | 'description'>,
  aiCache: Record<string, AiCacheEntry>,
  settings: RefreshSettings,
  promptHash: string
): boolean {
  const cacheKey = createInsightCacheKey(skill);
  const cached = aiCache[cacheKey];
  return !cached || cached.model !== settings.model || hasPromptMismatch(cached, settings.tagPrompt, promptHash);
}

function countPendingTagGeneration(
  skills: readonly Pick<SkillRecord, 'name' | 'description'>[],
  aiCache: Record<string, AiCacheEntry>,
  settings: RefreshSettings,
  promptHash: string
): number {
  return skills.filter((skill) => shouldGenerateTagsForSkill(skill, aiCache, settings, promptHash)).length;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function hasPromptMismatch(entry: AiCacheEntry, tagPrompt: string, promptHash: string): boolean {
  if (entry.promptHash) {
    return entry.promptHash !== promptHash;
  }

  return tagPrompt.trim().length > 0;
}

function createSnapshotHash(skills: SkillRecord[]): string {
  return hashText(JSON.stringify(skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    tags: skill.tags,
    location: skill.location,
    lastSyncedAt: skill.lastSyncedAt
  }))));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}

function ensureCurrentModel(models: OpenRouterModelSummary[], currentModel: string): OpenRouterModelSummary[] {
  if (models.some((entry) => entry.id === currentModel)) {
    return models;
  }

  return [
    { id: currentModel, name: currentModel },
    ...models
  ];
}

function rankSkillsLexically(question: string, skills: SkillRecord[]): SkillRecord[] {
  const tokens = tokenize(question);

  return [...skills]
    .map((skill) => ({
      skill,
      score: scoreSkill(tokens, skill)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .map((entry) => entry.skill);
}

function scoreSkill(tokens: readonly string[], skill: SkillRecord): number {
  const haystack = `${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(' ')} ${skill.sourceLabel}`.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (skill.name.toLowerCase().includes(token)) {
      score += 6;
    }
    if (skill.tags.some((tag) => tag.toLowerCase().includes(token))) {
      score += 4;
    }
    if (haystack.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9#+./-]+/g).filter((token) => token.length >= 2))];
}

function buildHeuristicReason(question: string, skill: SkillRecord): string {
  const tokens = tokenize(question);
  const matched = skill.tags.filter((tag) => tokens.some((token) => tag.toLowerCase().includes(token))).slice(0, 2);

  if (matched.length > 0) {
    return `Matches the request through ${matched.join(' and ')}.`;
  }

  return `Relevant to ${skill.category.toLowerCase()} work and ${skill.scope} skills.`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
