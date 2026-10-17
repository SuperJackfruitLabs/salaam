#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { ROOT } from './config.js';
import { cliHelp, hasHelpFlag } from './cli-help.js';
import { SalaamService } from './service.js';
import { call } from './transport.js';
import { attach, acquireControl, Outbox } from './attach.js';
import type { SessionSnapshot, Approval, Operation } from './protocol.js';
import { providerRoute } from './provider-config.js';
import { credentialPath, loadApiKey, readSecret, saveApiKey } from './credentials.js';
import { canonical } from './protocol.js';
import { SocketEffectConnector } from './effect-connector.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    console.log('salaam ' + JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
    return;
  }
  if (!args.length || args[0] === 'help' || hasHelpFlag(args)) {
    const group = args[0] === 'help' ? args[1] : args[0]?.startsWith('-') ? undefined : args[0];
    const help = cliHelp(group);
    if (!help) {
      console.error('Unknown command. Run salaam --help.');
      process.exitCode = 2;
      return;
    }
    console.log(help);
    return;
  }
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
  if (group === 'auth' && verb === 'set' && id === 'anthropic') {
    saveApiKey(await readSecret());
    console.log('Claude API key saved to ' + credentialPath() + ' (mode 600).');
    return;
  }
  if (group === 'session' && id && (verb === 'children' || verb === 'usage')) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/${verb}`), null, 2));
    return;
  }
  if (group === 'children' && id && ['inspect', 'result', 'ack'].includes(verb ?? '')) {
    if (verb === 'ack') {
      const result_id = option('--result');
      if (!result_id) throw new Error('Supply the result ID with --result');
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}/ack`, {
            result_id,
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
    } else
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}${verb === 'result' ? '/result' : ''}`),
          null,
          2,
        ),
      );
    return;
  }
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
    const provider = option('--provider') ?? 'offline';
    const model = option('--model');
    const cap = option('--max-output-tokens');
    const workspace = option('--workspace-id');
    const route = providerRoute(
      provider,
      model,
      cap === undefined ? undefined : Number(cap),
      workspace,
    );
    const effectSocket = option('--effect-socket');
    const opaque = args.includes('--effect-opaque');
    if (foreground) {
      const service = await SalaamService.open({
        stateDir: state,
        providerRoute: route,
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
    let health: { provider_route?: unknown } | undefined;
    try {
      health = await call(socket, '/v1/health');
    } catch {}
    if (health) {
      if (canonical(health.provider_route ?? providerRoute()) !== canonical(route))
        throw new Error('Service is already running with another provider route; stop it first');
      console.log('Salaam service already running');
      return;
    }
    if (route.provider === 'anthropic') loadApiKey();
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
        '--provider',
        provider,
        ...(model ? ['--model', model] : []),
        ...(cap ? ['--max-output-tokens', cap] : []),
        ...(workspace ? ['--workspace-id', workspace] : []),
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
  const help = cliHelp(group);
  if (args.length === 1 && help) console.log(help);
  else {
    console.error('Unknown or incomplete command. Run salaam --help.');
    process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
