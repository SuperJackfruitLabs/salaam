import { expect, test } from 'vitest';
import {
  permissionKind,
  providerOutcome,
  acpFailure,
  toolMetadata,
  toolTitle,
  parseAcpFailure,
  providerRefusalEvent,
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
test('operator MCP calls are titled by server and tool, and a fetch is a fetch', () => {
  const call = { action: 'call', server: 'fetch', tool: 'fetch', arguments: { url: 'https://x' } };
  expect(toolTitle('salaam_operator_mcp', call)).toBe('fetch · fetch');
  expect(toolTitle('salaam_operator_mcp', JSON.stringify(call))).toBe('fetch · fetch');
  expect(toolMetadata('salaam_operator_mcp', call).kind).toBe('fetch');
  expect(toolMetadata('salaam_operator_mcp', { ...call, tool: 'search_issues' }).kind).toBe(
    'other',
  );
  expect(toolTitle('salaam_operator_mcp', { action: 'catalog' })).toBe('MCP catalog');
  expect(toolTitle('salaam_operator_mcp', { action: 'catalog', server: 'fetch' })).toBe(
    'MCP catalog · fetch',
  );
  expect(toolMetadata('salaam_operator_mcp', { action: 'catalog' }).kind).toBe('read');
  // A name that is not a plain identifier is not echoed into the title.
  expect(
    toolTitle('salaam_operator_mcp', { action: 'call', server: 'x\n<b>', tool: 'fetch' }),
  ).toBe('Operator MCP');
  expect(toolTitle('salaam_files', { action: 'read' })).toBe('salaam_files');
});
