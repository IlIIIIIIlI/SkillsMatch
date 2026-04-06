import type { SkillFilter, SkillSourceSummary } from './types';

export function filterSourceSummaries(
  sources: readonly SkillSourceSummary[],
  filter: SkillFilter,
  query: string
): SkillSourceSummary[] {
  const normalizedQuery = query.trim().toLowerCase();

  return sources.filter((source) => {
    if (filter.scope !== 'all' && source.scope !== filter.scope) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    return source.label.toLowerCase().includes(normalizedQuery);
  });
}
