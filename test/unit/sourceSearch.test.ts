import * as assert from 'node:assert/strict';

import { filterSourceSummaries } from '../../src/shared/sourceSearch';

suite('sourceSearch', () => {
  const sources = [
    { id: 'global:claude', label: 'Claude Global', scope: 'global', count: 20 },
    { id: 'workspace:github', label: 'Workspace GitHub Skills', scope: 'workspace', count: 4 },
    { id: 'online:openai', label: 'OpenAI Skills', scope: 'online', count: 9 }
  ] as const;

  test('returns all sources when no query or scope filter is active', () => {
    const visible = filterSourceSummaries(sources, { scope: 'all' }, '');
    assert.equal(visible.length, 3);
  });

  test('restricts sources to the active scope', () => {
    const visible = filterSourceSummaries(sources, { scope: 'workspace' }, '');
    assert.deepEqual(visible.map((source) => source.id), ['workspace:github']);
  });

  test('matches sources by label substring', () => {
    const visible = filterSourceSummaries(sources, { scope: 'all' }, 'openai');
    assert.deepEqual(visible.map((source) => source.id), ['online:openai']);
  });
});
