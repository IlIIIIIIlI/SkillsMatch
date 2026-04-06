import * as path from 'node:path';

import type { SkillRecord } from '../shared/types';
import { hashText, slugify } from './utils';

export function resolveProjectApplyPath(workspacePath: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    throw new Error('Project apply path cannot be empty.');
  }

  if (path.isAbsolute(trimmed)) {
    throw new Error('Project apply path must stay relative to the workspace root.');
  }

  const workspaceRoot = path.resolve(workspacePath);
  const targetPath = path.resolve(workspaceRoot, trimmed);
  const workspacePrefix = `${workspaceRoot}${path.sep}`;

  if (targetPath === workspaceRoot) {
    throw new Error('Project apply path cannot point at the workspace root.');
  }

  if (!targetPath.startsWith(workspacePrefix)) {
    throw new Error('Project apply path must stay inside the workspace root.');
  }

  return targetPath;
}

export function buildAppliedSkillDirectoryName(skill: Pick<SkillRecord, 'slug' | 'name' | 'id'>): string {
  const base = skill.slug || slugify(skill.name) || 'skill';
  return `${base}-${hashText(skill.id).slice(0, 6)}`;
}
