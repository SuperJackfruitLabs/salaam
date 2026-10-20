import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import { localHash, prepareLocalEdits, applyLocalEdits } from '../../src/local-edits.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { until } from '../helpers.js';
function setup() {
  const root = realpathSync(mkdtempSync('/tmp/sal-local-code-'));
  const store = new Store(':memory:');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const submission = store.accept(session.id, 'submit', session.revision, 'code');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  let valid = true;
  const active = () => {
    if (!valid) throw Error('Attempt cancelled');
  };
  const managed = new ManagedWork(store, {
    assertActive: active,
    reply: () => {},
    failed: () => {},
  });
  const local = new LocalCoding(store, managed, active);
  const prepare = (id: string, args: Record<string, unknown>) =>
    local.prepare(session.id, epoch, submission.attempt_id, id, args);
  const approve = (created: ReturnType<typeof prepare>) =>
    managed.decide(
      created.approval.id,
      'approve-' + created.call.id,
      created.approval.revision,
      created.operation.operation_digest,
      'approve',
    );
  return {
    root,
    store,
    session,
    epoch,
    submission,
    local,
    managed,
    prepare,
    approve,
    cancel: () => {
      valid = false;
    },
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('reviewed edits require exact approval, apply actual files once, and preserve concurrent human changes', async () => {
  const f = setup();
  try {
    writeFileSync(join(f.root, 'a.txt'), 'before');
    const input = {
      action: 'edit',
      edits: [
        { path: 'a.txt', sha256: localHash('before'), content: 'after' },
        { path: 'b.txt', sha256: null, content: 'new' },
      ],
    };
    const c = f.prepare('edit', input);
    expect(f.local.run(c.call.id).call.state).toBe('prepared');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('before');
    f.approve(c);
    expect(f.local.run(c.call.id).call.state).toBe('succeeded');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('after');
    expect(f.prepare('edit', input).call.id).toBe(c.call.id);
    expect(f.local.run(c.call.id).call.state).toBe('succeeded');
    const stale = f.prepare('stale', {
      action: 'edit',
      edits: [{ path: 'a.txt', sha256: localHash('after'), content: 'overwrite' }],
    });
    f.approve(stale);
    writeFileSync(join(f.root, 'a.txt'), 'human edit');
    expect(f.local.run(stale.call.id).call.state).toBe('failed');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('human edit');
  } finally {
    await f.close();
  }
});
test('all files are checked before any apply and new files never overwrite a concurrent create', () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-edit-'));
  try {
    writeFileSync(join(root, 'a'), 'old');
    const edits = prepareLocalEdits(root, [
      { path: 'a', sha256: localHash('old'), content: 'new' },
      { path: 'b', sha256: null, content: 'new' },
    ]);
    writeFileSync(join(root, 'b'), 'human');
    expect(() => applyLocalEdits(root, edits, () => {})).toThrow();
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('old');
    symlinkSync('/etc/passwd', join(root, 'outside'));
    for (const path of ['../escape', '.env', 'outside'])
      expect(() => prepareLocalEdits(root, [{ path, sha256: null, content: 'bad' }])).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('native commands have bounded output, truthful failure and timeout, and never replay', async () => {
  const f = setup();
  try {
    const c = f.prepare('cmd', {
      action: 'command',
      command: 'printf once >> count; printf ok; exit 7',
    });
    f.approve(c);
    f.local.run(c.call.id);
    const result = await until(
      () => f.local.view(c.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(result.call.state).toBe('failed');
    expect(result.result).toMatchObject({ exit_code: 7, output: 'ok' });
    f.local.run(c.call.id);
    expect(readFileSync(join(f.root, 'count'), 'utf8')).toBe('once');
    const timeout = f.prepare('timeout', {
      action: 'command',
      command: 'sleep 20',
      timeout_ms: 100,
    });
    f.approve(timeout);
    f.local.run(timeout.call.id);
    expect(
      (
        await until(
          () => f.local.view(timeout.call.id),
          (v) => v.call.state !== 'running',
        )
      ).call.state,
    ).toBe('timed_out');
    const overflow = f.prepare('overflow', { action: 'command', command: 'yes output' });
    f.approve(overflow);
    f.local.run(overflow.call.id);
    const limited = await until(
      () => f.local.view(overflow.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(limited.call.state).toBe('output_limited');
    expect(Buffer.byteLength(limited.result.output)).toBeLessThanOrEqual(65536);
    const cancelled = f.prepare('cancel', { action: 'command', command: 'sleep 20' });
    f.approve(cancelled);
    f.local.run(cancelled.call.id);
    f.cancel();
    expect(
      (
        await until(
          () => f.local.view(cancelled.call.id),
          (v) => v.call.state !== 'running',
        )
      ).call.state,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
}, 15000);
test('lost execution is fenced durably rather than replayed after restart', async () => {
  const f = setup();
  let recovered: LocalCoding | undefined;
  try {
    const c = f.prepare('lost', { action: 'command', command: 'printf duplicate >> count' });
    f.approve(c);
    f.store.transaction(() => {
      f.managed.takePermissionInTransaction(c.operation.id);
      f.store.db.prepare("UPDATE local_calls SET state='running' WHERE id=?").run(c.call.id);
    });
    await f.local.close();
    recovered = new LocalCoding(f.store, f.managed, () => {});
    expect(recovered.run(c.call.id).call.state).toBe('outcome_unknown');
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
    expect(() =>
      recovered!.prepare(f.session.id, f.epoch, f.submission.attempt_id, 'new', {
        action: 'command',
        command: 'true',
      }),
    ).toThrow();
  } finally {
    await recovered?.close();
    await f.close();
  }
});

test('lost undo completion fences the root and reconciles only after original files are restored', async () => {
  const { reviewUndo, assertUndoSettled, reconcileUndo } = await import('../../src/local-undo.js');
  const f = setup();
  try {
    writeFileSync(join(f.root, 'a.txt'), 'before');
    const edit = f.prepare('undo-recovery', {
      action: 'edit',
      edits: [{ path: 'a.txt', sha256: localHash('before'), content: 'after' }],
    });
    f.approve(edit);
    f.local.run(edit.call.id);
    const review = reviewUndo(f.store, f.session.id);
    f.store.transaction(() => f.store.event(f.session.id, 'local.undo.started', review, 'lost'));
    expect(() => assertUndoSettled(f.store, f.root)).toThrow('unconfirmed');
    expect(() => f.prepare('blocked', { action: 'command', command: 'true' })).toThrow(
      'unconfirmed',
    );
    const lease = f.store.control(f.session.id, 'take', 'operator', 'acquire', 0);
    const actor = { client_id: 'operator', token: lease.token };
    expect(() => reconcileUndo(f.store, f.session.id, actor, () => {})).toThrow('File changed');
    writeFileSync(join(f.root, 'a.txt'), 'before');
    expect(reconcileUndo(f.store, f.session.id, actor, () => {})).toMatchObject({
      state: 'completed',
      reconciled: true,
    });
    expect(() => assertUndoSettled(f.store, f.root)).not.toThrow();
  } finally {
    await f.close();
  }
});
