import * as assert from 'node:assert/strict';

import { buildHeuristicInsight, inferCategory } from '../../src/core/classification';

suite('classification', () => {
  test('infers testing category from description keywords', () => {
    const category = inferCategory('Playwright Helper', 'Run e2e tests, regression checks, and QA verification flows.');
    assert.equal(category, 'Testing');
  });

  test('builds 20 heuristic tags', () => {
    const insight = buildHeuristicInsight({
      name: 'Design System Helper',
      description: 'Creates UI libraries, brand themes, and Figma-ready design system guidance.',
      scope: 'workspace',
      sourceLabel: 'Workspace Catalog',
      relativePath: 'design-system-helper'
    });

    assert.equal(insight.category, 'Design');
    assert.equal(insight.tags.length, 20);
    assert.ok(insight.tags.includes('design workflow'));
  });
});
