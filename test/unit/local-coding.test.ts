import { test, expect, vi } from 'vitest';
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

test('fast commands are owned before release and cancellation before release cannot write', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 8; i++) {
      const call = f.prepare('fast-' + i, {
        action: 'command',
        command: 'read input && exit 9; printf x >> fast',
      });
      f.approve(call);
      f.local.run(call.call.id);
      const result = await until(
        () => f.local.view(call.call.id),
        (v) => v.call.state !== 'running',
      );
      expect(result.call.state).toBe('succeeded');
      expect(f.local.get(call.call.id).identity).toBeTruthy();
    }
    expect(readFileSync(join(f.root, 'fast'), 'utf8')).toBe('xxxxxxxx');
    const call = f.prepare('cancel-before-start', {
      action: 'command',
      command: 'printf bad >> fast',
    });
    f.approve(call);
    f.local.run(call.call.id);
    f.cancel();
    const result = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(result.call.state).toBe('cancelled');
    expect(readFileSync(join(f.root, 'fast'), 'utf8')).toBe('xxxxxxxx');
  } finally {
    await f.close();
  }
});

test('failed process ownership persistence never releases the command', async () => {
  const f = setup();
  try {
    writeFileSync(join(f.root, 'marker'), 'untouched');
    const call = f.prepare('persistence-failure', {
      action: 'command',
      command: 'printf changed > marker',
    });
    f.approve(call);
    f.local.run(call.call.id);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce(() => {
      throw Error('journal unavailable');
    });
    const result = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(result.call.state).toBe('outcome_unknown');
    expect(readFileSync(join(f.root, 'marker'), 'utf8')).toBe('untouched');
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

// Item 10: local commands run sandboxed where the host can, and say plainly when it cannot.
import type { LocalSandbox } from '../../src/local-coding.js';
function sandboxed(sandbox: LocalSandbox) {
  const f = setup();
  (f.local as unknown as { sandbox: LocalSandbox }).sandbox = sandbox;
  return f;
}
const bwrap = { path: '/usr/bin/bwrap', version: 'bubblewrap 0.11.1' };

test('a bubblewrap host binds the sandbox into the approval and runs the command inside it', async () => {
  const f = sandboxed({ kind: 'bwrap', level: 'workspace-write', bwrap });
  try {
    const created = f.prepare('c1', { action: 'command', command: 'echo hi' });
    expect(created.operation.value).toContain('bubblewrap sandbox (workspace-write)');
    expect(created.operation.value).not.toContain('unsandboxed');
    expect(
      JSON.parse(
        String(
          f.store.db.prepare('SELECT args FROM local_calls WHERE id=?').get(created.call.id)!.args,
        ),
      ),
    ).toMatchObject({
      sandbox: { kind: 'bwrap', level: 'workspace-write', bwrap: 'bubblewrap 0.11.1' },
    });
    const argv = (
      f.local as unknown as { commandArgv(root: string, script: string): string[] }
    ).commandArgv(f.root, 'echo hi');
    expect(argv[0]).toBe('/usr/bin/bwrap');
    expect(argv).toContain('--unshare-net');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  } finally {
    await f.close();
  }
});

test('the tools user still reports its own host process group, then runs bubblewrap', async () => {
  const f = sandboxed({ kind: 'bwrap', level: 'workspace-write', bwrap });
  try {
    (f.local as unknown as { tools: { mode: string; user: string; uid: number } }).tools = {
      mode: 'tools-user',
      user: 'salaam-tools',
      uid: 1234,
      prefix: ['/usr/bin/sudo', '-n', '-u', 'salaam-tools', '--'],
      warning: null,
    } as never;
    const argv = (
      f.local as unknown as { commandArgv(root: string, script: string): string[] }
    ).commandArgv(f.root, 'echo hi');
    const outer = argv.indexOf('/usr/bin/setsid');
    expect(outer).toBeGreaterThan(-1);
    const shell = argv.slice(outer).join(' ');
    // The host-side shell prints its own pid (the group leader) before exec-ing bubblewrap.
    expect(shell).toMatch(/salaam-tool-pgid:%s.*exec "\$@"/s);
    expect(argv.indexOf('/usr/bin/bwrap')).toBeGreaterThan(outer);
  } finally {
    await f.close();
  }
});

test('a Linux host without a usable bubblewrap falls back to none, like macOS', async () => {
  const { chooseLocalSandbox } = await import('../../src/command-sandbox.js');
  expect(chooseLocalSandbox('workspace-write', 'linux', () => null)).toEqual({
    kind: 'none',
    level: 'workspace-write',
    bwrap: null,
  });
  expect(chooseLocalSandbox('workspace-write', 'linux', () => bwrap).kind).toBe('bwrap');
  expect(chooseLocalSandbox('workspace-write', 'darwin', () => bwrap).kind).toBe('none');
  expect(chooseLocalSandbox('full-access', 'linux', () => bwrap).kind).toBe('none');
});

test('a host with no sandbox labels every command approval unsandboxed and binds kind none', async () => {
  const f = sandboxed({ kind: 'none', level: 'workspace-write', bwrap: null });
  try {
    const created = f.prepare('c1', { action: 'command', command: 'echo hi' });
    expect(created.operation.value).toContain(
      'unsandboxed: this host has no usable command sandbox',
    );
    expect(
      JSON.parse(
        String(
          f.store.db.prepare('SELECT args FROM local_calls WHERE id=?').get(created.call.id)!.args,
        ),
      ).sandbox,
    ).toEqual({ kind: 'none', level: 'workspace-write', bwrap: null });
  } finally {
    await f.close();
  }
});

test('an unsandboxed command records sandbox none in its execution result', async () => {
  const f = sandboxed({ kind: 'none', level: 'workspace-write', bwrap: null });
  try {
    const call = f.prepare('c1', { action: 'command', command: 'echo hi' });
    f.approve(call);
    f.local.run(call.call.id);
    const done = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(done.result).toMatchObject({ sandbox: 'none', isolation: 'local-user-no-os-sandbox' });
  } finally {
    await f.close();
  }
});

test('host plan names the command sandbox kind and labels none unsandboxed', async () => {
  const { hostLocalSandbox } = await import('../../src/host.js');
  expect(hostLocalSandbox('linux', () => null)).toEqual({ kind: 'none', label: 'unsandboxed' });
  expect(hostLocalSandbox('darwin', () => bwrap)).toEqual({ kind: 'none', label: 'unsandboxed' });
  expect(hostLocalSandbox('linux', () => bwrap)).toEqual({ kind: 'bwrap', label: 'bubblewrap' });
});
