// Attempts: a submission queued, claimed by its worker, run and finished, with the transcript it
// synced; and what a restart does to the attempts it interrupted.
import { randomUUID } from 'node:crypto';
import {
  acpFailure,
  ServiceError,
  type Attempt,
  type AttemptOutcome,
  type Controller,
  type Session,
  type Submission,
} from '../core/index.js';
import type { Journal } from './journal.js';

export interface AttemptStore extends Journal {
  readonly execution: { assert(session: string): void; revocation(session: string): unknown };
  readonly usage: { importEntries(session: string, entries: { id: string }[]): void };
  guardTaskSubmission?: (session: string, step?: string) => void;
  projectTaskAttempt?: (attempt: Attempt) => void;
  finishChild?: (attempt: Attempt) => void;
  taskChildFinished?: (attempt: string) => void;
  reconcileCompactions?: (id: string) => void;
  authorizeControl(id: string, controller: Controller): void;
  attempt(id: string): Attempt;
  assertEpoch(id: string, epoch: number): Session;
  hasUnknown(id: string): boolean;
  cancelled(id: string): boolean;
  finish(
    id: string,
    state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
    result: string | null,
    error: string | null,
  ): void;
}

export function enqueue(
  store: AttemptStore,
  id: string,
  requestId: string,
  text: string,
  controller?: Controller,
  continuesAttempt: string | null = null,
  taskStep?: string,
): { id: string; attempt_id: string; state: 'accepted' } {
  if (!store.db.isTransaction) throw new Error('Submission requires a transaction');
  if (
    store.db
      .prepare('SELECT 1 FROM turn_cancellations WHERE session_id=? AND target_request_id=?')
      .get(id, requestId)
  )
    throw new ServiceError(
      'prompt_cancelled',
      'This logical instruction was cancelled before dispatch',
    );
  store.execution.assert(id);
  store.guardTaskSubmission?.(id, taskStep);
  if (controller) store.authorizeControl(id, controller);
  if (text.trimStart().startsWith('/'))
    throw new ServiceError(
      'reserved_command',
      'Pi slash commands cannot be submitted as prompts',
      400,
    );
  if (continuesAttempt) {
    const previous = store.db
      .prepare('SELECT * FROM attempts WHERE id=?')
      .get(continuesAttempt) as unknown as Attempt | undefined;
    if (
      !previous ||
      previous.session_id !== id ||
      previous.state !== 'interrupted' ||
      previous.resolved_by
    )
      throw new ServiceError('invalid_continuation', 'Attempt is not an unresolved interruption');
  }
  const submission = randomUUID();
  const attempt = randomUUID();
  store.db
    .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
    .run(submission, id, text, attempt);
  store.db
    .prepare(
      "INSERT INTO attempts(id,session_id,submission_id,state,continues_attempt_id) VALUES (?,?,?,'accepted',?)",
    )
    .run(attempt, id, submission, continuesAttempt);
  if (continuesAttempt)
    store.db.prepare('UPDATE attempts SET resolved_by=? WHERE id=?').run(attempt, continuesAttempt);
  store.event(
    id,
    'submission.accepted',
    {
      submission_id: submission,
      attempt_id: attempt,
      continues_attempt_id: continuesAttempt,
    },
    requestId,
  );
  return { id: submission, attempt_id: attempt, state: 'accepted' };
}
export function claim(
  store: AttemptStore,
  id: string,
  epoch: number,
): { attempt: Attempt; submission: Submission } | null {
  return store.transaction(() => {
    if (store.execution.revocation(id)) return null;
    if (store.assertEpoch(id, epoch).state !== 'ready') return null;
    if (store.hasUnknown(id)) return null;
    if (
      store.db
        .prepare(
          "SELECT 1 FROM attempts WHERE session_id=? AND (state IN ('dispatching','running') OR (state='interrupted' AND resolved_by IS NULL))",
        )
        .get(id)
    )
      return null;
    const next = store.db
      .prepare(
        "SELECT * FROM attempts WHERE session_id=? AND state='accepted' ORDER BY (continues_attempt_id IS NULL),rowid LIMIT 1",
      )
      .get(id) as unknown as Attempt | undefined;
    if (!next) return null;
    store.db
      .prepare("UPDATE attempts SET state='dispatching',worker_epoch=? WHERE id=?")
      .run(epoch, next.id);
    store.db
      .prepare("UPDATE submissions SET state='dispatching' WHERE id=?")
      .run(next.submission_id);
    store.projectTaskAttempt?.(store.attempt(next.id));
    store.event(id, 'attempt.dispatching', {
      attempt_id: next.id,
      submission_id: next.submission_id,
      epoch,
    });
    return {
      attempt: store.attempt(next.id),
      submission: store.db
        .prepare('SELECT * FROM submissions WHERE id=?')
        .get(next.submission_id) as unknown as Submission,
    };
  });
}
export function running(store: AttemptStore, id: string): void {
  store.transaction(() => {
    const attempt = store.attempt(id);
    if (attempt.state !== 'dispatching') return;
    store.db.prepare("UPDATE attempts SET state='running' WHERE id=?").run(id);
    store.db
      .prepare("UPDATE submissions SET state='running' WHERE id=?")
      .run(attempt.submission_id);
    store.projectTaskAttempt?.(store.attempt(id));
    store.event(attempt.session_id, 'attempt.running', {
      attempt_id: id,
      submission_id: attempt.submission_id,
    });
  });
}
export function finish(
  store: AttemptStore,
  id: string,
  state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
  result: string | null,
  error: string | null,
  transcript?: { epoch: number; entries: { id: string }[]; leaf: string | null },
  outcome?: AttemptOutcome,
): void {
  store.transaction(() => {
    const attempt = store.attempt(id);
    if (!['dispatching', 'running'].includes(attempt.state)) return;
    if (state === 'completed' && outcome && outcome.stopReason !== 'end_turn') state = 'failed';
    if (store.cancelled(id)) state = 'cancelled';
    else if (store.hasUnknown(attempt.session_id)) {
      state = 'interrupted';
      error = 'Managed operation outcome is unknown';
    }
    if (transcript)
      appendEntries(
        store,
        attempt.session_id,
        transcript.epoch,
        transcript.entries,
        transcript.leaf,
      );
    const finalOutcome: AttemptOutcome =
      state === 'completed'
        ? (outcome ?? { version: 1, stopReason: 'end_turn' })
        : state === 'cancelled'
          ? {
              version: 1,
              stopReason: 'cancelled',
              failure: acpFailure(new ServiceError('attempt_cancelled', 'Attempt cancelled')),
            }
          : state === 'interrupted'
            ? {
                version: 1,
                stopReason: 'interrupted',
                failure: acpFailure(
                  new ServiceError('attempt_interrupted', error ?? 'Attempt interrupted'),
                ),
              }
            : (outcome ?? {
                version: 1,
                stopReason: 'error',
                failure: acpFailure(new ServiceError('attempt_failed', error ?? 'Attempt failed')),
              });
    if (finalOutcome.failure)
      finalOutcome.failure = {
        ...finalOutcome.failure,
        sessionId: attempt.session_id,
        attemptId: id,
      };
    store.db
      .prepare('UPDATE attempts SET state=?,result=?,error=?,outcome=? WHERE id=?')
      .run(state, result, error, JSON.stringify(finalOutcome), id);
    store.db.prepare('UPDATE submissions SET state=? WHERE id=?').run(state, attempt.submission_id);
    store.event(attempt.session_id, `attempt.${state}`, {
      attempt_id: id,
      submission_id: attempt.submission_id,
      text: result?.slice(0, 65536) ?? null,
      truncated: (result?.length ?? 0) > 65536,
      error,
      outcome: finalOutcome,
    });
    store.projectTaskAttempt?.(store.attempt(id));
    store.finishChild?.(store.attempt(id));
    store.taskChildFinished?.(id);
  });
}
export function recoverWork(store: AttemptStore): void {
  const active = store.db
    .prepare("SELECT id FROM attempts WHERE state IN ('dispatching','running')")
    .all() as { id: string }[];
  for (const attempt of active)
    store.finish(
      attempt.id,
      'interrupted',
      null,
      'Service stopped before the attempt outcome committed; it will not be replayed',
    );
  store.transaction(() => {
    for (const row of store.db
      .prepare('SELECT session_id FROM controls WHERE expires_at>0')
      .all() as { session_id: string }[]) {
      store.db
        .prepare(
          'UPDATE controls SET client_id=NULL,token_hash=NULL,expires_at=0,epoch=epoch+1 WHERE session_id=?',
        )
        .run(row.session_id);
      store.event(row.session_id, 'control.revoked', { reason: 'service restart' });
    }
  });
}
export function appendEntries(
  store: AttemptStore,
  id: string,
  epoch: number,
  entries: { id: string }[],
  leaf: string | null,
): void {
  store.assertEpoch(id, epoch);
  for (const entry of entries)
    store.db
      .prepare('INSERT OR IGNORE INTO pi_entries VALUES (?,?,?)')
      .run(id, entry.id, JSON.stringify(entry));
  store.usage.importEntries(id, entries);
  store.db
    .prepare('UPDATE sessions SET pi_cursor=COALESCE(?,pi_cursor),pi_leaf=? WHERE id=?')
    .run(entries.at(-1)?.id ?? null, leaf, id);
  store.reconcileCompactions?.(id);
  store.event(id, 'transcript.synced', { entries: entries.length, leaf });
}
