import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import {
  configurePermissions,
  permissionPolicy,
  permissionDigest,
  validatePermissions,
  nextMode,
  leavingPlanNeedsConfirm,
  planNote,
  autoApprovesEdits,
  type PermissionMode,
} from '../../src/autonomy.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { localHash } from '../../src/local-edits.js';

// Phase 2b (operator-approved plan, 2026-10-31): one-key modes for interactive coding sessions —
// plan, accept edits, auto — and full access as an explicit per-session sandbox level.
function setup(opts: { allowFullAccess?: boolean; workspace?: boolean } = {}) {
  const root = realpathSync(mkdtempSync('/tmp/sal-modes-')),
    store = new Store(':memory:');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'before');
  const session =
    opts.workspace === false
      ? store.create(root, 'create', false)
      : store.create(root, 'create', false, {
          workspace: true,
          coding: true,
          route: OFFLINE_ROUTE,
        });
  const lease = store.control(session.id, 'lease', 'operator', 'acquire', 0),
    actor = { client_id: 'operator', token: lease.token };
  const submission = store.accept(session.id, 'submit', store.session(session.id).revision, 'go');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const active = (id: string, e: number, attempt: string) => {
    store.execution.assert(id);
    store.assertEpoch(id, e);
    if (store.cancelled(attempt) || store.attempt(attempt).state !== 'running')
      throw Error('inactive');
  };
  const managed = new ManagedWork(store, {
      assertActive: active,
      reply: () => {},
      failed: () => {},
    }),
    local = new LocalCoding(store, managed, active, undefined, {
      kind: 'bwrap',
      level: 'workspace-write',
      bwrap: { path: '/usr/bin/bwrap', version: 'bubblewrap 0.11.1' },
    });
  let n = 0;
  const configure = (mode: PermissionMode, access?: 'full') => {
    const rev = permissionPolicy(store, session.id).revision;
    return configurePermissions(
      store,
      session.id,
      'policy-' + n++,
      rev,
      { mode, paths: [], ...(access ? { access } : {}) },
      actor,
      { allowFullAccess: opts.allowFullAccess ?? true },
    );
  };
  const edit = (path = 'src/a.txt') =>
    local.prepare(session.id, epoch, submission.attempt_id, 'edit-' + n++, {
      action: 'edit',
      edits: [
        { path, sha256: path === 'src/a.txt' ? localHash('before') : null, content: 'after' },
      ],
    });
  const command = () =>
    local.prepare(session.id, epoch, submission.attempt_id, 'cmd-' + n++, {
      action: 'command',
      command: 'echo hi',
    });
  const args = (call: { id: string }) =>
    JSON.parse(
      String(store.db.prepare('SELECT args FROM local_calls WHERE id=?').get(call.id)!.args),
    );
  const state = (approval: { id: string }) =>
    String(store.db.prepare('SELECT state FROM approvals WHERE id=?').get(approval.id)!.state);
  return {
    root,
    store,
    session,
    actor,
    managed,
    local,
    configure,
    edit,
    command,
    state,
    args,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the new modes validate, take no paths, and full access is an explicit separate field', () => {
  for (const mode of ['plan', 'accept-edits', 'auto'] as const)
    expect(validatePermissions({ mode, paths: [] })).toEqual({ mode, paths: [] });
  expect(() => validatePermissions({ mode: 'auto', paths: ['src/'] })).toThrow();
  expect(validatePermissions({ mode: 'review', paths: [], access: 'full' })).toEqual({
    mode: 'review',
    paths: [],
    access: 'full',
  });
  expect(() => validatePermissions({ mode: 'review', paths: [], access: 'root' })).toThrow();
});

test('a sandboxed policy keeps its digest: existing auto-approval bindings stay valid', async () => {
  const f = setup();
  try {
    const saved = f.configure('review');
    expect('access' in saved).toBe(false);
    expect(permissionDigest(permissionPolicy(f.store, f.session.id))).toBe(permissionDigest(saved));
  } finally {
    await f.close();
  }
});

test('plan mode denies mutations, even an exact manual approval', async () => {
  const f = setup();
  try {
    const pending = f.edit();
    f.configure('plan');
    expect(() =>
      f.managed.decide(
        pending.approval.id,
        'manual',
        pending.approval.revision,
        pending.operation.operation_digest,
        'approve',
      ),
    ).toThrow('does not permit');
  } finally {
    await f.close();
  }
});

test('accept-edits approves project edits by itself, but commands and private paths still ask', async () => {
  const f = setup();
  try {
    f.configure('accept-edits');
    expect(f.state(f.edit().approval)).toBe('decided');
    expect(f.state(f.command().approval)).toBe('pending');
    // Private and hidden paths are refused before a mode is consulted; the mode rule refuses them too.
    const policy = permissionPolicy(f.store, f.session.id);
    expect(autoApprovesEdits(policy, ['src/a.txt'])).toBe(true);
    for (const path of ['.git/config', 'node_modules/x.js', '../out.txt', '/etc/passwd', ''])
      expect(autoApprovesEdits(policy, [path])).toBe(false);
  } finally {
    await f.close();
  }
});

test('auto approves edits and sandboxed commands, and records the policy it used', async () => {
  const f = setup();
  try {
    const policy = f.configure('auto');
    expect(f.state(f.edit().approval)).toBe('decided');
    const cmd = f.command();
    expect(f.state(cmd.approval)).toBe('decided');
    const receipt = f.store.db
      .prepare(
        "SELECT payload FROM events WHERE kind='permission.auto-approved' AND json_extract(payload,'$.operation_id')=?",
      )
      .get(cmd.operation.id) as { payload: string };
    expect(JSON.parse(receipt.payload).policy_digest).toBe(permissionDigest(policy));
  } finally {
    await f.close();
  }
});

test('full access binds an unsandboxed level into the command, and auto still does not approve it', async () => {
  const f = setup();
  try {
    f.configure('auto', 'full');
    const cmd = f.command();
    expect(f.args(cmd.call).sandbox.level).toBe('full-access');
    expect(String(cmd.operation.value)).toContain('unsandboxed');
    // Full access is never approved by mode alone: each unsandboxed command asks.
    expect(f.state(cmd.approval)).toBe('pending');
    f.configure('auto');
    expect(f.args(f.command().call).sandbox.level).toBe('workspace-write');
  } finally {
    await f.close();
  }
});

test('full access is refused when the operator does not allow it, and for non-local sessions', async () => {
  const f = setup({ allowFullAccess: false });
  try {
    expect(() => f.configure('review', 'full')).toThrow('operator');
  } finally {
    await f.close();
  }
  const g = setup({ workspace: false });
  try {
    expect(() => g.configure('review', 'full')).toThrow();
  } finally {
    await g.close();
  }
});

test('every mode change is a recorded session event', async () => {
  const f = setup();
  try {
    f.configure('plan');
    f.configure('accept-edits');
    const modes = f.store.db
      .prepare(
        "SELECT json_extract(payload,'$.mode') AS m FROM events WHERE kind='permissions.configured' ORDER BY seq",
      )
      .all()
      .map((r) => (r as { m: string }).m);
    expect(modes).toEqual(['plan', 'accept-edits']);
  } finally {
    await f.close();
  }
});

test('Shift+Tab cycles review, accept edits, auto, plan; leaving plan needs a confirm', () => {
  expect(nextMode('review')).toBe('accept-edits');
  expect(nextMode('accept-edits')).toBe('auto');
  expect(nextMode('auto')).toBe('plan');
  expect(nextMode('plan')).toBe('review');
  expect(nextMode('scoped-edit')).toBe('review');
  expect(nextMode('inspect')).toBe('review');
  expect(leavingPlanNeedsConfirm('plan', 'review')).toBe(true);
  expect(leavingPlanNeedsConfirm('review', 'accept-edits')).toBe(false);
});

test('plan mode tells the model it is planning, and only in plan mode', () => {
  expect(planNote('plan', 'fix it')).toMatch(/^\[Plan mode[^\]]*\]/);
  expect(planNote('plan', 'fix it').endsWith('fix it')).toBe(true);
  expect(planNote('review', 'fix it')).toBe('fix it');
});
