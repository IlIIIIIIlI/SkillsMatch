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

interface DocumentsPaginatedResponse {
  documents?: Array<{
    file_path?: string;
    updated_at?: string;
  }>;
  pagination?: {
    page?: number;
    page_size?: number;
    total_count?: number;
    total_pages?: number;
    has_next?: boolean;
    has_prev?: boolean;
  };
  status_counts?: Record<string, number>;
}

export interface LightRagReference {
  filePath: string;
  content: string[];
}

export interface LightRagQueryResult {
  response: string;
  references: LightRagReference[];
}

export interface LightRagDocumentInventory {
  totalCount: number;
  filePaths: string[];
  latestUpdatedAt?: string;
  statusCounts: Record<string, number>;
}

export function normalizeLightRagBaseUrl(value: string): string {
  const trimmed = value.trim() || 'http://127.0.0.1:9621';

  try {
    const url = new URL(trimmed);
    url.pathname = stripLightRagUiPath(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export class LightRagClient {
  private readonly normalizedBaseUrl: string;
  private workspaceHeaderEnabled: boolean;

  public constructor(private readonly config: LightRagClientConfig) {
    this.normalizedBaseUrl = normalizeLightRagBaseUrl(config.baseUrl);
    this.workspaceHeaderEnabled = config.workspace.trim().length > 0;
  }

  public async getStatus(): Promise<{ status?: string }> {
    return this.requestJson<{ status?: string }>('/health');
  }

  public async clearDocuments(): Promise<void> {
    await this.requestJson('/documents', {
      method: 'DELETE'
    });
  }

  public async getDocumentInventory(): Promise<LightRagDocumentInventory> {
    const pageSize = 200;
    let page = 1;
    let totalPages = 1;
    let totalCount = 0;
    let latestUpdatedAt: string | undefined;
    let statusCounts: Record<string, number> = {};
    const filePaths: string[] = [];

    while (page <= totalPages) {
      const payload = await this.requestJson<DocumentsPaginatedResponse>('/documents/paginated', {
        method: 'POST',
        body: JSON.stringify({
          page,
          page_size: pageSize,
          sort_field: 'file_path',
          sort_direction: 'asc'
        })
      });

      const documents = payload.documents ?? [];
      const pagination = payload.pagination ?? {};
      totalPages = Math.max(pagination.total_pages ?? 1, 1);
      totalCount = pagination.total_count ?? totalCount;

      if (page === 1) {
        statusCounts = payload.status_counts ?? {};
      }

      for (const document of documents) {
        if (typeof document.file_path === 'string' && document.file_path.trim().length > 0) {
          filePaths.push(document.file_path);
        }

        if (typeof document.updated_at === 'string' && isMoreRecentIsoTimestamp(document.updated_at, latestUpdatedAt)) {
          latestUpdatedAt = document.updated_at;
        }
      }

      page += 1;
    }

    return {
      totalCount: totalCount || filePaths.length,
      filePaths,
      latestUpdatedAt,
      statusCounts
    };
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
    return this.requestJsonInternal<T>(pathname, init, true);
  }

  private async requestJsonInternal<T>(pathname: string, init: RequestInit | undefined, allowWorkspaceFallback: boolean): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const targetUrl = new URL(trimLeadingSlash(pathname), ensureTrailingSlash(this.normalizedBaseUrl));
      const headers = new Headers(init?.headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      if (this.workspaceHeaderEnabled) {
        headers.set('LIGHTRAG-WORKSPACE', this.config.workspace);
      } else {
        headers.delete('LIGHTRAG-WORKSPACE');
      }

      const response = await fetch(targetUrl, {
        ...init,
        signal: controller.signal,
        headers
      });

      if (!response.ok) {
        const text = await response.text();
        if (
          allowWorkspaceFallback &&
          this.workspaceHeaderEnabled &&
          shouldRetryWithoutWorkspaceHeader(response.status, text)
        ) {
          this.workspaceHeaderEnabled = false;
          return this.requestJsonInternal<T>(pathname, init, false);
        }
        throw new Error(`LightRAG request failed: ${response.status} ${response.statusText} ${text}`.trim());
      }

      const text = await response.text();

      try {
        return JSON.parse(text) as T;
      } catch {
        const snippet = text.trim().slice(0, 80);
        throw new Error(
          `LightRAG returned non-JSON from ${targetUrl.toString()}. Check that the base URL points to the API root, not /webui or /docs. Response starts with: ${snippet}`
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`LightRAG request timed out after ${Math.round(this.config.timeoutMs / 1000)}s.`);
      }
      throw error;
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

function stripLightRagUiPath(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  if (normalized === '/webui' || normalized === '/docs' || normalized === '/redoc') {
    return '/';
  }
  return normalized || '/';
}

function shouldRetryWithoutWorkspaceHeader(status: number, responseText: string): boolean {
  if (status !== 500) {
    return false;
  }

  const normalized = responseText.toLowerCase();
  return normalized.includes('pipeline_status')
    && normalized.includes('initialize_storages')
    && normalized.includes('not found');
}

function isMoreRecentIsoTimestamp(candidate: string, current?: string): boolean {
  if (!current) {
    return true;
  }

  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (Number.isNaN(candidateTime)) {
    return false;
  }
  if (Number.isNaN(currentTime)) {
    return true;
  }

  return candidateTime > currentTime;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { name?: string; code?: string };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}
