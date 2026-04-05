import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverLocalSkillsFromRoots } from '../../src/core/localSkillDiscovery';

suite('localSkillDiscovery', () => {
  test('finds workspace skills under a provided root', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-map-test-'));
    const skillDir = path.join(workspaceRoot, '.claude', 'skills', 'release-notes');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '# Release Notes\n\nSummarize product changes and prepare documentation.'
    );

    const skills = await discoverLocalSkillsFromRoots([
      {
        scope: 'workspace',
        sourceId: 'workspace:test',
        sourceLabel: 'Workspace Test',
        rootPath: path.join(workspaceRoot, '.claude', 'skills'),
        workspaceFolderName: 'temp'
      }
    ]);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, 'Release Notes');
    assert.equal(skills[0]?.scope, 'workspace');
    assert.equal(skills[0]?.workspaceFolderName, 'temp');
  });
});
