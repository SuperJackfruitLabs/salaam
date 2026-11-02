import { expect, test } from 'vitest';
import { fixture, fake, ready, until } from '../helpers.js';
import { call } from '../../src/core/transport.js';
import { ServiceError, type Session } from '../../src/core/protocol.js';
import type { Launch } from '../../src/runtime/supervisor.js';

// Phase 4 (modularity): how the worker bridge answers each kind of request from a ready worker
// with no active attempt, in the order it checks them (credentials, epoch, availability,
// execution authority, readiness, then the request's own authority), and what each refusal does
// to the worker. Pinned before bridge() is split into one handler per kind of request.

type Body = Record<string, unknown>;
const CASES: [label: string, method: string, body?: Body, token?: string][] = [
  ['heartbeat', 'heartbeat'],
  ['context', 'context'],
  ['policy for an admitted tool', 'policy', { tool: 'salaam_probe' }],
  ['tool for an admitted tool', 'tool', { tool: 'salaam_probe' }],
  ['policy for a tool outside policy', 'policy', { tool: 'bash' }],
  ['an unknown method', 'nope'],
  ['a second handshake', 'handshake'],
  ['failure', 'failure', { reason: 'x' }],
  ['a wrong token', 'heartbeat', {}, 'x'.repeat(64)],
  ['a stale epoch', 'heartbeat', { epoch: 99 }],
  ['history', 'history', {}],
  ['history of a missing entry', 'history', { entry_id: 'missing' }],
  ['team.send', 'team.send', { request_id: 'r' }],
  ['specialist.read', 'specialist.read', { tool_call_id: 't', args: {} }],
  ['specialist.report', 'specialist.report', { findings: [] }],
  ['provider.auth', 'provider.auth'],
  ['operator_mcp.catalog', 'operator_mcp.catalog'],
  ['toolkit.catalog', 'toolkit.catalog'],
  ['mcp.catalog', 'mcp.catalog'],
  ['board.read', 'board.read', { tool_call_id: 't', args: {} }],
  ['station.read', 'station.read', { tool_call_id: 't', args: { action: 'list' } }],
  ['web.search', 'web.search', { tool_call_id: 't', args: { query: 'q' } }],
  ['bgtask.list', 'bgtask.list'],
  ['local.prepare', 'local.prepare', { tool_call_id: 't', args: {} }],
  ['local.read', 'local.read', { tool_call_id: 't', args: {} }],
  ['coding.files', 'coding.files', { tool_call_id: 't', args: {} }],
  ['operation.prepare', 'operation.prepare', { tool_call_id: 't', kind: 'review' }],
  ['child.spawn', 'child.spawn', { step_key: 's', prompt: 'p', budget: 1 }],
  ['child.list', 'child.list'],
  ['compaction.plan', 'compaction.plan'],
  ['usage', 'usage', { source_key: 'k', usage: {} }],
  ['model', 'model', { provider: 'salaam-proof', model: 'scripted', context_digest: 'x' }],
];

function workerConfig(value: unknown): { token: string; epoch: number } {
  if (
    value &&
    typeof value === 'object' &&
    'token' in value &&
    typeof value.token === 'string' &&
    'epoch' in value &&
    typeof value.epoch === 'number'
  )
    return { token: value.token, epoch: value.epoch };
  throw new Error('launch has no worker configuration');
}

test('the worker bridge answers each kind of request as recorded', async () => {
  const seen: Launch[] = [];
  const base = fake().launch;
  if (!base) throw new Error('fake() has no launch');
  const f = await fixture({
    ...fake(),
    launch: (launch) => {
      seen.push(launch);
      return base(launch);
    },
  });
  const out: Record<string, unknown> = {};
  try {
    for (const [n, [label, method, body = {}, token]] of CASES.entries()) {
      const session = await call<Session>(f.service.socket, '/v1/sessions', {
        request_id: `create-${n}`,
        cwd: f.dir,
      });
      await ready(f.service, session.id);
      const launch = seen.find((x) => x.args.includes(session.id));
      const config = workerConfig(JSON.parse(String(launch?.env.SALAAM_WORKER_CONFIG)));
      const before = f.service.store.session(session.id).seq;
      let answer: unknown;
      try {
        const result = await f.service.supervisor.bridge(
          session.id,
          method,
          token ?? config.token,
          { epoch: config.epoch, ...body },
        );
        answer = { result: result === undefined ? '<undefined>' : result };
      } catch (error) {
        answer =
          error instanceof ServiceError
            ? { code: error.code, status: error.status, message: error.message }
            : { thrown: error instanceof Error ? error.message : String(error) };
      }
      // A refusal that fails the worker settles its state asynchronously.
      await until(
        () => f.service.supervisor.inspect(session.id).state,
        (s) => s === 'ready' || s === 'unhealthy',
      );
      const after = f.service.supervisor.inspect(session.id);
      out[label] = JSON.parse(
        JSON.stringify({
          answer,
          state: after.state,
          error: after.error ?? null,
          events: f.service.store
            .events(session.id, before, 1000)
            .map((e) => (e.kind === 'station.call_refused' ? { [e.kind]: e.payload } : e.kind)),
        })
          .split(session.id)
          .join('<session>')
          .replace(/[a-f0-9]{32}/g, '<hex32>'),
      );
    }
  } finally {
    await f.close();
  }
  expect(out).toMatchSnapshot();
});
