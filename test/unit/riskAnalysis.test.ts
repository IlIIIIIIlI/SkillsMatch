import * as assert from 'node:assert/strict';

import { computeSharedToolSurface, computeSkillRiskScore, extractToolSurface, riskLabel } from '../../src/core/riskAnalysis';
import type { SkillRecord } from '../../src/shared/types';

function makeSkill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: 'test-id',
    slug: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    scope: 'global',
    origin: 'local',
    category: 'Other',
    tags: [],
    tagSource: 'heuristic',
    sourceId: 'src',
    sourceLabel: 'Local',
    location: '/path/to/skill',
    manifestPath: '/path/to/skill/SKILL.md',
    lastSyncedAt: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

suite('riskAnalysis', () => {
  suite('riskLabel', () => {
    test('returns low for score below 0.3', () => {
      assert.equal(riskLabel(0), 'low');
      assert.equal(riskLabel(0.15), 'low');
      assert.equal(riskLabel(0.29), 'low');
    });

    test('returns medium for score 0.3 to 0.59', () => {
      assert.equal(riskLabel(0.3), 'medium');
      assert.equal(riskLabel(0.45), 'medium');
      assert.equal(riskLabel(0.59), 'medium');
    });

    test('returns high for score 0.6 and above', () => {
      assert.equal(riskLabel(0.6), 'high');
      assert.equal(riskLabel(0.85), 'high');
      assert.equal(riskLabel(1.0), 'high');
    });
  });

  suite('computeSkillRiskScore', () => {
    test('low risk for skill with no dangerous tags', () => {
      const skill = makeSkill({ name: 'Documentation Helper', category: 'Documentation', tags: ['markdown', 'writing', 'content'] });
      const score = computeSkillRiskScore(skill);
      assert.ok(score < 0.3, `Expected low risk, got ${score}`);
    });

    test('high risk for skill with bash and write tags', () => {
      const skill = makeSkill({ name: 'Shell Executor', category: 'DevOps', tags: ['bash', 'shell', 'execute', 'write'] });
      const score = computeSkillRiskScore(skill);
      assert.ok(score >= 0.6, `Expected high risk, got ${score}`);
    });

    test('category bonus contributes to score', () => {
      const low = makeSkill({ name: 'Helper', category: 'Documentation', tags: [] });
      const high = makeSkill({ name: 'Helper', category: 'Security', tags: [] });
      assert.ok(computeSkillRiskScore(high) > computeSkillRiskScore(low));
    });

    test('score is capped at 1.0', () => {
      const skill = makeSkill({
        name: 'Bash Shell Execute Terminal',
        category: 'DevOps',
        tags: ['bash', 'shell', 'execute', 'terminal', 'write', 'edit', 'delete', 'deploy']
      });
      const score = computeSkillRiskScore(skill);
      assert.ok(score <= 1.0, `Score should not exceed 1.0, got ${score}`);
    });

    test('name keywords are included in analysis', () => {
      const skillWithBashName = makeSkill({ name: 'bash runner', category: 'Other', tags: [] });
      const skillNoRisk = makeSkill({ name: 'Note Taker', category: 'Other', tags: [] });
      assert.ok(computeSkillRiskScore(skillWithBashName) > computeSkillRiskScore(skillNoRisk));
    });
  });

  suite('extractToolSurface', () => {
    test('returns empty set for skill with no tool keywords', () => {
      const skill = makeSkill({ name: 'Note Taker', category: 'Documentation', tags: ['docs', 'markdown'] });
      assert.equal(extractToolSurface(skill).size, 0);
    });

    test('detects bash in name', () => {
      const skill = makeSkill({ name: 'Bash Helper', category: 'Other', tags: [] });
      assert.ok(extractToolSurface(skill).has('bash'));
    });

    test('detects multiple tools from tags', () => {
      const skill = makeSkill({ name: 'CI Runner', category: 'DevOps', tags: ['bash', 'deploy', 'build'] });
      const surface = extractToolSurface(skill);
      assert.ok(surface.has('bash'));
      assert.ok(surface.has('deploy'));
      assert.ok(surface.has('build'));
    });
  });

  suite('computeSharedToolSurface', () => {
    test('returns 0 when skills share no tools', () => {
      const a = makeSkill({ name: 'Doc Writer', tags: ['markdown', 'writing'] });
      const b = makeSkill({ name: 'Bash Runner', tags: ['bash', 'shell'] });
      assert.equal(computeSharedToolSurface(a, b), 0);
    });

    test('returns count of shared tool keywords', () => {
      const a = makeSkill({ name: 'CI Deploy', tags: ['bash', 'deploy', 'build'] });
      const b = makeSkill({ name: 'Release Manager', tags: ['deploy', 'build', 'publish'] });
      const shared = computeSharedToolSurface(a, b);
      assert.ok(shared >= 2, `Expected at least 2 shared tools, got ${shared}`);
    });

    test('is symmetric', () => {
      const a = makeSkill({ name: 'Shell Script Runner', tags: ['bash', 'execute', 'deploy'] });
      const b = makeSkill({ name: 'Deploy Helper', tags: ['deploy', 'bash', 'migrate'] });
      assert.equal(computeSharedToolSurface(a, b), computeSharedToolSurface(b, a));
    });

    test('returns 0 when first skill has no tool surface', () => {
      const a = makeSkill({ name: 'Note Taker', category: 'Documentation', tags: [] });
      const b = makeSkill({ name: 'Bash Runner', tags: ['bash', 'shell'] });
      assert.equal(computeSharedToolSurface(a, b), 0);
    });
  });
});
