import * as assert from 'node:assert/strict';

import { applyCategoryFilter, applyScopeFilter, applySourceFilter } from '../../src/shared/filterState';

suite('filterState', () => {
  test('category filters preserve an active source filter', () => {
    const next = applyCategoryFilter(
      { scope: 'global', sourceId: 'source:claude-global' },
      'Development'
    );

    assert.deepEqual(next, {
      scope: 'global',
      category: 'Development',
      sourceId: 'source:claude-global'
    });
  });

  test('source filters preserve an active category filter', () => {
    const next = applySourceFilter(
      { scope: 'all', category: 'Testing' },
      'source:workspace-playwright',
      'workspace'
    );

    assert.deepEqual(next, {
      scope: 'workspace',
      category: 'Testing',
      sourceId: 'source:workspace-playwright'
    });
  });

  test('scope filters preserve category and clear source', () => {
    const next = applyScopeFilter(
      { scope: 'global', category: 'AI/ML', sourceId: 'source:claude-global' },
      'workspace'
    );

    assert.deepEqual(next, {
      scope: 'workspace',
      category: 'AI/ML'
    });
  });
});
