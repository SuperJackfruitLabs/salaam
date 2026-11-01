import { test, expect, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { ManagedWork } from '../../src/execution/managed.js';
import { LocalCoding } from '../../src/local/coding.js';
import {
  localHash,
  prepareLocalEdits,
  applyLocalEdits,
  reviewLocalEdits,
} from '../../src/local/edits.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
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
  const { reviewUndo, assertUndoSettled, reconcileUndo } = await import('../../src/local/undo.js');
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
import type { LocalSandbox } from '../../src/local/coding.js';
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

test('a Linux host without a usable bubblewrap chooses none; macOS chooses Seatbelt when usable', async () => {
  const { chooseLocalSandbox } = await import('../../src/local/command-sandbox.js');
  expect(
    chooseLocalSandbox(
      'workspace-write',
      'linux',
      () => null,
      () => null,
    ),
  ).toEqual({
    kind: 'none',
    level: 'workspace-write',
    bwrap: null,
    seatbelt: null,
  });
  expect(
    chooseLocalSandbox(
      'workspace-write',
      'linux',
      () => bwrap,
      () => null,
    ).kind,
  ).toBe('bwrap');
  expect(
    chooseLocalSandbox(
      'workspace-write',
      'darwin',
      () => bwrap,
      () => ({
        path: '/usr/bin/sandbox-exec',
      }),
    ).kind,
  ).toBe('seatbelt');
  expect(
    chooseLocalSandbox(
      'workspace-write',
      'darwin',
      () => bwrap,
      () => null,
    ).kind,
  ).toBe('none');
  expect(
    chooseLocalSandbox(
      'full-access',
      'linux',
      () => bwrap,
      () => null,
    ).kind,
  ).toBe('none');
});

// Operator ruling 2026-10-30 (option A): no usable sandbox means local commands are refused,
// unless the operator set unsandboxed_commands: "allow" for this host.
test('a host with no usable sandbox refuses a local command and names the fix', async () => {
  const f = sandboxed({ kind: 'none', level: 'workspace-write', bwrap: null, seatbelt: null });
  try {
    let error: unknown;
    try {
      f.prepare('c1', { action: 'command', command: 'echo hi' });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'sandbox_unavailable' });
    const message = String((error as Error).message);
    expect(message).toContain('refused');
    expect(message).toContain('bubblewrap');
    expect(message).toContain('Seatbelt');
    expect(message).toContain('unsandboxed_commands');
    expect(
      f.store.db.prepare('SELECT count(*) AS n FROM local_calls WHERE args IS NOT NULL').get(),
    ).toEqual({
      n: 0,
    });
    // An edit is not a command: it needs no OS sandbox and is still offered.
    expect(() =>
      f.prepare('e1', { action: 'edit', edits: [{ path: 'a.txt', sha256: null, content: 'x' }] }),
    ).not.toThrow();
  } finally {
    await f.close();
  }
});

test('full access the operator chose still runs as is on a host with no sandbox', async () => {
  const f = sandboxed({ kind: 'none', level: 'full-access', bwrap: null, seatbelt: null });
  try {
    const created = f.prepare('c1', { action: 'command', command: 'echo hi' });
    expect(created.operation.value).toContain('unsandboxed: the operator chose full access');
  } finally {
    await f.close();
  }
});

test('a Seatbelt host binds the sandbox into the approval and runs the command under sandbox-exec', async () => {
  const f = sandboxed({
    kind: 'seatbelt',
    level: 'workspace-write',
    bwrap: null,
    seatbelt: { path: '/usr/bin/sandbox-exec' },
  });
  try {
    const created = f.prepare('c1', { action: 'command', command: 'echo hi' });
    expect(created.operation.value).toContain('Seatbelt sandbox (workspace-write)');
    expect(created.operation.value).not.toContain('unsandboxed');
    expect(
      JSON.parse(
        String(
          f.store.db.prepare('SELECT args FROM local_calls WHERE id=?').get(created.call.id)!.args,
        ),
      ).sandbox,
    ).toEqual({ kind: 'seatbelt', level: 'workspace-write', bwrap: null });
    const argv = (
      f.local as unknown as { commandArgv(root: string, script: string, tmp: string): string[] }
    ).commandArgv(f.root, 'echo hi', '/private/tmp/salaam-cmd-t');
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  } finally {
    await f.close();
  }
});

test('a host the operator opted in labels every command approval unsandboxed and binds kind none', async () => {
  const f = sandboxed({
    kind: 'none',
    level: 'workspace-write',
    bwrap: null,
    seatbelt: null,
    allowUnsandboxed: true,
  });
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
  const f = sandboxed({
    kind: 'none',
    level: 'workspace-write',
    bwrap: null,
    seatbelt: null,
    allowUnsandboxed: true,
  });
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

test('host plan names the command sandbox, refused without one unless the operator allows it', async () => {
  const { hostLocalSandbox } = await import('../../src/host/host.js');
  const sb = () => ({ path: '/usr/bin/sandbox-exec' });
  expect(
    hostLocalSandbox(
      'linux',
      () => null,
      () => null,
    ),
  ).toEqual({ kind: 'none', label: 'refused' });
  expect(
    hostLocalSandbox(
      'linux',
      () => null,
      () => null,
      true,
    ),
  ).toEqual({
    kind: 'none',
    label: 'unsandboxed',
    unsandboxed_commands: 'allow',
  });
  expect(
    hostLocalSandbox(
      'darwin',
      () => bwrap,
      () => null,
    ),
  ).toEqual({ kind: 'none', label: 'refused' });
  expect(hostLocalSandbox('darwin', () => null, sb)).toEqual({
    kind: 'seatbelt',
    label: 'seatbelt',
  });
  expect(
    hostLocalSandbox(
      'linux',
      () => bwrap,
      () => null,
    ),
  ).toEqual({ kind: 'bwrap', label: 'bubblewrap' });
  expect(
    hostLocalSandbox(
      'linux',
      () => bwrap,
      () => null,
      true,
    ),
  ).toEqual({
    kind: 'bwrap',
    label: 'bubblewrap',
    unsandboxed_commands: 'allow',
  });
});

// Every host runs this with its own sandbox and nothing is skipped (the CI evidence gate refuses a
// skipped test): Seatbelt on macOS, bubblewrap on a Linux host that has it, and a refusal where no
// sandbox can start (a CI container).
test('a real command runs under the host sandbox and records it, or is refused where there is none', async () => {
  const { chooseLocalSandbox } = await import('../../src/local/command-sandbox.js');
  const chosen = chooseLocalSandbox('workspace-write');
  if (process.platform === 'darwin') expect(chosen.kind).toBe('seatbelt');
  const f = sandboxed(chosen);
  try {
    if (chosen.kind === 'none') {
      expect(() => f.prepare('c1', { action: 'command', command: 'echo hi' })).toThrow(
        expect.objectContaining({ code: 'sandbox_unavailable' }),
      );
      return;
    }
    const call = f.prepare('c1', {
      action: 'command',
      command: 'echo hi > out.txt && echo "$TMPDIR" && echo bad > "$HOME/salaam-lc-escape"',
    });
    f.approve(call);
    f.local.run(call.call.id);
    const done = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(done.result).toMatchObject({
      sandbox: chosen.kind,
      isolation: 'local-user-' + chosen.kind + '-workspace-write',
    });
    expect(readFileSync(join(f.root, 'out.txt'), 'utf8')).toBe('hi\n');
    expect(existsSync(join(process.env.HOME ?? '/nonexistent', 'salaam-lc-escape'))).toBe(false);
    if (chosen.kind === 'seatbelt') {
      // Seatbelt gives each command its own TMPDIR, removed when it ends.
      const tmp = String((done.result as { output: string }).output).match(
        /(\/\S*salaam-cmd-\S+?)\/?\n/,
      )?.[1];
      expect(tmp).toBeTruthy();
      await until(
        () => existsSync(tmp!),
        (exists) => !exists,
      );
    }
  } finally {
    await f.close();
  }
});

// Network allowlist (operator rulings 2026-10-30): with the broker configured, a sandboxed command
// reaches the network only through stk's local-commands socket, and the approval says so.
test('a broker-network host says in every approval that the network goes through the broker allowlist', () => {
  const f = sandboxed({
    kind: 'bwrap',
    level: 'workspace-write',
    bwrap,
    network: { socket: '/run/stk/local-commands.sock' },
  });
  try {
    const created = f.prepare('c1', { action: 'command', command: 'echo hi' });
    expect(created.operation.value).toContain('network: through the broker allowlist');
    expect(created.operation.value).not.toContain('has no network');
  } finally {
    void f.close();
  }
});

// Every host runs this with its own sandbox and nothing is skipped: Seatbelt on macOS, bubblewrap on
// a Linux host that has it; where no sandbox can start, the command is refused.
test('a real broker-network command reaches only the allowlisted host, and nothing directly', async () => {
  const { chooseLocalSandbox } = await import('../../src/local/command-sandbox.js');
  const { fakeBroker, helloServer } = await import('../helpers/fake-broker.js');
  const chosen = chooseLocalSandbox('workspace-write');
  if (process.platform === 'darwin') expect(chosen.kind).toBe('seatbelt');
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const f = sandboxed({ ...chosen, network: { socket: broker.socket } });
  try {
    if (chosen.kind === 'none') {
      expect(() => f.prepare('c1', { action: 'command', command: 'true' })).toThrow(
        expect.objectContaining({ code: 'sandbox_unavailable' }),
      );
      return;
    }
    const call = f.prepare('c1', {
      action: 'command',
      command: [
        'curl -sS --max-time 10 --proxytunnel -x "$HTTP_PROXY" http://allowed.test/; echo',
        'curl -sS --max-time 10 --proxytunnel -x "$HTTP_PROXY" http://evil.test/ || echo refused-ok',
        `curl -sS --max-time 3 --noproxy '*' http://127.0.0.1:${up.port}/ || echo direct-blocked`,
      ].join('\n'),
    });
    f.approve(call);
    f.local.run(call.call.id);
    const done = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    const output = String((done.result as { output: string }).output);
    expect(output).toContain('hello');
    expect(output).toContain('refused-ok');
    expect(output).toContain('direct-blocked');
    expect(output).toContain('not in the local-commands allowlist');
    expect((done.result as { network: unknown }).network).toMatchObject({
      broker: 'available',
      connections: expect.arrayContaining([
        expect.objectContaining({ target: 'allowed.test:80', allowed: 1 }),
        expect.objectContaining({ target: 'evil.test:80', refused: 1 }),
      ]),
    });
  } finally {
    await f.close();
    await broker.close();
    await up.close();
  }
}, 60000);

test('a broker-network command with the broker socket missing still runs, with no network', async () => {
  const { chooseLocalSandbox } = await import('../../src/local/command-sandbox.js');
  const chosen = chooseLocalSandbox('workspace-write');
  const f = sandboxed({ ...chosen, network: { socket: '/nonexistent/salaam/broker.sock' } });
  try {
    if (chosen.kind === 'none') {
      expect(() => f.prepare('c1', { action: 'command', command: 'true' })).toThrow(
        expect.objectContaining({ code: 'sandbox_unavailable' }),
      );
      return;
    }
    const call = f.prepare('c1', {
      action: 'command',
      command:
        'curl -sS --max-time 5 --proxytunnel -x "$HTTP_PROXY" http://allowed.test/ || echo no-net; echo ran',
    });
    f.approve(call);
    f.local.run(call.call.id);
    const done = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    const output = String((done.result as { output: string }).output);
    expect(output).toContain('ran');
    expect(output).toContain('no-net');
    expect((done.result as { network: { broker: string } }).network.broker).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 60000);

// Background commands get the same broker network as foreground ones, through a relay that lives
// as long as the task. They used to get none while the approval said "through the broker".
test('a real broker-network background command reaches only the allowlisted host', async () => {
  const { chooseLocalSandbox } = await import('../../src/local/command-sandbox.js');
  const { fakeBroker, helloServer } = await import('../helpers/fake-broker.js');
  const chosen = chooseLocalSandbox('workspace-write');
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const f = sandboxed({ ...chosen, network: { socket: broker.socket } });
  f.local.interactive = () => true;
  try {
    if (chosen.kind === 'none') {
      expect(() =>
        f.prepare('b1', { action: 'command', command: 'true', background: true }),
      ).toThrow(expect.objectContaining({ code: 'sandbox_unavailable' }));
      return;
    }
    const call = f.prepare('b1', {
      action: 'command',
      background: true,
      command: [
        'curl -sS --max-time 10 --proxytunnel -x "$HTTP_PROXY" http://allowed.test/; echo',
        'curl -sS --max-time 10 --proxytunnel -x "$HTTP_PROXY" http://evil.test/ || echo refused-ok',
        `curl -sS --max-time 3 --noproxy '*' http://127.0.0.1:${up.port}/ || echo direct-blocked`,
      ].join('\n'),
    });
    expect(call.operation.value).toContain('through the broker allowlist');
    f.approve(call);
    f.local.run(call.call.id);
    const launched = await until(
      () => f.local.view(call.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(launched.result).toMatchObject({ network: 'through the broker allowlist' });
    const task = (launched.result as { task_id: string }).task_id;
    await until(
      () => f.local.tasks(f.session.id).find((t) => t.id === task)!,
      (t) => t.state !== 'running',
    );
    const out = f.local.taskOutput(f.session.id, task);
    expect(out.output).toContain('hello');
    expect(out.output).toContain('refused-ok');
    expect(out.output).toContain('direct-blocked');
    expect(out.output).toContain('[network] refused evil.test:80');
    expect(out.network).toMatchObject({
      broker: 'available',
      connections: expect.arrayContaining([
        expect.objectContaining({ target: 'allowed.test:80', allowed: 1 }),
        expect.objectContaining({ target: 'evil.test:80', refused: 1 }),
      ]),
    });
  } finally {
    await f.close();
    await broker.close();
    await up.close();
  }
}, 60000);

// Targeted edits (daily-driver Phase 1A). An interactive one-line change used to resend and
// review the whole file: ~3,500 output tokens and a 315-line approval for one line.
const LINES = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('a targeted replacement changes one span, applies it exactly and reviews only the change', async () => {
  const f = setup();
  try {
    writeFileSync(join(f.root, 'big.txt'), LINES);
    const c = f.prepare('one-line', {
      action: 'edit',
      edits: [
        {
          path: 'big.txt',
          sha256: localHash(LINES),
          replacements: [{ old: 'line 150\n', new: 'line 150 changed\n' }],
        },
      ],
    });
    const review = c.operation.value;
    expect(review).toContain('-line 150');
    expect(review).toContain('+line 150 changed');
    expect(review).not.toContain('line 10\n');
    expect(review.split('\n').length).toBeLessThan(20);
    f.approve(c);
    expect(f.local.run(c.call.id).call.state).toBe('succeeded');
    expect(readFileSync(join(f.root, 'big.txt'), 'utf8')).toBe(
      LINES.replace('line 150\n', 'line 150 changed\n'),
    );
  } finally {
    await f.close();
  }
});

test('several replacements apply in order and the review shows each change, not the lines between', () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-edit-'));
  try {
    writeFileSync(join(root, 'big.txt'), LINES);
    const edits = prepareLocalEdits(root, [
      {
        path: 'big.txt',
        sha256: localHash(LINES),
        replacements: [
          { old: 'line 20\n', new: 'line twenty\n' },
          { old: 'line 280\n', new: 'line two hundred eighty\n' },
        ],
      },
    ]);
    expect(edits[0]!.after).toBe(
      LINES.replace('line 20\n', 'line twenty\n').replace(
        'line 280\n',
        'line two hundred eighty\n',
      ),
    );
    const review = reviewLocalEdits(edits);
    expect(review).toContain('+line twenty');
    expect(review).toContain('+line two hundred eighty');
    expect(review).not.toContain('line 150');
    expect(review.match(/^@@ /gm)).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['not found', [{ old: 'no such line\n', new: 'x' }], 'not found'],
  ['ambiguous', [{ old: 'line 1', new: 'x' }], 'occurs'],
  ['empty old', [{ old: '', new: 'x' }], 'empty'],
  ['no change', [{ old: 'line 7\n', new: 'line 7\n' }], 'changes nothing'],
])('a replacement must match exactly once (%s)', (_name, replacements, message) => {
  const root = realpathSync(mkdtempSync('/tmp/sal-edit-'));
  try {
    writeFileSync(join(root, 'big.txt'), LINES);
    expect(() =>
      prepareLocalEdits(root, [{ path: 'big.txt', sha256: localHash(LINES), replacements }]),
    ).toThrow(message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a replacement edits an existing file only, and never together with whole content', () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-edit-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    expect(() =>
      prepareLocalEdits(root, [
        { path: 'new.txt', sha256: null, replacements: [{ old: 'a', new: 'b' }] },
      ]),
    ).toThrow('existing file');
    expect(() =>
      prepareLocalEdits(root, [
        {
          path: 'a.txt',
          sha256: localHash('alpha\n'),
          content: 'beta\n',
          replacements: [{ old: 'alpha', new: 'beta' }],
        },
      ]),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an approval for one targeted edit cannot run a different one', async () => {
  const f = setup();
  try {
    writeFileSync(join(f.root, 'big.txt'), LINES);
    const one = f.prepare('one', {
      action: 'edit',
      edits: [
        {
          path: 'big.txt',
          sha256: localHash(LINES),
          replacements: [{ old: 'line 5\n', new: 'five\n' }],
        },
      ],
    });
    const two = f.prepare('two', {
      action: 'edit',
      edits: [
        {
          path: 'big.txt',
          sha256: localHash(LINES),
          replacements: [{ old: 'line 6\n', new: 'six\n' }],
        },
      ],
    });
    expect(one.operation.operation_digest).not.toBe(two.operation.operation_digest);
    expect(() =>
      f.managed.decide(
        two.approval.id,
        'cross',
        two.approval.revision,
        one.operation.operation_digest,
        'approve',
      ),
    ).toThrow();
    expect(f.local.run(two.call.id).call.state).toBe('prepared');
    expect(readFileSync(join(f.root, 'big.txt'), 'utf8')).toBe(LINES);
  } finally {
    await f.close();
  }
});

test('a small change to a file larger than 16 KiB is accepted and reviewed briefly', () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-edit-'));
  try {
    const big = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join('\n') + '\n';
    writeFileSync(join(root, 'huge.txt'), big);
    const edits = prepareLocalEdits(root, [
      {
        path: 'huge.txt',
        sha256: localHash(big),
        replacements: [{ old: 'row 2000\n', new: 'row two thousand\n' }],
      },
    ]);
    expect(reviewLocalEdits(edits).length).toBeLessThan(1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a large review is bounded and says how much it left out', () => {
  const before = Array.from({ length: 2000 }, (_, i) => `a ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 2000 }, (_, i) => `b ${i}`).join('\n') + '\n';
  const review = reviewLocalEdits([{ path: 'x.txt', before, after, mode: 0o644 }]);
  expect(review.split('\n').length).toBeLessThan(260);
  expect(review).toMatch(/more changed lines not shown/);
});

test('undo after a targeted edit restores the original file', async () => {
  const { reviewUndo } = await import('../../src/local/undo.js');
  const f = setup();
  try {
    writeFileSync(join(f.root, 'big.txt'), LINES);
    const c = f.prepare('undoable', {
      action: 'edit',
      edits: [
        {
          path: 'big.txt',
          sha256: localHash(LINES),
          replacements: [{ old: 'line 9\n', new: 'nine\n' }],
        },
      ],
    });
    f.approve(c);
    f.local.run(c.call.id);
    const review = reviewUndo(f.store, f.session.id);
    expect(review.edits[0]!.before).toBe(LINES);
    expect(review.edits[0]!.after).toBe(LINES.replace('line 9\n', 'nine\n'));
  } finally {
    await f.close();
  }
});
