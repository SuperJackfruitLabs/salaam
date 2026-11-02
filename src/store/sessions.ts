// Sessions: creating one, forking a local one, and what its creation recorded about it.
import { randomUUID } from 'node:crypto';
import {
  canonical,
  ServiceError,
  type Controller,
  type ProviderRoute,
  type Session,
} from '../core/index.js';
import type { Journal } from './journal.js';

export interface SessionStore extends Journal {
  toolExecution?: { mode: string; user: string; uid: number };
  readonly execution: { assert(session: string): void };
  authorizeControl(id: string, controller: Controller): void;
  hasUnknown(id: string): boolean;
  providerRoute(id: string): ProviderRoute | null;
  localCoding(id: string): boolean;
  localWorkspace(id: string): boolean;
  localOutputCap(id: string): boolean | undefined;
}

export function create(
  store: SessionStore,
  cwd: string,
  requestId: string,
  coding = false,
  local?: {
    workspace: true;
    route: ProviderRoute;
    requestedRoute?: ProviderRoute;
    outputCap?: boolean;
    coding?: boolean;
  },
): Session {
  return store.request(
    'local-operator',
    requestId,
    {
      kind: 'create',
      cwd,
      ...(coding ? { coding: true } : {}),
      ...(local
        ? {
            local: {
              workspace: true,
              route: local.requestedRoute ?? local.route,
              ...(local.coding ? { coding: true } : {}),
            },
          }
        : {}),
    },
    () => {
      const id = randomUUID();
      store.db
        .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
        .run(id, cwd, id);
      store.event(
        id,
        'session.created',
        {
          cwd,
          ...(local
            ? {
                local_workspace: true,
                local_coding: local.coding === true,
                output_cap: local.outputCap ?? true,
                ...(store.toolExecution ? { tool_execution: store.toolExecution } : {}),
              }
            : {}),
        },
        requestId,
      );
      if (local) {
        store.db.prepare('INSERT INTO session_routes VALUES (?,?)').run(id, canonical(local.route));
        store.event(id, 'provider.bound', { route: local.route });
      }
      return store.session(id);
    },
  );
}
export function localCoding(store: Journal, id: string): boolean {
  return !!store.db
    .prepare(
      "SELECT 1 FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_coding')=1",
    )
    .get(id);
}
export function localWorkspace(store: Journal, id: string): boolean {
  return !!store.db
    .prepare(
      "SELECT 1 FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_workspace')=1",
    )
    .get(id);
}
export function localOutputCap(store: Journal, id: string): boolean | undefined {
  const row = store.db
    .prepare(
      "SELECT json_extract(payload,'$.output_cap') AS cap FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_workspace')=1",
    )
    .get(id);
  return row ? row.cap === 1 : undefined;
}
export function forkLocal(
  store: SessionStore,
  id: string,
  request: string,
  expected: number,
  controller: Controller,
  clone: (source: Session, target: string) => string,
  /** A rewind forks from an earlier conversation leaf. */
  at?: { leaf: string | null },
): Session {
  const input = { kind: 'fork', id, expected, ...(at ? { leaf: at.leaf } : {}) };
  return store.request('local-operator', request, input, () => {
    store.authorizeControl(id, controller);
    const source = store.session(id);
    if (source.revision !== expected)
      throw new ServiceError('revision_conflict', 'Session changed before fork');
    if (!store.localWorkspace(id) || !source.pi_session_file || store.hasUnknown(id))
      throw new ServiceError(
        'fork_unavailable',
        'Fork requires an initialized local session without uncertain effects',
      );
    if (
      store.db
        .prepare(
          "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
        )
        .get(id)
    )
      throw new ServiceError('session_busy', 'Wait for queued and active work before forking');
    store.execution.assert(id);
    const target = randomUUID();
    const file = clone(source, target);
    store.db
      .prepare(
        'INSERT INTO sessions(id,cwd,pi_session_id,pi_session_file,pi_cursor,pi_leaf) VALUES(?,?,?,?,?,?)',
      )
      .run(target, source.cwd, target, file, source.pi_cursor, at ? at.leaf : source.pi_leaf);
    store.event(
      target,
      'session.created',
      {
        cwd: source.cwd,
        local_workspace: true,
        local_coding: store.localCoding(id),
        output_cap: store.localOutputCap(id) ?? true,
        ...(store.toolExecution ? { tool_execution: store.toolExecution } : {}),
        forked_from: id,
      },
      request,
    );
    const route = store.providerRoute(id)!;
    store.db.prepare('INSERT INTO session_routes VALUES (?,?)').run(target, canonical(route));
    store.event(target, 'provider.bound', { route });
    store.db
      .prepare(
        'INSERT INTO pi_entries SELECT ?,entry_id,payload FROM pi_entries WHERE session_id=?',
      )
      .run(target, id);
    store.event(
      target,
      'session.forked',
      {
        parent: id,
        parent_revision: expected,
        leaf: at ? at.leaf : source.pi_leaf,
        cursor: source.pi_cursor,
        ...(at ? { rewound: true } : {}),
      },
      request,
    );
    return store.session(target);
  });
}
