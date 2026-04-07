import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SkillRecord } from '../shared/types';

interface GitHubDirectoryItem {
  type: 'file' | 'dir';
  name: string;
  path: string;
  download_url?: string | null;
}

export async function materializeSkill(skill: SkillRecord, targetDir: string, timeoutMs: number): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  if (skill.origin === 'local') {
    await copyLocalSkillDirectory(skill, targetDir);
    return;
  }

  await copyOnlineSkillDirectory(skill, targetDir, timeoutMs);
}

async function copyLocalSkillDirectory(skill: SkillRecord, targetDir: string): Promise<void> {
  const sourceDir = path.dirname(skill.manifestPath);
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: true
  });
}

async function copyOnlineSkillDirectory(skill: SkillRecord, targetDir: string, timeoutMs: number): Promise<void> {
  const source = resolveGitHubSkillSource(skill);
  if (!source) {
    throw new Error(`Cannot determine GitHub source details for ${skill.name}.`);
  }

  const manifestDir = path.posix.dirname(source.relativePath);
  if (!manifestDir || manifestDir === '.') {
    await downloadGitHubFile(source.owner, source.repo, source.branch, source.relativePath, path.join(targetDir, 'SKILL.md'), timeoutMs);
    return;
  }

  await downloadGitHubDirectory(source.owner, source.repo, source.branch, manifestDir, targetDir, timeoutMs, 0);
}

function resolveGitHubSkillSource(skill: SkillRecord):
  | { owner: string; repo: string; branch: string; relativePath: string }
  | undefined {
  if (!skill.repositoryUrl || !skill.relativePath || !skill.sourceBranch) {
    return undefined;
  }

  const repositoryUrl = new URL(skill.repositoryUrl);
  const segments = repositoryUrl.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }

  return {
    owner: segments[0],
    repo: segments[1],
    branch: skill.sourceBranch,
    relativePath: skill.relativePath.replace(/\\/g, '/')
  };
}

async function downloadGitHubDirectory(
  owner: string,
  repo: string,
  branch: string,
  repoDir: string,
  targetDir: string,
  timeoutMs: number,
  depth: number
): Promise<void> {
  if (depth > 6) {
    return;
  }

  const items = await fetchGitHubContents(owner, repo, branch, repoDir, timeoutMs);
  for (const item of items) {
    const destination = path.join(targetDir, path.posix.relative(repoDir, item.path));

    if (item.type === 'dir') {
      await fs.mkdir(destination, { recursive: true });
      await downloadGitHubDirectory(owner, repo, branch, item.path, destination, timeoutMs, depth + 1);
      continue;
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await downloadGitHubFile(owner, repo, branch, item.path, destination, timeoutMs, item.download_url ?? undefined);
  }
}

async function fetchGitHubContents(
  owner: string,
  repo: string,
  branch: string,
  repoPath: string,
  timeoutMs: number
): Promise<GitHubDirectoryItem[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponentPath(repoPath)}?ref=${encodeURIComponent(branch)}`;
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`GitHub contents request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as GitHubDirectoryItem[] | GitHubDirectoryItem;
  return Array.isArray(payload) ? payload : [payload];
}

async function downloadGitHubFile(
  owner: string,
  repo: string,
  branch: string,
  repoPath: string,
  targetPath: string,
  timeoutMs: number,
  downloadUrl?: string
): Promise<void> {
  const sourceUrl = downloadUrl ?? `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${repoPath}`;
  const response = await fetchWithTimeout(sourceUrl, timeoutMs);
  if (!response.ok) {
    throw new Error(`GitHub file request failed: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(targetPath, bytes);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'skillmatch-vscode-extension'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function encodeURIComponentPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
