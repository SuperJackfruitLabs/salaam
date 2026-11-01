import type { Store } from '../store/index.js';
import type { ManagedWork } from '../execution/index.js';
import { canonical, ServiceError, type Controller } from '../core/index.js';

export interface CancellationReceipt {
  version: 1;
  sessionId: string;
  requestId: string;
  targetRequestId: string | null;
  attemptIds: string[];
  state: 'requested' | 'confirmed' | 'unknown';
  activeAttemptIds: string[];
  unresolvedOperationIds: string[];
  unconfirmedResources: string[];
}
interface Row {
  request_id: string;
  session_id: string;
  target_request_id: string | null;
  attempt_ids: string;
  receipt: string;
  requested_at: number;
}

/** A cancellation fences one immutable instruction; it never revokes the session's work authority. */
export class TurnCancellations {
  cancelAdditional?: (attempt: string) => void;
  additionalResources?: (session: string, attempt: string) => string[];
  constructor(
    private store: Store,
    private managed: ManagedWork,
    private active: (attempt: string) => boolean,
    private stop: (attempt: string) => Promise<void>,
  ) {}
  private row(session: string, request: string): Row {
    const row = this.store.db
      .prepare('SELECT * FROM turn_cancellations WHERE request_id=? AND session_id=?')
      .get(request, session) as unknown as Row | undefined;
    if (!row) throw new ServiceError('not_found', 'Cancellation receipt not found', 404);
    return row;
  }
  private compute(row: Row): CancellationReceipt {
    const attemptIds = JSON.parse(row.attempt_ids) as string[];
    const activeAttemptIds: string[] = [],
      unresolvedOperationIds: string[] = [],
      unconfirmedResources: string[] = [];
    for (const id of attemptIds) {
      const work = this.store.attempt(id);
      unconfirmedResources.push(...(this.additionalResources?.(work.session_id, id) ?? []));
      if (
        ['accepted', 'dispatching', 'running', 'delegated'].includes(work.state) ||
        this.active(id)
      )
        activeAttemptIds.push(id);
      for (const op of this.store.db
        .prepare("SELECT id FROM operations WHERE attempt_id=? AND state='outcome_unknown'")
        .all(id))
        unresolvedOperationIds.push(String(op.id));
      for (const run of this.store.db
        .prepare(
          "SELECT id FROM command_runs WHERE attempt_id=? AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
        )
        .all(id))
        unconfirmedResources.push('command:' + run.id);
      for (const run of this.store.db
        .prepare(
          'SELECT e.run_id FROM external_runs e JOIN child_tasks c ON c.id=e.child_id WHERE c.child_attempt=? AND e.stopped=0',
        )
        .all(id))
        unconfirmedResources.push('external:' + run.run_id);
      const worker = this.store.db
        .prepare('SELECT state FROM workers WHERE session_id=? AND epoch=?')
        .get(work.session_id, work.worker_epoch ?? -1);
      if (
        worker &&
        (worker.state === 'unhealthy' ||
          (work.session_id !== row.session_id && worker.state !== 'exited'))
      )
        unconfirmedResources.push(`worker:${work.session_id}:${work.worker_epoch}`);
    }
    const state =
      unresolvedOperationIds.length ||
      unconfirmedResources.length ||
      (activeAttemptIds.length && Date.now() - row.requested_at > 10000)
        ? 'unknown'
        : activeAttemptIds.length
          ? 'requested'
          : 'confirmed';
    return {
      version: 1,
      sessionId: row.session_id,
      requestId: row.request_id,
      targetRequestId: row.target_request_id,
      attemptIds,
      state,
      activeAttemptIds,
      unresolvedOperationIds: [...new Set(unresolvedOperationIds)],
      unconfirmedResources: [...new Set(unconfirmedResources)],
    };
  }
  begin(
    session: string,
    request: string,
    target: string | null,
    controller: Controller,
  ): CancellationReceipt {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request))
      throw new ServiceError('invalid_field', 'Cancellation request must be a UUID');
    this.store.request('local-operator', request, { kind: 'cancel-turn', session, target }, () => {
      this.store.authorizeControl(session, controller);
      let roots: string[];
      if (target !== null) {
        const previous = this.store.db
          .prepare("SELECT response FROM requests WHERE actor='local-operator' AND id=?")
          .get(target);
        if (previous) {
          const attempt = JSON.parse(String(previous.response)).attempt_id;
          if (typeof attempt !== 'string' || this.store.attempt(attempt).session_id !== session)
            throw new ServiceError(
              'request_conflict',
              'Cancellation target is not this session instruction',
            );
          roots = [attempt];
        } else roots = [];
      } else
        roots = this.store.db
          .prepare(
            "SELECT id FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running','delegated') LIMIT 101",
          )
          .all(session)
          .map((r) => String(r.id));
      const ids = new Set<string>();
      for (const id of roots)
        for (const row of this.store.db
          .prepare(
            'WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT c.child_attempt FROM child_tasks c JOIN owned o ON c.parent_attempt=o.id) SELECT id FROM owned',
          )
          .all(id))
          ids.add(String(row.id));
      if (ids.size > 100)
        throw new ServiceError(
          'cancellation_limit',
          'Use explicit session revocation for this execution tree',
        );
      for (const id of ids) {
        this.cancelAdditional?.(id);
        if (
          ['accepted', 'dispatching', 'running', 'delegated'].includes(this.store.attempt(id).state)
        )
          this.managed.cancelInTransaction(id, request);
      }
      const row: Row = {
        request_id: request,
        session_id: session,
        target_request_id: target,
        attempt_ids: JSON.stringify([...ids]),
        receipt: '',
        requested_at: Date.now(),
      };
      const receipt = this.compute(row);
      this.store.db
        .prepare('INSERT INTO turn_cancellations VALUES (?,?,?,?,?,?)')
        .run(request, session, target, row.attempt_ids, JSON.stringify(receipt), row.requested_at);
      this.store.event(session, 'turn.cancel_requested', { receipt }, request);
      return { request_id: request };
    });
    const receipt = this.get(session, request);
    for (const id of receipt.attemptIds) void this.stop(id).catch(() => {});
    return receipt;
  }
  get(session: string, request: string): CancellationReceipt {
    const row = this.row(session, request),
      previous = JSON.parse(row.receipt) as CancellationReceipt;
    if (previous.state === 'confirmed') return previous;
    const current = this.compute(row);
    if (canonical(previous) !== canonical(current))
      this.store.transaction(() => {
        this.store.db
          .prepare('UPDATE turn_cancellations SET receipt=? WHERE request_id=?')
          .run(JSON.stringify(current), request);
        this.store.event(session, 'turn.cancel_status', { receipt: current }, request);
      });
    return current;
  }
  list(session: string): CancellationReceipt[] {
    this.store.session(session);
    return this.store.db
      .prepare(
        "SELECT request_id FROM turn_cancellations WHERE session_id=? ORDER BY (json_extract(receipt,'$.state')='confirmed'),requested_at DESC LIMIT 100",
      )
      .all(session)
      .map((r) => this.get(session, String(r.request_id)));
  }
  recover(): void {
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM turn_cancellations WHERE json_extract(receipt,'$.state')!='confirmed'",
      )
      .all() as unknown as Row[])
      for (const id of JSON.parse(row.attempt_ids) as string[]) void this.stop(id).catch(() => {});
  }
}
