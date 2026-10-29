import { expect, test } from 'vitest';
import {
  permissionKind,
  providerOutcome,
  acpFailure,
  toolMetadata,
  toolTitle,
  parseAcpFailure,
  providerRefusalEvent,
  planUpdate,
} from '../../src/acp-outcome.js';
import corpus from '../fixtures/agentpod-acp-v1.json' with { type: 'json' };
import { ServiceError } from '../../src/protocol.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';

for (const sample of corpus.failures)
  test(`shared ACP corpus: ${sample.name}`, () => {
    expect(!!parseAcpFailure(sample.value)).toBe(sample.accept);
  });
test('the actual provider producer emits the shared correlated quota failure', () => {
  const expected = corpus.failures[0]!.value;
  const outcome = providerOutcome(
    'error',
    JSON.stringify({ error: { type: 'insufficient_quota', message: 'Fixture quota exhausted' } }),
    { ...OFFLINE_ROUTE, provider: 'fixture', model: 'fixture-model' },
    402,
  );
  expect({
    ...outcome.failure,
    sessionId: expected.sessionId,
    requestId: expected.requestId,
    attemptId: expected.attemptId,
  }).toEqual(expected);
});
test.each([
  ['anthropic-messages', { delta: { stop_reason: 'refusal' } }],
  ['google-generative-ai', { candidates: [{ finishReason: 'SAFETY' }] }],
  ['google-vertex', { candidates: [{ finishReason: 'SPII' }] }],
  ['bedrock-converse-stream', { messageStop: { stopReason: 'guardrail_intervened' } }],
  ['openai-completions', { choices: [{ delta: { refusal: 'Fixture refusal' } }] }],
  ['openai-responses', { type: 'response.refusal.delta' }],
  ['azure-openai-responses', { type: 'response.refusal.done' }],
  ['openai-codex-responses', { response: { output: [{ content: [{ type: 'refusal' }] }] } }],
])('provider refusal survives SDK normalization for %s', (api, event) => {
  expect(providerRefusalEvent(api as string, event)).toBe(true);
  expect(providerRefusalEvent(api as string, { unrelated: 'refusal' })).toBe(false);
});

test.each([
  ['length', '', undefined, 'max_tokens', 'max_tokens'],
  ['refusal', '', undefined, 'refusal', 'refusal'],
  [
    'error',
    '401 {"error":{"type":"authentication_error","message":"Fixture access denied"}}',
    401,
    'error',
    'auth',
  ],
  [
    'error',
    '402 {"error":{"type":"insufficient_quota","message":"Fixture billing exhausted"}}',
    402,
    'error',
    'quota',
  ],
  ['error', 'Provider request failed (HTTP 429)', 429, 'error', 'rate_limit'],
  ['error', 'Provider request failed (HTTP 503)', 503, 'error', 'provider_unavailable'],
] as const)(
  'typed provider outcome %s / %s never becomes end_turn',
  (reason, message, status, stop, kind) => {
    expect(providerOutcome(reason, message, OFFLINE_ROUTE, status)).toMatchObject({
      version: 1,
      stopReason: stop,
      failure: { version: 1, kind, provider: OFFLINE_ROUTE.provider },
    });
  },
);
test('provider secrets and arbitrary body fields never cross failure metadata', () => {
  const result = providerOutcome(
    'error',
    '401 {"error":{"type":"authentication_error","message":"SECRET fixture-key-123"},"headers":{"Authorization":"private"}}',
    OFFLINE_ROUTE,
    401,
    ['fixture-key-123'],
  );
  expect(JSON.stringify(result)).not.toMatch(/SECRET|fixture-key-123|Authorization/);
  expect(result.failure?.kind).toBe('auth');
  expect(
    providerOutcome(
      'error',
      '{"error":{"message":"Unrelated upstream private content"}}',
      OFFLINE_ROUTE,
      429,
    ).failure,
  ).toMatchObject({ kind: 'rate_limit', message: 'Provider request failed (HTTP 429)' });
  expect(acpFailure(new ServiceError('authority_expired', 'Work lease expired')).kind).toBe(
    'cancelled',
  );
});
test('known tool kinds use their actual guarded root and never invent source locations', () => {
  expect(
    toolMetadata('salaam_files', { action: 'read', path: 'src/a.ts' }, '/guarded/owned'),
  ).toEqual({ kind: 'read', locations: [{ path: '/guarded/owned/src/a.ts' }] });
  expect(
    toolMetadata('salaam_files', { action: 'patch', path: 'a.ts', content: null }, '/guarded/owned')
      .kind,
  ).toBe('delete');
  expect(
    toolMetadata(
      'salaam_files',
      { action: 'patch', path: 'a.ts', content: 'new' },
      '/guarded/owned',
    ).kind,
  ).toBe('edit');
  expect(toolMetadata('salaam_files', { action: 'search' }).kind).toBe('search');
  expect(toolMetadata('salaam_command', { action: 'start' }).kind).toBe('execute');
  expect(toolMetadata('salaam_repository', { action: 'read', path: 'a.ts' })).toEqual({
    kind: 'read',
    locations: [],
  });
  expect(
    toolMetadata('salaam_files', { action: 'read', path: '../outside' }, '/guarded/owned')
      .locations,
  ).toEqual([]);
  expect(toolMetadata('salaam_review', {})).toEqual({ kind: 'other', locations: [] });
  expect(toolMetadata('salaam_repository', { action: 'patch', path: 'a.ts' }).kind).toBe('other');
  expect(toolMetadata('salaam_files', { action: 'unknown', path: 'a.ts' }).kind).toBe('other');
});

test('approval kinds let AgentPod modes approve edits without approving commands', () => {
  expect(permissionKind('workspace')).toBe('edit');
  expect(permissionKind('harness')).toBe('execute');
  for (const kind of ['review', 'effect', 'mcp', 'unknown'])
    expect(permissionKind(kind)).toBe('other');
});

// Staging E2E 2026-10-23: six fetches showed as six "salaam_operator_mcp" cards of kind "other".
// Parity with a board agent (operator ruling 2026-10-28): a card reads "tool: what it acted on".
test('operator MCP calls are titled by tool and key argument, and a fetch is a fetch', () => {
  const call = {
    action: 'call',
    server: 'fetch',
    tool: 'fetch',
    arguments: { url: 'https://x.test/a/b' },
  };
  expect(toolTitle('salaam_operator_mcp', call)).toBe('fetch: x.test/a/b');
  expect(toolTitle('salaam_operator_mcp', JSON.stringify(call))).toBe('fetch: x.test/a/b');
  expect(toolMetadata('salaam_operator_mcp', call).kind).toBe('fetch');
  expect(toolMetadata('salaam_operator_mcp', { ...call, tool: 'search_issues' }).kind).toBe(
    'other',
  );
  expect(toolTitle('salaam_operator_mcp', { action: 'catalog' })).toBe('MCP catalog');
  expect(toolTitle('salaam_operator_mcp', { action: 'catalog', server: 'fetch' })).toBe(
    'MCP catalog: fetch',
  );
  expect(toolMetadata('salaam_operator_mcp', { action: 'catalog' }).kind).toBe('read');
  // A name that is not a plain identifier is not echoed into the title.
  expect(
    toolTitle('salaam_operator_mcp', { action: 'call', server: 'x\n<b>', tool: 'fetch' }),
  ).toBe('MCP call: fetch');
  // No step reads as a bare tool name: a call that arrived without input, or with an action
  // the tool does not know, still says so in plain words.
  expect(toolTitle('salaam_operator_mcp', { action: 'other' })).toBe('MCP request: other');
  expect(toolTitle('salaam_operator_mcp', undefined)).toBe('MCP request (no input)');
  expect(toolTitle('salaam_operator_mcp', null)).toBe('MCP request (no input)');
  expect(toolTitle('salaam_operator_mcp', {})).toBe('MCP request (no input)');
  expect(toolTitle('salaam_files', { action: 'read' })).toBe('read');
});

test('workspace and board tools name what they acted on, the way a board agent does', () => {
  expect(
    toolTitle('salaam_station', { action: 'patch', path: 'runs/r/answer.md', content: 'x' }),
  ).toBe('write: runs/r/answer.md');
  expect(toolTitle('salaam_station', { action: 'patch', path: 'old.md', content: null })).toBe(
    'delete: old.md',
  );
  expect(toolTitle('salaam_station', { action: 'read', path: 'src/a.ts' })).toBe('read: src/a.ts');
  expect(toolTitle('salaam_station', { action: 'search', query: 'TODO' })).toBe('search: TODO');
  expect(toolTitle('salaam_station', { action: 'inspect' })).toBe('inspect workspace');
  expect(toolTitle('salaam_station', { action: 'check', command: 'npm test -- --run' })).toBe(
    'check: npm test -- --run',
  );
  expect(toolTitle('salaam_board', { action: 'card' })).toBe('read this card');
  expect(toolTitle('salaam_board', { action: 'attempts' })).toBe('read this card’s runs');
  expect(toolTitle('salaam_board', { action: 'library_search', query: 'gateway timeout' })).toBe(
    'library_search: gateway timeout',
  );
  expect(
    toolTitle('salaam_board', { action: 'library_get', item_id: 'itm_0123456789abcdef' }),
  ).toBe('library_get: itm_0123456789abcdef');
  expect(toolTitle('salaam_review', {})).toBe('salaam_review');
  expect(toolMetadata('salaam_board', { action: 'library_search', query: 'x' }).kind).toBe('read');
});

test('a title never carries a secret from a URL, a control character, or more than 80 characters', () => {
  const call = (url: string) => ({
    action: 'call',
    server: 'fetch',
    tool: 'fetch',
    arguments: { url },
  });
  expect(toolTitle('salaam_operator_mcp', call('https://user:pass@x.test/p?token=abc#frag'))).toBe(
    'fetch: x.test/p',
  );
  expect(toolTitle('salaam_operator_mcp', call('not a url'))).toBe('fetch');
  expect(toolTitle('salaam_station', { action: 'read', path: 'a\n\u0007b.md' })).toBe(
    'read: a b.md',
  );
  const long = toolTitle('salaam_station', { action: 'read', path: 'd/'.repeat(100) + 'f.md' });
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith('…')).toBe(true);
});

test('a failed tool names itself, and only a plain identifier is echoed', async () => {
  const { toolFailureMessage } = await import('../../src/supervisor.js');
  expect(toolFailureMessage('salaam_station')).toBe('Tool execution failed (tool salaam_station)');
  for (const bad of [undefined, 7, '', 'x'.repeat(65), 'rm -rf /', 'a\nb'])
    expect(toolFailureMessage(bad)).toBe('Tool execution failed');
});

test('a durable task plan is the ACP plan update the protocol defines', () => {
  const step = (key: string, title: string, state: string) => ({
    key,
    title,
    instruction: 'do ' + key,
    depends_on: [],
    checks: [],
    id: key,
    state,
    attempt_id: null,
    review: null,
  });
  const update = planUpdate({
    steps: [
      step('a', 'Read the RFC', 'completed'),
      step('b', 'Write answer.md', 'running'),
      step('c', 'Review', 'awaiting_review'),
      step('d', 'Publish', 'pending'),
      step('e', 'Queued', 'queued'),
      step('f', 'Stopped', 'cancelled'),
      step('g', 'Broke', 'failed'),
      step('h', 'Cut off', 'interrupted'),
    ],
  } as never);
  expect(update).toEqual({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Read the RFC', priority: 'medium', status: 'completed' },
      { content: 'Write answer.md', priority: 'medium', status: 'in_progress' },
      { content: 'Review', priority: 'medium', status: 'in_progress' },
      { content: 'Publish', priority: 'medium', status: 'pending' },
      { content: 'Queued', priority: 'medium', status: 'pending' },
      // ACP has no failed status; the entry says what happened instead of claiming progress.
      { content: 'Stopped (cancelled)', priority: 'medium', status: 'pending' },
      { content: 'Broke (failed)', priority: 'medium', status: 'pending' },
      { content: 'Cut off (interrupted)', priority: 'medium', status: 'pending' },
    ],
  });
  expect(planUpdate(null)).toBe(null);
  expect(planUpdate({ steps: [] } as never)).toBe(null);
});

// Cards F and G (2026-10-28): the last unreadable titles. A long patch's input is clipped before it
// is titled, so it no longer parses as JSON; an operator MCP call may name only a server or a tool.
test('a clipped tool input is still titled by what it acted on, and a partial MCP call says what it named', () => {
  const clipped = JSON.stringify({
    action: 'patch',
    path: 'runs/r/answer.md',
    content: 'x'.repeat(9000),
  }).slice(0, 8192);
  expect(toolTitle('salaam_station', clipped)).toBe('write: runs/r/answer.md');
  const clippedRead = '{"action":"check","command":"npm test","content":"' + 'y'.repeat(9000);
  expect(toolTitle('salaam_station', clippedRead)).toBe('check: npm test');
  expect(toolTitle('salaam_station', 'not json at all')).toBe('salaam_station');
  expect(toolTitle('salaam_operator_mcp', { action: 'call', server: 'fetch' })).toBe(
    'MCP call: fetch',
  );
  expect(toolTitle('salaam_operator_mcp', { action: 'call', tool: 'fetch' })).toBe(
    'MCP call: fetch',
  );
  expect(toolTitle('salaam_operator_mcp', { action: 'call' })).toBe('MCP call');
});
