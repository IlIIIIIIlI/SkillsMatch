import * as path from 'node:path';

export interface ParsedAgent {
  name: string;
  skills: string[];
  team?: string;
}

// ── Inline array parser ────────────────────────────────────────────────────────

function parseInlineArray(text: string): string[] {
  const inner = text.replace(/^\s*\[|\]\s*$/g, '').trim();
  if (!inner) return [];
  return inner.split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// ── YAML agent extractor ───────────────────────────────────────────────────────
// Handles common ECC/harness agent config patterns without a full YAML parser.

interface YamlLine {
  lineIdx: number;
  indent: number;
  raw: string;
  trimmed: string;
  isList: boolean;
  key?: string;
  value?: string;
  inlineArray?: string[];
}

function tokenizeYaml(text: string): YamlLine[] {
  return text.split('\n').map((raw, lineIdx) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return null;
    }
    const indent = raw.search(/\S/);
    const isList = trimmed.startsWith('- ');
    const content = isList ? trimmed.slice(2).trim() : trimmed;
    let key: string | undefined;
    let value: string | undefined;
    let inlineArray: string[] | undefined;

    const colonSpaceIdx = content.indexOf(': ');
    const endsColon = content.endsWith(':');
    if (colonSpaceIdx !== -1) {
      key = content.slice(0, colonSpaceIdx).trim();
      const afterColon = content.slice(colonSpaceIdx + 2).trim();
      if (afterColon.startsWith('[')) {
        inlineArray = parseInlineArray(afterColon);
      } else {
        value = afterColon || undefined;
      }
    } else if (endsColon) {
      key = content.slice(0, -1).trim();
    } else {
      value = content || undefined;
    }
    return { lineIdx, indent, raw, trimmed, isList, key, value, inlineArray } satisfies YamlLine;
  }).filter((l): l is YamlLine => l !== null);
}

function readSkillsAt(lines: YamlLine[], startIdx: number, ownerIndent: number): string[] {
  const skills: string[] = [];
  let inSkills = false;
  let skillsIndent = -1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.indent <= ownerIndent) break;

    if (!inSkills && line.key === 'skills') {
      inSkills = true;
      skillsIndent = line.indent;
      if (line.inlineArray) {
        skills.push(...line.inlineArray);
        inSkills = false;
      }
      continue;
    }

    if (inSkills) {
      if (line.indent <= skillsIndent) {
        inSkills = false;
        continue;
      }
      if (line.isList && line.value) {
        skills.push(line.value.replace(/^["']|["']$/g, ''));
      }
    }
  }

  return skills;
}

function readStringValue(lines: YamlLine[], startIdx: number, ownerIndent: number, keyName: string): string | undefined {
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.indent <= ownerIndent) break;
    if (line.key === keyName && line.value) {
      return line.value.replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

function extractAgentsFromYaml(text: string): ParsedAgent[] {
  const lines = tokenizeYaml(text);
  const agents: ParsedAgent[] = [];

  // Pattern A: agents: as a list (- name: foo / skills: [...])
  const agentsListIdx = lines.findIndex((l) => !l.isList && l.key === 'agents' && !l.value && !l.inlineArray);
  if (agentsListIdx !== -1) {
    const agentsLine = lines[agentsListIdx];
    // Next lines should be list items at higher indent
    let i = agentsListIdx + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent <= agentsLine.indent) break;
      if (!line.isList) { i++; continue; }

      // List item may be '- name: foo' or '- foo' (name is the value)
      const agentIndent = line.indent;
      let agentName = line.key === 'name' ? line.value : line.value;
      if (line.key && line.key !== 'name') {
        // - key: value style item where key is something else
        agentName = line.value ?? undefined;
      } else if (line.key === 'name') {
        agentName = line.value;
      } else {
        agentName = line.value;
      }

      const bodyStart = i + 1;
      const name = agentName ?? readStringValue(lines, bodyStart, agentIndent, 'name');
      if (name) {
        const skills = readSkillsAt(lines, bodyStart, agentIndent);
        const team = readStringValue(lines, bodyStart, agentIndent, 'team');
        agents.push({ name, skills, team });
      }

      // Advance past this list item's block
      i = bodyStart;
      while (i < lines.length && lines[i].indent > agentIndent) i++;
    }

    if (agents.length > 0) return agents;
  }

  // Pattern B: agents: as a map (agentName:\n  skills: [...])
  if (agentsListIdx !== -1) {
    const agentsLine = lines[agentsListIdx];
    let i = agentsListIdx + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent <= agentsLine.indent) break;
      if (line.isList) { i++; continue; }

      if (line.key && !line.value && !line.inlineArray && line.indent === agentsLine.indent + 2) {
        // This looks like an agent name key
        const agentIndent = line.indent;
        const agentBodyStart = i + 1;
        const skills = readSkillsAt(lines, agentBodyStart, agentIndent);
        agents.push({ name: line.key, skills });
      }
      i++;
    }
    if (agents.length > 0) return agents;
  }

  // Pattern C: top-level map keys as agent names (each with skills:)
  const topIndent = lines[0]?.indent ?? 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== topIndent || line.isList) { i++; continue; }
    if (line.key && !line.value && !line.inlineArray) {
      const bodyStart = i + 1;
      const skills = readSkillsAt(lines, bodyStart, line.indent);
      if (skills.length > 0 && line.key !== 'agents' && line.key !== 'steps' && line.key !== 'config') {
        agents.push({ name: line.key, skills });
      }
    }
    i++;
  }
  if (agents.length > 0) return agents;

  // Pattern D: single agent file (top-level name: + skills:)
  const topName = readStringValue(lines, 0, -1, 'name');
  if (topName) {
    const skills = readSkillsAt(lines, 0, -1);
    if (skills.length > 0) {
      return [{ name: topName, skills }];
    }
  }

  return agents;
}

// ── TOML agent extractor ───────────────────────────────────────────────────────

function extractAgentsFromToml(text: string): ParsedAgent[] {
  const agents: ParsedAgent[] = [];
  const lines = text.split('\n');

  interface TomlAgent { name?: string; skills: string[] }
  const agentMap = new Map<string, TomlAgent>();
  let currentSection: string | null = null;
  let currentAgentKey: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section headers: [[agents]] or [agents.foo] or [agents]
    const arrayHeaderMatch = trimmed.match(/^\[\[(\w[\w.]*)\]\]$/);
    if (arrayHeaderMatch) {
      currentSection = arrayHeaderMatch[1];
      if (currentSection === 'agents') {
        const key = `__seq_${agentMap.size}`;
        agentMap.set(key, { skills: [] });
        currentAgentKey = key;
      }
      continue;
    }

    const tableHeaderMatch = trimmed.match(/^\[(\w[\w.]*)\]$/);
    if (tableHeaderMatch) {
      currentSection = tableHeaderMatch[1];
      const agentsSubMatch = currentSection.match(/^agents\.(.+)$/);
      if (agentsSubMatch) {
        const agentName = agentsSubMatch[1];
        if (!agentMap.has(agentName)) {
          agentMap.set(agentName, { name: agentName, skills: [] });
        }
        currentAgentKey = agentName;
      } else {
        currentAgentKey = null;
      }
      continue;
    }

    // Key-value pairs within current section
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;

    if (currentAgentKey && agentMap.has(currentAgentKey)) {
      const agent = agentMap.get(currentAgentKey)!;
      if (key === 'name') {
        agent.name = rawValue.trim().replace(/^["']|["']$/g, '');
      } else if (key === 'skills') {
        if (rawValue.trim().startsWith('[')) {
          agent.skills = parseInlineArray(rawValue.trim());
        }
      }
    }
  }

  for (const [, agent] of agentMap) {
    const name = agent.name ?? undefined;
    if (name && agent.skills.length > 0) {
      agents.push({ name, skills: agent.skills });
    }
  }

  return agents;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function detectConfigFormat(filePath: string): 'yaml' | 'toml' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.toml') return 'toml';
  return 'unknown';
}

export function isLikelyAgentConfig(text: string): boolean {
  // Must contain something skill-like and something agent-like
  const hasSkills = /\bskills\s*[=:]/i.test(text);
  const hasAgentContext =
    /\bagents?\s*[=:\[]/i.test(text) ||
    /\bname\s*[=:]/i.test(text) ||
    /\borchestrat/i.test(text) ||
    /\bpipeline\b/i.test(text) ||
    /\bworkflow\b/i.test(text);
  return hasSkills && hasAgentContext;
}

export function parseAgentConfig(text: string, filePath: string): ParsedAgent[] {
  const format = detectConfigFormat(filePath);
  try {
    if (format === 'toml') {
      return extractAgentsFromToml(text);
    }
    return extractAgentsFromYaml(text);
  } catch {
    return [];
  }
}
