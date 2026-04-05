import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function slugify(value: string): string {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeTag(value: string): string {
  return compactWhitespace(
    value
      .toLowerCase()
      .replace(/[`"'()[\]{}]/g, '')
      .replace(/[^\p{L}\p{N}#+./ -]/gu, ' ')
  );
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function hashText(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

export function expandHome(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }

  return path.join(os.homedir(), value.slice(2));
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function mapLimit<T, TResult>(
  items: readonly T[],
  limit: number,
  iteratee: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, limit);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function createNonce(length = 24): string {
  return crypto.randomBytes(length).toString('base64url');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
