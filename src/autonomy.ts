import { realpathSync } from 'node:fs';
import type { Store } from './store.js';
import { canonical, digest, object, ServiceError, type Controller } from './protocol.js';
export type PermissionMode = 'inspect' | 'review' | 'scoped-edit';
export interface PermissionPolicy {
  revision: number;
  mode: PermissionMode;
  paths: string[];
  root: string;
}
export function permissionPolicy(store: Store, session: string): PermissionPolicy {
  const root = store.session(session).cwd;
  const row = store.db
    .prepare(
      "SELECT payload FROM events WHERE session_id=? AND kind='permissions.configured' ORDER BY seq DESC LIMIT 1",
    )
    .get(session) as { payload: string } | undefined;
  if (!row)
    return {
      revision: 0,
      mode: store.localCoding(session) ? 'review' : 'inspect',
      paths: [],
      root,
    };
  try {
    const saved = object(JSON.parse(row.payload));
    if (
      !Number.isSafeInteger(saved.revision) ||
      Number(saved.revision) < 1 ||
      saved.root !== root ||
      Object.keys(saved).some((key) => !['revision', 'root', 'mode', 'paths'].includes(key))
    )
      throw new Error('Invalid saved policy');
    const policy = validatePermissions({ mode: saved.mode, paths: saved.paths });
    return { ...policy, revision: Number(saved.revision), root };
  } catch {
    throw new ServiceError(
      'invalid_permissions',
      'Saved permission policy is invalid; mutations are blocked',
    );
  }
}
export function validatePermissions(value: unknown): { mode: PermissionMode; paths: string[] } {
  const input = object(value);
  if (
    Object.keys(input).some((k) => !['mode', 'paths'].includes(k)) ||
    !['inspect', 'review', 'scoped-edit'].includes(String(input.mode))
  )
    throw new ServiceError(
      'invalid_permissions',
      'Choose inspect, review or scoped-edit; unknown policy fields are rejected',
    );
  const paths = input.paths ?? [];
  if (
    !Array.isArray(paths) ||
    paths.length > 32 ||
    paths.some(
      (p) =>
        typeof p !== 'string' ||
        p.length > 512 ||
        /[\x00-\x1f\x7f]/.test(p) ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_./ -]*\/?$/.test(p) ||
        p
          .split('/')
          .some(
            (part, i, all) =>
              (!part && i !== all.length - 1) ||
              part === '..' ||
              part.startsWith('.') ||
              ['credentials', 'secrets', 'node_modules', 'vendor'].includes(part),
          ),
    ) ||
    new Set(paths).size !== paths.length
  )
    throw new ServiceError(
      'invalid_permissions',
      'Use up to 32 distinct project-relative files or directories ending in /; no wildcards, traversal or private paths',
    );
  if ((input.mode === 'scoped-edit') !== paths.length > 0)
    throw new ServiceError(
      'invalid_permissions',
      'Only scoped-edit takes paths, and requires at least one',
    );
  return { mode: input.mode as PermissionMode, paths: [...paths].sort() };
}
export function configurePermissions(
  store: Store,
  session: string,
  request: string,
  expected: number,
  value: unknown,
  actor: Controller,
) {
  const policy = validatePermissions(value);
  return store.request(
    'local-operator',
    request,
    { kind: 'configure-permissions', session, expected, policy },
    () => {
      store.authorizeControl(session, actor);
      store.execution.assert(session);
      if (!store.localWorkspace(session))
        throw new ServiceError(
          'permissions_unavailable',
          'This policy applies only to local workspace sessions, not managed stations or child workers',
        );
      if (policy.mode !== 'inspect' && !store.localCoding(session))
        throw new ServiceError(
          'local_denied',
          'Create a coding session first; policy cannot grant missing coding capability',
        );
      const current = permissionPolicy(store, session);
      if (current.revision !== expected)
        throw new ServiceError('revision_conflict', 'Permission policy changed; review it again');
      const root = store.session(session).cwd;
      if (realpathSync(root) !== root)
        throw new ServiceError('workspace_changed', 'Workspace root changed');
      const next = { ...policy, revision: expected + 1, root };
      // Old binaries reject schema 28 rather than silently ignoring a restrictive policy.
      if (Number(store.db.prepare('PRAGMA user_version').get()!.user_version) < 28)
        store.db.exec('PRAGMA user_version=28');
      store.event(session, 'permissions.configured', next, request);
      return next;
    },
  );
}
export function matchesEditScope(policy: PermissionPolicy, paths: string[]): boolean {
  return (
    policy.mode === 'scoped-edit' &&
    paths.length > 0 &&
    paths.every((path) =>
      policy.paths.some((scope) => (scope.endsWith('/') ? path.startsWith(scope) : path === scope)),
    )
  );
}
export function assertPermissionBinding(
  store: Store,
  session: string,
  operation: string,
  root: string,
): void {
  const policy = permissionPolicy(store, session);
  if (policy.root !== root || policy.mode === 'inspect')
    throw new ServiceError('permission_denied', 'Current policy does not permit local mutations');
  const binding = store.db
    .prepare(
      "SELECT payload FROM events WHERE session_id=? AND kind='permission.auto-approved' AND json_extract(payload,'$.operation_id')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(session, operation) as { payload: string } | undefined;
  if (binding && JSON.parse(binding.payload).policy_digest !== digest(policy))
    throw new ServiceError(
      'permission_changed',
      'Auto-approval belongs to an older policy; prepare and review a fresh operation',
    );
}
export const permissionDigest = (policy: PermissionPolicy) => digest(JSON.parse(canonical(policy)));
