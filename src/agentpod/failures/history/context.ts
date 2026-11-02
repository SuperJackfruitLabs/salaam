// What every step of the historical read-only check shares: the journal, the run's identity,
// the audit it builds and the two ways a step reads the journal (rows, artifact). A step that
// finds the history incomplete throws; the rule turns any throw into null.
import { canonical, digest, type AgentPodBinding, type WorkTask } from '../../../core/index.js';
import type { SQLInputValue } from 'node:sqlite';
import type { Artifacts, Store } from '../../../store/index.js';
import type { Row } from '../rule.js';

/** The most rows one historical query may return; more is not a history this check can close. */
export const HISTORY_ROW_LIMIT = 256;
/** The root session and at most 32 children. */
export const HISTORY_SESSION_LIMIT = 33;

export type HistoryStore = Pick<Store, 'db' | 'providerRoute'>;

/** What the rule reads through: the journal and the artifact bytes behind it. */
export interface HistoryDeps {
  readonly store: HistoryStore;
  readonly verification: { readonly artifacts: Pick<Artifacts, 'read'> };
}

/** An expired (or invalidated) unanswered workspace write: its operation, approval and offer. */
export interface Expiry {
  operation: Row;
  approval: Row;
  offered: Row;
  invalidated?: true;
}

/** An approved workspace write that was applied. */
export interface Applied {
  operation: Row;
  approval: Row;
}

/** The expired write that was never sent: its attempt, station call and tool call. */
export interface Unapplied {
  attempt: string;
  call: Row;
  tool: string;
}

/** The applied write's station call and the tree change it made, settled at an event seq. */
export interface AppliedPatch {
  call: Row;
  transition: { before: string; after: string; settled: number };
}

/** The root session, its children's sessions (`marks` binds them) and all their attempts. */
export interface HistoryRun {
  children: Row[];
  sessions: string[];
  marks: string;
  attempts: Row[];
}

export interface History {
  readonly store: HistoryStore;
  readonly task: WorkTask;
  readonly runtime: Row;
  readonly session: string;
  /** The digest of the root binding. */
  readonly root: string;
  /** The run's agentpod_work row, and the verification binding it was admitted with. */
  readonly original: Row;
  readonly originalVerification: Row;
  /** Every row read through rows(), by key, in the order read. */
  readonly audit: Record<string, unknown>;
  /** Every artifact row read through artifact(), in the order read. */
  readonly artifactAudit: Row[];
  readonly require: (condition: unknown) => void;
  readonly rows: (key: string, sql: string, ...args: SQLInputValue[]) => Row[];
  /** The artifact's parsed JSON (or its text), after its row and byte count are checked. */
  readonly artifact: (id: unknown, owner: string, json?: boolean) => any;
}

/** The history's shared state, after the run's own agentpod_work row is found. */
export function openHistory(
  deps: HistoryDeps,
  binding: AgentPodBinding,
  task: WorkTask,
  runtime: Row,
): History {
  const require = (condition: unknown): void => {
    if (!condition) throw new Error('Incomplete historical read-only evidence');
  };
  const audit: Record<string, unknown> = {};
  const rows = (key: string, sql: string, ...args: SQLInputValue[]): Row[] => {
    const result = deps.store.db.prepare(sql).all(...args);
    require(result.length <= HISTORY_ROW_LIMIT);
    audit[key] = result;
    return result;
  };
  const artifactAudit: Row[] = [];
  const artifact = (id: unknown, owner: string, json = true) => {
    require(typeof id === 'string');
    const row = deps.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(String(id));
    require(row && row.session_id === owner);
    const text = deps.verification.artifacts.read(String(id));
    require(Buffer.byteLength(text) === row!.bytes);
    artifactAudit.push(row!);
    return json ? JSON.parse(text) : text;
  };
  const root = digest(binding),
    session = task.session_id;
  const original = deps.store.db
    .prepare(
      'SELECT verification_json,request_id FROM agentpod_work WHERE task_id=? AND session_id=?',
    )
    .get(task.id, session);
  require(original);
  const originalVerification = JSON.parse(String(original!.verification_json));
  return {
    store: deps.store,
    task,
    runtime,
    session,
    root,
    original: original!,
    originalVerification,
    audit,
    artifactAudit,
    require,
    rows,
    artifact,
  };
}

/** A station write's arguments are exactly a patch, and its operation is bound to them. */
export function patchArgsBind(op: Row, call: Row, args: Row, root: string): boolean {
  return (
    args.action === 'patch' &&
    Object.keys(args).toSorted().join(',') === 'action,content,expected_hash,expected_tree,path' &&
    typeof args.path === 'string' &&
    /^[a-f0-9]{64}$/.test(args.expected_tree) &&
    (args.expected_hash === null || /^[a-f0-9]{64}$/.test(args.expected_hash)) &&
    (args.content === null || typeof args.content === 'string') &&
    call.input_digest === digest(args) &&
    op.value === canonical(args) &&
    op.target === 'station:' + args.path &&
    op.target_version ===
      digest({ id: call.id, root, configuration: call.configuration_digest, args }) &&
    op.argument_digest ===
      digest({ target: op.target, value: op.value, target_version: op.target_version }) &&
    op.action_key ===
      digest({
        id: op.id,
        attempt: op.attempt_id,
        epoch: op.worker_epoch,
        call: op.tool_call_id,
        target: op.target,
        value: op.value,
        version: op.target_version,
      })
  );
}

/** A station unit's complete durable stop proof. */
export function stopProof(h: History, unit: Row): Row {
  h.require(unit.state === 'stopped' && unit.stop_json);
  const stop = JSON.parse(String(unit.stop_json));
  h.require(
    stop.version === 1 &&
      stop.observed_empty === true &&
      stop.unit === `salaam-station-${unit.id}.service` &&
      stop.cgroup === `/system.slice/${stop.unit}` &&
      /^[a-f0-9]{32}$/.test(stop.invocation),
  );
  return stop;
}
