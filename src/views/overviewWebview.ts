import * as vscode from 'vscode';

import { SkillCatalogService } from '../core/skillCatalogService';
import { createNonce, escapeHtml } from '../core/utils';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/types';

export class OverviewWebviewSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly service: SkillCatalogService,
    private readonly isDashboard: boolean = false
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
      case 'openOpenRouterSettings':
        await this.service.openOpenRouterSettings();
        break;
      case 'refreshOpenRouterModels':
        await this.service.refreshOpenRouterModels({ announce: true });
        break;
      case 'setOpenRouterModel':
        await this.service.setOpenRouterModel(message.model);
        break;
      case 'configureLightRagBaseUrl':
        await this.service.configureLightRagBaseUrl();
        break;
      case 'configureGitHubSources':
        await this.service.configureGitHubSources();
        break;
      case 'clearOpenRouterKey':
        await this.service.clearOpenRouterKey();
        break;
      case 'generateTags':
        await this.service.generateTags({ announce: true });
        break;
      case 'syncKnowledgeBase':
        await this.service.syncKnowledgeBase({ announce: true, force: true });
        break;
      case 'recommendSkills':
        await this.service.recommendSkills(message.question);
        break;
      case 'toggleRecommendedSkill':
        this.service.toggleRecommendedSkill(message.skillId);
        break;
      case 'applyRecommendedSkills':
        await this.service.applyRecommendedSkills();
        break;
      case 'setProjectWorkspace':
        this.service.setProjectWorkspace(message.workspaceId);
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
      content="default-src 'none'; img-src ${this.webview.cspSource} https: data: blob:; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src blob:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SkillMatch Overview</title>
    <style>
      :root {
        color-scheme: light dark;
        --panel-bg: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
        --panel-border: color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
        --accent: color-mix(in srgb, var(--vscode-textLink-foreground) 86%, #8bd3e6);
        --accent-strong: color-mix(in srgb, var(--vscode-button-background) 80%, #f6c451);
        --surface-muted: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 60%, transparent);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      #app { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
      /* Scrollable wrapper for everything above the graph */
      .above-fold { flex-shrink: 0; overflow-y: auto; max-height: 45vh; }
      button, input, select { font: inherit; }

      /* ── Top bar ── */
      .topbar {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 10px 14px; border-bottom: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 92%, transparent);
        position: sticky; top: 0; z-index: 10; flex-shrink: 0;
      }
      .topbar-title { font-size: 13px; font-weight: 600; white-space: nowrap; margin-right: 4px; }
      .scope-tabs { display: flex; gap: 2px; }
      .scope-tab {
        border: 1px solid transparent; border-radius: 6px; padding: 4px 10px;
        background: none; color: inherit; cursor: pointer; font-size: 12px; opacity: 0.7;
        transition: opacity 0.1s, background 0.1s;
      }
      .scope-tab:hover { opacity: 1; background: color-mix(in srgb, var(--panel-bg) 80%, transparent); }
      .scope-tab.active {
        opacity: 1; border-color: var(--panel-border);
        background: color-mix(in srgb, var(--accent) 18%, var(--panel-bg));
      }
      .scope-tab .count { font-size: 10px; opacity: 0.65; margin-left: 3px; }
      .topbar-search {
        flex: 1; min-width: 140px; max-width: 280px;
        border-radius: 8px; border: 1px solid var(--panel-border); padding: 5px 10px;
        background: color-mix(in srgb, var(--panel-bg) 92%, transparent); color: inherit; font-size: 12px;
      }
      .topbar-sep { width: 1px; height: 20px; background: var(--panel-border); flex-shrink: 0; }
      .icon-btn {
        border: none; background: none; color: inherit; cursor: pointer; padding: 4px 6px;
        border-radius: 6px; opacity: 0.7; font-size: 13px;
        transition: opacity 0.1s, background 0.1s;
      }
      .icon-btn:hover { opacity: 1; background: color-mix(in srgb, var(--panel-bg) 80%, transparent); }
      .status-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        background: color-mix(in srgb, var(--accent) 80%, #5cc8a1);
      }
      .status-dot.busy { background: #f6c451; animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      .status-text { font-size: 11px; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }

      /* ── Category strip ── */
      .cat-strip {
        display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 14px;
        border-bottom: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 70%, transparent);
        flex-shrink: 0;
      }
      .cat-chip {
        border: 1px solid var(--panel-border); border-radius: 999px; padding: 3px 10px;
        background: none; color: inherit; cursor: pointer; font-size: 11px; opacity: 0.75;
        transition: opacity 0.1s, background 0.1s, border-color 0.1s;
      }
      .cat-chip-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .cat-chip:hover { opacity: 1; }
      .cat-chip.active {
        opacity: 1;
        background: color-mix(in srgb, var(--accent) 22%, var(--panel-bg));
        border-color: color-mix(in srgb, var(--accent) 60%, var(--panel-border));
      }
      .cat-chip-muted {
        cursor: default;
        opacity: 0.82;
      }
      .cat-chip .cnt { font-size: 10px; opacity: 0.6; margin-left: 3px; }
      .cat-inline-tools {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
        flex-wrap: wrap;
      }
      .cat-inline-control {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--panel-bg) 82%, transparent);
        font-size: 11px;
      }
      .cat-inline-label {
        opacity: 0.68;
        white-space: nowrap;
      }
      .cat-inline-select {
        border: none;
        background: transparent;
        color: inherit;
        font-size: 11px;
        padding: 0;
      }
      .cat-color-input {
        width: 22px;
        height: 22px;
        padding: 0;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        background: transparent;
        cursor: pointer;
        overflow: hidden;
      }
      .cat-color-input::-webkit-color-swatch-wrapper {
        padding: 0;
      }
      .cat-color-input::-webkit-color-swatch {
        border: none;
        border-radius: 999px;
      }

      /* ── Setup + recommendation ── */
      .control-deck {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 12px;
        padding: 12px 14px; border-bottom: 1px solid var(--panel-border);
        background: linear-gradient(180deg, color-mix(in srgb, var(--panel-bg) 90%, transparent), transparent);
        flex-shrink: 0;
        align-items: start;
      }
      .setup-card {
        border: 1px solid var(--panel-border); border-radius: 14px; padding: 14px;
        background: color-mix(in srgb, var(--panel-bg) 82%, transparent);
        display: grid; gap: 10px;
        min-width: 0;
      }
      .setup-card-emphasis {
        border-color: color-mix(in srgb, var(--accent-strong) 70%, var(--panel-border));
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--accent-strong) 18%, transparent), transparent 60%),
          color-mix(in srgb, var(--panel-bg) 86%, transparent);
      }
      .setup-kicker {
        font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.62;
      }
      .setup-card h2 {
        margin: 0; font-size: 15px; line-height: 1.3;
      }
      .setup-card p {
        margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.78;
      }
      .setup-field {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      .setup-field-label {
        font-size: 11px;
        opacity: 0.64;
      }
      .setup-select {
        width: 100%;
        min-width: 0;
        border-radius: 8px;
        border: 1px solid var(--panel-border);
        padding: 6px 10px;
        background: color-mix(in srgb, var(--panel-bg) 92%, transparent);
        color: inherit;
      }
      .setup-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .setup-foot { font-size: 11px; opacity: 0.62; }
      .setup-links { display: flex; flex-wrap: wrap; gap: 6px; }
      .muted-copy { font-size: 11px; opacity: 0.58; }
      .source-link { max-width: 100%; }

      .recommend-panel {
        padding: 12px 14px 14px;
        border-bottom: 1px solid var(--panel-border);
        display: grid; gap: 10px;
        background: color-mix(in srgb, var(--panel-bg) 72%, transparent);
        flex-shrink: 0;
      }
      .recommend-head {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      }
      .recommend-copy {
        margin: 4px 0 0; font-size: 12px; line-height: 1.45; opacity: 0.72;
      }
      .recommend-controls, .recommend-subcontrols {
        display: flex; gap: 10px; flex-wrap: wrap;
      }
      .question-input, .project-select {
        border-radius: 10px; border: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 92%, transparent);
        color: inherit;
      }
      .question-input {
        flex: 1; min-width: 260px; padding: 10px 12px; font-size: 12px;
      }
      .project-select {
        min-width: 220px; padding: 8px 10px; font-size: 12px;
      }
      .recommend-status {
        display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; opacity: 0.68;
      }
      .recommend-summary {
        margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.84;
      }
      .recommend-list {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;
      }
      .recommend-card {
        border: 1px solid var(--panel-border); border-radius: 12px; padding: 10px;
        background: color-mix(in srgb, var(--panel-bg) 78%, transparent);
        display: grid; gap: 8px;
      }
      .recommend-card.selected {
        border-color: color-mix(in srgb, var(--accent) 70%, var(--panel-border));
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
      }
      .recommend-top {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
      }
      .mini-toggle {
        border: 1px solid var(--panel-border); border-radius: 999px; padding: 4px 10px;
        background: none; color: inherit; cursor: pointer; font-size: 11px;
      }
      .mini-toggle.selected {
        background: color-mix(in srgb, var(--accent) 20%, var(--panel-bg));
        border-color: color-mix(in srgb, var(--accent) 60%, var(--panel-border));
      }
      .recommend-score {
        font-size: 11px; font-weight: 600; opacity: 0.72;
      }
      .recommend-name {
        border: none; background: none; color: inherit; padding: 0; text-align: left;
        font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .recommend-reason {
        margin: 0; font-size: 11px; line-height: 1.45; opacity: 0.76;
      }
      .empty.compact {
        padding: 16px; border: 1px dashed var(--panel-border); border-radius: 12px;
        text-align: left;
      }

      .dashboard-layout {
        display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0;
      }
      .above-fold {
        display: flex; flex-direction: column; min-width: 0; flex-shrink: 0;
      }
      .dashboard-layout.is-dashboard .above-fold {
        flex: 0 0 var(--dashboard-top-height, clamp(280px, 42vh, 560px));
        min-height: 220px;
        overflow: auto;
      }
      .layout-splitter {
        position: relative; flex-shrink: 0;
        background: color-mix(in srgb, var(--panel-border) 45%, transparent);
      }
      .layout-splitter::after {
        content: '';
        position: absolute;
        background: color-mix(in srgb, var(--accent) 50%, var(--panel-border));
        opacity: 0.38;
        border-radius: 999px;
      }
      .layout-splitter:hover::after,
      .layout-splitter.active::after {
        opacity: 0.9;
      }
      .layout-splitter.vertical {
        height: 10px;
        cursor: row-resize;
      }
      .layout-splitter.vertical::after {
        width: 56px; height: 3px; left: 50%; top: 50%; transform: translate(-50%, -50%);
      }
      .layout-splitter.horizontal {
        width: 10px;
        cursor: col-resize;
      }
      .layout-splitter.horizontal::after {
        width: 3px; height: 56px; left: 50%; top: 50%; transform: translate(-50%, -50%);
      }
      body.is-resizing {
        user-select: none;
      }
      body.is-resizing * {
        user-select: none !important;
      }
      body.is-resizing.horizontal-resize {
        cursor: col-resize;
      }
      body.is-resizing.vertical-resize {
        cursor: row-resize;
      }

      /* ── Main layout ── */
      .main {
        display: grid; grid-template-columns: minmax(420px, 1.35fr) minmax(320px, 1fr); gap: 0;
        flex: 1; min-height: 0; overflow: hidden;
        min-height: clamp(320px, 42vh, 760px);
      }
      .main.is-dashboard {
        display: flex;
        min-height: 260px;
      }
      @media (max-width: 1180px) {
        .main { grid-template-columns: minmax(360px, 1.2fr) minmax(300px, 1fr); }
      }
      @media (max-width: 900px) {
        .main { grid-template-columns: 1fr; }
        .main.is-dashboard { display: grid; }
        .dashboard-layout.is-dashboard .above-fold {
          flex: 0 0 auto;
          min-height: 0;
          overflow: visible;
        }
        .layout-splitter { display: none; }
        .graph-pane { border-right: none; border-bottom: 1px solid var(--panel-border); }
      }

      /* ── Graph pane ── */
      .graph-pane {
        border-right: 1px solid var(--panel-border);
        display: flex; flex-direction: column; overflow: hidden; min-width: 0;
      }
      .main.is-dashboard .graph-pane {
        flex: 0 0 var(--graph-pane-width, 58%);
        min-width: 320px;
        max-width: 78%;
      }
      .graph-pane .pane-header {
        gap: 12px;
        flex-wrap: wrap;
      }
      .graph-header-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .graph-tuning {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .graph-control {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--surface-muted) 74%, transparent);
        font-size: 10px;
      }
      .graph-control-label,
      .graph-control-value {
        opacity: 0.72;
        white-space: nowrap;
      }
      .graph-control-value {
        min-width: 2.8em;
        text-align: right;
      }
      .graph-range {
        width: 96px;
        accent-color: var(--accent);
      }
      .pane-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
      }
      .pane-title { font-size: 12px; font-weight: 600; opacity: 0.8; }
      .pane-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .view-toggle {
        display: flex; gap: 2px;
        border: 1px solid var(--panel-border); border-radius: 6px; overflow: hidden;
      }
      .view-btn {
        border: none; background: none; color: inherit; cursor: pointer; padding: 3px 9px;
        font-size: 11px; opacity: 0.6; transition: opacity 0.1s, background 0.1s;
      }
      .view-btn.active { opacity: 1; background: color-mix(in srgb, var(--accent) 22%, var(--panel-bg)); }
      .graph-wrap {
        flex: 1; position: relative; overflow: hidden; min-height: 0;
        background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%);
      }
      #tag-graph { width: 100%; height: 100%; display: block; cursor: grab; position: absolute; top: 0; left: 0; }
      #tag-graph:active { cursor: grabbing; }
      #tag-graph-3d {
        width: 100%; height: 100%; position: absolute; top: 0; left: 0; overflow: hidden;
      }
      #tag-graph-3d canvas { display: block; }
      .graph-hover-tip {
        position: absolute;
        z-index: 4;
        max-width: min(280px, calc(100% - 24px));
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 94%, rgba(8,8,10,0.8));
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.22);
        pointer-events: none;
      }
      .graph-hover-title {
        font-size: 12px;
        font-weight: 700;
        line-height: 1.4;
        margin-bottom: 8px;
      }
      .graph-hover-meta,
      .graph-hover-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .graph-hover-copy {
        margin: 8px 0 6px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        opacity: 0.58;
      }
      .graph-hint { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); font-size: 10px; opacity: 0.4; pointer-events: none; white-space: nowrap; }

      /* ── Right pane: list + detail ── */
      .right-pane { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
      .main.is-dashboard .right-pane { flex: 1 1 auto; min-width: 280px; }
      .selected-strip {
        display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 12px;
        border-bottom: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 64%, transparent);
      }
      .selected-skill-pill {
        border: 1px solid var(--panel-border); border-radius: 999px; padding: 4px 10px;
        background: color-mix(in srgb, var(--accent) 14%, var(--panel-bg));
        color: inherit; cursor: pointer; font-size: 11px;
      }
      .skill-list-wrap {
        flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
      }
      .skill-card {
        border: 1px solid var(--panel-border); border-radius: 10px; padding: 10px 12px;
        background: color-mix(in srgb, var(--panel-bg) 76%, transparent); cursor: pointer;
        transition: border-color 0.1s, box-shadow 0.1s;
      }
      .skill-card:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--panel-border)); }
      .skill-card.selected-card { border-color: color-mix(in srgb, var(--accent-strong) 65%, var(--panel-border)); }
      .skill-card.active {
        border-color: color-mix(in srgb, var(--accent) 70%, var(--panel-border));
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      }
      .skill-card h3 { margin: 0 0 4px; font-size: 13px; }
      .skill-card p { margin: 0; font-size: 11px; line-height: 1.45; opacity: 0.75; }
      .meta-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
      .pill {
        display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px;
        border: 1px solid var(--panel-border); font-size: 10px;
        background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
      }

      /* ── Skill card inline detail ── */
      .skill-card { cursor: pointer; }
      .card-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .card-main { flex: 1; min-width: 0; }
      .card-pills { display: flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0; max-width: 160px; justify-content: flex-end; }
      .card-detail {
        margin-top: 10px; padding-top: 10px;
        border-top: 1px solid var(--panel-border);
        animation: fadeIn 0.12s ease;
      }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      .card-detail-actions { display: flex; gap: 8px; margin-bottom: 10px; }
      .card-meta-full { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
      .btn {
        border: 1px solid var(--panel-border); border-radius: 6px; padding: 5px 12px;
        background: color-mix(in srgb, var(--panel-bg) 86%, transparent); color: inherit; cursor: pointer; font-size: 12px;
      }
      .btn.compact { padding: 4px 10px; font-size: 11px; }
      .btn.selected-inline {
        background: color-mix(in srgb, var(--accent) 18%, var(--panel-bg));
        border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
      }
      .btn.primary {
        background: color-mix(in srgb, var(--accent-strong) 28%, var(--panel-bg));
        border-color: color-mix(in srgb, var(--accent-strong) 65%, var(--panel-border));
      }
      .tag-grid { display: flex; flex-wrap: wrap; gap: 6px; }
      .tag {
        padding: 3px 9px; border-radius: 999px; border: 1px solid var(--panel-border);
        font-size: 11px; background: color-mix(in srgb, var(--accent) 11%, var(--panel-bg));
        cursor: pointer;
      }
      .tag.active-tag { background: color-mix(in srgb, var(--accent) 30%, var(--panel-bg)); border-color: color-mix(in srgb, var(--accent) 60%, var(--panel-border)); }

      .empty { padding: 24px; text-align: center; opacity: 0.6; font-size: 12px; }

      /* ── Settings popover ── */
      .settings-wrap { position: relative; }
      .settings-popover {
        display: none; position: absolute; right: 0; top: calc(100% + 6px);
        background: var(--vscode-editor-background); border: 1px solid var(--panel-border);
        border-radius: 10px; padding: 10px; min-width: 200px; z-index: 100;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      }
      .settings-popover.open { display: grid; gap: 6px; }
      .settings-popover .btn { width: 100%; text-align: left; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div id="app" data-state="${escapeHtml(JSON.stringify(initialState))}" data-dashboard="${this.isDashboard}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
