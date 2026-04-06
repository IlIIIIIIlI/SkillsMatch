import * as assert from 'node:assert/strict';

import { buildAppliedSkillDirectoryName, resolveProjectApplyPath } from '../../src/core/projectSkillConfig';

suite('projectSkillConfig', () => {
  test('resolves a managed path inside the workspace', () => {
    const target = resolveProjectApplyPath('/workspace/app', '.codex/skills/skill-map-curated');
    assert.equal(target, '/workspace/app/.codex/skills/skill-map-curated');
  });

  test('rejects workspace root as the target path', () => {
    assert.throws(() => resolveProjectApplyPath('/workspace/app', '.'), /workspace root/);
  });

  test('builds a stable directory name for applied skills', () => {
    const value = buildAppliedSkillDirectoryName({
      id: 'abc123',
      slug: 'react-testing',
      name: 'React Testing'
    });

    assert.match(value, /^react-testing-[a-f0-9]{6}$/);
  });
});
