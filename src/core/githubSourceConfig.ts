import type { GitHubSkillSourceDescriptor } from './constants';
import { compactWhitespace, hashText, unique } from './utils';

export interface ParseGitHubSourcesResult {
  sources: GitHubSkillSourceDescriptor[];
  errors: string[];
}

export function splitGitHubSourceInput(value: string): string[] {
  return unique(
    value
      .split(/[\s,]+/g)
      .map((entry) => compactWhitespace(entry))
      .filter(Boolean)
  );
}

export function parseConfiguredGitHubSourceUrls(urls: readonly string[]): ParseGitHubSourcesResult {
  const sources: GitHubSkillSourceDescriptor[] = [];
  const errors: string[] = [];

  for (const rawUrl of unique(urls.map((entry) => compactWhitespace(entry)).filter(Boolean))) {
    try {
      sources.push(parseGitHubSourceUrl(rawUrl));
    } catch (error) {
      errors.push(`${rawUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sources, errors };
}

export function parseGitHubSourceUrl(rawUrl: string): GitHubSkillSourceDescriptor {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();

  if (host === 'github.com') {
    return parseGitHubHtmlUrl(url);
  }

  if (host === 'raw.githubusercontent.com') {
    return parseGitHubRawUrl(url);
  }

  throw new Error('Only github.com and raw.githubusercontent.com URLs are supported.');
}

function parseGitHubHtmlUrl(url: URL): GitHubSkillSourceDescriptor {
  const segments = sanitizeSegments(url.pathname);
  if (segments.length < 2) {
    throw new Error('GitHub URL must include both owner and repository.');
  }

  const [owner, repo, mode, branchCandidate, ...rest] = segments;
  if (!owner || !repo) {
    throw new Error('GitHub URL must include both owner and repository.');
  }

  if (!mode) {
    return createDescriptor({
      owner,
      repo,
      sourceUrl: url.toString(),
      includePrefixes: ['']
    });
  }

  if (mode === 'tree') {
    if (!branchCandidate) {
      throw new Error('Tree URLs must include a branch name.');
    }

    return createDescriptor({
      owner,
      repo,
      branch: branchCandidate,
      sourceUrl: url.toString(),
      includePrefixes: [rest.join('/')]
    });
  }

  if (mode === 'blob') {
    if (!branchCandidate || rest.length === 0) {
      throw new Error('Blob URLs must include a branch and file path.');
    }

    const manifestPath = rest.join('/');
    if (!manifestPath.toLowerCase().endsWith('skill.md')) {
      throw new Error('Blob URLs must point directly to a SKILL.md file.');
    }

    return createDescriptor({
      owner,
      repo,
      branch: branchCandidate,
      sourceUrl: url.toString(),
      strategy: 'direct',
      includePrefixes: [],
      directManifestPath: manifestPath
    });
  }

  throw new Error('Use a repository root, tree folder, or direct SKILL.md blob URL.');
}

function parseGitHubRawUrl(url: URL): GitHubSkillSourceDescriptor {
  const segments = sanitizeSegments(url.pathname);
  if (segments.length < 4) {
    throw new Error('Raw GitHub URLs must include owner, repo, branch, and file path.');
  }

  const [owner, repo, branch, ...rest] = segments;
  const manifestPath = rest.join('/');

  if (manifestPath.toLowerCase().endsWith('skill.md')) {
    return createDescriptor({
      owner,
      repo,
      branch,
      sourceUrl: url.toString(),
      strategy: 'direct',
      includePrefixes: [],
      directManifestPath: manifestPath
    });
  }

  return createDescriptor({
    owner,
    repo,
    branch,
    sourceUrl: url.toString(),
    includePrefixes: [manifestPath]
  });
}

function createDescriptor(input: {
  owner: string;
  repo: string;
  branch?: string;
  includePrefixes: string[];
  strategy?: GitHubSkillSourceDescriptor['strategy'];
  directManifestPath?: string;
  sourceUrl: string;
}): GitHubSkillSourceDescriptor {
  const prefix = input.directManifestPath ?? input.includePrefixes.find((entry) => entry.length > 0) ?? '';
  const scopeLabel = prefix ? `${input.owner}/${input.repo}:${prefix}` : `${input.owner}/${input.repo}`;

  return {
    id: `github:${hashText(input.sourceUrl)}`,
    label: `GitHub · ${scopeLabel}`,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    type: 'configured',
    strategy: input.strategy ?? 'tree',
    includePrefixes: input.includePrefixes.length > 0 ? input.includePrefixes : [''],
    directManifestPath: input.directManifestPath,
    sourceUrl: input.sourceUrl
  };
}

function sanitizeSegments(pathname: string): string[] {
  return pathname
    .replace(/\/+$/g, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}
