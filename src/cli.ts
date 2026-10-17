#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { SalaamService } from './service.js';
import { call } from './transport.js';
import { attach, acquireControl, Outbox } from './attach.js';
import type { SessionSnapshot, Approval, Operation } from './protocol.js';
import { SocketEffectConnector } from './effect-connector.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return;
    const value = args[i + 1];
    if (!value) throw new Error(`Missing ${name}`);
    args.splice(i, 2);
    return value;
  };
  const state = resolve(
    option('--state') ?? process.env.SALAAM_STATE_DIR ?? join(homedir(), '.local/state/salaam'),
  );
  const foreground = args.includes('--foreground');
  if (foreground) args.splice(args.indexOf('--foreground'), 1);
  const socket = join(state, 'operator.sock');
  const [group, verb, id] = args;
  if (group === 'approvals' && verb === 'list') {
    const session = option('--session');
    console.log(
      JSON.stringify(
        await call(
          socket,
          '/v1/approvals' + (session ? '?session=' + encodeURIComponent(session) : ''),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'approvals' && id && ['inspect', 'approve', 'deny'].includes(verb ?? '')) {
    const approval = await call<Approval>(socket, `/v1/approvals/${id}`);
    if (verb === 'inspect') {
      console.log(
        JSON.stringify(
          { approval, operation: await call(socket, `/v1/operations/${approval.operation_id}`) },
          null,
          2,
        ),
      );
      return;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    if (!binding || !Number.isSafeInteger(revision))
      throw new Error('Supply the reviewed --digest and --revision from approvals inspect');
    const outbox = new Outbox(state, approval.session_id);
    const record = outbox.enqueueDecision(
      id,
      binding,
      revision,
      verb === 'approve' ? 'approve' : 'deny',
      option('--request-id'),
    );
    console.log(JSON.stringify({ request_id: record.request_id }));
    await outbox.flush(socket, approval.session_id);
    console.log(JSON.stringify(await call(socket, `/v1/approvals/${id}`), null, 2));
    return;
  }
  if (group === 'operations' && id && ['inspect', 'reconcile', 'resolve'].includes(verb ?? '')) {
    if (verb === 'inspect') {
      console.log(JSON.stringify(await call(socket, `/v1/operations/${id}`), null, 2));
      return;
    }
    if (verb === 'reconcile') {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/operations/${id}/reconcile`, {
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
      return;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    const evidence = option('--evidence');
    const outcome = option('--outcome');
    if (
      !binding ||
      !Number.isSafeInteger(revision) ||
      !evidence ||
      !['succeeded', 'failed_definite'].includes(outcome ?? '')
    )
      throw new Error(
        'Supply reviewed --digest --revision --evidence and --outcome succeeded|failed_definite',
      );
    const request_id = option('--request-id') ?? randomUUID();
    console.log(JSON.stringify({ request_id }));
    console.log(
      JSON.stringify(
        await call(socket, `/v1/operations/${id}/resolution`, {
          request_id,
          expected_revision: revision,
          operation_digest: binding,
          evidence,
          outcome,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'session' && verb === 'cancel' && id) {
    const attempt = option('--attempt');
    if (!attempt) throw new Error('Supply --attempt');
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
      const outbox = new Outbox(state, id);
      const record = outbox.enqueueCancellation(attempt, snapshot.revision, option('--request-id'));
      console.log(JSON.stringify({ request_id: record.request_id }));
      await outbox.flush(socket, id, controller);
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'attach' && verb) {
    await attach(state, verb, {
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
    });
    return;
  }
  if (group === 'session' && ['submit', 'continue', 'resume'].includes(verb ?? '') && id) {
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      if (verb !== 'resume') {
        const text = option('--text');
        if (!text) throw new Error('Supply --text with a new instruction');
        const continues = verb === 'continue' ? option('--attempt') : undefined;
        if (verb === 'continue' && !continues)
          throw new Error('Supply --attempt with the interrupted attempt ID');
        const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
        const outbox = new Outbox(state, id);
        const pending = outbox.enqueue(text, snapshot.revision, continues);
        await outbox.flush(socket, id, controller);
        console.log(JSON.stringify({ request_id: pending.request_id, accepted: true }));
      }
      console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/resume`, controller)));
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'service' && verb === 'start') {
    const effectSocket = option('--effect-socket');
    const opaque = args.includes('--effect-opaque');
    if (foreground) {
      const service = await SalaamService.open({
        stateDir: state,
        effectConnector: effectSocket
          ? new SocketEffectConnector(resolve(effectSocket), { opaque })
          : undefined,
      });
      process.stdout.write(JSON.stringify({ socket, service: 'started' }) + '\n');
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void service.close().catch(() => {
            console.error('Salaam stopped with a persistence error');
            process.exitCode = 1;
          });
        });
      await service.closed;
      return;
    }
    try {
      await call(socket, '/v1/health');
      console.log('Salaam service already running');
      return;
    } catch {}
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const fd = openSync(join(state, 'service.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        'service',
        'start',
        '--foreground',
        '--state',
        state,
        ...(effectSocket ? ['--effect-socket', resolve(effectSocket)] : []),
        ...(opaque ? ['--effect-opaque'] : []),
      ],
      { detached: true, stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    child.unref();
    for (let i = 0; i < 50; i++) {
      try {
        await call(socket, '/v1/health');
        console.log(JSON.stringify({ socket, service: 'started' }));
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Service did not start; inspect ' + join(state, 'service.log'));
  }
  if (group === 'service' && verb === 'stop') {
    console.log(JSON.stringify(await call(socket, '/v1/shutdown', {})));
    return;
  }
  if (group === 'service' && verb === 'status') {
    console.log(JSON.stringify(await call(socket, '/v1/health'), null, 2));
    return;
  }
  if (group === 'session' && verb === 'create') {
    const cwd = resolve(option('--cwd') ?? process.cwd());
    const requestId = option('--request-id') ?? randomUUID();
    console.log(
      JSON.stringify(await call(socket, '/v1/sessions', { cwd, request_id: requestId }), null, 2),
    );
    return;
  }
  if (group === 'session' && verb === 'list') {
    console.log(JSON.stringify(await call(socket, '/v1/sessions'), null, 2));
    return;
  }
  if (group === 'session' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/snapshot`), null, 2));
    return;
  }
  if (group === 'session' && verb === 'probe' && id) {
    const client_id = randomUUID();
    const lease = await acquireControl(socket, id, client_id, args.includes('--takeover'));
    const controller = { client_id, token: lease.token };
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/sessions/${id}/probe`, controller, undefined, 15000),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  console.log(
    'Usage: sal service start|stop|status [--state DIR] [--foreground] [--effect-socket PATH] [--effect-opaque]\n       sal session create [--cwd DIR] [--request-id ID]\n       sal attach ID [--observe|--takeover] [--state DIR]\n       sal session submit ID --text TEXT\n       sal session continue ID --attempt ID --text NEW_INSTRUCTION\n       sal session cancel ID --attempt ID [--takeover]\n       sal approvals list [--session ID] | inspect ID | approve|deny ID --digest DIGEST --revision N\n       sal operations inspect|reconcile ID | resolve ID --digest DIGEST --revision N --outcome STATE --evidence TEXT\n       sal session list|inspect ID|probe ID|resume ID [--state DIR]',
  );
  if (args.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
