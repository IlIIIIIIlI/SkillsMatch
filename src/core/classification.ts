import type { SkillInsight, SkillRecord } from '../shared/types';
import { ALLOWED_CATEGORIES } from './constants';
import { compactWhitespace, normalizeTag, unique } from './utils';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'help',
  'helps',
  'in',
  'into',
  'is',
  'it',
  'make',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'use',
  'using',
  'with',
  'your'
]);

const CATEGORY_KEYWORDS: Array<{ category: (typeof ALLOWED_CATEGORIES)[number]; keywords: string[] }> = [
  {
    category: 'Development',
    keywords: ['code', 'coding', 'developer', 'framework', 'sdk', 'plugin', 'repository', 'typescript', 'javascript', 'python', 'api']
  },
  {
    category: 'Testing',
    keywords: ['test', 'testing', 'qa', 'e2e', 'playwright', 'verification', 'assertion', 'regression']
  },
  {
    category: 'Design',
    keywords: ['design', 'ui', 'ux', 'figma', 'visual', 'theme', 'brand', 'prototype']
  },
  {
    category: 'Documentation',
    keywords: ['docs', 'documentation', 'markdown', 'docx', 'slides', 'pptx', 'xlsx', 'knowledge']
  },
  {
    category: 'DevOps',
    keywords: ['deploy', 'deployment', 'infrastructure', 'cloud', 'docker', 'kubernetes', 'ci', 'cd', 'release']
  },
  {
    category: 'Data',
    keywords: ['data', 'dataset', 'spreadsheet', 'analytics', 'notebook', 'sql', 'csv']
  },
  {
    category: 'AI/ML',
    keywords: ['llm', 'agent', 'model', 'prompt', 'ml', 'ai', 'neural', 'training', 'pytorch']
  },
  {
    category: 'Security',
    keywords: ['security', 'threat', 'risk', 'ownership', 'compliance', 'audit']
  },
  {
    category: 'Productivity',
    keywords: ['workflow', 'automation', 'productivity', 'planning', 'meeting', 'task', 'coordination']
  },
  {
    category: 'Research',
    keywords: ['research', 'analysis', 'insight', 'exploration', 'discovery']
  },
  {
    category: 'Operations',
    keywords: ['operations', 'runbook', 'incident', 'support', 'triage']
  }
];

const CATEGORY_PAD_TAGS: Record<string, string[]> = {
  Development: ['developer tools', 'coding workflow', 'automation'],
  Testing: ['quality assurance', 'verification', 'test workflow'],
  Design: ['visual system', 'design workflow', 'user experience'],
  Documentation: ['knowledge capture', 'documentation workflow', 'written communication'],
  DevOps: ['delivery workflow', 'infrastructure automation', 'release management'],
  Data: ['data workflow', 'structured information', 'analysis'],
  'AI/ML': ['agent workflow', 'model operations', 'prompt engineering'],
  Security: ['security review', 'risk analysis', 'governance'],
  Productivity: ['team workflow', 'efficiency', 'planning'],
  Research: ['investigation', 'knowledge synthesis', 'analysis'],
  Operations: ['operations workflow', 'support process', 'triage'],
  Other: ['general skill', 'automation', 'tooling']
};

export function inferCategory(name: string, description: string): string {
  const haystack = `${name} ${description}`.toLowerCase();
  let bestCategory = 'Other';
  let bestScore = 0;

  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    const score = keywords.reduce((sum, keyword) => (haystack.includes(keyword) ? sum + 1 : sum), 0);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

export function buildHeuristicInsight(skill: Pick<SkillRecord, 'name' | 'description' | 'scope' | 'sourceLabel' | 'relativePath'>): SkillInsight {
  const category = inferCategory(skill.name, skill.description);
  const candidates = new Map<string, number>();
  const tokenSources = [skill.name, skill.description, skill.sourceLabel, skill.relativePath ?? ''];

  for (const source of tokenSources) {
    const words = tokenize(source);
    for (const word of words) {
      candidates.set(word, (candidates.get(word) ?? 0) + 2);
    }

    for (let index = 0; index < words.length - 1; index += 1) {
      const phrase = normalizeTag(`${words[index]} ${words[index + 1]}`);
      if (phrase && phrase.split(' ').length <= 3) {
        candidates.set(phrase, (candidates.get(phrase) ?? 0) + 1);
      }
    }
  }

  for (const fallback of CATEGORY_PAD_TAGS[category] ?? CATEGORY_PAD_TAGS.Other) {
    candidates.set(fallback, (candidates.get(fallback) ?? 0) + 3);
  }

  candidates.set(skill.scope, (candidates.get(skill.scope) ?? 0) + 2);
  candidates.set(category.toLowerCase(), (candidates.get(category.toLowerCase()) ?? 0) + 3);

  const tags = [...candidates.entries()]
    .filter(([tag]) => tag.length > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tag]) => tag)
    .slice(0, 20);

  const padded = padTags(tags, category, skill.scope);

  return {
    category,
    tags: padded,
    source: 'heuristic',
    generatedAt: new Date().toISOString()
  };
}

export function normalizeInsight(raw: { category?: string; tags?: string[] }, fallback: SkillInsight): SkillInsight {
  const normalizedCategory = ALLOWED_CATEGORIES.includes((raw.category ?? 'Other') as (typeof ALLOWED_CATEGORIES)[number])
    ? raw.category ?? 'Other'
    : fallback.category;

  const normalizedTags = unique(
    (raw.tags ?? [])
      .map((tag) => normalizeTag(tag))
      .filter((tag) => tag && !STOP_WORDS.has(tag))
  ).slice(0, 20);

  return {
    category: normalizedCategory,
    tags: padTags(normalizedTags, normalizedCategory, fallback.tags[0] ?? 'skill'),
    source: 'ai',
    generatedAt: new Date().toISOString()
  };
}

function tokenize(value: string): string[] {
  return unique(
    (value.toLowerCase().match(/[\p{L}\p{N}#+./-]+/gu) ?? [])
      .map((token) => normalizeTag(token))
      .map((token) => compactWhitespace(token))
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
  );
}

function padTags(seed: string[], category: string, scope: string): string[] {
  const result = [...seed];
  const fallbacks = [
    category.toLowerCase(),
    `${category.toLowerCase()} workflow`,
    `${scope} catalog`,
    'skill discovery',
    'metadata',
    'taxonomy',
    'visualization',
    'tag graph',
    'developer productivity',
    'workflow automation',
    'tooling',
    'catalog management',
    'sidebar view',
    'classification'
  ];

  for (const fallback of fallbacks) {
    const normalized = normalizeTag(fallback);
    if (!normalized || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
    if (result.length === 20) {
      return result;
    }
  }

  while (result.length < 20) {
    result.push(`tag ${result.length + 1}`);
  }

  return result.slice(0, 20);
}
