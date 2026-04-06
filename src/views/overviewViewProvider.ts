import * as vscode from 'vscode';

import { SkillCatalogService } from '../core/skillCatalogService';
import { OverviewWebviewSession } from './overviewWebview';

export class SkillsOverviewProvider implements vscode.WebviewViewProvider {
  private session?: OverviewWebviewSession;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: SkillCatalogService
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.session?.dispose();
    this.session = new OverviewWebviewSession(webviewView.webview, this.extensionUri, this.service);
    webviewView.onDidDispose(() => {
      this.session?.dispose();
      this.session = undefined;
    });
  }
}
