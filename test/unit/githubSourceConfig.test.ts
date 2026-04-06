import * as assert from 'node:assert/strict';

import {
  parseConfiguredGitHubSourceUrls,
  parseGitHubSourceUrl,
  splitGitHubSourceInput
} from '../../src/core/githubSourceConfig';

suite('githubSourceConfig', () => {
  test('parses repository root URLs', () => {
    const source = parseGitHubSourceUrl('https://github.com/openai/skills');
    assert.equal(source.owner, 'openai');
    assert.equal(source.repo, 'skills');
    assert.deepEqual(source.includePrefixes, ['']);
    assert.equal(source.strategy, 'tree');
  });

  test('parses folder tree URLs', () => {
    const source = parseGitHubSourceUrl('https://github.com/foo/bar/tree/main/.claude/skills');
    assert.equal(source.branch, 'main');
    assert.deepEqual(source.includePrefixes, ['.claude/skills']);
  });

  test('parses direct raw SKILL.md URLs', () => {
    const source = parseGitHubSourceUrl('https://raw.githubusercontent.com/foo/bar/main/skills/release/SKILL.md');
    assert.equal(source.strategy, 'direct');
    assert.equal(source.directManifestPath, 'skills/release/SKILL.md');
  });

  test('splits github source input on commas and whitespace', () => {
    const values = splitGitHubSourceInput('https://github.com/a/b, https://github.com/c/d\nhttps://github.com/e/f');
    assert.deepEqual(values, [
      'https://github.com/a/b',
      'https://github.com/c/d',
      'https://github.com/e/f'
    ]);
  });

  test('collects parse errors without aborting valid urls', () => {
    const result = parseConfiguredGitHubSourceUrls([
      'https://github.com/openai/skills',
      'https://example.com/not-supported'
    ]);

    assert.equal(result.sources.length, 1);
    assert.equal(result.errors.length, 1);
  });
});
