import type { SkillRecord, TagGraph } from '../shared/types';

export function buildTagGraph(skills: readonly SkillRecord[], maxTags: number): TagGraph {
  const tagToSkills = new Map<string, SkillRecord[]>();

  for (const skill of skills) {
    for (const tag of skill.tags) {
      const bucket = tagToSkills.get(tag) ?? [];
      bucket.push(skill);
      tagToSkills.set(tag, bucket);
    }
  }

  const nodes = [...tagToSkills.entries()]
    .map(([tag, taggedSkills]) => ({
      id: tag,
      label: tag,
      count: taggedSkills.length,
      category: dominantCategory(taggedSkills),
      skillIds: taggedSkills.map((skill) => skill.id)
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, maxTags);

  const selectedTags = new Set(nodes.map((node) => node.id));
  const links: TagGraph['links'] = [];

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (!selectedTags.has(left.id) || !selectedTags.has(right.id)) {
        continue;
      }

      const overlap = left.skillIds.filter((skillId) => right.skillIds.includes(skillId)).length;
      if (overlap === 0) {
        continue;
      }

      const weight = overlap / Math.min(left.count, right.count);
      links.push({
        source: left.id,
        target: right.id,
        overlap,
        weight
      });
    }
  }

  return { nodes, links };
}

function dominantCategory(skills: SkillRecord[]): string {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'Other';
}
