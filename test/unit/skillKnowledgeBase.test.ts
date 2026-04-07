import * as assert from 'node:assert/strict';

import type { SkillRecord } from '../../src/shared/types';
import {
  buildKnowledgeBaseFileSource,
  buildLightRagWorkspaceId,
  buildSkillKnowledgeDocument,
  extractSkillIdFromKnowledgeBaseFileSource
} from '../../src/core/skillKnowledgeBase';

suite('skillKnowledgeBase', () => {
  const skill: SkillRecord = {
    id: 'abcdef123456',
    slug: 'react-tests',
    name: 'React Tests',
    description: 'Adds component and hook tests with RTL and Vitest.',
    scope: 'workspace',
    origin: 'local',
    category: 'Testing',
    tags: ['react', 'vitest', 'rtl'],
    tagSource: 'heuristic',
    sourceId: 'workspace:test',
    sourceLabel: 'Workspace',
    location: '/tmp/workspace/.codex/skills/react-tests',
    manifestPath: '/tmp/workspace/.codex/skills/react-tests/SKILL.md',
    workspaceFolderName: 'workspace',
    relativePath: '.codex/skills/react-tests',
    lastSyncedAt: new Date(0).toISOString()
  };

  test('builds a deterministic lightrag workspace id', () => {
    const value = buildLightRagWorkspaceId(['file:///workspace-a', 'file:///workspace-b']);
    assert.match(value, /^skill_map_[a-f0-9]{12}$/);
  });

  test('maps file sources back to skill ids', () => {
    const fileSource = buildKnowledgeBaseFileSource(skill);
    assert.equal(fileSource, '/skillmatch/abcdef123456.md');
    assert.equal(extractSkillIdFromKnowledgeBaseFileSource(fileSource), skill.id);
  });

  test('serializes a skill into a knowledge document', () => {
    const document = buildSkillKnowledgeDocument(skill, '# React Tests\n\nTest all the things.');
    assert.match(document, /Category: Testing/);
    assert.match(document, /Tags: react, vitest, rtl/);
    assert.match(document, /Skill Manifest/);
  });
});
