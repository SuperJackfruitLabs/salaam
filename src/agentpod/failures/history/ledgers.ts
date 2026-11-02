// The ledgers of the historical read-only check: no effect ledger holds anything but the one
// boundary write, every child ran the diagnostic profile exactly as delegated, and every MCP call
// was an admitted read that returned.
import {
  canonical,
  digest,
  DIAGNOSTIC_PROFILE,
  NATIVE_CAPABILITIES,
  POLICY_DIGEST,
} from '../../../core/index.js';
import { mcpAdmissionView } from '../../../mcp/index.js';
import type { Row } from '../rule.js';
import type { Applied, Expiry, History, HistoryRun } from './context.js';

/** The run's MCP calls and the admissions that assigned their servers. */
export interface McpHistory {
  mcp: Row[];
  assigned: Row[];
}

/** Every effect ledger is empty but for the boundary write, and the child registries agree. */
export function effectLedgers(
  h: History,
  run: HistoryRun,
  boundary: Expiry | Applied | undefined,
): Row[] {
  const { require, rows, session, task } = h;
  const { children, sessions, marks } = run;
  for (const table of [
    'operations',
    'approvals',
    'toolkit_calls',
    'toolkit_resources',
    'local_calls',
    'command_runs',
  ])
    require(
      rows(table, `SELECT * FROM ${table} WHERE session_id IN (${marks})`, ...sessions).every(
        (r) =>
          boundary &&
          ((table === 'operations' && r.id === boundary.operation.id) ||
            (table === 'approvals' && r.id === boundary.approval.id)),
      ),
    );
  require(
    rows('reservations', 'SELECT * FROM task_reservations WHERE task_id=?', task.id).every(
      (r) =>
        r.remaining_requests === 0 &&
        r.remaining_tokens === 0 &&
        children.some((c) => c.child_attempt === r.attempt_id),
    ),
  );
  for (const table of ['task_invocations', 'task_mutations', 'task_restores', 'task_completions'])
    require(rows(table, `SELECT * FROM ${table} WHERE task_id=?`, task.id).length === 0);
  require(
    rows(
      'workspace_mutations',
      `SELECT m.* FROM workspace_mutations m JOIN workspaces w ON w.id=m.workspace_id WHERE w.session_id IN (${marks})`,
      ...sessions,
    ).length === 0,
  );
  require(
    rows(
      'integrations',
      `SELECT * FROM worker_integrations WHERE parent_session IN (${marks})`,
      ...sessions,
    ).length === 0,
  );
  // Inspect independent child registries, including partial/orphan records.
  const workers = rows(
    'child_workers',
    `SELECT w.* FROM child_workers w LEFT JOIN child_tasks c ON c.id=w.child_id WHERE c.id IS NULL OR c.parent_session IN (${marks}) OR json_extract(w.binding,'$.owner_session')=?`,
    ...sessions,
    session,
  );
  require(
    workers.length === children.length &&
      workers.every((w) => children.some((c) => c.id === w.child_id)),
  );
  for (const table of ['external_runs', 'external_model_requests'])
    require(
      rows(
        table,
        `SELECT e.* FROM ${table} e LEFT JOIN child_tasks c ON c.id=e.child_id WHERE c.id IS NULL OR c.parent_session IN (${marks})`,
        ...sessions,
      ).length === 0,
    );
  return workers;
}

/** The diagnostic profile, when there are children, and each child as delegated. */
export function delegatedChildren(
  h: History,
  run: HistoryRun,
  rootAttempts: Row[],
  workers: Row[],
): void {
  const { require, store } = h;
  const { children } = run;
  const profile = store.db
    .prepare('SELECT * FROM worker_profiles WHERE id=? AND revision=?')
    .get(DIAGNOSTIC_PROFILE.id, DIAGNOSTIC_PROFILE.revision);
  if (children.length)
    require(
      profile &&
        !profile.revoked &&
        profile.digest === digest(DIAGNOSTIC_PROFILE) &&
        digest(JSON.parse(String(profile.document))) === profile.digest,
    );
  for (const child of children) {
    checkChild(h, run, rootAttempts, workers, child);
  }
}

/** One child: completed, bound to the diagnostic profile, its prompt and result exact. */
function checkChild(
  h: History,
  run: HistoryRun,
  rootAttempts: Row[],
  workers: Row[],
  child: Row,
): void {
  const { require, artifact, store, session, task } = h;
  const { attempts } = run;
  const worker = workers.find((w) => w.child_id === child.id)!,
    b = JSON.parse(String(worker.binding));
  const attempt = attempts.find(
    (a) => a.id === child.child_attempt && a.session_id === child.child_session,
  );
  require(
    child.state === 'completed' &&
      child.result_id &&
      attempt &&
      rootAttempts.some((a) => a.id === child.parent_attempt) &&
      worker.dispatch_state === 'terminal' &&
      worker.generation === 1 &&
      worker.worker_epoch === attempt.worker_epoch &&
      worker.binding_digest === digest(b) &&
      b.schema_version === 1 &&
      b.legacy === false &&
      b.runtime === 'native-pi' &&
      !b.agent &&
      !b.assignment &&
      !b.external &&
      !b.isolation &&
      !b.repository &&
      b.workspace === null &&
      b.owner_session === session &&
      b.owner_task === task.id &&
      b.parent_attempt === child.parent_attempt &&
      b.session_id === child.child_session &&
      b.attempt_id === child.child_attempt &&
      b.step_key === child.step_key &&
      b.input_digest === child.input_digest &&
      b.policy_digest === POLICY_DIGEST &&
      b.profile_digest === digest(DIAGNOSTIC_PROFILE) &&
      canonical(b.profile) === canonical(DIAGNOSTIC_PROFILE) &&
      canonical(b.tools) === canonical(['salaam_probe']) &&
      child.authority === JSON.stringify(b.tools) &&
      b.capability_digest === digest(NATIVE_CAPABILITIES) &&
      canonical(b.capabilities) === canonical(NATIVE_CAPABILITIES) &&
      b.bounds?.scope === 'model-requests' &&
      b.bounds.requests === child.budget &&
      canonical(b.route) === canonical(store.providerRoute(String(child.child_session))),
  );
  const prompt = artifact(b.input_artifact, child.child_session, false);
  const submission = store.db
    .prepare('SELECT * FROM submissions WHERE id=? AND attempt_id=? AND session_id=?')
    .get(String(attempt!.submission_id), String(attempt!.id), String(child.child_session));
  require(
    submission?.text === prompt &&
      child.input_digest === digest({ prompt, budget: child.budget, requested: b.tools }),
  );
  const result = artifact(child.artifact_id, child.child_session);
  require(
    canonical(result) ===
      canonical({
        schema_version: 1,
        child_id: child.id,
        attempt_id: attempt!.id,
        state: 'completed',
        text: attempt!.result,
        error: null,
      }),
  );
}

/** The MCP calls, each an admitted read that returned. */
export function mcpReads(h: History, run: HistoryRun, rootAttempts: Row[]): McpHistory {
  const { rows } = h;
  const { sessions, marks } = run;
  const mcp = rows('mcp', `SELECT * FROM mcp_calls WHERE session_id IN (${marks})`, ...sessions);
  const assigned = rows(
    'mcp_admissions',
    `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='mcp.assigned'`,
    ...sessions,
  );
  for (const call of mcp) {
    mcpCall(h, rootAttempts, assigned, call);
  }
  return { mcp, assigned };
}

/** One MCP call: on an assigned read tool, its input digest and result exact. */
function mcpCall(h: History, rootAttempts: Row[], assigned: Row[], call: Row): void {
  const { require, artifact, session, root } = h;
  require(
    call.session_id === session &&
      call.binding_digest === root &&
      call.policy === 'read' &&
      call.state === 'returned' &&
      call.operation_id === null &&
      call.error === null &&
      rootAttempts.some((a) => a.id === call.attempt_id && a.worker_epoch === call.worker_epoch),
  );
  const view = assigned
    .filter((e) => e.session_id === call.session_id)
    .map((e) => mcpAdmissionView(JSON.parse(String(e.payload))))
    .find(
      (v) =>
        v.binding_digest === root &&
        v.assignment_digest === call.assignment_digest &&
        v.profile_digest === call.profile_digest &&
        v.credential_generation === call.credential_generation,
    );
  require(
    view?.servers
      .find((s) => s.name === call.server_name)
      ?.tools.some((t) => t.name === call.tool_name && t.policy === 'read'),
  );
  require(
    call.input_digest ===
      digest({
        session,
        epoch: call.worker_epoch,
        attempt: call.attempt_id,
        call: call.tool_call_id,
        server: call.server_name,
        tool: call.tool_name,
        arguments: JSON.parse(String(call.arguments_json)),
      }),
  );
  const result = artifact(call.result_artifact, session);
  require(
    result.protocol_result === 'returned' &&
      result.is_error === false &&
      Array.isArray(result.content),
  );
}
