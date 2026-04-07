import * as vscode from 'vscode';

import { SkillCatalogService } from './core/skillCatalogService';
import { SkillsTreeProvider } from './views/skillsTreeProvider';
import { SkillsOverviewProvider } from './views/overviewViewProvider';
import { OverviewWebviewSession } from './views/overviewWebview';
import type { SkillFilter } from './shared/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let dashboardPanel: vscode.WebviewPanel | undefined;

  const service = new SkillCatalogService(context);
  const treeProvider = new SkillsTreeProvider(service);
  const treeView = vscode.window.createTreeView('skillMap.explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  const explorerTreeView = vscode.window.createTreeView('skillMap.explorerInline', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  const overviewProvider = new SkillsOverviewProvider(context.extensionUri, service);

  await vscode.commands.executeCommand('setContext', 'skillMap.dashboardOpen', false);

  context.subscriptions.push(
    treeView,
    explorerTreeView,
    vscode.window.registerWebviewViewProvider('skillMap.overview', overviewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('skillMap.refresh', async () => {
      await service.refresh({ announce: true, reason: 'manual' });
    }),
    vscode.commands.registerCommand('skillMap.configureOpenRouterKey', async () => {
      await service.configureOpenRouterKey();
    }),
    vscode.commands.registerCommand('skillMap.openOpenRouterSettings', async () => {
      await service.openOpenRouterSettings();
    }),
    vscode.commands.registerCommand('skillMap.configureLightRagBaseUrl', async () => {
      await service.configureLightRagBaseUrl();
    }),
    vscode.commands.registerCommand('skillMap.configureGitHubSources', async () => {
      await service.configureGitHubSources();
    }),
    vscode.commands.registerCommand('skillMap.clearOpenRouterKey', async () => {
      await service.clearOpenRouterKey();
    }),
    vscode.commands.registerCommand('skillMap.generateTags', async () => {
      await service.generateTags({ announce: true });
    }),
    vscode.commands.registerCommand('skillMap.syncKnowledgeBase', async () => {
      await service.syncKnowledgeBase({ announce: true, force: true });
    }),
    vscode.commands.registerCommand('skillMap.applyRecommendedSkills', async () => {
      await service.applyRecommendedSkills();
    }),
    vscode.commands.registerCommand('skillMap.openSkill', async (skillId: string) => {
      await service.openSkill(skillId);
    }),
    vscode.commands.registerCommand('skillMap.setFilter', (filter: SkillFilter) => {
      service.setFilter(filter);
    }),
    vscode.commands.registerCommand('skillMap.clearFilter', () => {
      service.clearFilter();
    }),
    vscode.commands.registerCommand('skillMap.openDashboard', async () => {
      if (dashboardPanel) {
        await vscode.commands.executeCommand('setContext', 'skillMap.dashboardOpen', true);
        dashboardPanel.reveal(vscode.ViewColumn.One, false);
        return;
      }

      dashboardPanel = vscode.window.createWebviewPanel(
        'skillMap.dashboard',
        'Skill Map Dashboard',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
        }
      );

      await vscode.commands.executeCommand('setContext', 'skillMap.dashboardOpen', true);

      const session = new OverviewWebviewSession(dashboardPanel.webview, context.extensionUri, service, true);
      dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
        session.dispose();
        void vscode.commands.executeCommand('setContext', 'skillMap.dashboardOpen', false);
      });
    })
  );

  await service.initialize();
}

export function deactivate(): void {}
