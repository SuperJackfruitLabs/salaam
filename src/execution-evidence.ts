import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Artifacts } from './artifacts.js';
import type { AgentPodWorkAdmission } from './agentpod-work-protocol.js';
import { digest, ServiceError, textDigest } from './protocol.js';
import { verifyReadinessFingerprint } from './readiness-fingerprint.js';
import { committedToolkitResolutionEvidence } from './toolkit-evidence.js';

type Row = Record<string, string | number | null>;
const sections = [
  'attempts',
  'children',
  'tools',
  'checks',
  'integrations',
  'artifacts',
  'fingerprints',
] as const;
type Section = (typeof sections)[number];
const LIMIT = 256;
const TREE = `WITH RECURSIVE tree(id) AS (
  SELECT ? UNION SELECT child_session FROM child_tasks JOIN tree ON parent_session=tree.id
)`;

/** Metadata from committed source records only. Caller owns the SQLite read
 * transaction and authenticates the exact historical root before calling.
 * A recorded check is historical evidence, never a new freshness attestation.
 */
export function executionEvidence(
  store: Store,
  artifacts: Artifacts,
  admission: AgentPodWorkAdmission,
  taskId: string,
  session: string,
) {
  if (!store.db.isTransaction) throw Error('Evidence requires a consistent journal snapshot');
  const task = store.db
    .prepare('SELECT id,session_id,state,plan_revision FROM durable_tasks WHERE id=?')
    .get(taskId);
  if (!task || task.session_id !== session)
    throw new ServiceError('invalid_execution_evidence', 'Work task ownership changed');
  const truncated: Section[] = [];
  const bounded = <T>(name: Section, rows: T[]): T[] => {
    if (rows.length > LIMIT) truncated.push(name);
    return rows.slice(0, LIMIT);
  };
  const owned = (sql: string): Row[] => store.db.prepare(TREE + sql).all(session) as Row[];
  const fail = (): never => {
    throw new ServiceError(
      'invalid_execution_evidence',
      'Evidence source ownership is inconsistent',
    );
  };
  const attemptOwner = (id: Row[string], owner: Row[string]) => {
    if (
      id === null ||
      store.db.prepare('SELECT session_id FROM attempts WHERE id=?').get(id)?.session_id !== owner
    )
      fail();
  };
  const artifactOwner = (id: Row[string], owner: Row[string]) => {
    if (
      id !== null &&
      store.db.prepare('SELECT session_id FROM artifacts WHERE id=?').get(id)?.session_id !== owner
    )
      fail();
  };
  const attempts = bounded(
    'attempts',
    owned(`
    SELECT id,session_id,worker_epoch,state FROM attempts
    WHERE session_id IN (SELECT id FROM tree) ORDER BY id LIMIT 257`),
  );
  const fingerprints = bounded(
    'fingerprints',
    owned(`
    SELECT session_id,payload FROM events WHERE session_id IN (SELECT id FROM tree)
    AND kind='worker.ready' AND json_type(payload,'$.fingerprint')='object'
    ORDER BY session_id,seq LIMIT 257`).map((row) => {
      const payload = JSON.parse(String(row.payload));
      const fingerprint = verifyReadinessFingerprint(payload.fingerprint);
      if (fingerprint.session_id !== row.session_id || fingerprint.worker_epoch !== payload.epoch)
        fail();
      return fingerprint;
    }),
  );
  const children = bounded(
    'children',
    owned(`
    SELECT id,parent_session,parent_attempt,child_session,child_attempt,state,input_digest,artifact_id
    FROM child_tasks WHERE parent_session IN (SELECT id FROM tree) ORDER BY id LIMIT 257`),
  ).map((row): Row => {
    attemptOwner(row.parent_attempt!, row.parent_session!);
    attemptOwner(row.child_attempt!, row.child_session!);
    artifactOwner(row.artifact_id!, row.child_session!);
    if (row.child_session === session) fail();
    const worker = store.workerBoundary.view(String(row.id));
    const b = worker.binding;
    const onBehalf =
      !b.legacy &&
      !b.external &&
      b.runtime === 'native-pi' &&
      worker.binding_digest === digest(b) &&
      b.owner_session === row.parent_session &&
      b.session_id === row.child_session &&
      b.parent_attempt === row.parent_attempt &&
      b.attempt_id === row.child_attempt &&
      b.input_digest === row.input_digest;
    return { ...row, contributor_principal_id: onBehalf ? admission.binding.principal_id : null };
  });
  // A native child's immutable local delegation executes on behalf of the root
  // principal; its role ID never becomes a new suite principal. Opaque/external
  // execution does not establish peer contributor closure.
  const childExists = !!store.db
    .prepare('SELECT 1 FROM child_tasks WHERE parent_session=?')
    .get(session);
  const operations = owned(`
    SELECT id,session_id,attempt_id,tool_call_id,kind,state,argument_digest AS input_digest,
      id AS operation_id,operation_digest,receipt,resolution
    FROM operations WHERE session_id IN (SELECT id FROM tree) ORDER BY id LIMIT 257`).map(
    ({ receipt, ...row }): Row => ({
      ...row,
      source: 'operation',
      task_check_id: null,
      resolution_evidence: null,
      receipt_digest: receipt === null ? null : textDigest(String(receipt)),
    }),
  );
  const native = (
    table: string,
    source: string,
    inputColumn: string,
    receiptColumn: string,
    kindColumn: string,
    check = false,
  ) =>
    owned(`
    SELECT id,session_id,attempt_id,tool_call_id,${kindColumn} AS kind,state,
      ${inputColumn} AS input_digest,operation_id,${receiptColumn} AS receipt,
      ${check ? 'task_check_id' : 'NULL'} AS task_check_id
    FROM ${table} WHERE session_id IN (SELECT id FROM tree) ORDER BY id LIMIT 257`).map(
      ({ receipt, ...row }): Row => {
        if (source === 'managed-http') artifactOwner(receipt!, row.session_id!);
        return {
          ...row,
          source,
          operation_digest: null,
          receipt_digest:
            receipt === null
              ? null
              : textDigest(
                  source === 'managed-http' ? artifacts.read(String(receipt)) : String(receipt),
                ),
          resolution: null,
          resolution_evidence: null,
        };
      },
    );
  const stationHasChecks = store.db
    .prepare('PRAGMA table_info(station_calls)')
    .all()
    .some((column) => column.name === 'task_check_id');
  const tools = bounded(
    'tools',
    [
      ...operations,
      ...native('mcp_calls', 'managed-http', 'input_digest', 'result_artifact', "'mcp'"),
      ...native('toolkit_calls', 'managed-toolkit', 'request_digest', 'receipt_json', "'toolkit'"),
      ...native(
        'station_calls',
        'station',
        'input_digest',
        'result_json',
        'kind',
        stationHasChecks,
      ),
    ].sort((a, b) => String(a.source + ':' + a.id).localeCompare(String(b.source + ':' + b.id))),
  );
  for (const tool of tools) {
    if (tool.attempt_id !== null) attemptOwner(tool.attempt_id!, tool.session_id!);
    if (tool.operation_id !== null) {
      const operation = store.db
        .prepare('SELECT session_id,attempt_id,tool_call_id FROM operations WHERE id=?')
        .get(tool.operation_id!);
      if (
        !operation ||
        operation.session_id !== tool.session_id ||
        operation.attempt_id !== tool.attempt_id ||
        operation.tool_call_id !== tool.tool_call_id
      )
        fail();
    }
    if (tool.task_check_id !== null) {
      const check = store.db
        .prepare('SELECT task_id FROM task_checks WHERE id=?')
        .get(tool.task_check_id!);
      const owner =
        check &&
        store.db.prepare('SELECT session_id FROM durable_tasks WHERE id=?').get(check.task_id!);
      if (owner?.session_id !== tool.session_id) fail();
    }
  }
  const toolEvidence = tools.map((tool) =>
    Object.assign({}, tool, {
      resolution_evidence:
        tool.source === 'managed-toolkit'
          ? committedToolkitResolutionEvidence(store, String(tool.id), digest(admission.binding))
          : null,
    }),
  );
  const checks = bounded(
    'checks',
    store.db
      .prepare(
        `
    SELECT id,task_id,step_id,plan_revision,workspace_digest,profile_digest,engine_id,state,artifact_id
    FROM task_checks WHERE task_id=? ORDER BY id LIMIT 257`,
      )
      .all(taskId) as Row[],
  );
  for (const check of checks) artifactOwner(check.artifact_id!, session);
  const integrations = bounded(
    'integrations',
    owned(`
    SELECT id,parent_session,child_id,patch_digest,before_digest,after_artifact,state,mutation_id
    FROM worker_integrations WHERE parent_session IN (SELECT id FROM tree) ORDER BY id LIMIT 257`),
  );
  for (const integration of integrations) {
    const child = store.db
      .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
      .get(integration.child_id!);
    if (child?.parent_session !== integration.parent_session) fail();
    artifactOwner(integration.after_artifact!, integration.parent_session!);
    if (integration.state === 'applied') {
      const mutation = store.db
        .prepare('SELECT state,after_digest FROM workspace_mutations WHERE id=?')
        .get(integration.mutation_id!);
      const treeDigest = digest(JSON.parse(artifacts.read(String(integration.after_artifact))));
      if (!mutation || mutation.state !== 'applied' || mutation.after_digest !== treeDigest) fail();
    }
  }
  const artifactRows = bounded(
    'artifacts',
    owned(`
    SELECT id,session_id,digest,bytes FROM artifacts
    WHERE session_id IN (SELECT id FROM tree) ORDER BY id LIMIT 257`),
  );
  // A verified completion names each deliverable's artifact with the sha256 of its bytes.
  // Only an artifact whose bytes match that digest counts as produced; dispositions are
  // computed for this session's own artifacts alone, so another session's id names nothing.
  const deliverables = new Set<string>();
  const completed = store.db
    .prepare("SELECT artifact_id FROM task_completions WHERE task_id=? AND state='succeeded'")
    .get(taskId);
  if (completed?.artifact_id) {
    let record: { deliverables?: unknown } = {};
    try {
      record = JSON.parse(artifacts.read(String(completed.artifact_id)));
    } catch {
      record = {};
    }
    for (const d of Array.isArray(record.deliverables) ? record.deliverables : []) {
      const id = (d as { artifact_id?: unknown }).artifact_id,
        sha = (d as { sha256?: unknown }).sha256;
      if (typeof id !== 'string' || typeof sha !== 'string') continue;
      try {
        if (createHash('sha256').update(artifacts.read(id)).digest('hex') === sha)
          deliverables.add(id);
      } catch {
        /* a missing or corrupt artifact is not a deliverable */
      }
    }
  }
  const artifactEvidence = artifactRows.map((row): Row & { disposition: string } => {
    // Check actual immutable bytes, not just a database's claimed fingerprint.
    const content = artifacts.read(String(row.id));
    if (Buffer.byteLength(content) !== row.bytes)
      throw new ServiceError('invalid_execution_evidence', 'Artifact length differs from receipt');
    const integration = integrations.find((i) => i.after_artifact === row.id);
    const completion = store.db
      .prepare('SELECT 1 FROM task_completions WHERE task_id=? AND artifact_id=?')
      .get(taskId, row.id!);
    const appliedPatch = store.db
      .prepare(
        `
      SELECT 1 FROM station_calls c JOIN operations o ON o.id=c.operation_id
      WHERE c.session_id=? AND c.root_digest=? AND c.kind='patch' AND c.state='returned'
        AND o.session_id=c.session_id AND o.state='succeeded'
        AND json_extract(o.receipt,'$.scope')='station-workspace'
        AND json_extract(o.receipt,'$.call_id')=c.id
        AND json_extract(o.receipt,'$.root_digest')=c.root_digest
        AND json_extract(o.receipt,'$.configuration_digest')=c.configuration_digest
        AND json_extract(o.receipt,'$.input_digest')=c.input_digest
        AND json_extract(o.receipt,'$.artifact_id')=?
    `,
      )
      .get(row.session_id!, digest(admission.binding), row.id!);
    const disposition =
      integration?.state === 'applied' && integration.mutation_id
        ? 'integrated'
        : children.some((child) => child.artifact_id === row.id)
          ? 'proposed'
          : appliedPatch ||
              completion ||
              deliverables.has(String(row.id)) ||
              checks.some((check) => check.artifact_id === row.id)
            ? 'produced'
            : 'observed';
    return { ...row, disposition };
  });
  const { workspace: _privateWorkspace, ...binding } = admission.binding;
  return {
    schema_version: 'salaam-execution-evidence/v1' as const,
    source: 'salaam' as const,
    as_of: new Date().toISOString(),
    binding,
    task: {
      task_id: taskId,
      request_id: admission.request_id,
      session_id: session,
      state: String(task.state),
      plan_revision: Number(task.plan_revision),
      ...admission.work,
    },
    attempts,
    fingerprints,
    children,
    tools: toolEvidence,
    checks,
    integrations,
    artifacts: artifactEvidence,
    usage: store.usage.evidence(session),
    contributors: {
      principal_ids: [binding.principal_id],
      closure:
        childExists &&
        (truncated.includes('children') ||
          children.some((c) => c.contributor_principal_id === null))
          ? ('incomplete' as const)
          : ('complete' as const),
    },
    coverage: {
      truncated,
      unavailable: attempts.some(
        (a) =>
          a.worker_epoch !== null &&
          !fingerprints.some(
            (f) => f.session_id === a.session_id && f.worker_epoch === a.worker_epoch,
          ),
      )
        ? ['fingerprints']
        : [],
    },
  };
}
