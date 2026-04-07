import type { OpenRouterModelSummary, SkillInsight, SkillRecord } from '../shared/types';
import { ALLOWED_CATEGORIES } from './constants';
import { buildHeuristicInsight, normalizeInsight } from './classification';
import { chunk } from './utils';

interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  batchSize: number;
  tagPrompt: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
  }>;
}

export class OpenRouterClient {
  public constructor(private readonly config: OpenRouterConfig) {}

  public static async listModels(input: {
    baseUrl: string;
    apiKey?: string;
  }): Promise<OpenRouterModelSummary[]> {
    const endpoint = new URL('models', ensureTrailingSlash(input.baseUrl)).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com',
      'X-Title': 'SkillMatch'
    };

    if (input.apiKey) {
      headers.Authorization = `Bearer ${input.apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter model list failed: ${response.status} ${response.statusText} ${text}`);
    }

    const payload = (await response.json()) as OpenRouterModelsResponse;
    return (payload.data ?? [])
      .filter((entry): entry is { id: string; name?: string; context_length?: number } => Boolean(entry.id))
      .map((entry) => ({
        id: entry.id,
        name: entry.name?.trim() || entry.id,
        contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async enrichSkills(
    skills: SkillRecord[],
    options?: {
      signal?: AbortSignal;
      delayMs?: number;
      onProgress?: (completed: number, total: number) => void;
      onBatch?: (batch: SkillRecord[], insights: Map<string, SkillInsight>) => Promise<void> | void;
    }
  ): Promise<Map<string, SkillInsight>> {
    const insights = new Map<string, SkillInsight>();
    const batches = chunk(skills, this.config.batchSize);
    let completed = 0;

    for (const batch of batches) {
      throwIfAborted(options?.signal);
      const batchInsights = await this.enrichBatch(batch, options?.signal);
      for (const [skillId, insight] of batchInsights.entries()) {
        insights.set(skillId, insight);
        completed += 1;
        options?.onProgress?.(completed, skills.length);
      }
      await options?.onBatch?.(batch, batchInsights);

      if (options?.delayMs && completed < skills.length) {
        await sleepWithAbort(options.delayMs, options.signal);
      }
    }

    return insights;
  }

  public async recommendSkills(input: {
    question: string;
    retrievedContext?: string;
    candidates: SkillRecord[];
  }): Promise<{
    summary?: string;
    skills: Array<{ id: string; reason: string; score: number }>;
  }> {
    const endpoint = new URL('chat/completions', ensureTrailingSlash(this.config.baseUrl)).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com',
        'X-Title': 'SkillMatch'
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.15,
        response_format: {
          type: 'json_object'
        },
        messages: [
          {
            role: 'system',
            content: [
              'You recommend the best AI agent skills for a developer question.',
              'Return JSON only in the shape {"summary":"...","skills":[{"id":"...","reason":"...","score":0}]}',
              'Choose at most 8 skills, sorted from most relevant to least relevant.',
              'Use only skill ids that appear in the provided candidates.',
              'Reasons must be brief and concrete.'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify({
              question: input.question,
              retrievedContext: input.retrievedContext ?? '',
              candidates: input.candidates.map((skill) => ({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                category: skill.category,
                scope: skill.scope,
                source: skill.sourceLabel,
                tags: skill.tags,
                relativePath: skill.relativePath ?? ''
              }))
            })
          }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} ${text}`);
    }

    const payload = (await response.json()) as OpenRouterResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter returned an empty response.');
    }

    const parsed = extractJson(content) as {
      summary?: string;
      skills?: Array<{ id?: string; reason?: string; score?: number }>;
    };

    return {
      summary: parsed.summary,
      skills: (parsed.skills ?? [])
        .filter((entry): entry is { id: string; reason?: string; score?: number } => Boolean(entry.id))
        .map((entry) => ({
          id: entry.id,
          reason: entry.reason?.trim() || 'Relevant to the request.',
          score: normalizeScore(entry.score)
        }))
    };
  }

  private async enrichBatch(skills: SkillRecord[], signal?: AbortSignal): Promise<Map<string, SkillInsight>> {
    const endpoint = new URL('chat/completions', ensureTrailingSlash(this.config.baseUrl)).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com',
        'X-Title': 'SkillMatch'
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        response_format: {
          type: 'json_object'
        },
        messages: [
          {
            role: 'system',
            content: buildTagGenerationPrompt(this.config.tagPrompt)
          },
          {
            role: 'user',
            content: JSON.stringify({
              skills: skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                description: skill.description
              }))
            })
          }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} ${text}`);
    }

    const payload = (await response.json()) as OpenRouterResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter returned an empty response.');
    }

    const parsed = extractJson(content) as { skills?: Array<{ id?: string; category?: string; tags?: string[] }> };
    const insights = new Map<string, SkillInsight>();

    for (const skill of skills) {
      const fallback = buildHeuristicInsight(skill);
      const rawInsight = parsed.skills?.find((entry) => entry.id === skill.id);
      insights.set(skill.id, normalizeInsight(rawInsight ?? {}, fallback));
    }

    return insights;
  }
}

function extractJson(content: string): unknown {
  const codeFenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
  if (codeFenceMatch) {
    return JSON.parse(codeFenceMatch[1]);
  }

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('OpenRouter response did not include valid JSON.');
  }

  return JSON.parse(content.slice(firstBrace, lastBrace + 1));
}

function buildTagGenerationPrompt(tagPrompt: string): string {
  const base = [
    'You classify AI agent skills for a VS Code catalog.',
    `Use only these categories: ${ALLOWED_CATEGORIES.join(', ')}.`,
    'Return JSON only in the shape {"skills":[{"id":"...","category":"...","tags":["..."]}]}.',
    'Generate exactly 20 concise tags per skill.',
    'Tags must be lowercase, 1 to 3 words, specific, and unique within each skill.'
  ];

  const custom = tagPrompt.trim();
  if (custom) {
    base.push(`Additional SkillMatch instructions: ${custom}`);
  }

  return base.join(' ');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeScore(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
