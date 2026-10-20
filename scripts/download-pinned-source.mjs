import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Contributor build preparation only. Never use this retry policy for model/tool calls.
export async function downloadPinnedSource(url, options) {
  const {
    maxBytes,
    integrity,
    timeoutMs = 30000,
    redirect = 'error',
    fetcher = globalThis.fetch,
    sleep = delay,
  } = options;
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 128 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !['error', 'follow'].includes(redirect) ||
    !['sha256', 'git-blob-sha1'].includes(integrity.kind) ||
    !(integrity.kind === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(integrity.value)
  )
    throw Error('Invalid pinned source configuration');
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect,
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === 3) throw Error('Pinned source unavailable after bounded download retries');
      await sleep(Math.min(60000, 15000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status))
        throw Error(`Pinned source unavailable (HTTP ${response.status})`);
      const after = response.headers.get('retry-after');
      const requested =
        after && /^\d+$/.test(after)
          ? Number(after) * 1000
          : after
            ? Date.parse(after) - Date.now()
            : NaN;
      await sleep(
        Math.max(0, Math.min(60000, Number.isFinite(requested) ? requested : 15000 * 2 ** attempt)),
      );
      continue;
    }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
      await response.body?.cancel();
      throw Error('Pinned source exceeded byte bound');
    }
    const reader = response.body?.getReader(),
      chunks = [];
    let count = 0;
    try {
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          count += chunk.value.byteLength;
          if (count > maxBytes) {
            await reader.cancel();
            throw Error('Pinned source exceeded byte bound');
          }
          chunks.push(Buffer.from(chunk.value));
        }
    } finally {
      reader?.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const hash = createHash(integrity.kind === 'sha256' ? 'sha256' : 'sha1');
    if (integrity.kind === 'git-blob-sha1') hash.update(`blob ${bytes.length}\0`);
    if (hash.update(bytes).digest('hex') !== integrity.value)
      throw Error('Pinned source integrity mismatch');
    return bytes;
  }
  throw Error('Pinned source unavailable after bounded download retries');
}
