// The journal checks the zero- and known-effect rules share: no ledgered effect anywhere for the
// session and task, and any station unit unbound with a complete durable stop proof.
import type { WorkTask } from '../../core/index.js';
import type { Row, RuleStore } from './rule.js';

/** The ledgers a caller proves itself, so they are skipped here. */
export interface CheckedLedgers {
  operations?: boolean;
  stationReads?: boolean;
  stationCalls?: boolean;
  checkUnits?: string[];
}

/** Every execution/effect ledger, including read calls, is empty for this session and task,
 * and any station unit is unbound with a complete durable stop proof. Returns those units. */
export function noLedgeredEffects(
  store: RuleStore,
  session: string,
  task: WorkTask,
  checked: CheckedLedgers = {},
): Row[] | null {
  if (!sessionLedgersEmpty(store, session, checked) || !taskLedgersEmpty(store, session, task))
    return null;
  return stoppedUnboundUnits(store, session, checked);
}

/** The session's own execution/effect ledgers, children, integrations and mutations. */
function sessionLedgersEmpty(store: RuleStore, session: string, checked: CheckedLedgers): boolean {
  // These are all independent execution/effect ledgers, including read calls.
  for (const table of [
    'operations',
    'mcp_calls',
    'toolkit_calls',
    'toolkit_resources',
    'station_calls',
    'local_calls',
    'command_runs',
  ]) {
    // A caller that proves its own operations or closed reads checks those itself.
    if (table === 'operations' && checked.operations) continue;
    if (table === 'station_calls' && checked.stationCalls) continue;
    if (
      table === 'station_calls' &&
      checked.stationReads &&
      !store.db
        .prepare(
          "SELECT 1 FROM station_calls WHERE session_id=? AND NOT (kind='read' AND state='returned')",
        )
        .get(session)
    )
      continue;
    if (store.db.prepare(`SELECT 1 FROM ${table} WHERE session_id=?`).get(session)) return false;
  }
  if (
    store.db
      .prepare('SELECT 1 FROM child_tasks WHERE parent_session=? OR child_session=?')
      .get(session, session) ||
    store.db.prepare('SELECT 1 FROM worker_integrations WHERE parent_session=?').get(session) ||
    store.db
      .prepare(
        'SELECT 1 FROM workspace_mutations m JOIN workspaces w ON w.id=m.workspace_id WHERE w.session_id=?',
      )
      .get(session)
  )
    return false;
  return true;
}

/** The task's own ledgers, and no partially journaled or orphaned child execution. */
function taskLedgersEmpty(store: RuleStore, session: string, task: WorkTask): boolean {
  for (const table of [
    'task_reservations',
    'task_checks',
    'task_invocations',
    'task_mutations',
    'task_restores',
    'task_completions',
  ]) {
    if (store.db.prepare(`SELECT 1 FROM ${table} WHERE task_id=?`).get(task.id)) return false;
  }
  // Detect partially journaled or orphaned child execution as uncertainty too.
  if (
    store.db
      .prepare(
        'SELECT 1 FROM child_workers w LEFT JOIN child_tasks c ON c.id=w.child_id WHERE c.id IS NULL OR c.parent_session=?',
      )
      .get(session) ||
    store.db
      .prepare(
        'SELECT 1 FROM external_runs e LEFT JOIN child_tasks c ON c.id=e.child_id WHERE c.id IS NULL OR c.parent_session=?',
      )
      .get(session) ||
    store.db
      .prepare(
        'SELECT 1 FROM external_model_requests m LEFT JOIN child_tasks c ON c.id=m.child_id WHERE c.id IS NULL OR c.parent_session=?',
      )
      .get(session)
  )
    return false;
  return true;
}

/** Station units outside this work's ownership, each with its stop proof, or null. */
function stoppedUnboundUnits(
  store: RuleStore,
  session: string,
  checked: CheckedLedgers,
): Row[] | null {
  // Unbound startup verification units are outside this work's ownership. Only
  // their complete durable stop proof allows them to coexist with retirement.
  const units = store.db
    .prepare('SELECT * FROM station_units WHERE session_id=? OR session_id IS NULL')
    .all(session);
  for (const unit of units) {
    // A proven returned check's own unit belongs to this session; it still needs its stop proof.
    const ownCheck =
      unit.session_id === session &&
      typeof unit.call_id === 'string' &&
      !!checked.checkUnits?.includes(unit.call_id);
    if (
      (!ownCheck && (unit.session_id !== null || unit.call_id !== null)) ||
      unit.state !== 'stopped' ||
      !unit.stop_json
    )
      return null;
    const stop = JSON.parse(String(unit.stop_json));
    if (
      stop.version !== 1 ||
      stop.observed_empty !== true ||
      stop.unit !== `salaam-station-${String(unit.id)}.service` ||
      stop.cgroup !== `/system.slice/${stop.unit}` ||
      typeof stop.invocation !== 'string' ||
      !/^[a-f0-9]{32}$/.test(stop.invocation)
    )
      return null;
  }
  return units;
}
