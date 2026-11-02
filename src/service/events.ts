// A session's durable events as a server-sent event stream: replayed from a cursor, then live,
// with model previews interleaved and a heartbeat; a reader that stops draining is cut off.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Supervisor } from '../runtime/index.js';
import type { Store } from '../store/index.js';

/** Events read per pump; a full page schedules another. */
const EVENT_PAGE = 256;
/** How long a blocked reader may take to drain before it is cut off. */
const DRAIN_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 15000;

export function streamEvents(
  store: Store,
  supervisor: Supervisor,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  after: number,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
  let cursor = after;
  let active = true;
  let scheduled = false;
  let blocked = false;
  let drainTimer: NodeJS.Timeout | undefined;
  const write = (text: string) => {
    if (!res.write(text)) {
      blocked = true;
      drainTimer = setTimeout(() => res.destroy(), DRAIN_TIMEOUT_MS);
      res.once('drain', () => {
        clearTimeout(drainTimer);
        blocked = false;
        schedule();
      });
    }
  };
  const pump = () => {
    scheduled = false;
    if (!active || blocked) return;
    try {
      const events = store.events(id, cursor);
      for (const event of events) {
        write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
        if (blocked) return;
      }
      if (events.length === EVENT_PAGE) schedule();
    } catch {
      res.destroy();
    }
  };
  const schedule = () => {
    if (!scheduled && active) {
      scheduled = true;
      setImmediate(pump);
    }
  };
  const change = (event: { session_id: string }) => {
    if (event.session_id === id) schedule();
  };
  store.changes.on('event', change);
  const preview = (value: { session_id: string }) => {
    if (value.session_id === id && !blocked && active)
      write(`event: preview\ndata: ${JSON.stringify(value)}\n\n`);
  };
  supervisor.on('preview', preview);
  schedule();
  const heartbeat = setInterval(() => {
    if (!blocked) write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const cleanup = () => {
    active = false;
    clearInterval(heartbeat);
    clearTimeout(drainTimer);
    store.changes.off('event', change);
    supervisor.off('preview', preview);
  };
  res.on('close', cleanup);
  req.on('error', cleanup);
}
