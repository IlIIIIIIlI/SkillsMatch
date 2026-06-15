import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentGraph, AgentGraphLink, AgentGraphNode, AgentRecord } from '../shared/types';
import { isLikelyAgentConfig, parseAgentConfig } from './agentConfigParser';
import { hashText } from './utils';

const MAX_SCAN_DEPTH = 3;
const AGENT_CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.toml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.vscode', '__pycache__', '.cache']);

async function scanForAgentConfigs(
  dir: string,
  depth: number,
  results: { filePath: string }[]
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.claude' && entry.name !== '.cursor') continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanForAgentConfigs(fullPath, depth + 1, results);
    } else if (entry.isFile() && AGENT_CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push({ filePath: fullPath });
    }
  }
}

export async function discoverAgentConfigs(workspaceFolderPaths: string[]): Promise<AgentRecord[]> {
  const agentRecords: AgentRecord[] = [];
  const candidateFiles: { filePath: string }[] = [];

  for (const folderPath of workspaceFolderPaths) {
    await scanForAgentConfigs(folderPath, 0, candidateFiles);
  }

  await Promise.all(
    candidateFiles.map(async ({ filePath }) => {
      let text: string;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch {
        return;
      }

      if (!isLikelyAgentConfig(text)) return;

      const ext = path.extname(filePath).toLowerCase();
      const format = ext === '.toml' ? 'toml' : 'yaml';
      const parsedAgents = parseAgentConfig(text, filePath);

      for (const agent of parsedAgents) {
        if (!agent.name || agent.skills.length === 0) continue;
        const id = hashText(`${filePath}:${agent.name}`);
        agentRecords.push({
          id,
          name: agent.name,
          skills: agent.skills,
          configPath: filePath,
          configFormat: format,
          team: agent.team
        });
      }
    })
  );

  return agentRecords;
}

export function buildAgentGraph(agents: AgentRecord[]): AgentGraph {
  const nodes: AgentGraphNode[] = agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    skills: agent.skills,
    skillCount: agent.skills.length,
    team: agent.team,
    configPath: agent.configPath
  }));

  const links: AgentGraphLink[] = [];

  for (let leftIdx = 0; leftIdx < agents.length; leftIdx++) {
    for (let rightIdx = leftIdx + 1; rightIdx < agents.length; rightIdx++) {
      const left = agents[leftIdx];
      const right = agents[rightIdx];

      const leftSkillSet = new Set(left.skills.map((s) => s.toLowerCase()));
      const sharedSkills = right.skills.filter((s) => leftSkillSet.has(s.toLowerCase()));
      if (sharedSkills.length === 0) continue;

      const overlap = sharedSkills.length;
      const weight = overlap / Math.max(1, Math.min(left.skills.length, right.skills.length));
      links.push({
        source: left.id,
        target: right.id,
        sharedSkills,
        overlap,
        weight
      });
    }
  }

  return { agents, nodes, links };
}
