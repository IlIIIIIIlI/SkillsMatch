import * as fs from 'node:fs/promises';

import type { SkillRecord } from '../shared/types';
import { hashText } from './utils';

const KNOWLEDGE_BASE_PREFIX = '/skill-map';
const MANIFEST_CHAR_LIMIT = 16_000;

export function buildLightRagWorkspaceId(workspaceFolderIds: readonly string[]): string {
  const seed = workspaceFolderIds.length > 0 ? workspaceFolderIds.join('|') : 'global';
  return `skill_map_${hashText(seed).slice(0, 12)}`;
}

export function buildKnowledgeBaseFileSource(skill: Pick<SkillRecord, 'id'>): string {
  return `${KNOWLEDGE_BASE_PREFIX}/${skill.id}.md`;
}

export function extractSkillIdFromKnowledgeBaseFileSource(fileSource: string): string | undefined {
  const match = fileSource.match(/^\/skill-map\/([a-f0-9]+)\.md$/i);
  return match?.[1];
}

export async function loadSkillManifestContent(skill: SkillRecord, timeoutMs: number): Promise<string> {
  if (skill.origin === 'local') {
    return fs.readFile(skill.manifestPath, 'utf8');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(skill.rawUrl ?? skill.manifestPath, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'skill-map-vscode-extension'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${skill.name}: ${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function buildSkillKnowledgeDocument(skill: SkillRecord, manifestContent?: string): string {
  const sections = [
    `# ${skill.name}`,
    '',
    `Category: ${skill.category}`,
    `Scope: ${skill.scope}`,
    `Origin: ${skill.origin}`,
    `Source: ${skill.sourceLabel}`,
    `Location: ${skill.location}`,
    skill.relativePath ? `Relative Path: ${skill.relativePath}` : undefined,
    skill.workspaceFolderName ? `Workspace Folder: ${skill.workspaceFolderName}` : undefined,
    `Tags: ${skill.tags.join(', ') || 'none'}`,
    '',
    'Description',
    skill.description,
    '',
    'Skill Manifest',
    trimManifest(manifestContent ?? synthesizeSkillManifest(skill))
  ];

  return sections.filter((entry): entry is string => Boolean(entry)).join('\n');
}

export function synthesizeSkillManifest(skill: SkillRecord): string {
  return [
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    `Source: ${skill.sourceLabel}`,
    `Location: ${skill.location}`,
    skill.relativePath ? `Relative path: ${skill.relativePath}` : undefined,
    skill.repositoryUrl ? `Repository: ${skill.repositoryUrl}` : undefined
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n');
}

function trimManifest(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= MANIFEST_CHAR_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, MANIFEST_CHAR_LIMIT).trimEnd()}\n\n[truncated by Skill Map]`;
}
