import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SkillRecord, SkillScope } from '../shared/types';
import { GLOBAL_SOURCE_PATTERNS, type LocalSourcePattern, WORKSPACE_SOURCE_PATTERNS } from './constants';
import { parseSkillMarkdown } from './skillParser';
import { expandHome, hashText, slugify } from './utils';

const MAX_SCAN_DEPTH = 4;
const SKILL_FILENAMES = ['SKILL.md', 'skill.md'];

export interface WorkspaceFolderInput {
  name: string;
  fsPath: string;
}

interface ResolvedSourceRoot {
  scope: SkillScope;
  sourceId: string;
  sourceLabel: string;
  rootPath: string;
  workspaceFolderName?: string;
}

export interface DiscoverableSourceRoot extends ResolvedSourceRoot {}

export async function discoverLocalSkills(
  workspaces: readonly WorkspaceFolderInput[],
  additionalGlobalPaths: readonly string[]
): Promise<SkillRecord[]> {
  const roots: ResolvedSourceRoot[] = [];

  for (const pattern of GLOBAL_SOURCE_PATTERNS) {
    const resolvedRoots = await resolvePatternRoots(pattern);
    roots.push(
      ...resolvedRoots.map((rootPath) => ({
        scope: 'global' as const,
        sourceId: `${pattern.id}:${rootPath}`,
        sourceLabel: `${pattern.label} (${rootPath})`,
        rootPath
      }))
    );
  }

  for (const rawPath of additionalGlobalPaths) {
    const resolved = expandHome(rawPath);
    roots.push({
      scope: 'global',
      sourceId: `custom-global:${resolved}`,
      sourceLabel: `Custom Global (${resolved})`,
      rootPath: resolved
    });
  }

  for (const workspace of workspaces) {
    for (const pattern of WORKSPACE_SOURCE_PATTERNS) {
      roots.push({
        scope: 'workspace',
        sourceId: `${pattern.id}:${workspace.fsPath}`,
        sourceLabel: `${workspace.name} · ${pattern.label}`,
        rootPath: path.join(workspace.fsPath, pattern.relativePath),
        workspaceFolderName: workspace.name
      });
    }
  }

  return discoverLocalSkillsFromRoots(roots);
}

export async function discoverLocalSkillsFromRoots(roots: readonly DiscoverableSourceRoot[]): Promise<SkillRecord[]> {
  const skills = await Promise.all(roots.map((root) => scanRoot(root)));
  return skills.flat().sort((left, right) => left.name.localeCompare(right.name));
}

async function resolvePatternRoots(pattern: LocalSourcePattern): Promise<string[]> {
  return expandPattern(expandHome(pattern.pattern));
}

async function expandPattern(pattern: string): Promise<string[]> {
  const normalized = path.resolve(pattern);
  const parts = normalized.split(path.sep).filter(Boolean);
  const base = normalized.startsWith(path.sep) ? path.sep : '';

  async function visit(index: number, currentPath: string): Promise<string[]> {
    if (index === parts.length) {
      return (await exists(currentPath)) ? [currentPath] : [];
    }

    const segment = parts[index];
    if (segment !== '*') {
      const nextPath = path.join(currentPath, segment);
      return visit(index + 1, nextPath);
    }

    if (!(await exists(currentPath))) {
      return [];
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    const expanded = await Promise.all(
      directories.map((entry) => visit(index + 1, path.join(currentPath, entry.name)))
    );

    return expanded.flat();
  }

  return visit(0, base || '.');
}

async function scanRoot(root: ResolvedSourceRoot): Promise<SkillRecord[]> {
  if (!(await exists(root.rootPath))) {
    return [];
  }

  const manifests = await findSkillManifests(root.rootPath, 0);
  const skills = await Promise.all(
    manifests.map(async (manifestPath) => {
      const markdown = await fs.readFile(manifestPath, 'utf8');
      const parsed = parseSkillMarkdown(markdown);
      const skillDir = path.dirname(manifestPath);
      const relativePath = path.relative(root.rootPath, skillDir) || path.basename(skillDir);
      const name = parsed.title ?? prettifyName(path.basename(skillDir));
      const description = parsed.description ?? `Skill from ${root.sourceLabel}`;

      return {
        id: hashText(`${root.scope}:${skillDir}`),
        slug: slugify(name),
        name,
        description,
        scope: root.scope,
        origin: 'local' as const,
        category: 'Other',
        tags: [],
        tagSource: 'none' as const,
        sourceId: root.sourceId,
        sourceLabel: root.sourceLabel,
        location: skillDir,
        manifestPath,
        workspaceFolderName: root.workspaceFolderName,
        relativePath,
        lastSyncedAt: new Date().toISOString()
      } satisfies SkillRecord;
    })
  );

  return skills;
}

async function findSkillManifests(directoryPath: string, depth: number): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const skillFile of SKILL_FILENAMES) {
    const manifest = entries.find((entry) => entry.isFile() && entry.name === skillFile);
    if (manifest) {
      return [path.join(directoryPath, manifest.name)];
    }
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.git'))
    .sort((left, right) => left.name.localeCompare(right.name));

  const manifests = await Promise.all(
    directories.map((entry) => findSkillManifests(path.join(directoryPath, entry.name), depth + 1))
  );

  return manifests.flat();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function prettifyName(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
