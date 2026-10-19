import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { A2AInvocation, a2aTask, type A2ACheckpoint } from '../../src/a2a-protocol.js';
import { A2AHttp, validatePeer } from '../../src/a2a-peer.js';
import { digest } from '../../src/protocol.js';
import { sdkPeer } from '../fixtures/a2a-peer.js';

function fixture(rpc: any) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE checkpoint(document TEXT)');
  const peer = { id: 'peer', tenant: 't', digest: digest('peer'), cancel: true, skill: 'review' },
    text = 'Review',
    data = { files: {} };
  let cp = A2AInvocation.prepare('worker', 'attempt', peer, text, data, []);
  const save = (v: A2ACheckpoint) => {
    db.exec('DELETE FROM checkpoint');
    db.prepare('INSERT INTO checkpoint VALUES (?)').run(JSON.stringify(v));
    cp = v;
    return undefined;
  };
  save(cp);
  return {
    db,
    peer,
    text,
    data,
    save,
    get cp() {
      return cp;
    },
    invocation: new A2AInvocation(peer, cp, rpc, save),
  };
}
const task = (state = 'TASK_STATE_WORKING', id = 'task', contextId = 'context') => ({
  id,
  contextId,
  status: { state },
  artifacts: [],
});
test('lost acceptance is durable unknown and never resends, even after reconstruction', async () => {
  let sends = 0;
  const f = fixture({
    async rpc() {
      sends++;
      throw Error('Lost reply after acceptance');
    },
  });
  try {
    await expect(f.invocation.dispatch(f.text, f.data)).rejects.toThrow('Lost reply');
    expect(f.cp.state).toBe('unknown');
    const recovered = new A2AInvocation(f.peer, f.cp, f.invocation.rpc, f.save);
    await expect(recovered.dispatch(f.text, f.data)).rejects.toThrow('cannot dispatch');
    await expect(recovered.inspect()).rejects.toThrow('identity is unknown');
    expect(sends).toBe(1);
  } finally {
    f.db.close();
  }
});
test('checkpoint failure prevents dispatch; unknown peer/task/context cannot be read as owned', async () => {
  let calls = 0;
  const f = fixture({
    async rpc() {
      calls++;
      return { task: task() };
    },
  });
  try {
    const broken = new A2AInvocation(f.peer, f.cp, f.invocation.rpc, () => {
      throw Error('Disk full');
    });
    await expect(broken.dispatch(f.text, f.data)).rejects.toThrow('Disk full');
    expect(calls).toBe(0);
    await f.invocation.dispatch(f.text, f.data);
    const changed = {
      async rpc() {
        return task('TASK_STATE_COMPLETED', 'other');
      },
    };
    const recovered = new A2AInvocation(f.peer, f.cp, changed, f.save);
    await expect(recovered.inspect()).rejects.toThrow('ownership mismatch');
    expect(() => new A2AInvocation({ ...f.peer, tenant: 'wrong' }, f.cp, changed, f.save)).toThrow(
      'ownership changed',
    );
  } finally {
    f.db.close();
  }
});
test('cancel acknowledgement retains an unconfirmed remote stop and can later inspect terminal', async () => {
  const methods: string[] = [];
  let terminal = false;
  const f = fixture({
    async rpc(method: string) {
      methods.push(method);
      return method === 'SendMessage'
        ? { task: task() }
        : task(terminal ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING');
    },
  });
  try {
    await f.invocation.dispatch(f.text, f.data);
    await expect(f.invocation.cancel()).rejects.toThrow('does not confirm');
    expect(f.cp.cancel_state).toBe('acknowledged');
    terminal = true;
    await f.invocation.inspect();
    expect(f.cp.state).toBe('terminal');
    expect(methods.filter((m) => m === 'SendMessage')).toHaveLength(1);
  } finally {
    f.db.close();
  }
});
test('unsupported cancellation polls only the existing task and does not invent canceled state', async () => {
  let cancels = 0;
  const f = fixture({
    async rpc(method: string) {
      if (method === 'CancelTask') cancels++;
      return method === 'SendMessage' ? { task: task() } : task();
    },
  });
  try {
    const invocation = new A2AInvocation(
      { ...f.peer, cancel: false },
      f.cp,
      f.invocation.rpc,
      f.save,
    );
    await invocation.dispatch(f.text, f.data);
    await expect(invocation.cancel()).rejects.toThrow('unsupported');
    expect(cancels).toBe(0);
    expect(f.cp.result!.status.state).toBe('TASK_STATE_WORKING');
  } finally {
    f.db.close();
  }
});
test('terminal snapshots cannot regress or silently replace artifact bytes', async () => {
  const f = fixture({
    async rpc(method: string) {
      return method === 'SendMessage' ? { task: task('TASK_STATE_COMPLETED') } : task();
    },
  });
  try {
    await f.invocation.dispatch(f.text, f.data);
    await expect(f.invocation.inspect()).rejects.toThrow('Conflicting');
  } finally {
    f.db.close();
  }
  expect(() =>
    a2aTask({
      ...task(),
      artifacts: [{ artifactId: 'x', parts: [{ url: 'https://metadata.invalid' }] }],
    }),
  ).toThrow('inline');
  expect(() =>
    a2aTask({
      ...task(),
      artifacts: [
        { artifactId: 'x', parts: [] },
        { artifactId: 'x', parts: [] },
      ],
    }),
  ).toThrow('Duplicate');
});
test('actual official SDK accepts the v1 wire; reconnect polls its saved ID without another send', async () => {
  const peer = await sdkPeer();
  peer.complete = false;
  try {
    const http = new A2AHttp(peer.peer);
    await http.card();
    const f = fixture(http);
    const identity = {
      ...f.peer,
      id: peer.peer.id,
      tenant: peer.peer.tenant,
      digest: digest(peer.peer),
    };
    const cp = A2AInvocation.prepare('worker', 'attempt', identity, f.text, f.data, []),
      invocation = new A2AInvocation(identity, cp, http, f.save);
    await invocation.dispatch(f.text, f.data);
    const remote = peer.tasks.get(f.cp.task_id!);
    remote.status.state = 'TASK_STATE_COMPLETED';
    const recovered = new A2AInvocation(identity, f.cp, http, f.save);
    await recovered.inspect();
    expect(f.cp.state).toBe('terminal');
    expect(peer.accepted).toBe(1);
    expect(peer.requests.map((r) => r.method)).toEqual(['SendMessage', 'GetTask']);
    f.db.close();
  } finally {
    await peer.close();
  }
});
test('actual SDK peer lost acceptance and volatile task loss preserve uncertainty without resending', async () => {
  const peer = await sdkPeer();
  peer.lost = true;
  try {
    const f = fixture(new A2AHttp(peer.peer));
    await expect(f.invocation.dispatch(f.text, f.data)).rejects.toThrow();
    expect(peer.accepted).toBe(1);
    expect(f.cp.task_id).toBeNull();
    peer.lost = false;
    await expect(f.invocation.dispatch(f.text, f.data)).rejects.toThrow();
    expect(peer.accepted).toBe(1);
    f.db.close();
  } finally {
    await peer.close();
  }
});
test('peer registry rejects metadata destinations, inherited controls and unreviewed card URLs before any request', async () => {
  const p = await sdkPeer();
  try {
    for (const change of [
      { addresses: ['169.254.169.254'], local: false },
      { endpoint: 'http://127.0.0.1:1/a2a?token=x' },
      { card_url: 'https://attacker.invalid/card' },
      { env: { API_KEY: 'forbidden' } },
      { files: ['.gemini/settings.json'] },
    ])
      expect(() => validatePeer({ ...p.peer, ...change })).toThrow();
    p.card.supportedInterfaces[0].url = 'https://attacker.invalid';
    await expect(new A2AHttp(p.peer).card()).rejects.toThrow('Card changed');
    expect(p.requests).toHaveLength(0);
  } finally {
    await p.close();
  }
});

test('reordered/repeated stream chunks remain tentative and changing rendered artifact IDs retain one content receipt', async () => {
  let renders = 0,
    changed = false;
  const render = () => ({
    ...task('TASK_STATE_COMPLETED'),
    status: { state: 'TASK_STATE_COMPLETED', timestamp: String(++renders) },
    artifacts: [
      {
        artifactId: 'render-' + renders,
        parts: [{ text: changed ? 'changed bytes' : 'same bytes', mediaType: 'text/plain' }],
      },
    ],
  });
  const f = fixture({
    async rpc(method: string) {
      return method === 'SendMessage' ? { task: task() } : render();
    },
  });
  try {
    await f.invocation.dispatch(f.text, f.data);
    const chunk = {
      artifactUpdate: {
        taskId: 'task',
        contextId: 'context',
        artifact: { artifactId: 'chunk', parts: [{ text: 'partial' }] },
        append: true,
      },
    };
    f.invocation.observe(chunk);
    f.invocation.observe(chunk);
    f.invocation.observe({
      statusUpdate: {
        taskId: 'task',
        contextId: 'context',
        status: { state: 'TASK_STATE_COMPLETED' },
        final: true,
      },
    });
    expect(f.cp.state).toBe('running');
    expect(f.cp.progress!.artifact_ids).toEqual(['chunk']);
    await f.invocation.inspect();
    const id = f.cp.artifact_receipts![0]!.id;
    await f.invocation.inspect();
    expect(f.cp.artifact_receipts).toHaveLength(1);
    expect(f.cp.artifact_receipts![0]!.id).toBe(id);
    expect(f.cp.artifact_receipts![0]!.upstream_ids).toHaveLength(2);
    changed = true;
    await expect(f.invocation.inspect()).rejects.toThrow('Conflicting');
    expect(() =>
      f.invocation.observe({
        statusUpdate: {
          taskId: 'other',
          contextId: 'context',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      }),
    ).toThrow('Unowned');
  } finally {
    f.db.close();
  }
});
