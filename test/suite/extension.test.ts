import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

suite('extension smoke', () => {
  test('registers primary commands', async () => {
    await vscode.commands.executeCommand('skillMap.clearFilter');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('skillMap.refresh'));
    assert.ok(commands.includes('skillMap.configureOpenRouterKey'));
    assert.ok(commands.includes('skillMap.generateTags'));
  });
});
