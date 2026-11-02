// The attempts of the historical read-only check: the root session and its children, every
// attempt completed (or the one expired write's, cancelled), each model request granted,
// dispatched and receipted exactly once, and each root attempt bound to its plan step.
import { canonical, digest } from '../../../core/index.js';
import type { Row } from '../rule.js';
import { HISTORY_SESSION_LIMIT, type History, type HistoryRun, type Unapplied } from './context.js';

/** The native model ledgers the attempts are checked against. */
interface ModelJournal {
  usage: Row[];
  admissions: Row[];
  models: Row[];
  budgets: Row[];
}

/** The root session, its children and every attempt in them, all closed. */
export function historyRun(h: History, unapplied: Unapplied | null): HistoryRun {
  const { require, rows, store, session } = h;
  const children = rows('children', 'SELECT * FROM child_tasks WHERE parent_session=?', session);
  const sessions = [session, ...children.map((c) => String(c.child_session))];
  require(new Set(sessions).size === sessions.length && sessions.length <= HISTORY_SESSION_LIMIT);
  const marks = sessions.map(() => '?').join(',');
  require(
    !store.db
      .prepare(
        `SELECT 1 FROM child_tasks WHERE child_session=? OR (parent_session IN (${marks}) AND parent_session!=?)`,
      )
      .get(session, ...sessions, session),
  );
  const attempts = rows(
    'attempts',
    `SELECT * FROM attempts WHERE session_id IN (${marks})`,
    ...sessions,
  );
  require(
    attempts.length > 0 &&
      attempts.every(
        (a) =>
          (unapplied?.attempt === a.id
            ? a.state === 'cancelled'
            : a.state === 'completed' && a.error === null) &&
          a.continues_attempt_id === null &&
          a.resolved_by === null &&
          (unapplied?.attempt === a.id ||
            canonical(JSON.parse(String(a.outcome))) ===
              canonical({ version: 1, stopReason: 'end_turn' })),
      ),
  );
  return { children, sessions, marks, attempts };
}

/** Every attempt's model requests, from the independently journaled grants and receipts. */
export function modelGrants(h: History, run: HistoryRun): void {
  const { require, rows, runtime } = h;
  const { children, sessions, marks, attempts } = run;
  // Native model grants are independently journaled: a completed attempt
  // cannot hide an unmatched request, unknown receipt, or orphan budget.
  const attemptIds = attempts.map((a) => String(a.id)),
    attemptMarks = attemptIds.map(() => '?').join(',');
  const usage = rows(
    'usage',
    `SELECT * FROM usage_observations WHERE session_id IN (${marks}) OR attempt_id IN (${attemptMarks})`,
    ...sessions,
    ...attemptIds,
  );
  const admissions = rows(
    'usage_admitted',
    `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='usage.admitted' ORDER BY seq`,
    ...sessions,
  );
  const models = rows(
    'model_admitted',
    `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='model.admitted' ORDER BY seq`,
    ...sessions,
  );
  const budgets = rows(
    'attempt_budgets',
    `SELECT b.* FROM attempt_budgets b LEFT JOIN attempts a ON a.id=b.attempt_id WHERE a.id IS NULL OR a.session_id IN (${marks})`,
    ...sessions,
  );
  require(
    usage.length === admissions.length &&
      models.length === admissions.length &&
      budgets.length === attempts.length &&
      runtime.requests_spent === usage.length,
  );
  for (const a of attempts) attemptGrants(h, children, a, { usage, admissions, models, budgets });
}

/** One attempt: each grant dispatched once and receipted exactly, within its budget. */
function attemptGrants(h: History, children: Row[], a: Row, journal: ModelJournal): void {
  const { require, store, session } = h;
  const { usage, admissions, models, budgets } = journal;
  const receipts = usage.filter((u) => u.attempt_id === a.id && u.session_id === a.session_id);
  const grants = admissions.filter(
    (e) => JSON.parse(String(e.payload)).attempt_id === a.id && e.session_id === a.session_id,
  );
  const dispatched = models.filter(
    (e) => JSON.parse(String(e.payload)).attempt_id === a.id && e.session_id === a.session_id,
  );
  const budget = budgets.find((b) => b.attempt_id === a.id),
    route = store.providerRoute(String(a.session_id));
  require(
    new Set(grants.map((e) => JSON.parse(String(e.payload)).source_key)).size === grants.length &&
      receipts.every((r) =>
        grants.some((e) => JSON.parse(String(e.payload)).source_key === r.source_key),
      ),
  );
  require(
    route &&
      budget &&
      receipts.length > 0 &&
      receipts.length === grants.length &&
      grants.length === dispatched.length &&
      budget.spent_requests === receipts.length &&
      budget.spent_requests + budget.reserved_requests <= budget.limit_requests &&
      budget.reserved_requests ===
        children.filter((c) => c.parent_attempt === a.id).reduce((n, c) => n + Number(c.budget), 0),
  );
  if (a.session_id !== session)
    require(budget!.limit_requests === children.find((c) => c.child_attempt === a.id)?.budget);
  for (let i = 0; i < grants.length; i++) {
    const grant = grants[i]!,
      modelEvent = dispatched[i]!,
      p = JSON.parse(String(grant.payload)),
      model = JSON.parse(String(modelEvent.payload));
    const receipt = receipts.find((u) => u.source_key === p.source_key);
    require(
      receipt &&
        ['known', 'estimated'].includes(receipt.status) &&
        receipt.payload_digest &&
        receipt.provider === route!.provider &&
        receipt.model === route!.model &&
        model.provider === receipt.provider &&
        model.epoch === a.worker_epoch &&
        /^[a-f0-9]{64}$/.test(model.context_digest) &&
        /^[a-f0-9]{64}$/.test(model.payload_digest) &&
        Number(grant.seq) < Number(modelEvent.seq),
    );
    const values = [
      receipt!.input,
      receipt!.output,
      receipt!.cache_read,
      receipt!.cache_write,
      receipt!.cost,
    ];
    require(
      values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) &&
        receipt!.payload_digest ===
          digest({
            provider: receipt!.provider,
            model: receipt!.model,
            values,
            status: receipt!.status,
          }),
    );
  }
}

/** The root attempts, each bound to a step of this plan revision; no worker still runs. */
export function stepAttempts(h: History, run: HistoryRun, unapplied: Unapplied | null): Row[] {
  const { require, rows, store, session, task } = h;
  const { children, sessions, marks, attempts } = run;
  require(
    rows('compactions', `SELECT * FROM compactions WHERE session_id IN (${marks})`, ...sessions)
      .length === 0,
  );
  require(
    attempts.filter((a) => a.session_id !== session).length === children.length &&
      attempts
        .filter((a) => a.session_id !== session)
        .every((a) =>
          children.some((c) => c.child_attempt === a.id && c.child_session === a.session_id),
        ),
  );
  require(!unapplied || !children.some((c) => c.parent_attempt === unapplied.attempt));
  const rootAttempts = attempts.filter((a) => a.session_id === session);
  const links = rows(
    'step_attempts',
    'SELECT b.* FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=?',
    task.id,
  );
  require(
    rootAttempts.length > 0 &&
      links.length === rootAttempts.length &&
      links.every(
        (l) =>
          l.plan_revision === task.plan_revision &&
          rootAttempts.some((a) => a.id === l.attempt_id) &&
          task.steps.some(
            (s) =>
              s.id === l.step_id &&
              s.attempt_id === l.attempt_id &&
              (s.attempt_id === unapplied?.attempt
                ? s.state === 'cancelled'
                : ['completed', 'awaiting_review'].includes(s.state)),
          ),
      ),
  );
  require(
    task.steps.every((s) =>
      s.state === 'pending'
        ? s.attempt_id === null
        : (s.attempt_id === unapplied?.attempt
            ? s.state === 'cancelled'
            : ['completed', 'awaiting_review'].includes(s.state)) &&
          links.some((l) => l.step_id === s.id),
    ),
  );
  require(
    !store.db
      .prepare(`SELECT 1 FROM workers WHERE session_id IN (${marks}) AND state!='exited'`)
      .get(...sessions),
  );
  return rootAttempts;
}
