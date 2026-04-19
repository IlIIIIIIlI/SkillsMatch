import * as assert from 'node:assert/strict';

import type { LightRagDocumentInventory } from '../../src/core/lightRagClient';
import { LightRagClient } from '../../src/core/lightRagClient';

suite('lightRagClient', () => {
  const originalFetch = globalThis.fetch;

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('falls back to document-id deletion when delete-by-file-path is unavailable', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/documents/delete_by_file_paths')) {
        return jsonResponse({ detail: 'Not Found' }, 404, 'Not Found');
      }

      if (url.endsWith('/documents/delete_document')) {
        return jsonResponse({ status: 'deletion_started', message: 'queued' });
      }

      if (url.endsWith('/documents/pipeline_status')) {
        return jsonResponse({ busy: false });
      }

      if (url.endsWith('/documents/paginated')) {
        return jsonResponse({
          documents: [],
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 0,
            total_pages: 1,
            has_next: false,
            has_prev: false
          },
          status_counts: {}
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const client = new LightRagClient({
      baseUrl: 'http://127.0.0.1:9621',
      workspace: '',
      timeoutMs: 5000
    });
    const inventory: LightRagDocumentInventory = {
      totalCount: 1,
      documents: [
        {
          id: 'doc-123',
          filePath: '/skillmatch/react-tests.md'
        }
      ],
      filePaths: ['/skillmatch/react-tests.md'],
      statusCounts: {}
    };

    await client.deleteDocumentsByFilePaths(['/skillmatch/react-tests.md'], inventory, 5000);

    const deleteByIdCall = calls.find((call) => call.url.endsWith('/documents/delete_document'));
    assert.ok(deleteByIdCall);
    assert.equal(deleteByIdCall.method, 'DELETE');
    assert.deepEqual(JSON.parse(deleteByIdCall.body ?? '{}'), {
      doc_ids: ['doc-123'],
      delete_file: false,
      delete_llm_cache: false
    });
  });

  test('falls back to root track-status endpoint when the documents-prefixed route is unavailable', async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);

      if (url.endsWith('/documents/track_status/track-1')) {
        return jsonResponse({ detail: 'Not Found' }, 404, 'Not Found');
      }

      if (url.endsWith('/track_status/track-1')) {
        return jsonResponse({
          total_count: 2,
          status_summary: {
            processed: 2
          }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const client = new LightRagClient({
      baseUrl: 'http://127.0.0.1:9621',
      workspace: '',
      timeoutMs: 5000
    });

    const trackStatus = await client.getTrackStatus('track-1');

    assert.deepEqual(trackStatus, {
      totalCount: 2,
      statusCounts: {
        processed: 2
      }
    });
    assert.deepEqual(calls, [
      'http://127.0.0.1:9621/documents/track_status/track-1',
      'http://127.0.0.1:9621/track_status/track-1'
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
