import type { AgentProfileConfig, HarnessToolRisk, SkillRecord, SkillRiskScore } from './types';

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

const DEFAULT_THRESHOLDS = { review: 0.4, confirm: 0.55, block: 0.7 };

function extractTokens(skill: SkillRecord): Set<string> {
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

function extractToolTokens(skill: SkillRecord): Set<string> {
  const result = new Set<string>();
  for (const token of extractTokens(skill)) {
    if (ALL_TOOL_KEYWORDS.has(token)) result.add(token);
  }
  return result;
}

export function computeSkillRiskScore(skill: SkillRecord, profile?: AgentProfileConfig): SkillRiskScore {
  const tokens = extractTokens(skill);
  let score = 0;
  let dangerousToolCount = 0;

  for (const token of tokens) {
    if (HIGH_RISK_TOOLS.has(token)) {
      score += 0.3;
      dangerousToolCount++;
    } else if (MEDIUM_RISK_TOOLS.has(token)) {
      score += 0.1;
    } else if (LOW_RISK_TOOLS.has(token)) {
      score += 0.05;
    }
  }

  score = Math.min(1, score);

  const thresholds = profile?.riskThresholds ?? DEFAULT_THRESHOLDS;
  let riskLevel: HarnessToolRisk;
  if (score >= thresholds.block) {
    riskLevel = 'high';
  } else if (score >= thresholds.review) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  let allowedByProfile = true;
  if (profile?.disallowedTools && profile.disallowedTools.length > 0) {
    const toolSurface = extractToolTokens(skill);
    const disallowed = new Set(profile.disallowedTools.map((t) => t.toLowerCase()));
    allowedByProfile = ![...toolSurface].some((t) => disallowed.has(t));
  }

  return { skillId: skill.id, score, riskLevel, dangerousToolCount, allowedByProfile };
}

export function computeToolSurfaceOverlap(a: SkillRecord, b: SkillRecord): number {
  const surfaceA = extractToolTokens(a);
  const surfaceB = extractToolTokens(b);
  if (surfaceA.size === 0 && surfaceB.size === 0) return 0;
  let intersection = 0;
  for (const token of surfaceA) {
    if (surfaceB.has(token)) intersection++;
  }
  const union = new Set([...surfaceA, ...surfaceB]).size;
  return union === 0 ? 0 : intersection / union;
}
