// Requests from protected station work: read-only board reads served by the hub, and the
// station workspace's reads, patches and checks.
import { ServiceError, object, string } from '../../core/index.js';
import type { Store } from '../../store/index.js';
import type { ChildWork } from '../../workers/index.js';
import type { BoardReads } from '../board-reads.js';
import type { StationBridge } from '../station.js';
import { unawaited, type BridgeRequest } from './bridge.js';

export interface StationDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly station?: StationBridge;
  readonly boardReads: BoardReads;
  assertActive(id: string, epoch: number, attempt: string): void;
}

export class StationHandlers {
  constructor(private readonly s: StationDeps) {}

  /** board.read and board.status: read-only board reads. */
  board({ id, method, body, w }: BridgeRequest): unknown {
    // Read-only board reads, served by the hub (operator ruling 2026-10-28, option iii).
    if (!this.s.station || !w.station || !w.attempt || this.s.children?.owned(id))
      throw new ServiceError('station_disabled', 'Board reads need protected station work');
    this.s.assertActive(id, w.epoch, w.attempt);
    return method === 'board.read'
      ? this.s.boardReads.request(
          id,
          string(body.tool_call_id, 'tool_call_id', 512),
          object(body.args),
        )
      : this.s.boardReads.get(id, string(body.read_id, 'read_id', 64));
  }

  /** station.*: the protected station workspace. Its replies are handed back unawaited. */
  station({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.station || !w.station || !w.attempt || this.s.children?.owned(id))
      throw new ServiceError('station_disabled', 'Station execution is unavailable');
    this.s.assertActive(id, w.epoch, w.attempt);
    this.s.store.taskGrantCheck?.(id);
    if (method === 'station.read')
      return unawaited(
        this.s.station.read(
          id,
          w.epoch,
          w.attempt,
          string(body.tool_call_id, 'tool_call_id', 512),
          object(body.args),
        ),
      );
    if (method === 'station.prepare')
      return unawaited(
        this.s.station.prepare(
          id,
          w.epoch,
          w.attempt,
          string(body.tool_call_id, 'tool_call_id', 512),
          object(body.args),
        ),
      );
    const c = this.s.station.get(string(body.call_id, 'call_id', 128));
    if (c.session_id !== id || c.worker_epoch !== w.epoch || c.attempt_id !== w.attempt)
      throw new ServiceError('station_scope', 'Station call belongs to another invocation', 403);
    if (method === 'station.run') return unawaited(this.s.station.run(c.id));
    if (method === 'station.status') return unawaited(this.s.station.view(c.id));
    throw new ServiceError('invalid_field', 'Unsupported station method');
  }
}

/** A station call refused before it runs leaves no station_calls row, so record its
 * method, requested action and refusal code: never its path, arguments or content. */
export function recordStationRefusal(
  store: Store,
  attempt: string | undefined,
  id: string,
  method: string,
  body: Record<string, unknown>,
  error: unknown,
): void {
  const args =
    body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
  const ident = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
  try {
    store.transaction(() =>
      store.event(id, 'station.call_refused', {
        attempt_id: attempt ?? null,
        method: ident(method),
        action: ident(args.action),
        code: error instanceof ServiceError ? ident(error.code) : 'error',
      }),
    );
  } catch {
    // Recording a refusal never changes the refusal itself.
  }
}
