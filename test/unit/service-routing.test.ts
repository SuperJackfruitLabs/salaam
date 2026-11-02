import { expect, test } from 'vitest';
import { request } from 'node:http';
import { fixture, fake, create, ready } from '../helpers.js';

// How the service matches a request to a route: exact paths, wrong methods, routes that fall
// through to the next one after their own checks, and each route family's own not-found answer.
// Most of these routes have no other test; the cases hold the matching while handle() becomes a
// route table.

interface Reply {
  status: number;
  body: unknown;
}

function send(socketPath: string, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ agent: false, socketPath, method, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const error = (status: number, code: string, message: string): Reply => ({
  status,
  body: { code, error: message },
});

/** [method, path (SID is a live session), body, the reply]. */
const OPERATOR: [string, string, string | undefined, Reply][] = [
  ['PUT', '/v1/health', '{}', error(404, 'not_found', 'Route not implemented')],
  ['GET', '/v1/health/', undefined, error(404, 'not_found', 'Route not implemented')],
  ['GET', '/v1/sessions/', undefined, error(404, 'not_found', 'Route not implemented')],
  ['GET', '/v1/attempts/x/extra', undefined, error(404, 'not_found', 'Route not implemented')],
  ['GET', '/v1/sessions/nope', undefined, error(404, 'not_found', 'Session not found')],
  [
    'GET',
    '/v1/station/calls/x',
    undefined,
    error(409, 'station_disabled', 'Station execution is unavailable'),
  ],
  [
    'GET',
    '/v1/schedules/x/occurrences',
    undefined,
    error(404, 'not_found', 'Recurring job not found'),
  ],
  [
    'PUT',
    '/v1/schedules/x/occurrences?offset=abc',
    '{}',
    error(400, 'invalid_field', 'Invalid offset'),
  ],
  ['POST', '/v1/schedules/x/update', '{}', error(400, 'invalid_field', 'Invalid client_id')],
  ['GET', '/v1/jobs/x/extra', undefined, error(404, 'not_found', 'Job route not found')],
  ['PUT', '/v1/inbox', '{}', error(404, 'not_found', 'Inbox route not found')],
  ['GET', '/v1/inbox/x/extra', undefined, error(404, 'not_found', 'Inbox item not found')],
  ['POST', '/v1/harnesses', '{}', error(404, 'not_found', 'External worker route not found')],
  ['GET', '/v1/harnesses/x', undefined, error(404, 'not_found', 'External worker not found')],
  [
    'POST',
    '/v1/agentpod/work-trace',
    '{}',
    error(409, 'authority_disabled', 'AgentPod authority requires reviewed --agentpod-config pins'),
  ],
  [
    'POST',
    '/v1/agentpod/x',
    '{',
    error(409, 'authority_disabled', 'AgentPod authority requires reviewed --agentpod-config pins'),
  ],
  ['GET', '/v1/workers/x/proposal', undefined, error(404, 'not_found', 'Worker not found')],
  ['DELETE', '/v1/workers/x/proposal', '{}', error(404, 'not_found', 'Worker not found')],
  ['POST', '/v1/tasks/x/team/assign', '{}', error(404, 'not_found', 'Task not found')],
  ['POST', '/v1/tasks/x/verify', '{}', error(400, 'invalid_field', 'Invalid client_id')],
  ['POST', '/v1/tasks/x/cancel', '{}', error(400, 'invalid_field', 'Invalid client_id')],
  ['POST', '/v1/tasks/x/extra/a/b', '{', error(400, 'invalid_json', 'Invalid JSON')],
  ['GET', '/v1/compactions/x', undefined, error(404, 'not_found', 'Compaction not found')],
  [
    'GET',
    '/v1/sessions/SID/local-tasks/x',
    undefined,
    error(403, 'background_denied', 'Background commands are not admitted'),
  ],
  [
    'POST',
    '/v1/sessions/SID/local-tasks/x/stop',
    '{}',
    error(403, 'background_denied', 'Background commands are not admitted'),
  ],
  [
    'POST',
    '/v1/sessions/SID/hooks/trust',
    '{}',
    error(403, 'hooks_denied', 'Hooks run only in your own desk sessions'),
  ],
  ['POST', '/v1/sessions/SID/agents/admit', '{}', error(400, 'invalid_field', 'Invalid client_id')],
  ['PUT', '/v1/sessions/SID/agents/revoke', '{}', error(400, 'invalid_field', 'Invalid client_id')],
  [
    'PUT',
    '/v1/sessions/SID/approval-rules',
    '{}',
    error(400, 'invalid_field', 'Invalid client_id'),
  ],
  [
    'POST',
    '/v1/sessions/SID/commands/x/reconcile',
    '{}',
    error(400, 'invalid_field', 'Invalid client_id'),
  ],
  ['POST', '/v1/sessions/SID/commands/x/y', '{', error(400, 'invalid_json', 'Invalid JSON')],
  ['POST', '/v1/sessions/SID/artifacts', '{}', error(400, 'invalid_field', 'Invalid request_id')],
  ['POST', '/v1/sessions/SID/submissions', '{', error(400, 'invalid_json', 'Invalid JSON')],
  [
    'GET',
    '/v1/sessions/SID/workspace/diff',
    undefined,
    error(409, 'workspace_unavailable', 'Owned coding workspace is unavailable'),
  ],
];

const BRIDGE: [string, string, Reply][] = [
  ['GET', '/worker/a/b', error(404, 'not_found', 'Bridge route not found')],
  ['POST', '/worker/a', error(404, 'not_found', 'Bridge route not found')],
  ['POST', '/v1/health', error(404, 'not_found', 'Bridge route not found')],
  ['POST', '/managed-toolkit/v1/verify', error(404, 'not_found', 'Bridge route not found')],
  ['POST', '/worker/a/b', error(403, 'unauthorized', 'Invalid worker credentials')],
];

test('requests reach the same route, or the same not-found answer', async () => {
  const f = await fixture(fake());
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    for (const [method, path, body, reply] of OPERATOR)
      expect(
        await send(f.service.socket, method, path.replace('SID', session.id), body),
        `${method} ${path}`,
      ).toEqual(reply);
    for (const [method, path, reply] of BRIDGE)
      expect(
        await send(f.service.bridgeSocket, method, path, '{}'),
        `bridge ${method} ${path}`,
      ).toEqual(reply);
    const inventory = await send(f.service.socket, 'GET', '/v1/command-inventory');
    expect(inventory).toMatchObject({ status: 200, body: { version: 1, surface: 'salaam-tui' } });
    const agents = await send(f.service.socket, 'GET', `/v1/sessions/${session.id}/agents/admit`);
    expect(agents.status).toBe(200);
    expect(Array.isArray(agents.body)).toBe(true);
  } finally {
    await f.close();
  }
});
