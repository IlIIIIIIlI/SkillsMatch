import * as assert from 'node:assert/strict';

import { parseSkillMarkdown } from '../../src/core/skillParser';

suite('skillParser', () => {
  test('extracts the first heading and paragraph', () => {
    const markdown = `---
name: example
---

# Skill Builder

Builds a polished skill catalog from markdown metadata.

## Usage

- Step one
`;

    const parsed = parseSkillMarkdown(markdown);
    assert.equal(parsed.title, 'Skill Builder');
    assert.equal(parsed.description, 'Builds a polished skill catalog from markdown metadata.');
  });
});
