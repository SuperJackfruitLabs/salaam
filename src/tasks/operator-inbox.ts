import { randomUUID } from 'node:crypto';
import { canonical, ServiceError, type Controller } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { InboxEntry } from '../core/index.js';
/** Attention is a durable projection; acknowledging it never decides or retries its source. */
export class OperatorInbox {
  private timer?: NodeJS.Timeout;
  controlError: string | null = null;
  constructor(
    readonly store: Store,
    readonly failed: (error: Error) => void,
  ) {}
  reconcile(): void {
    const desired = new Map<string, { session: string; kind: string; detail: unknown }>();
    const add = (key: string, session: string, kind: string, detail: unknown) =>
      desired.set(key, { session, kind, detail });
    for (const r of this.store.db
      .prepare("SELECT * FROM approvals WHERE state='pending' OR state='expired'")
      .all())
      add(
        'approval:' + r.id,
        String(r.session_id),
        Number(r.expires_at) <= Date.now() ? 'approval_expired' : 'approval',
        r,
      );
    for (const r of this.store.db
      .prepare(
        "SELECT id,session_id,target,state,error FROM operations WHERE state='outcome_unknown'",
      )
      .all())
      add('effect:' + r.id, String(r.session_id), 'unknown_effect', r);
    for (const r of this.store.db
      .prepare(
        "SELECT id,session_id,command,state,error FROM command_runs WHERE state='outcome_unknown'",
      )
      .all())
      add('command:' + r.id, String(r.session_id), 'unknown_command', r);
    for (const r of this.store.db
      .prepare('SELECT id,id AS session_id,state,error FROM sessions WHERE error IS NOT NULL')
      .all())
      add('worker:' + r.id, String(r.session_id), 'infrastructure', r);
    for (const r of this.store.db
      .prepare(
        "SELECT id,session_id,state,reason,revision FROM durable_tasks WHERE state NOT IN ('accepted','running','verifying')",
      )
      .all())
      add(
        'task:' + r.id,
        String(r.session_id),
        ['succeeded', 'succeeded_with_exception', 'cancelled'].includes(String(r.state))
          ? 'result'
          : 'task_attention',
        r,
      );
    for (const r of this.store.db
      .prepare(
        "SELECT c.id,c.task_id,c.check_key,c.state,t.session_id FROM task_checks c JOIN durable_tasks t ON t.id=c.task_id WHERE c.state IN ('failed','interrupted')",
      )
      .all())
      add('verification:' + r.id, String(r.session_id), 'verification', r);
    for (const r of this.store.db
      .prepare(
        "SELECT r.id,r.error,r.job_id,j.session_id FROM recurring_occurrences r JOIN recurring_jobs j ON j.id=r.job_id WHERE r.error IS NOT NULL AND r.state!='cancelled'",
      )
      .all())
      add('provision:' + r.id, String(r.session_id), 'infrastructure', r);
    this.store.transaction(() => {
      for (const [key, item] of desired) {
        const detail = canonical(item.detail),
          old = this.store.db.prepare('SELECT * FROM operator_inbox WHERE source_key=?').get(key);
        if (old && old.detail === detail && old.kind === item.kind && old.state === 'open')
          continue;
        const id = old ? String(old.id) : randomUUID();
        if (old)
          this.store.db
            .prepare(
              "UPDATE operator_inbox SET kind=?,detail=?,revision=revision+1,state='open',updated_at=? WHERE id=?",
            )
            .run(item.kind, detail, Date.now(), id);
        else
          this.store.db
            .prepare("INSERT INTO operator_inbox VALUES (?,?,?,?,?,1,'open',0,?)")
            .run(id, item.session, key, item.kind, detail, Date.now());
        this.store.event(item.session, 'inbox.changed', { inbox_id: id, kind: item.kind });
      }
      for (const row of this.store.db
        .prepare("SELECT id,session_id,source_key FROM operator_inbox WHERE state='open'")
        .all())
        if (!desired.has(String(row.source_key))) {
          this.store.db
            .prepare(
              "UPDATE operator_inbox SET state='resolved',revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(Date.now(), String(row.id));
          this.store.event(String(row.session_id), 'inbox.resolved', { inbox_id: row.id });
        }
    });
  }
  get(id: string): InboxEntry {
    const row = this.store.db
      .prepare('SELECT * FROM operator_inbox WHERE id=?')
      .get(id) as unknown as InboxEntry | undefined;
    if (!row) throw new ServiceError('not_found', 'Inbox item not found', 404);
    return row;
  }
  list(offset = 0, session?: string) {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM operator_inbox WHERE state='open' AND ack_revision<revision ${session ? 'AND session_id=?' : ''} ORDER BY updated_at DESC,id LIMIT 33 OFFSET ?`,
      )
      .all(...(session ? [session, offset] : [offset])) as unknown as InboxEntry[];
    return { items: rows.slice(0, 32), next_offset: rows.length > 32 ? offset + 32 : null };
  }
  ack(id: string, request: string, expected: number, actor: Controller) {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'inbox-ack', id, expected },
      () => {
        const item = this.get(id);
        this.store.authorizeControl(item.session_id, actor);
        if (item.revision !== expected)
          throw new ServiceError(
            'inbox_revision_conflict',
            'Attention changed; inspect the current item',
          );
        this.store.db.prepare('UPDATE operator_inbox SET ack_revision=revision WHERE id=?').run(id);
        this.store.event(
          item.session_id,
          'inbox.acknowledged',
          { inbox_id: id, revision: expected },
          request,
        );
        return { id, ack_revision: expected };
      },
    );
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (error) {
        this.controlError = 'Required operator inbox failed: ' + (error as Error).message;
        this.failed(error as Error);
      }
    }, 400);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
}
