import type { SkillRecord } from '../shared/types';

const HIGH_RISK_TOOLS = new Set([
  'bash', 'shell', 'execute', 'terminal', 'write', 'edit',
  'delete', 'rm', 'destroy', 'truncate', 'overwrite'
]);

const MEDIUM_RISK_TOOLS = new Set([
  'deploy', 'build', 'publish', 'migrate', 'run', 'create',
  'update', 'install', 'git', 'commit', 'push', 'patch', 'rollback', 'move'
]);

const LOW_RISK_TOOLS = new Set([
  'read', 'search', 'grep', 'browse', 'list', 'glob',
  'fetch', 'query', 'select', 'find', 'analyze', 'scan'
]);

const ALL_TOOL_KEYWORDS = new Set([...HIGH_RISK_TOOLS, ...MEDIUM_RISK_TOOLS, ...LOW_RISK_TOOLS]);

const CATEGORY_RISK: Record<string, number> = {
  Security: 0.2,
  DevOps: 0.1,
  Operations: 0.1
};

export function riskLabel(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

function skillTokens(skill: SkillRecord): Set<string> {
  const tokens = new Set<string>();
  for (const word of skill.name.toLowerCase().split(/\W+/)) {
    if (word) tokens.add(word);
  }
  for (const tag of skill.tags) {
    const t = tag.toLowerCase();
    if (t) tokens.add(t);
  }
  return tokens;
}

export function computeSkillRiskScore(skill: SkillRecord): number {
  const tokens = skillTokens(skill);
  let score = 0;

  for (const token of tokens) {
    if (HIGH_RISK_TOOLS.has(token)) {
      score += 0.3;
    } else if (MEDIUM_RISK_TOOLS.has(token)) {
      score += 0.1;
    }
  }

  score += CATEGORY_RISK[skill.category] ?? 0;
  return Math.min(1, score);
}

export function extractToolSurface(skill: SkillRecord): Set<string> {
  const result = new Set<string>();
  for (const token of skillTokens(skill)) {
    if (ALL_TOOL_KEYWORDS.has(token)) result.add(token);
  }
  return result;
}

export function computeSharedToolSurface(a: SkillRecord, b: SkillRecord): number {
  const surfaceA = extractToolSurface(a);
  const surfaceB = extractToolSurface(b);
  let count = 0;
  for (const tool of surfaceA) {
    if (surfaceB.has(tool)) count++;
  }
  return count;
}
