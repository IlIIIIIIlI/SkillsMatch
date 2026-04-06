import * as vscode from 'vscode';

import { applyCategoryFilter, applySourceFilter } from '../shared/filterState';
import type { SkillFilter, SkillRecord, SkillSourceSummary } from '../shared/types';
import { SkillCatalogService } from '../core/skillCatalogService';

type SkillTreeNode =
  | { kind: 'all' }
  | { kind: 'scopeRoot'; scope: 'workspace' | 'global' | 'online'; label: string }
  | { kind: 'categoriesRoot' }
  | { kind: 'category'; category: string; count: number }
  | { kind: 'source'; source: SkillSourceSummary }
  | { kind: 'skill'; skill: SkillRecord };

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<SkillTreeNode | undefined>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly service: SkillCatalogService) {
    this.service.onDidChangeState(() => {
      this.changeEmitter.fire(undefined);
    });
  }

  public getTreeItem(node: SkillTreeNode): vscode.TreeItem {
    const state = this.service.getState();

    switch (node.kind) {
      case 'all': {
        const item = new vscode.TreeItem(`All Skills (${state.snapshot.counts.all})`, vscode.TreeItemCollapsibleState.None);
        item.command = {
          command: 'skillMap.clearFilter',
          title: 'Show all skills'
        };
        item.description = filterEquals(state.filter, { scope: 'all' }) ? 'active' : undefined;
        item.iconPath = new vscode.ThemeIcon(filterEquals(state.filter, { scope: 'all' }) ? 'check' : 'library');
        return item;
      }
      case 'categoriesRoot': {
        const item = new vscode.TreeItem(
          `Categories (${state.snapshot.categories.length})`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon('symbol-class');
        return item;
      }
      case 'scopeRoot': {
        const count = state.snapshot.skills.filter((skill) => skill.scope === node.scope).length;
        const item = new vscode.TreeItem(`${node.label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('folder-library');
        return item;
      }
      case 'category': {
        const filter = applyCategoryFilter(state.filter, node.category);

        const item = new vscode.TreeItem(`${node.category} (${node.count})`, vscode.TreeItemCollapsibleState.None);
        item.command = {
          command: 'skillMap.setFilter',
          title: 'Filter by category',
          arguments: [filter]
        };
        item.description = filterEquals(state.filter, filter) ? 'active' : undefined;
        item.iconPath = new vscode.ThemeIcon(filterEquals(state.filter, filter) ? 'check' : 'tag');
        return item;
      }
      case 'source': {
        const filter = applySourceFilter(state.filter, node.source.id, node.source.scope);
        const item = new vscode.TreeItem(`${node.source.label} (${node.source.count})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.command = {
          command: 'skillMap.setFilter',
          title: 'Filter by source',
          arguments: [filter]
        };
        item.description = filterEquals(state.filter, filter) ? 'active' : undefined;
        item.iconPath = new vscode.ThemeIcon(filterEquals(state.filter, filter) ? 'check' : 'folder');
        return item;
      }
      case 'skill': {
        const item = new vscode.TreeItem(node.skill.name, vscode.TreeItemCollapsibleState.None);
        item.description = node.skill.category;
        item.tooltip = `${node.skill.description}\n\n${node.skill.sourceLabel}`;
        item.command = {
          command: 'skillMap.openSkill',
          title: 'Open skill',
          arguments: [node.skill.id]
        };
        item.iconPath = new vscode.ThemeIcon(scopeIcon(node.skill.scope));
        return item;
      }
    }
  }

  public getChildren(node?: SkillTreeNode): Thenable<SkillTreeNode[]> {
    const state = this.service.getState();

    if (!node) {
      return Promise.resolve([
        { kind: 'all' },
        { kind: 'categoriesRoot' },
        { kind: 'scopeRoot', scope: 'workspace', label: 'Workspace' },
        { kind: 'scopeRoot', scope: 'global', label: 'Global' },
        { kind: 'scopeRoot', scope: 'online', label: 'Online' }
      ]);
    }

    switch (node.kind) {
      case 'categoriesRoot':
        return Promise.resolve(
          state.snapshot.categories.map((category) => ({
            kind: 'category',
            category: category.name,
            count: category.count
          }))
        );
      case 'scopeRoot':
        return Promise.resolve(
          state.snapshot.sources
            .filter((source) => source.scope === node.scope)
            .map((source) => ({
              kind: 'source',
              source
            }))
        );
      case 'source':
        return Promise.resolve(
          state.snapshot.skills
            .filter((skill) => skill.sourceId === node.source.id)
            .map((skill) => ({
              kind: 'skill',
              skill
            }))
        );
      default:
        return Promise.resolve([]);
    }
  }
}

function filterEquals(left: SkillFilter, right: SkillFilter): boolean {
  return left.scope === right.scope && left.category === right.category && left.sourceId === right.sourceId;
}

function scopeIcon(scope: SkillRecord['scope']): string {
  switch (scope) {
    case 'workspace':
      return 'root-folder';
    case 'global':
      return 'globe';
    case 'online':
      return 'cloud';
  }
}
