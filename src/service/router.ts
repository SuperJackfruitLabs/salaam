// The service's route table: an ordered list of (method, pattern) → handler, matched first to
// last. A handler answers the request, throws, or returns NEXT after its own checks so the routes
// below it get their turn; a request no route answers gets the table's not-found error.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ServiceError } from '../core/index.js';

/** Returned by a handler that did not answer: matching continues with the next route. */
export const NEXT = Symbol('next');
export type Next = typeof NEXT;

export interface RouteContext<K extends string = never> {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path's segments, empty ones dropped. */
  parts: string[];
  /** The values of the pattern's :name segments. */
  params: Record<K, string>;
}

export type Handler<K extends string = never> = (
  ctx: RouteContext<K>,
) => void | Next | Promise<void | Next>;

/** The :name segments of a pattern, as a union of their names. */
export type Params<P extends string> = P extends `${string}:${infer N}/${infer R}`
  ? N | Params<`/${R}`>
  : P extends `${string}:${infer N}`
    ? N
    : never;

/** `*` matches any method. A pattern is one of:
 * - segments, matched against `parts`: literals, `:name` (one segment), and a final `**` (zero or
 *   more further segments); without `**` the segment count must match exactly;
 * - `path:/x`, the URL's pathname exactly (a trailing slash or a doubled one does not match);
 * - `url:/x`, the raw request URL exactly, query included. */
export interface Route {
  method: string;
  pattern: string;
  handle: Handler<string>;
}

export function route<P extends string>(
  method: string,
  pattern: P,
  handle: Handler<Params<P>>,
): Route {
  // match() binds every :name in the pattern, so the handler's params are all present.
  return { method, pattern, handle };
}

/** Whether the route takes this request; on a match, its params. */
export function match(
  { method, pattern }: Route,
  req: Pick<IncomingMessage, 'method' | 'url'>,
  url: URL,
  parts: string[],
): Record<string, string> | undefined {
  if (method !== '*' && req.method !== method) return undefined;
  if (pattern.startsWith('url:')) return req.url === pattern.slice('url:'.length) ? {} : undefined;
  if (pattern.startsWith('path:'))
    return url.pathname === pattern.slice('path:'.length) ? {} : undefined;
  const segments = pattern.split('/').filter(Boolean);
  const rest = segments.at(-1) === '**';
  if (rest) segments.pop();
  if (rest ? parts.length < segments.length : parts.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, segment] of segments.entries()) {
    const part = parts[i] ?? '';
    if (segment.startsWith(':')) params[segment.slice(1)] = part;
    else if (segment !== part) return undefined;
  }
  return params;
}

export function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** The one place a failure becomes a response: a ServiceError keeps its status, code and
 * message; anything else is a 500 that reveals nothing. A response already started is cut. */
export function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const value =
    error instanceof ServiceError
      ? error
      : new ServiceError('internal_error', 'Service operation failed', 500);
  send(res, value.status, { code: value.code, error: value.message });
}

export class Router {
  constructor(
    readonly routes: Route[],
    /** The answer when no route takes the request. */
    private readonly notFound: string,
    private readonly stopping: () => boolean,
  ) {}

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.stopping()) throw new ServiceError('stopping', 'Service is stopping', 503);
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      for (const entry of this.routes) {
        const params = match(entry, req, url, parts);
        if (!params) continue;
        // A handler with nothing to wait for runs and returns in the same tick, as one if-chain did.
        const answered = entry.handle({ req, res, url, parts, params });
        if ((answered instanceof Promise ? await answered : answered) !== NEXT) return;
      }
      throw new ServiceError('not_found', this.notFound, 404);
    } catch (error) {
      sendError(res, error);
    }
  }
}
