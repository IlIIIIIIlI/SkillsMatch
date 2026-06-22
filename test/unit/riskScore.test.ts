import * as assert from 'node:assert/strict';

import { computeSkillRiskScore, computeToolSurfaceOverlap } from '../../src/shared/riskScore';
import type { AgentProfileConfig, SkillRecord } from '../../src/shared/types';

function makeSkill(id: string, tags: string[]): SkillRecord {
  return {
    id,
    slug: id,
    name: id,
    description: '',
    scope: 'global',
    origin: 'local',
    category: 'Development',
    tags,
    tagSource: 'heuristic',
    sourceId: 'test',
    sourceLabel: 'test',
    location: '',
    manifestPath: '',
    lastSyncedAt: '2026-01-01T00:00:00Z'
  };
}

suite('riskScore — computeSkillRiskScore', () => {
  test('skill with no tool-related tags has near-zero score and low risk', () => {
    const skill = makeSkill('s1', ['documentation', 'planning', 'agile']);
    const result = computeSkillRiskScore(skill);
    assert.equal(result.skillId, 's1');
    assert.equal(result.riskLevel, 'low');
    assert.equal(result.dangerousToolCount, 0);
    assert.ok(result.score < 0.4, `expected score < 0.4, got ${result.score}`);
  });

  test('skill with bash/write tags has high score', () => {
    const skill = makeSkill('s2', ['bash', 'write', 'edit', 'shell']);
    const result = computeSkillRiskScore(skill);
    assert.equal(result.riskLevel, 'high');
    assert.ok(result.dangerousToolCount >= 3, `expected dangerousToolCount >= 3, got ${result.dangerousToolCount}`);
    assert.ok(result.score >= 0.7, `expected score >= 0.7, got ${result.score}`);
  });

  test('skill with only medium-risk tags has medium score', () => {
    const skill = makeSkill('s3', ['read', 'search', 'browse', 'list', 'planning']);
    const result = computeSkillRiskScore(skill);
    assert.equal(result.dangerousToolCount, 0);
    assert.ok(result.score < 0.7, `expected score < 0.7, got ${result.score}`);
  });

  test('allowedByProfile is false when skill tags match disallowedTools', () => {
    const skill = makeSkill('s4', ['bash', 'shell']);
    const profile: AgentProfileConfig = { disallowedTools: ['bash'] };
    const result = computeSkillRiskScore(skill, profile);
    assert.equal(result.allowedByProfile, false);
  });

  test('allowedByProfile is true when no profile is set', () => {
    const skill = makeSkill('s5', ['bash']);
    const result = computeSkillRiskScore(skill);
    assert.equal(result.allowedByProfile, true);
  });

  test('custom riskThresholds change the riskLevel classification', () => {
    const skill = makeSkill('s6', ['bash', 'write']);
    const strictProfile: AgentProfileConfig = { riskThresholds: { review: 0.1, confirm: 0.3, block: 0.5 } };
    const result = computeSkillRiskScore(skill, strictProfile);
    assert.equal(result.riskLevel, 'high');
    // With lenient thresholds the same score should be low
    const lenientProfile: AgentProfileConfig = { riskThresholds: { review: 0.9, confirm: 0.95, block: 0.99 } };
    const resultLenient = computeSkillRiskScore(skill, lenientProfile);
    assert.equal(resultLenient.riskLevel, 'low');
  });
});

suite('riskScore — computeToolSurfaceOverlap', () => {
  test('two skills with no tool tags have zero overlap', () => {
    const a = makeSkill('a', ['documentation', 'planning']);
    const b = makeSkill('b', ['research', 'analysis']);
    assert.equal(computeToolSurfaceOverlap(a, b), 0);
  });

  test('identical tool tags produce overlap of 1', () => {
    const a = makeSkill('a', ['bash', 'write']);
    const b = makeSkill('b', ['bash', 'write']);
    assert.equal(computeToolSurfaceOverlap(a, b), 1);
  });

  test('disjoint tool tag sets produce overlap of 0', () => {
    const a = makeSkill('a', ['bash', 'shell']);
    const b = makeSkill('b', ['read', 'search']);
    assert.equal(computeToolSurfaceOverlap(a, b), 0);
  });

  test('partial overlap returns a value in (0, 1)', () => {
    const a = makeSkill('a', ['bash', 'write', 'read']);
    const b = makeSkill('b', ['bash', 'read', 'search']);
    const overlap = computeToolSurfaceOverlap(a, b);
    assert.ok(overlap > 0 && overlap < 1, `expected 0 < overlap < 1, got ${overlap}`);
  });

  test('overlap is symmetric', () => {
    const a = makeSkill('a', ['bash', 'edit', 'grep']);
    const b = makeSkill('b', ['bash', 'search']);
    assert.equal(computeToolSurfaceOverlap(a, b), computeToolSurfaceOverlap(b, a));
  });
});
