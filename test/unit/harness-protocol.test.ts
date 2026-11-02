import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HarnessProtocol,
  type HarnessCheckpoint,
  type HarnessProtocolHooks,
} from '../../src/harness/protocol.js';
import { ROOT } from '../../src/core/config.js';

function fixture(dialect: 'acp' | 'codex', mode = 'normal') {
  const dir = mkdtempSync('/tmp/sal-harness-protocol-'),
    path = join(dir, 'journal.sqlite'),
    audit = join(dir, 'audit');
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE checkpoint(id INTEGER PRIMARY KEY, document TEXT NOT NULL);',
  );
  const prepared: HarnessCheckpoint = {
    schema_version: 1,
    dialect,
    worker_id: 'worker-a',
    attempt_id: 'attempt-a',
    state: 'prepared',
    session_id: null,
    turn_id: null,
    prompt_digest: null,
    cancel_requested: false,
    result: null,
    load_session: false,
  };
  const saves: HarnessCheckpoint[] = [],
    permissions: any[] = [];
  const hooks: HarnessProtocolHooks = {
    save: (checkpoint) => {
      db.prepare('INSERT OR REPLACE INTO checkpoint VALUES(1,?)').run(JSON.stringify(checkpoint));
      saves.push(checkpoint);
    },
    permission: async (binding) => {
      permissions.push(binding);
      return 'approve';
    },
  };
  hooks.save(prepared);
  const open = (state: HarnessCheckpoint, scenario = mode, custom = hooks) =>
    new HarnessProtocol(
      {
        executable: process.execPath,
        args: [
          join(ROOT, 'test/fixtures/harness-protocol-peer.mjs'),
          scenario,
          dialect,
          path,
          audit,
        ],
        cwd: dir,
        env: {},
        dialect,
      },
      state,
      custom,
    );
  const rows = () => {
    try {
      return readFileSync(audit, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    prepared,
    open,
    hooks,
    saves,
    permissions,
    rows,
    read: () =>
      JSON.parse(
        String(db.prepare('SELECT document FROM checkpoint WHERE id=1').get()!.document),
      ) as HarnessCheckpoint,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const dialect of ['acp', 'codex'] as const)
  test(
    dialect +
      ' persists session and prompt intent before forwarding and never accepts a second prompt',
    async () => {
      const f = fixture(dialect),
        p = f.open(f.prepared);
      try {
        await p.initialize();
        await p.create({ cwd: '/workspace' });
        const r = await p.prompt('Implement one scoped change');
        expect(p.view().state).toBe('terminal');
        expect(r).toBeTruthy();
        const sent = f.rows().find((r) => ['session/prompt', 'turn/start'].includes(r.method));
        expect(sent.checkpoint).toMatchObject({
          state: 'dispatching',
          session_id: dialect === 'acp' ? 'owned-session' : 'owned-thread',
        });
        expect(sent.checkpoint.prompt_digest).toBeTruthy();
        await expect(p.prompt('repeat')).rejects.toMatchObject({ code: 'harness_replay' });
        expect(
          f.rows().filter((r) => ['session/prompt', 'turn/start'].includes(r.method)),
        ).toHaveLength(1);
      } finally {
        await p.close();
        f.close();
      }
    },
  );
for (const dialect of ['acp', 'codex'] as const)
  test(
    dialect + ' lost acceptance survives restart as unknown without a second prompt',
    async () => {
      const f = fixture(dialect, 'crash'),
        p = f.open(f.prepared);
      let next: HarnessProtocol | undefined;
      try {
        await p.initialize();
        await p.create({ cwd: '/workspace' });
        await expect(p.prompt('one durable operation')).rejects.toThrow();
        expect(f.read().state).toBe('unknown');
        await p.close();
        next = f.open(f.read(), 'normal');
        await next.initialize();
        if (dialect === 'acp')
          await expect(next.inspect({ cwd: '/workspace' })).rejects.toMatchObject({
            code: 'harness_outcome_unknown',
          });
        else await next.inspect({ cwd: '/workspace' });
        expect(next.view().state).toBe('unknown');
        await expect(next.prompt('retry after death')).rejects.toMatchObject({
          code: 'harness_replay',
        });
        expect(
          f.rows().filter((r) => ['session/prompt', 'turn/start'].includes(r.method)),
        ).toHaveLength(1);
      } finally {
        await next?.close();
        await p.close();
        f.close();
      }
    },
  );
for (const dialect of ['acp', 'codex'] as const)
  test(
    dialect + ' unowned notifications or terminal receipts never complete local work',
    async () => {
      const f = fixture(dialect, 'foreign'),
        p = f.open(f.prepared);
      try {
        await p.initialize();
        await p.create({});
        await expect(p.prompt('scoped change')).rejects.toThrow();
        expect(f.read().state).toBe('unknown');
      } finally {
        await p.close();
        f.close();
      }
    },
  );
for (const dialect of ['acp', 'codex'] as const)
  test(
    dialect + ' permission callbacks receive frozen worker/attempt identity only for owned scopes',
    async () => {
      const f = fixture(dialect, 'permission'),
        p = f.open(f.prepared);
      try {
        await p.initialize();
        await p.create({});
        await p.prompt('one change');
        expect(f.permissions).toHaveLength(1);
        expect(f.permissions[0]).toMatchObject({
          worker_id: 'worker-a',
          attempt_id: 'attempt-a',
          session_id: dialect === 'acp' ? 'owned-session' : 'owned-thread',
          turn_id: dialect === 'acp' ? null : 'owned-turn',
        });
      } finally {
        await p.close();
        f.close();
      }
    },
  );
for (const dialect of ['acp', 'codex'] as const)
  test(
    dialect + ' wrong-session/turn permission requests cannot reach operator authority',
    async () => {
      const f = fixture(dialect, 'foreign-permission'),
        p = f.open(f.prepared);
      try {
        await p.initialize();
        await p.create({});
        await p.prompt('one change');
        expect(f.permissions).toHaveLength(0);
        expect(f.rows().find((r) => r.permission_reply)?.permission_reply.error).toBeTruthy();
      } finally {
        await p.close();
        f.close();
      }
    },
  );
for (const mode of ['early', 'duplicate'])
  test('Codex ' + mode + ' terminal events cannot duplicate completion receipts', async () => {
    const f = fixture('codex', mode),
      p = f.open(f.prepared);
    try {
      await p.initialize();
      await p.create({});
      await p.prompt('one change');
      await new Promise((r) => setTimeout(r, 30));
      expect(f.saves.filter((s) => s.state === 'terminal')).toHaveLength(1);
      expect(p.view().result).toMatchObject({ turn: { id: 'owned-turn', status: 'completed' } });
    } finally {
      await p.close();
      f.close();
    }
  });
test('Codex interrupt acknowledgement remains running until an owned terminal receipt arrives', async () => {
  const f = fixture('codex', 'wait'),
    p = f.open(f.prepared);
  try {
    await p.initialize();
    await p.create({});
    const done = p.prompt('long operation');
    while (p.view().state !== 'running') await new Promise((r) => setTimeout(r, 5));
    const acknowledged = await p.cancel();
    expect(acknowledged).toMatchObject({
      state: 'running',
      cancel_requested: true,
      cancel_state: 'acknowledged',
    });
    await done;
    expect(p.view()).toMatchObject({
      state: 'terminal',
      result: { turn: { status: 'interrupted' } },
    });
    expect(f.rows().filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
  } finally {
    await p.close();
    f.close();
  }
});
test('ACP cancellation is confirmed only by the original prompt terminal reply', async () => {
  const f = fixture('acp', 'wait'),
    p = f.open(f.prepared);
  try {
    await p.initialize();
    await p.create({});
    const done = p.prompt('long operation');
    await p.cancel();
    await done;
    expect(p.view()).toMatchObject({ state: 'terminal', result: { stopReason: 'cancelled' } });
  } finally {
    await p.close();
    f.close();
  }
});
test('unsupported ACP loading fails without creating another session', async () => {
  const f = fixture('acp', 'no-load'),
    p = f.open(f.prepared);
  try {
    await p.initialize();
    await p.create({});
    await expect(p.inspect({ cwd: '/workspace' })).rejects.toMatchObject({
      code: 'harness_resume_unsupported',
    });
    expect(f.rows().filter((r) => r.method === 'session/new')).toHaveLength(1);
  } finally {
    await p.close();
    f.close();
  }
});
test('persistence failure prevents session dispatch and cannot become a timer exception', async () => {
  const f = fixture('codex'),
    p = f.open(f.prepared, 'normal', {
      ...f.hooks,
      save: () => {
        throw Error('fixture storage failure');
      },
    });
  try {
    await p.initialize();
    await expect(p.create({})).rejects.toThrow('storage failure');
    expect(f.rows().filter((r) => r.method === 'thread/start')).toHaveLength(0);
  } finally {
    await p.close();
    f.close();
  }
});
test('a persistence failure during progress revokes every later grant, and recovery starts unknown', async () => {
  const f = fixture('acp');
  const p = f.open(f.prepared, 'normal', {
    ...f.hooks,
    save: (s) => {
      if (s.state === 'running') throw Error('fixture progress storage failure');
      return f.hooks.save(s);
    },
  });
  let recovered: HarnessProtocol | undefined;
  try {
    await p.initialize();
    await p.create({});
    await expect(p.prompt('one operation')).rejects.toThrow();
    expect(f.read().state).toBe('dispatching');
    await expect(p.inspect()).rejects.toMatchObject({ code: 'harness_control_failed' });
    await expect(p.prompt('unsafe retry')).rejects.toMatchObject({
      code: 'harness_control_failed',
    });
    await p.close();
    recovered = f.open(f.read());
    expect(recovered.view().state).toBe('unknown');
    await recovered.initialize();
    await expect(recovered.inspect({ cwd: '/workspace' })).rejects.toMatchObject({
      code: 'harness_outcome_unknown',
    });
    await expect(recovered.prompt('retry')).rejects.toMatchObject({ code: 'harness_replay' });
    expect(f.rows().filter((r) => r.method === 'session/prompt')).toHaveLength(1);
  } finally {
    await recovered?.close();
    await p.close();
    f.close();
  }
});
test('a delayed approval cannot grant permission after cancellation revoked the invocation', async () => {
  const f = fixture('acp', 'permission');
  let release!: () => void,
    asked = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const p = f.open(f.prepared, 'permission', {
    ...f.hooks,
    permission: async () => {
      asked = true;
      await gate;
      return 'approve';
    },
  });
  try {
    await p.initialize();
    await p.create({});
    const done = p.prompt('one operation');
    while (!asked) await new Promise((r) => setTimeout(r, 5));
    await p.cancel();
    await done;
    expect(p.view()).toMatchObject({
      state: 'terminal',
      cancel_requested: true,
      result: { stopReason: 'cancelled' },
    });
    release();
    for (let i = 0; i < 30 && !f.rows().some((r) => r.permission_reply); i++)
      await new Promise((r) => setTimeout(r, 5));
    const reply = f.rows().find((r) => r.permission_reply)?.permission_reply;
    expect(reply?.error).toBeTruthy();
    expect(reply?.result).toBeUndefined();
    expect(f.rows().filter((r) => r.method === 'session/prompt')).toHaveLength(1);
  } finally {
    release?.();
    await p.close();
    f.close();
  }
});
