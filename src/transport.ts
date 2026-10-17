import { request as httpRequest, type IncomingMessage } from 'node:http';
import { ServiceError } from './protocol.js';

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new ServiceError('body_too_large', 'Request exceeds 1 MiB', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceError('invalid_json', 'Invalid JSON', 400);
  }
}
export function call<T = unknown>(
  socketPath: string,
  path: string,
  body?: unknown,
  token?: string,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            res.destroy(new Error('Response too large'));
          } else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((res.statusCode ?? 500) >= 400)
              reject(
                new ServiceError(
                  value.code ?? 'remote_error',
                  value.error ?? 'Service error',
                  res.statusCode,
                ),
              );
            else resolve(value as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
