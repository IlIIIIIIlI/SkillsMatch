import type { SkillRecord } from '../shared/types';
import { ONLINE_SKILL_SOURCES, type GitHubSkillSourceDescriptor } from './constants';
import { parseSkillMarkdown } from './skillParser';
import { hashText, mapLimit, slugify } from './utils';

interface GitHubTreeResponse {
  tree: Array<{
    path: string;
    type: 'blob' | 'tree';
  }>;
}

interface GitHubContentItem {
  type: 'file' | 'dir';
  name: string;
  path: string;
}

export async function discoverOnlineSkills(timeoutMs: number): Promise<SkillRecord[]> {
  const catalogs = await mapLimit(ONLINE_SKILL_SOURCES, 3, (source) => scanGitHubSource(source, timeoutMs));
  return catalogs.flat().sort((left, right) => left.name.localeCompare(right.name));
}

async function scanGitHubSource(descriptor: GitHubSkillSourceDescriptor, timeoutMs: number): Promise<SkillRecord[]> {
  const manifestPaths =
    descriptor.strategy === 'tree'
      ? await listManifestPathsFromTree(descriptor, timeoutMs)
      : await listManifestPathsFromContents(descriptor, timeoutMs);

  if (manifestPaths.length === 0 && descriptor.singleSkillFallback) {
    const readmeContent = await fetchText(buildRawUrl(descriptor, descriptor.singleSkillFallback.readmePath), timeoutMs);
    const parsed = parseSkillMarkdown(readmeContent);
    const name = descriptor.singleSkillFallback.title;
    const description = parsed.description ?? descriptor.singleSkillFallback.description;

    return [
      {
        id: hashText(`online:${descriptor.owner}/${descriptor.repo}:${descriptor.singleSkillFallback.readmePath}`),
        slug: slugify(name),
        name,
        description,
        scope: 'online',
        origin: 'github',
        category: 'Other',
        tags: [],
        tagSource: 'none',
        sourceId: descriptor.id,
        sourceLabel: descriptor.label,
        location: buildHtmlUrl(descriptor, descriptor.singleSkillFallback.readmePath),
        manifestPath: buildRawUrl(descriptor, descriptor.singleSkillFallback.readmePath),
        repositoryUrl: `https://github.com/${descriptor.owner}/${descriptor.repo}`,
        rawUrl: buildRawUrl(descriptor, descriptor.singleSkillFallback.readmePath),
        relativePath: descriptor.singleSkillFallback.readmePath,
        lastSyncedAt: new Date().toISOString()
      }
    ];
  }

  const skills = await mapLimit(manifestPaths, 5, async (manifestPath) => {
    const rawUrl = buildRawUrl(descriptor, manifestPath);
    const content = await fetchText(rawUrl, timeoutMs);
    const parsed = parseSkillMarkdown(content);
    const skillDir = manifestPath.split('/').slice(0, -1).join('/');
    const name = parsed.title ?? prettifyName(skillDir.split('/').pop() ?? descriptor.repo);
    const description = parsed.description ?? `${descriptor.label} skill`;

    return {
      id: hashText(`online:${descriptor.owner}/${descriptor.repo}:${manifestPath}`),
      slug: slugify(name),
      name,
      description,
      scope: 'online' as const,
      origin: 'github' as const,
      category: 'Other',
      tags: [],
      tagSource: 'none' as const,
      sourceId: descriptor.id,
      sourceLabel: descriptor.label,
      location: buildHtmlUrl(descriptor, manifestPath),
      manifestPath: rawUrl,
      repositoryUrl: `https://github.com/${descriptor.owner}/${descriptor.repo}`,
      rawUrl,
      relativePath: manifestPath,
      lastSyncedAt: new Date().toISOString()
    } satisfies SkillRecord;
  });

  return skills;
}

async function listManifestPathsFromTree(descriptor: GitHubSkillSourceDescriptor, timeoutMs: number): Promise<string[]> {
  const url = `https://api.github.com/repos/${descriptor.owner}/${descriptor.repo}/git/trees/${descriptor.branch}?recursive=1`;
  const payload = await fetchJson<GitHubTreeResponse>(url, timeoutMs);
  return payload.tree
    .filter((entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'))
    .map((entry) => entry.path)
    .filter((manifestPath) => descriptor.includePrefixes.some((prefix) => manifestPath.startsWith(prefix)))
    .sort((left, right) => left.localeCompare(right));
}

async function listManifestPathsFromContents(descriptor: GitHubSkillSourceDescriptor, timeoutMs: number): Promise<string[]> {
  const manifests = await Promise.all(
    descriptor.includePrefixes.map((prefix) => walkDirectory(descriptor, prefix, timeoutMs, 0))
  );
  return manifests.flat().sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(
  descriptor: GitHubSkillSourceDescriptor,
  directoryPath: string,
  timeoutMs: number,
  depth: number
): Promise<string[]> {
  if (depth > 5) {
    return [];
  }

  const url = `https://api.github.com/repos/${descriptor.owner}/${descriptor.repo}/contents/${encodeURIComponentPath(directoryPath)}?ref=${descriptor.branch}`;
  const response = await fetchJson<GitHubContentItem[] | GitHubContentItem>(url, timeoutMs);
  const items = Array.isArray(response) ? response : [response];

  const manifests = items.filter((item) => item.type === 'file' && item.name === 'SKILL.md').map((item) => item.path);
  if (manifests.length > 0) {
    return manifests;
  }

  const directories = items.filter((item) => item.type === 'dir');
  const nested = await Promise.all(
    directories.map((item) => walkDirectory(descriptor, item.path, timeoutMs, depth + 1))
  );
  return nested.flat();
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'skill-map-vscode-extension'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildRawUrl(descriptor: GitHubSkillSourceDescriptor, manifestPath: string): string {
  return `https://raw.githubusercontent.com/${descriptor.owner}/${descriptor.repo}/${descriptor.branch}/${manifestPath}`;
}

function buildHtmlUrl(descriptor: GitHubSkillSourceDescriptor, manifestPath: string): string {
  return `https://github.com/${descriptor.owner}/${descriptor.repo}/blob/${descriptor.branch}/${manifestPath}`;
}

function encodeURIComponentPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function prettifyName(value: string): string {
  return value
    .replace(/^\.+/, '')
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
