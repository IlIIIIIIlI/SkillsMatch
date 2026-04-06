export interface LightRagClientConfig {
  baseUrl: string;
  workspace: string;
  timeoutMs: number;
}

interface InsertResponse {
  status?: string;
  message?: string;
  track_id?: string;
}

interface TrackStatusResponse {
  total_count?: number;
  status_summary?: Record<string, number>;
}

interface QueryResponse {
  response?: string;
  references?: Array<{
    file_path?: string;
    content?: string[];
  }>;
}

export interface LightRagReference {
  filePath: string;
  content: string[];
}

export interface LightRagQueryResult {
  response: string;
  references: LightRagReference[];
}

export class LightRagClient {
  public constructor(private readonly config: LightRagClientConfig) {}

  public async getStatus(): Promise<{ status?: string }> {
    return this.requestJson<{ status?: string }>('');
  }

  public async clearDocuments(): Promise<void> {
    await this.requestJson('/documents', {
      method: 'DELETE'
    });
  }

  public async insertTexts(texts: string[], fileSources: string[]): Promise<{ trackId?: string; status?: string; message?: string }> {
    const payload = await this.requestJson<InsertResponse>('/documents/texts', {
      method: 'POST',
      body: JSON.stringify({
        texts,
        file_sources: fileSources
      })
    });

    return {
      trackId: payload.track_id,
      status: payload.status,
      message: payload.message
    };
  }

  public async waitForTrack(trackId: string, expectedCount: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const payload = await this.requestJson<TrackStatusResponse>(`/documents/track_status/${encodeURIComponent(trackId)}`);
      const statusSummary = payload.status_summary ?? {};
      const totalCount = payload.total_count ?? 0;
      const pendingCount =
        (statusSummary.pending ?? 0) +
        (statusSummary.processing ?? 0) +
        (statusSummary.preprocessed ?? 0);

      if (totalCount >= expectedCount && pendingCount === 0) {
        if ((statusSummary.failed ?? 0) > 0) {
          throw new Error(`LightRAG indexed ${totalCount} documents with ${statusSummary.failed} failures.`);
        }
        return;
      }

      await delay(1500);
    }

    throw new Error(`LightRAG indexing did not finish within ${Math.round(timeoutMs / 1000)}s.`);
  }

  public async query(question: string): Promise<LightRagQueryResult> {
    const payload = await this.requestJson<QueryResponse>('/query', {
      method: 'POST',
      body: JSON.stringify({
        query: question,
        mode: 'mix',
        top_k: 12,
        chunk_top_k: 12,
        stream: false,
        include_references: true,
        include_chunk_content: true,
        response_type: 'Bullet Points'
      })
    });

    return {
      response: payload.response ?? '',
      references: (payload.references ?? []).map((reference) => ({
        filePath: reference.file_path ?? '',
        content: reference.content ?? []
      }))
    };
  }

  private async requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(new URL(trimLeadingSlash(pathname), ensureTrailingSlash(this.config.baseUrl)), {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'LIGHTRAG-WORKSPACE': this.config.workspace,
          ...(init?.headers ?? {})
        }
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LightRAG request failed: ${response.status} ${response.statusText} ${text}`.trim());
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}
