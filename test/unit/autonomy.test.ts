import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import { configurePermissions, permissionPolicy, validatePermissions } from '../../src/autonomy.js';
import { OFFLINE_ROUTE } from '../../src/provider-route.js';
import { localHash } from '../../src/local-edits.js';
function setup() {
  const root = realpathSync(mkdtempSync('/tmp/sal-autonomy-')),
    store = new Store(':memory:');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'before');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const lease = store.control(session.id, 'lease', 'operator', 'acquire', 0),
    actor = { client_id: 'operator', token: lease.token };
  const submission = store.accept(session.id, 'submit', store.session(session.id).revision, 'edit');
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
    local = new LocalCoding(store, managed, active);
  const configure = (mode: 'inspect' | 'review' | 'scoped-edit', paths: string[] = []) => {
    const rev = permissionPolicy(store, session.id).revision;
    return configurePermissions(store, session.id, 'policy-' + rev, rev, { mode, paths }, actor);
  };
  const edit = (tool = 'edit', path = 'src/a.txt') =>
    local.prepare(session.id, epoch, submission.attempt_id, tool, {
      action: 'edit',
      edits: [
        { path, sha256: path === 'src/a.txt' ? localHash('before') : null, content: 'after' },
      ],
    });
  return {
    root,
    store,
    session,
    actor,
    epoch,
    submission,
    managed,
    local,
    configure,
    edit,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('scoped approvals consume the existing exact permission and do not auto-approve commands or sibling paths', async () => {
  const f = setup();
  try {
    expect(f.edit().approval.state).toBe('pending');
    f.configure('scoped-edit', ['src/']);
    const work = f.edit('automatic');
    expect(work.approval).toMatchObject({
      state: 'decided',
      decision: 'approve',
      decided_by: 'scoped-policy',
    });
    expect(f.local.run(work.call.id).call.state).toBe('succeeded');
    expect(readFileSync(join(f.root, 'src/a.txt'), 'utf8')).toBe('after');
    expect(f.local.run(work.call.id).call.state).toBe('succeeded');
    expect(f.edit('outside', 'src-other.txt').approval.state).toBe('pending');
    const command = f.local.prepare(f.session.id, f.epoch, f.submission.attempt_id, 'shell', {
      action: 'command',
      command: 'echo unsafe',
    });
    expect(command.approval.state).toBe('pending');
    expect(
      f.store.events(f.session.id, 0).filter((e) => e.kind === 'permission.auto-approved'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
for (const scenario of [
  'policy',
  'inspect',
  'hash',
  'epoch',
  'revocation',
  'expiry',
  'budget',
  'native-owner',
] as const)
  test(`scoped approval cannot bypass ${scenario} at consumption`, async () => {
    const f = setup();
    try {
      f.configure('scoped-edit', ['src/']);
      const work = f.edit();
      if (scenario === 'policy') f.configure('review');
      if (scenario === 'inspect') f.configure('inspect');
      if (scenario === 'hash') writeFileSync(join(f.root, 'src/a.txt'), 'human');
      if (scenario === 'epoch')
        f.store.db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=?').run(f.session.id);
      if (scenario === 'revocation')
        f.store.execution.revoke(
          f.session.id,
          'revoke',
          f.store.session(f.session.id).revision,
          'test',
          f.actor,
          () => {},
        );
      if (scenario === 'expiry')
        f.store.db.prepare('UPDATE approvals SET expires_at=0 WHERE id=?').run(work.approval.id);
      if (scenario === 'budget')
        f.store.taskGrantCheck = () => {
          throw Error('budget exhausted');
        };
      if (scenario === 'native-owner')
        f.store.nativeResourceCheck = () => {
          throw Error('owner uncertain');
        };
      try {
        f.local.run(work.call.id);
      } catch {
        /* Required-control rejection is also non-success. */
      }
      expect(f.local.get(work.call.id).state).not.toBe('succeeded');
      expect(readFileSync(join(f.root, 'src/a.txt'), 'utf8')).toBe(
        scenario === 'hash' ? 'human' : 'before',
      );
    } finally {
      await f.close();
    }
  });
test('policy cannot manufacture capability, accept foreign control, or authorize symlinks/private paths', async () => {
  const f = setup();
  try {
    expect(() =>
      configurePermissions(
        f.store,
        f.session.id,
        'foreign',
        0,
        { mode: 'scoped-edit', paths: ['src/'] },
        { client_id: 'other', token: 'other' },
      ),
    ).toThrow();
    const inspection = f.store.create(f.root, 'inspection', false, {
      workspace: true,
      route: OFFLINE_ROUTE,
    });
    const lease = f.store.control(inspection.id, 'reader', 'reader', 'acquire', 0);
    expect(() =>
      configurePermissions(
        f.store,
        inspection.id,
        'upgrade',
        0,
        { mode: 'review', paths: [] },
        { client_id: 'reader', token: lease.token },
      ),
    ).toThrow('coding session');
    f.configure('scoped-edit', ['src/']);
    symlinkSync('/etc/passwd', join(f.root, 'src/outside'));
    expect(() => f.edit('link', 'src/outside')).toThrow();
    expect(() => f.edit('secret', '.env')).toThrow();
    for (const paths of [['../'], ['/tmp/'], ['src/../'], ['src/*'], ['.git/'], ['credentials/']])
      expect(() => validatePermissions({ mode: 'scoped-edit', paths })).toThrow();
    expect(() =>
      validatePermissions({ mode: 'scoped-edit', paths: ['src/'], commands: ['*'] }),
    ).toThrow();
  } finally {
    await f.close();
  }
});
test('permission revisions deduplicate before fresh control checks without changing progression', async () => {
  const f = setup();
  try {
    const before = f.store.db.prepare('SELECT * FROM durable_tasks').all();
    const input = { mode: 'scoped-edit', paths: ['src/'] };
    const saved = configurePermissions(f.store, f.session.id, 'fixed', 0, input, f.actor);
    expect(
      configurePermissions(f.store, f.session.id, 'fixed', 0, input, {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(saved);
    expect(() =>
      configurePermissions(f.store, f.session.id, 'stale', 0, { mode: 'review' }, f.actor),
    ).toThrow('changed');
    expect(f.store.db.prepare('SELECT * FROM durable_tasks').all()).toEqual(before);
    expect(
      f.store
        .events(f.session.id, 0)
        .some((e) => e.kind.startsWith('task.') || e.kind.startsWith('job.')),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('inspect mode denies even exact manual approval and local undo', async () => {
  const { applyUndo } = await import('../../src/local-undo.js');
  const f = setup();
  try {
    const pending = f.edit();
    f.configure('inspect');
    expect(() =>
      f.managed.decide(
        pending.approval.id,
        'manual',
        pending.approval.revision,
        pending.operation.operation_digest,
        'approve',
      ),
    ).toThrow('does not permit');
    expect(() => applyUndo(f.store, f.session.id, 'undo', 'review', f.actor, () => {})).toThrow(
      'does not permit',
    );
    expect(readFileSync(join(f.root, 'src/a.txt'), 'utf8')).toBe('before');
  } finally {
    await f.close();
  }
});
test('controller recovery does not replay an auto-approved operation with uncertain execution', async () => {
  const f = setup();
  let recovered: LocalCoding | undefined;
  try {
    f.configure('scoped-edit', ['src/']);
    const work = f.edit();
    f.store.transaction(() => {
      expect(f.managed.takePermissionInTransaction(work.operation.id)).toBe(true);
      f.store.db.prepare("UPDATE local_calls SET state='running' WHERE id=?").run(work.call.id);
    });
    await f.local.close();
    recovered = new LocalCoding(f.store, f.managed, () => {});
    expect(recovered.get(work.call.id).state).toBe('outcome_unknown');
    expect(recovered.run(work.call.id).call.state).toBe('outcome_unknown');
    expect(() =>
      recovered!.prepare(f.session.id, f.epoch, f.submission.attempt_id, 'replacement', {
        action: 'edit',
        edits: [{ path: 'src/a.txt', sha256: localHash('before'), content: 'overwrite' }],
      }),
    ).toThrow('Unresolved');
    expect(readFileSync(join(f.root, 'src/a.txt'), 'utf8')).toBe('before');
  } finally {
    await recovered?.close();
    await f.close();
  }
});

test('corrupt durable policy and control characters fail closed', async () => {
  const s = setup();
  try {
    expect(() => validatePermissions({ mode: 'scoped-edit', paths: ['src/\n'] })).toThrow();
    s.store.transaction(() =>
      s.store.event(s.session.id, 'permissions.configured', {
        revision: 1,
        root: s.root,
        mode: 'unknown',
        paths: [],
      }),
    );
    expect(() => permissionPolicy(s.store, s.session.id)).toThrow('invalid');
    expect(() => s.edit()).toThrow();
  } finally {
    await s.close();
  }
});
