import * as vscode from 'vscode';

import { SkillCatalogService } from '../core/skillCatalogService';
import { createNonce, escapeHtml } from '../core/utils';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/types';

export class OverviewWebviewSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly service: SkillCatalogService
  ) {
    this.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };

    this.webview.html = this.renderHtml();

    this.disposables.push(
      this.service.onDidChangeState((state) => {
        void this.postMessage({ type: 'state', state });
      }),
      this.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        void this.handleMessage(message);
      })
    );
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postMessage({ type: 'state', state: this.service.getState() });
        break;
      case 'refresh':
        await this.service.refresh({ announce: true, reason: 'manual' });
        break;
      case 'configureOpenRouterKey':
        await this.service.configureOpenRouterKey();
        break;
      case 'clearOpenRouterKey':
        await this.service.clearOpenRouterKey();
        break;
      case 'generateTags':
        await this.service.generateTags({ announce: true });
        break;
      case 'setFilter':
        this.service.setFilter(message.filter);
        break;
      case 'clearFilter':
        this.service.clearFilter();
        break;
      case 'openSkill':
        await this.service.openSkill(message.skillId);
        break;
      case 'selectSkill':
        this.service.selectSkill(message.skillId);
        break;
    }
  }

  private async postMessage(message: ExtensionToWebviewMessage): Promise<void> {
    await this.webview.postMessage(message);
  }

  private renderHtml(): string {
    const nonce = createNonce();
    const scriptUri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const initialState = this.service.getState();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${this.webview.cspSource} https: data:; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Skill Map Overview</title>
    <style>
      :root {
        color-scheme: light dark;
        --panel-bg: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
        --panel-border: color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
        --accent: color-mix(in srgb, var(--vscode-textLink-foreground) 86%, #8bd3e6);
        --accent-strong: color-mix(in srgb, var(--vscode-button-background) 80%, #f6c451);
        --surface-muted: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 60%, transparent);
        --danger: var(--vscode-errorForeground);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background:
          radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 38%),
          radial-gradient(circle at 90% 10%, color-mix(in srgb, var(--accent-strong) 14%, transparent), transparent 35%),
          var(--vscode-editor-background);
      }
      #app { min-height: 100vh; }
      button, input { font: inherit; }
      .shell { padding: 14px; }
      .hero {
        display: grid; gap: 12px; padding: 16px; border: 1px solid var(--panel-border);
        border-radius: 18px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--panel-bg) 84%, transparent), color-mix(in srgb, var(--surface-muted) 68%, transparent));
        backdrop-filter: blur(14px);
      }
      .hero h1 { margin: 0; font-size: 18px; }
      .hero p { margin: 0; opacity: 0.82; line-height: 1.5; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
      .toolbar button, .chip {
        border: 1px solid var(--panel-border); border-radius: 999px; padding: 7px 12px;
        background: color-mix(in srgb, var(--panel-bg) 86%, transparent); color: inherit; cursor: pointer;
      }
      .toolbar button.primary, .chip.active {
        background: color-mix(in srgb, var(--accent-strong) 28%, var(--panel-bg));
        border-color: color-mix(in srgb, var(--accent-strong) 65%, var(--panel-border));
      }
      .status { font-size: 12px; opacity: 0.75; }
      .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; margin-top: 14px; }
      .metric { border-radius: 14px; padding: 12px; border: 1px solid var(--panel-border); background: color-mix(in srgb, var(--panel-bg) 80%, transparent); }
      .metric span { display: block; font-size: 11px; opacity: 0.76; text-transform: uppercase; letter-spacing: 0.08em; }
      .metric strong { display: block; margin-top: 6px; font-size: 22px; }
      .grid { display: grid; gap: 14px; margin-top: 14px; }
      .filters, .visual, .list, .detail {
        border: 1px solid var(--panel-border); border-radius: 18px; background: color-mix(in srgb, var(--panel-bg) 84%, transparent); padding: 14px;
      }
      .section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
      .section-head h2 { margin: 0; font-size: 14px; }
      .chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .content-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
      .stack { display: grid; gap: 14px; }
      .search {
        width: 100%; border-radius: 12px; border: 1px solid var(--panel-border); padding: 10px 12px;
        background: color-mix(in srgb, var(--panel-bg) 92%, transparent); color: inherit;
      }
      .skill-list { display: grid; gap: 10px; max-height: 620px; overflow: auto; }
      .skill-card {
        border: 1px solid var(--panel-border); border-radius: 14px; padding: 12px;
        background: color-mix(in srgb, var(--panel-bg) 76%, transparent); cursor: pointer;
      }
      .skill-card.active { border-color: color-mix(in srgb, var(--accent) 70%, var(--panel-border)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent); }
      .skill-card h3 { margin: 0 0 8px; font-size: 14px; }
      .skill-card p { margin: 0; font-size: 12px; line-height: 1.45; opacity: 0.82; }
      .meta-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
      .pill {
        display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px;
        border: 1px solid var(--panel-border); font-size: 11px; background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
      }
      .detail-empty { opacity: 0.72; line-height: 1.6; }
      .detail header { display: grid; gap: 8px; margin-bottom: 12px; }
      .detail header h2 { margin: 0; font-size: 16px; }
      .detail p { margin: 0; line-height: 1.55; }
      .tag-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .tag {
        padding: 6px 10px; border-radius: 999px; border: 1px solid var(--panel-border);
        font-size: 11px; background: color-mix(in srgb, var(--accent) 11%, var(--panel-bg));
      }
      .graph-wrap {
        position: relative; min-height: 320px; overflow: hidden; border-radius: 14px; border: 1px solid var(--panel-border);
        background: radial-gradient(circle at center, color-mix(in srgb, var(--accent) 10%, transparent), transparent 62%), color-mix(in srgb, var(--panel-bg) 78%, transparent);
      }
      .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .legend .pill { cursor: default; }
      svg { width: 100%; height: 320px; display: block; }
      .empty { padding: 24px; text-align: center; opacity: 0.8; }
      @media (min-width: 1380px) {
        .content-grid { grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr); }
        .graph-wrap { min-height: 420px; }
        svg { height: 420px; }
      }
    </style>
  </head>
  <body>
    <div id="app" data-state="${escapeHtml(JSON.stringify(initialState))}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
