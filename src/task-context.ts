import { randomUUID } from 'node:crypto';
import type { TaskWork } from './task-work.js';
import type { Store } from './store.js';
import type { Artifacts } from './artifacts.js';
import { canonical, ServiceError, string, integer, object } from './protocol.js';

export const TASK_FRAME_BYTES = 16384;
export const FACT_KINDS = [
  'objective',
  'constraint',
  'completed',
  'outstanding',
  'evidence',
] as const;
export interface TaskFact {
  id: string;
  version: number;
  kind: string;
  text: string;
  supersedes: string | null;
  artifact_id: string | null;
  source: string;
  superseded_by: string | null;
}
export interface TaskState {
  version: number;
  compaction_cursor: string | null;
  facts: TaskFact[];
}
export interface Compaction {
  id: string;
  session_id: string;
  epoch: number;
  task_version: number;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  cursor: string | null;
  error: string | null;
}
/** Explicit operator facts are append-only; summaries have no write authority. */
export class TaskContext {
  work?: TaskWork;
  constructor(
    readonly store: Store,
    readonly artifacts: Artifacts,
  ) {
    store.reconcileCompactions = (id) => this.reconcile(id);
  }
  state(id: string): TaskState {
    this.store.session(id);
    const head = this.store.db
      .prepare('SELECT version,compaction_cursor FROM task_heads WHERE session_id=?')
      .get(id) as { version: number; compaction_cursor: string | null } | undefined;
    const facts = this.store.db
      .prepare(
        `SELECT f.id,f.version,f.kind,f.text,f.supersedes,f.artifact_id,f.source,
      (SELECT n.id FROM task_facts n WHERE n.session_id=f.session_id AND n.supersedes=f.id) AS superseded_by
      FROM task_facts f WHERE f.session_id=? ORDER BY f.version`,
      )
      .all(id) as unknown as TaskFact[];
    return {
      version: head?.version ?? 0,
      compaction_cursor: head?.compaction_cursor ?? null,
      facts,
    };
  }
  frame(id: string, binding: string): string {
    const state = this.state(id);
    const admitted = [
      ...new Map(
        (this.store.workerBoundary.profiles?.snapshot(id) ?? [])
          .filter((p) => p.state === 'active')
          .map((p) => [
            p.profile_id,
            {
              profile_id: p.profile_id,
              profile_digest: p.profile_digest,
              tools: p.tools,
              route: p.route,
              max_depth: 1,
            },
          ]),
      ).values(),
    ].sort((a, b) => a.profile_id.localeCompare(b.profile_id));
    // The compaction cursor is a projection, not a task fact/version.
    const frame =
      'SALAAM_TASK_STATE ' +
      canonical({
        session_id: id,
        binding,
        version: state.version,
        instructions:
          'Runtime bookkeeping, not a user message or a new task. Answer the latest actual user request. Empty facts mean no saved notes, not an empty workspace or missing objective. Inspect workspace tools for filesystem questions; history is only for prior conversation. Use active facts; superseded facts are historical. Do not repeat completed steps.',
        facts: state.facts,
        ...(admitted.length ? { admitted_agents: admitted } : {}),
        ...(this.work?.forSession(id) ? { work_task: this.work.frame(id) } : {}),
      });
    if (Buffer.byteLength(frame) > TASK_FRAME_BYTES)
      throw new ServiceError('context_capacity', 'Mandatory task state exceeds the context budget');
    return frame;
  }
  update(
    id: string,
    request: string,
    expected: number,
    input: Record<string, unknown>,
    authorize: () => void,
  ): TaskState {
    const kind = string(input.kind, 'kind', 32);
    if (!FACT_KINDS.includes(kind as (typeof FACT_KINDS)[number]))
      throw new ServiceError('invalid_fact', 'Unsupported task fact kind', 400);
    const text = string(input.text, 'text', 4096);
    const supersedes =
      input.supersedes == null ? null : string(input.supersedes, 'supersedes', 128);
    const artifact =
      input.artifact_id == null ? null : string(input.artifact_id, 'artifact_id', 128);
    return this.store.request(
      'local-operator',
      request,
      { kind: 'task-update', id, expected, fact: { kind, text, supersedes, artifact } },
      () => {
        authorize();
        const before = this.state(id);
        if (before.version !== expected)
          throw new ServiceError('task_version_conflict', 'Task version changed');
        if (before.facts.length >= 128)
          throw new ServiceError('context_capacity', 'Task fact capacity reached');
        const old = before.facts.find((fact) => fact.id === supersedes);
        if (supersedes && (!old || old.superseded_by))
          throw new ServiceError(
            'invalid_supersession',
            'Superseded fact must be current and belong to this session',
          );
        if (
          kind === 'objective' &&
          before.facts.some((f) => f.kind === kind && !f.superseded_by && f.id !== supersedes)
        )
          throw new ServiceError(
            'invalid_supersession',
            'A new objective must supersede the current objective',
          );
        if (
          artifact &&
          !this.store.db
            .prepare('SELECT 1 FROM artifacts WHERE id=? AND session_id=?')
            .get(artifact, id)
        )
          throw new ServiceError('invalid_artifact', 'Evidence must belong to this session');
        const version = expected + 1;
        this.store.db
          .prepare(
            'INSERT INTO task_heads(session_id,version) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET version=excluded.version',
          )
          .run(id, version);
        this.store.db
          .prepare('INSERT INTO task_facts VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            id,
            version,
            kind,
            text,
            supersedes,
            artifact,
            'operator:' + request,
            Date.now(),
          );
        this.frame(id, 'x'.repeat(32)); // Capacity failures roll the entire update back.
        this.store.event(
          id,
          'task.updated',
          { version, kind, supersedes, artifact_id: artifact },
          request,
        );
        return this.state(id);
      },
    );
  }
  putArtifact(
    id: string,
    request: string,
    content: string,
    authorize: () => void,
  ): { artifact_id: string } {
    return this.store.request('local-operator', request, { kind: 'artifact', id, content }, () => {
      authorize();
      const prepared = this.artifacts.prepare(id, content);
      prepared.commit();
      return { artifact_id: prepared.id };
    });
  }
  history(id: string, input: Record<string, unknown>): unknown {
    this.store.session(id);
    const offset = input.offset === undefined ? 0 : integer(input.offset, 'offset');
    if (input.branch === true || input.branch === 'true') {
      const rows = this.store.db
        .prepare(
          `WITH RECURSIVE branch(entry_id,payload,depth) AS (
        SELECT entry_id,payload,0 FROM pi_entries WHERE session_id=? AND entry_id=?
        UNION ALL SELECT p.entry_id,p.payload,b.depth+1 FROM pi_entries p JOIN branch b ON p.entry_id=json_extract(b.payload,'$.parentId') AND p.session_id=? WHERE b.depth<100000
      ) SELECT entry_id FROM branch ORDER BY depth DESC LIMIT 33 OFFSET ?`,
        )
        .all(id, this.store.session(id).pi_leaf, id, offset);
      return { entries: rows.slice(0, 32), next_offset: rows.length > 32 ? offset + 32 : null };
    }
    if (input.artifact_id !== undefined) {
      const artifact = string(input.artifact_id, 'artifact_id', 128);
      if (
        !this.store.db
          .prepare('SELECT 1 FROM artifacts WHERE id=? AND session_id=?')
          .get(artifact, id)
      )
        throw new ServiceError('not_found', 'Session artifact not found', 404);
      const text = this.artifacts.read(artifact);
      return {
        artifact_id: artifact,
        text: text.slice(offset, offset + 8192),
        next_offset: offset + 8192 < text.length ? offset + 8192 : null,
      };
    }
    if (input.entry_id !== undefined) {
      const entry = string(input.entry_id, 'entry_id', 128);
      const row = this.store.db
        .prepare('SELECT payload FROM pi_entries WHERE session_id=? AND entry_id=?')
        .get(id, entry) as { payload: string } | undefined;
      if (!row) throw new ServiceError('not_found', 'History entry not found', 404);
      return {
        entry_id: entry,
        text: row.payload.slice(offset, offset + 8192),
        next_offset: offset + 8192 < row.payload.length ? offset + 8192 : null,
      };
    }
    // An append-order page includes pre-compaction entries and abandoned branches.
    const rows = this.store.db
      .prepare(
        'SELECT entry_id FROM pi_entries WHERE session_id=? ORDER BY rowid LIMIT 33 OFFSET ?',
      )
      .all(id, offset);
    return { entries: rows.slice(0, 32), next_offset: rows.length > 32 ? offset + 32 : null };
  }
  compaction(id: string): Compaction {
    const row = this.store.db.prepare('SELECT * FROM compactions WHERE id=?').get(id) as unknown as
      Compaction | undefined;
    if (!row) throw new ServiceError('not_found', 'Compaction not found', 404);
    return row;
  }
  begin(
    id: string,
    epoch: number,
    request: string,
    expected: number,
    authorize: () => void,
  ): Compaction {
    const saved = this.store.request(
      'local-operator',
      request,
      { kind: 'compact', id, expected },
      () => {
        authorize();
        if (this.state(id).version !== expected)
          throw new ServiceError('task_version_conflict', 'Task version changed');
        const operation = randomUUID();
        this.store.db
          .prepare("INSERT INTO compactions VALUES (?,?,?,?,'running',NULL,NULL)")
          .run(operation, id, epoch, expected);
        this.store.event(
          id,
          'compaction.started',
          { compaction_id: operation, task_version: expected },
          request,
        );
        return { id: operation };
      },
    );
    return this.compaction(saved.id);
  }
  settle(id: string, state: Compaction['state'], error: string | null): void {
    this.store.transaction(() => {
      const work = this.compaction(id);
      if (work.state !== 'running') return;
      this.store.db
        .prepare('UPDATE compactions SET state=?,error=? WHERE id=?')
        .run(state, error, id);
      this.store.event(work.session_id, 'compaction.' + state, { compaction_id: id, error });
    });
  }
  /** Called inside the transcript transaction, including startup reconciliation. */
  reconcile(id: string): void {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM compactions WHERE session_id=? AND state IN ('running','interrupted') ORDER BY rowid",
      )
      .all(id) as unknown as Compaction[];
    for (const work of rows) {
      const entries = this.store.db
        .prepare(
          "SELECT entry_id,payload FROM pi_entries WHERE session_id=? AND json_extract(payload,'$.type')='compaction' AND json_extract(payload,'$.details.salaam_compaction')=?",
        )
        .all(id, work.id) as { entry_id: string; payload: string }[];
      if (entries.length > 1) throw new Error('Duplicate Pi compaction receipt');
      const entry = entries[0];
      if (!entry) continue;
      const details = object(JSON.parse(entry.payload).details);
      if (details.task_version !== work.task_version)
        throw new Error('Compaction task version mismatch');
      this.store.db
        .prepare("UPDATE compactions SET state='completed',cursor=?,error=NULL WHERE id=?")
        .run(entry.entry_id, work.id);
      this.store.db
        .prepare(
          'INSERT INTO task_heads(session_id,version,compaction_cursor) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET compaction_cursor=excluded.compaction_cursor',
        )
        .run(id, this.state(id).version, entry.entry_id);
      this.store.event(id, 'compaction.completed', {
        compaction_id: work.id,
        cursor: entry.entry_id,
        task_version: work.task_version,
      });
    }
  }
  recover(): void {
    for (const row of this.store.db
      .prepare("SELECT id FROM compactions WHERE state='running'")
      .all() as { id: string }[])
      this.settle(
        row.id,
        'interrupted',
        'Service restart; reconcile persisted Pi entries before retrying',
      );
  }
}
