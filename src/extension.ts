import * as vscode from 'vscode';

import { SkillCatalogService } from './core/skillCatalogService';
import { SkillsTreeProvider } from './views/skillsTreeProvider';
import { SkillsOverviewProvider } from './views/overviewViewProvider';
import { OverviewWebviewSession } from './views/overviewWebview';
import type { SkillFilter } from './shared/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
    vscode.commands.registerCommand('skillMap.clearOpenRouterKey', async () => {
      await service.clearOpenRouterKey();
    }),
    vscode.commands.registerCommand('skillMap.generateTags', async () => {
      await service.generateTags({ announce: true });
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
      const panel = vscode.window.createWebviewPanel(
        'skillMap.dashboard',
        'Skill Map Dashboard',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      const session = new OverviewWebviewSession(panel.webview, context.extensionUri, service);
      panel.onDidDispose(() => {
        session.dispose();
      });
    })
  );

  await service.initialize();
}

export function deactivate(): void {}
