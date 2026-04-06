import type { SkillFilter, SkillScope } from './types';

export function applyScopeFilter(current: SkillFilter, scope: SkillFilter['scope']): SkillFilter {
  return {
    scope,
    category: current.category
  };
}

export function applyCategoryFilter(current: SkillFilter, category?: string): SkillFilter {
  const nextCategory = current.category === category ? undefined : category;

  return {
    scope: current.scope,
    category: nextCategory,
    sourceId: current.sourceId
  };
}

export function applySourceFilter(current: SkillFilter, sourceId: string, sourceScope: SkillScope): SkillFilter {
  const isSameSource = current.sourceId === sourceId && current.scope === sourceScope;

  return {
    scope: sourceScope,
    category: current.category,
    sourceId: isSameSource ? undefined : sourceId
  };
}
