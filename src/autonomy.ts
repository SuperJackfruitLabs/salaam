import { realpathSync } from 'node:fs';
import type { Store } from './store.js';
import { canonical, digest, object, ServiceError, type Controller } from './protocol.js';
export type PermissionMode =
  | 'inspect'
  | 'review'
  | 'scoped-edit'
  // Phase 2b (operator rulings 2026-10-31): the one-key modes of an interactive session.
  | 'accept-edits'
  | 'auto';
const MODES: readonly PermissionMode[] = [
  'inspect',
  'review',
  'scoped-edit',
  'accept-edits',
  'auto',
];
/** Modes in which the service performs no local mutation, however it was approved. */
const READ_ONLY_MODES: readonly PermissionMode[] = ['inspect'];
/** Shift+Tab: review → accept edits → auto → review. Full access and YOLO are never in the cycle. */
const CYCLE: readonly PermissionMode[] = ['review', 'accept-edits', 'auto'];
export function nextMode(mode: PermissionMode): PermissionMode {
  const at = CYCLE.indexOf(mode);
  return at < 0 ? 'review' : CYCLE[(at + 1) % CYCLE.length]!;
}
/** Sandbox levels a session can choose beyond its mode: full access (no OS sandbox; dangerous
 * commands still ask) and YOLO (no OS sandbox and no approvals at all). */
export type SessionAccess = 'full' | 'yolo';
export interface PermissionPolicy {
  revision: number;
  mode: PermissionMode;
  paths: string[];
  root: string;
  /** Present only when the person chose full access or YOLO: later commands run without the OS
   * sandbox. Absent for sandboxed policies, so their digests (and receipts bound to them) are unchanged. */
  access?: SessionAccess;
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
      Object.keys(saved).some(
        (key) => !['revision', 'root', 'mode', 'paths', 'access'].includes(key),
      )
    )
      throw new Error('Invalid saved policy');
    const policy = validatePermissions({
      // Plan mode was removed (operator ruling 2026-10-31): a session saved in it reads as review.
      mode: saved.mode === 'plan' ? 'review' : saved.mode,
      paths: saved.paths,
      ...(saved.access === undefined ? {} : { access: saved.access }),
    });
    return { ...policy, revision: Number(saved.revision), root };
  } catch {
    throw new ServiceError(
      'invalid_permissions',
      'Saved permission policy is invalid; mutations are blocked',
    );
  }
}
export function validatePermissions(value: unknown): {
  mode: PermissionMode;
  paths: string[];
  access?: SessionAccess;
} {
  const input = object(value);
  if (
    Object.keys(input).some((k) => !['mode', 'paths', 'access'].includes(k)) ||
    !(MODES as readonly string[]).includes(String(input.mode)) ||
    (input.access !== undefined && input.access !== 'full' && input.access !== 'yolo')
  )
    throw new ServiceError(
      'invalid_permissions',
      'Choose inspect, review, scoped-edit, accept-edits or auto, and access "full", "yolo" or none; unknown policy fields are rejected',
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
  return {
    mode: input.mode as PermissionMode,
    paths: [...paths].sort(),
    ...(input.access === 'full' || input.access === 'yolo'
      ? { access: input.access as SessionAccess }
      : {}),
  };
}
export function configurePermissions(
  store: Store,
  session: string,
  request: string,
  expected: number,
  value: unknown,
  actor: Controller,
  /** The operator's settings: may an interactive session choose full access or YOLO, and is this a
   * desk session (YOLO is never for host-managed, board or child work)? */
  opts: { allowFullAccess?: boolean; allowYolo?: boolean; deskSession?: boolean } = {},
) {
  const policy = validatePermissions(value);
  if (policy.access === 'full' && opts.allowFullAccess === false)
    throw new ServiceError(
      'full_access_denied',
      'The operator does not allow full access on this host; commands stay in the OS sandbox',
    );
  if (policy.access === 'yolo' && (opts.allowYolo === false || opts.deskSession !== true))
    throw new ServiceError(
      'yolo_denied',
      opts.deskSession !== true
        ? 'YOLO is only for your own desk sessions, never host-managed, board or child work'
        : 'The operator does not allow YOLO on this host; commands keep their approvals',
    );
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
      if (!READ_ONLY_MODES.includes(policy.mode) && !store.localCoding(session))
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
  if (policy.root !== root || READ_ONLY_MODES.includes(policy.mode))
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
/** A project-relative path the session's modes may edit without review: not private or hidden. */
function ordinaryProjectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '..' &&
          !part.startsWith('.') &&
          !['credentials', 'secrets', 'node_modules', 'vendor'].includes(part),
      )
  );
}
/** Whether this policy approves these edits by itself: scoped edits, accept-edits, auto and full
 * access approve ordinary project edits; YOLO approves every edit. */
export function autoApprovesEdits(policy: PermissionPolicy, paths: string[]): boolean {
  if (policy.access === 'yolo') return paths.length > 0;
  if (policy.mode === 'scoped-edit' && !policy.access) return matchesEditScope(policy, paths);
  return (
    (policy.mode === 'accept-edits' || policy.mode === 'auto' || policy.access === 'full') &&
    paths.length > 0 &&
    paths.every(ordinaryProjectPath)
  );
}
/** Whether this policy approves a command by itself: auto inside the OS sandbox; full access unless
 * the danger check calls the command dangerous; YOLO always. */
export function autoApprovesCommands(
  policy: PermissionPolicy,
  sandboxed: boolean,
  dangerous: boolean,
  /** Pushes or opens a pull request: asks in every mode but YOLO (operator ruling 2026-10-31). */
  publishes = false,
): boolean {
  if (policy.access === 'yolo') return true;
  if (publishes) return false;
  if (policy.access === 'full') return !dangerous;
  return policy.mode === 'auto' && sandboxed;
}
export const permissionDigest = (policy: PermissionPolicy) => digest(JSON.parse(canonical(policy)));
