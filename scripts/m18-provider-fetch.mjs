import { request } from 'node:http';
import { Readable } from 'node:stream';

/** Acceptance-only provider transport. Native authority/admission still comes from Salaam. */
export function providerFetch(socket) {
  if (!socket || !socket.startsWith('/home/hermes/.cache/salaam-m10.eByB1aeQ/m18-'))
    throw Error('Select the owned acceptance provider socket');
  return async (input, init = {}) => {
    const source = input instanceof Request ? input : null,
      url = new URL(source?.url ?? String(input));
    if (
      url.origin !== 'https://api.anthropic.com' ||
      !['/v1/messages', '/v1/messages?beta=true'].includes(url.pathname + url.search)
    )
      throw Error('Outside the fixed acceptance provider route');
    const method = init.method ?? source?.method ?? 'GET';
    if (method !== 'POST') throw Error('Provider method rejected');
    const headers = new Headers(init.headers ?? source?.headers),
      raw = init.body ?? (source ? await source.clone().arrayBuffer() : null);
    const body =
      typeof raw === 'string'
        ? Buffer.from(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Buffer.isBuffer(raw)
            ? raw
            : null;
    if (!body || body.length > 2097152) throw Error('Provider request bound');
    const frame = Buffer.from(
      JSON.stringify({
        method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(
          ['x-api-key', 'authorization', 'anthropic-beta', 'anthropic-version', 'content-type']
            .filter((key) => headers.has(key))
            .map((key) => [key, headers.get(key)]),
        ),
        body: body.toString('base64'),
      }),
    );
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          path: '/messages',
          method: 'POST',
          agent: false,
          signal: init.signal ?? source?.signal,
          headers: { 'content-type': 'application/json', 'content-length': String(frame.length) },
        },
        (res) =>
          resolve(
            new Response(Readable.toWeb(res), {
              status: res.statusCode,
              headers: { 'content-type': res.headers['content-type'] ?? 'application/json' },
            }),
          ),
      );
      req.on('error', reject);
      req.end(frame);
    });
  };
}
