import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ROOT } from '../../src/core/config.js';
import { A2AHttp, type A2APeer } from '../../src/a2a/peer.js';
import { A2AInvocation, type A2ACheckpoint } from '../../src/a2a/protocol.js';
import { digest } from '../../src/core/protocol.js';
import { until } from '../helpers.js';

async function fixture(stage: 'before_model' | 'after_model', failModel = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sal-m18-peer-'))),
    file = join(dir, 'peer.json'),
    token = 'fixture-mixed-peer-' + 'm'.repeat(48),
    config = {
      schema: 1,
      host: '127.0.0.1',
      port: 0,
      token,
      tenant: 'mixed-review',
      sdk: join(ROOT, 'node_modules/@a2a-js/sdk'),
      state: join(dir, 'state'),
    };
  const frames: any[] = [];
  let child: ReturnType<typeof spawn> | undefined,
    errors = '',
    ready: any;
  const save = () => writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  save();
  async function start() {
    const old = frames.length;
    child = spawn(
      process.execPath,
      [join(ROOT, 'scripts/mixed-a2a-peer.mjs'), '--run', '--config', file],
      { cwd: dir, env: { HOME: dir, PATH: process.env.PATH, LANG: 'en_US.UTF-8' }, stdio: 'pipe' },
    );
    child.stderr!.on('data', (b) => {
      errors = (errors + b).slice(-16384);
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.kind === 'model_request')
        child!.stdin!.write(
          JSON.stringify({
            op: 'model_response',
            id: frame.id,
            ...(failModel
              ? { error: 'Fixture provider transport failed' }
              : {
                  text: 'Actual fixture reply saved before the peer restart; no live model claim.',
                }),
          }) + '\n',
        );
    });
    ready = await until(() => frames.slice(old).find((f) => f.kind === 'ready'), Boolean).catch(
      (error) => {
        throw Error(error.message + ' ' + errors);
      },
    );
    config.port = Number(new URL(ready.endpoint).port);
    save();
  }
  async function kill() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  }
  await start();
  child!.stdin!.write(JSON.stringify({ op: 'arm_barrier', stage }) + '\n');
  await until(() => frames.find((f) => f.kind === 'armed'), Boolean);
  const credential = { peer: 'mixed-peer', token },
    credential_file = join(dir, 'credential.json');
  writeFileSync(credential_file, JSON.stringify(credential), { mode: 0o600 });
  const card = await (
    await fetch(ready.card_url, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const peer: A2APeer = {
    id: 'mixed-peer',
    endpoint: ready.endpoint,
    card_url: ready.card_url,
    card_digest: digest(card),
    tenant: config.tenant,
    skill: 'review',
    addresses: ['127.0.0.1'],
    local: true,
    credential_file,
    credential_digest: digest(credential),
    files: [],
    retention: 'durable',
    cancel: false,
    streaming: false,
  };
  return {
    dir,
    frames,
    peer,
    start,
    kill,
    get child() {
      return child!;
    },
    async close() {
      await kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const stage of ['before_model', 'after_model'] as const)
  test(`independent peer SIGKILL ${stage}: same task/context, no repeated model frame, no duplicate artifact`, async () => {
    const f = await fixture(stage);
    try {
      const http = new A2AHttp(f.peer),
        peer = {
          id: f.peer.id,
          tenant: f.peer.tenant,
          digest: digest(f.peer),
          cancel: false,
          skill: 'review',
        },
        text = 'Review the explicitly disclosed fixture',
        data = { files: { 'app.js': 'export const answer=42;' } };
      let cp = A2AInvocation.prepare('worker', 'attempt', peer, text, data, []);
      const save = (value: A2ACheckpoint) => {
        cp = value;
        return undefined;
      };
      const invocation = new A2AInvocation(peer, cp, http, save);
      await invocation.dispatch(text, data);
      await until(
        () => f.frames.find((frame) => frame.kind === 'barrier' && frame.stage === stage),
        Boolean,
      );
      const original = {
        task: cp.task_id,
        context: cp.context_id,
        models: f.frames.filter((frame) => frame.kind === 'model_request').length,
      };
      await f.kill();
      await f.start();
      const recovered = new A2AInvocation(peer, cp, http, save),
        task = await recovered.inspect();
      expect(task.id).toBe(original.task);
      expect(task.contextId).toBe(original.context);
      expect(f.frames.filter((frame) => frame.kind === 'model_request')).toHaveLength(
        original.models,
      );
      if (stage === 'after_model') {
        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        expect(task.artifacts).toHaveLength(1);
        const receipts = digest(cp.artifact_receipts);
        await recovered.inspect();
        expect(digest(cp.artifact_receipts)).toBe(receipts);
        expect(original.models).toBe(1);
      } else {
        expect(task.status.state).toBe('TASK_STATE_FAILED');
        expect(task.metadata.outcome_unknown).toBe(true);
        expect(original.models).toBe(0);
      }
      await expect(recovered.dispatch(text, data)).rejects.toThrow('cannot dispatch');
    } finally {
      await f.close();
    }
  });

test('provider failure stays a failed peer task across restart without an analysis artifact or repeated model request', async () => {
  const f = await fixture('after_model', true);
  try {
    const scope = {
        id: f.peer.id,
        tenant: f.peer.tenant,
        digest: digest(f.peer),
        cancel: false,
        skill: 'review',
      },
      text = 'Review only the supplied fixture',
      data = {};
    let cp = A2AInvocation.prepare('worker', 'attempt', scope, text, data, []);
    const invocation = new A2AInvocation(scope, cp, new A2AHttp(f.peer), (value) => {
      cp = value;
    });
    await invocation.dispatch(text, data);
    const failed = await until(
      () => invocation.inspect(),
      (task) => task.status.state === 'TASK_STATE_FAILED',
    );
    expect(failed.artifacts ?? []).toHaveLength(0);
    await f.kill();
    await f.start();
    const recovered = new A2AInvocation(scope, cp, new A2AHttp(f.peer), (value) => {
      cp = value;
    });
    expect((await recovered.inspect()).id).toBe(failed.id);
    expect((await recovered.inspect()).status.state).toBe('TASK_STATE_FAILED');
    expect(f.frames.filter((frame) => frame.kind === 'model_request')).toHaveLength(1);
    await expect(recovered.dispatch(text, data)).rejects.toThrow('cannot dispatch');
  } finally {
    await f.close();
  }
});
