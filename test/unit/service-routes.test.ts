import { expect, test } from 'vitest';
import {
  BRIDGE_NOT_FOUND,
  OPERATOR_NOT_FOUND,
  bridgeRoutes,
  controllers,
  operatorRoutes,
} from '../../src/service/routes.js';
import { match, route, type Route } from '../../src/service/router.js';
import { fixture } from '../helpers.js';

// The route tables, method and pattern, in match order: the routes the service's one if-chain
// served before it became a table (recorded at a500bb9). A dropped, added or reordered route fails
// here; where patterns overlap, the order decides which one answers.

const BRIDGE = ['POST /worker/:worker/:method'];

const OPERATOR = [
  'POST url:/managed-toolkit/v1/verify',
  'POST url:/managed-toolkit/v1/control',
  'GET /v1/a2a/grants/:assignment',
  'GET /v1/harnesses',
  'GET /v1/harnesses/:worker',
  'POST /v1/harnesses/:worker/reconcile',
  '* /v1/harnesses/:worker/**',
  '* /v1/harnesses/**',
  'POST /v1/agentpod/attach',
  'POST /v1/agentpod/status',
  'POST /v1/agentpod/work-capability',
  'POST /v1/agentpod/work-restore',
  'POST /v1/agentpod/work-checkpoints',
  'POST /v1/agentpod/work-checkpoint-diff',
  'POST /v1/agentpod/work-status',
  'POST /v1/agentpod/work-progress',
  'POST /v1/agentpod/work-abandon',
  'POST /v1/agentpod/work-fail',
  'POST /v1/agentpod/work-expire',
  'POST /v1/agentpod/work-settle',
  'POST /v1/agentpod/work-trace',
  'POST /v1/agentpod/work-evidence-artifacts',
  'POST /v1/agentpod/work-evidence',
  'POST /v1/agentpod/work-completion',
  'POST /v1/agentpod/work-read',
  'POST /v1/agentpod/work-decisions',
  'POST /v1/agentpod/work-decision',
  'POST /v1/agentpod/work-admit',
  'POST /v1/agentpod/mcp-assign',
  'POST /v1/agentpod/admit',
  'POST /v1/agentpod/renew',
  'POST /v1/agentpod/revoke',
  'POST /v1/agentpod/:method',
  'GET /v1/job-occurrences/:occurrence',
  'GET /v1/inbox',
  'GET /v1/inbox/:item/**',
  'POST /v1/inbox/:item/ack',
  '* /v1/inbox/**',
  'GET /v1/schedules',
  'GET /v1/schedules/:schedule/occurrences/**',
  'GET /v1/schedules/:schedule/**',
  'POST /v1/schedules',
  'POST /v1/schedules/:schedule/update',
  'POST /v1/schedules/:schedule/run',
  '* /v1/schedules/**',
  'GET /v1/jobs',
  'GET /v1/jobs/:job',
  'POST /v1/jobs',
  'POST /v1/jobs/:job/run',
  'POST /v1/jobs/:job/cancel',
  '* /v1/jobs/**',
  'POST /v1/integrations/:worker/resolve',
  'GET /v1/integrations/:worker',
  'GET /v1/workers/:worker/proposal',
  'POST /v1/workers/:worker/integrate',
  '* /v1/workers/:worker/:action',
  'GET /v1/tasks/:task/team',
  'POST /v1/tasks/:task/team/assign',
  'POST /v1/tasks/:task/team/send',
  'POST /v1/tasks/:task/team/:assignment/run',
  'POST /v1/tasks/:task/team/:assignment/reject',
  'POST /v1/tasks/:task/team/:assignment/receive',
  'POST /v1/tasks/:task/team/:assignment/ack',
  'POST /v1/tasks/:task/team/:assignment/:action',
  'POST /v1/tasks/:task/team/**',
  '* /v1/tasks/:task/team/**',
  'GET /v1/tasks',
  'GET /v1/tasks/:task/checkpoints',
  'GET /v1/tasks/:task/restores',
  'GET /v1/tasks/:task',
  'GET /v1/tasks/:task/history',
  'POST /v1/tasks',
  'POST /v1/tasks/:task/verify',
  'POST /v1/tasks/:task/finish',
  'POST /v1/tasks/:task/checkpoint',
  'POST /v1/tasks/:task/restore',
  'POST /v1/tasks/:task/auto',
  'POST /v1/tasks/:task/cancel',
  'POST /v1/tasks/:task/revise',
  'POST /v1/tasks/:task/steps/:step/run',
  'POST /v1/tasks/:task/steps/:step/complete',
  'POST /v1/tasks/**',
  'GET path:/v1/command-inventory',
  'GET path:/v1/health',
  'POST path:/v1/shutdown',
  'GET path:/v1/sessions',
  'POST path:/v1/sessions',
  'GET /v1/compactions/:compaction',
  'POST /v1/compactions/:compaction/cancel/**',
  '* /v1/compactions/:compaction/**',
  'GET /v1/sessions/:session/approval-rules',
  'POST /v1/sessions/:session/approval-rules',
  'POST /v1/sessions/:session/approval-rules/:rule/remove',
  '* /v1/sessions/:session/approval-rules',
  '* /v1/sessions/:session/approval-rules/:rule/:action',
  'GET /v1/sessions/:session/permissions',
  'POST /v1/sessions/:session/permissions',
  'GET /v1/sessions/:session/danger-classifier',
  'POST /v1/sessions/:session/danger-classifier',
  'GET /v1/sessions/:session/hooks',
  'POST /v1/sessions/:session/hooks/trust',
  'POST /v1/sessions/:session/hooks/revoke',
  'POST /v1/sessions/:session/hooks/:action',
  '* /v1/sessions/:session/hooks/**',
  'GET /v1/sessions/:session/local-tasks',
  'GET /v1/sessions/:session/local-tasks/:task',
  'POST /v1/sessions/:session/local-tasks/:task/stop',
  '* /v1/sessions/:session/local-tasks/**',
  'GET /v1/sessions/:session/local-diff',
  'GET /v1/sessions/:session/local-edits',
  'POST /v1/sessions/:session/steer',
  'POST /v1/sessions/:session/undo-reconcile',
  'GET /v1/sessions/:session/undo',
  'POST /v1/sessions/:session/undo',
  'GET /v1/sessions/:session/checkpoints',
  'GET /v1/sessions/:session/rewind',
  'POST /v1/sessions/:session/rewind',
  'GET /v1/sessions/:session/review',
  'GET /v1/sessions/:session/review/hunks',
  'POST /v1/sessions/:session/review',
  'POST /v1/sessions/:session/fork',
  'GET /v1/sessions/:session/name',
  'POST /v1/sessions/:session/name',
  'GET /v1/sessions/:session/revocation',
  'POST /v1/sessions/:session/revoke',
  'GET /v1/sessions/:session/agents/**',
  '* /v1/sessions/:session/agents/admit/**',
  '* /v1/sessions/:session/agents/revoke/**',
  '* /v1/sessions/:session/agents/**',
  'GET /v1/sessions/:session/activity/**',
  'GET /v1/sessions/:session/workspace/diff/**',
  'GET /v1/sessions/:session/workspace/**',
  'POST /v1/sessions/:session/workspace/refresh/**',
  'GET /v1/sessions/:session/commands',
  'GET /v1/sessions/:session/commands/:command/logs/**',
  'GET /v1/sessions/:session/commands/:command/**',
  'POST /v1/sessions/:session/commands',
  'POST /v1/sessions/:session/commands/:command/cancel/**',
  'POST /v1/sessions/:session/commands/:command/reconcile/**',
  'POST /v1/sessions/:session/commands/**',
  'GET /v1/sessions/:session/context',
  'POST /v1/sessions/:session/context/plan/**',
  'POST /v1/sessions/:session/context/admit/**',
  'GET /v1/sessions/:session/task/**',
  'GET /v1/sessions/:session/history/**',
  'POST /v1/sessions/:session/task/**',
  'POST /v1/sessions/:session/compact/**',
  'POST /v1/sessions/:session/artifacts/**',
  'GET /v1/approvals',
  'GET /v1/approvals/:approval',
  'POST /v1/approvals/:approval/decision/**',
  'GET /v1/toolkit/calls/:call',
  'POST /v1/toolkit/calls/:call/resolution',
  'GET /v1/operations/:operation',
  'POST /v1/operations/:operation/reconcile/**',
  'POST /v1/operations/:operation/resolution/**',
  'GET /v1/station/calls/:call',
  'GET /v1/attempts/:attempt',
  'POST /v1/attempts/:attempt/cancel/**',
  'GET /v1/children/:child',
  'GET /v1/children/:child/result/**',
  'POST /v1/children/:child/ack/**',
  '* /v1/children/:child/**',
  'GET /v1/sessions/:session/children/**',
  'GET /v1/sessions/:session/usage/**',
  'GET /v1/sessions/:session',
  'GET /v1/sessions/:session/snapshot/**',
  'GET /v1/sessions/:session/tool-metadata/**',
  'GET /v1/sessions/:session/cancellations/**',
  'POST /v1/sessions/:session/cancellations/**',
  'POST /v1/sessions/:session/control/**',
  'POST /v1/sessions/:session/route/**',
  'POST /v1/sessions/:session/resume/**',
  'GET /v1/sessions/:session/events/**',
  'POST /v1/sessions/:session/submissions/**',
  'POST /v1/sessions/:session/probe/**',
];

const table = (routes: Route[]) => routes.map((r) => `${r.method} ${r.pattern}`);

test('the route tables hold every route in its order', async () => {
  const f = await fixture();
  try {
    const built = controllers(f.service);
    expect(table(bridgeRoutes(built))).toEqual(BRIDGE);
    expect(table(operatorRoutes(built))).toEqual(OPERATOR);
    expect([BRIDGE_NOT_FOUND, OPERATOR_NOT_FOUND]).toEqual([
      'Bridge route not found',
      'Route not implemented',
    ]);
  } finally {
    await f.close();
  }
});

const none = () => undefined;
function matches(r: Route, method: string, raw: string) {
  const url = new URL(raw, 'http://local');
  return match(r, { method, url: raw }, url, url.pathname.split('/').filter(Boolean));
}

test('a pattern matches as the if-chain did', () => {
  const one = route('GET', '/v1/sessions/:session', none);
  expect(matches(one, 'GET', '/v1/sessions/s1')).toEqual({ session: 's1' });
  expect(matches(one, 'GET', '/v1/sessions/s1/')).toEqual({ session: 's1' });
  expect(matches(one, 'GET', '/v1//sessions/s1')).toEqual({ session: 's1' });
  expect(matches(one, 'POST', '/v1/sessions/s1')).toBeUndefined();
  expect(matches(one, 'GET', '/v1/sessions/s1/x')).toBeUndefined();
  expect(matches(one, 'GET', '/v1/sessions')).toBeUndefined();
  const rest = route('*', '/v1/sessions/:session/agents/**', none);
  expect(matches(rest, 'PUT', '/v1/sessions/s1/agents')).toEqual({ session: 's1' });
  expect(matches(rest, 'PUT', '/v1/sessions/s1/agents/a/b')).toEqual({ session: 's1' });
  expect(matches(rest, 'PUT', '/v1/sessions/s1/agent')).toBeUndefined();
  const path = route('GET', 'path:/v1/health', none);
  expect(matches(path, 'GET', '/v1/health?x=1')).toEqual({});
  expect(matches(path, 'GET', '/v1/health/')).toBeUndefined();
  expect(matches(path, 'GET', '/v1//health')).toBeUndefined();
  const exact = route('POST', 'url:/managed-toolkit/v1/verify', none);
  expect(matches(exact, 'POST', '/managed-toolkit/v1/verify')).toEqual({});
  expect(matches(exact, 'POST', '/managed-toolkit/v1/verify?x=1')).toBeUndefined();
});
