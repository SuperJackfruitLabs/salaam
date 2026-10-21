import { describe, expect, it } from 'vitest';
import type { Store } from '../../src/store.js';
import { canonical, digest } from '../../src/protocol.js';
import { committedToolkitResolutionEvidence, toolkitEvidence } from '../../src/toolkit-evidence.js';

const binding = {
  root_digest: digest('root'),
  profile_digest: digest('profile'),
  invocation_id: 'call-1',
  receipt_id: digest(['stk.managed-mcp.v1', digest('root'), 'call-1']),
  request_digest: digest('request'),
};
const body = {
  version: 1,
  ...binding,
  state: 'returned',
  cancellation_requested: false,
  root_revoked: true,
  authority: false,
  product_effect_verified: false,
};
const signed = (value: Record<string, unknown>) => ({ ...value, evidence_digest: digest(value) });

describe('historical Toolkit evidence', () => {
  it('accepts revoked historical protocol return without claiming effect or authority', () => {
    expect(toolkitEvidence(signed(body), binding)).toEqual(signed(body));
  });
  it.each([
    'root_digest',
    'profile_digest',
    'invocation_id',
    'receipt_id',
    'request_digest',
  ] as const)('rejects a self-consistent but foreign %s', (key) => {
    const foreign = { ...body, [key]: key === 'invocation_id' ? 'other' : digest('foreign') };
    expect(() => toolkitEvidence(signed(foreign), binding)).toThrow('Toolkit evidence');
  });
  it.each([
    { result: 'secret' },
    { args: {} },
    { config_path: '/private/config' },
    { authority: true },
    { product_effect_verified: true },
    { root_revoked: 0 },
    { decision_id: '' },
    { state: 'success' },
    { resolution_id: 'forged' },
    { version: 2 },
    { cancellation_requested: null },
  ])('rejects unexpected or widened projection %j', (patch) => {
    expect(() => toolkitEvidence(signed({ ...body, ...patch }), binding)).toThrow(
      'Toolkit evidence',
    );
  });
  it('rejects a changed digest and incomplete acknowledgement', () => {
    expect(() =>
      toolkitEvidence({ ...signed(body), evidence_digest: digest('wrong') }, binding),
    ).toThrow();
    expect(() =>
      toolkitEvidence(signed({ ...body, state: 'outcome_acknowledged' }), binding),
    ).toThrow();
    const acknowledged = {
      ...body,
      state: 'outcome_acknowledged',
      resolution_id: 'resolution-1',
      resolution_stop_digest: digest('stop'),
    };
    expect(toolkitEvidence(signed(acknowledged), binding).product_effect_verified).toBe(false);
  });

  function history() {
    const privateBinding = { workspace: '/private/workspace' };
    const request = {
      version: 1,
      root_digest: digest(privateBinding),
      invocation_id: 'call-1',
      profile_digest: digest('profile'),
      service: 'test',
      action: 'read',
      args: { secret: 'input' },
      approval: false,
      expires_at_ms: 1,
    };
    const call = {
      id: digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]),
      session_id: 'session',
      worker_epoch: 1,
      attempt_id: 'attempt',
      tool_call_id: 'tool',
      resource_id: 'resource',
      request_json: canonical(request),
      request_digest: digest(request),
      context_digest: digest('context'),
      action_pin: '{}',
      operation_id: null,
      state: 'outcome_unknown',
      revision: 3,
      receipt_json: '{"private":"result"}',
      cancel_requested: 1,
    };
    const context = {
      binding: privateBinding,
      call: { ...call, receipt_digest: digest(call.receipt_json) },
      stop: { path: '/private/stop' },
    };
    const input = { outcome: 'succeeded', evidence: 'private human explanation' };
    const row = {
      id: digest({ request: 'operator-1', input, context }),
      call_id: call.id,
      request_id: 'operator-1',
      call_revision: 3,
      request_digest: call.request_digest,
      operation_id: null,
      context_json: canonical(context),
      context_digest: digest(context),
      input_json: canonical(input),
      native_receipt_json: '',
    };
    row.native_receipt_json = canonical({
      id: call.id,
      request_digest: call.request_digest,
      state: 'outcome_acknowledged',
      resolution_id: row.id,
      resolution_stop_digest: digest(context.stop),
    });
    const store = {
      db: {
        isTransaction: true,
        prepare: (sql: string) => ({
          get: () => (sql.includes('toolkit_resolutions') ? row : call),
        }),
      },
    } as unknown as Store;
    return { store, call, row, root: request.root_digest };
  }
  it('projects committed acknowledgement and operator attestation separately without private bytes', () => {
    const h = history();
    const result = committedToolkitResolutionEvidence(h.store, h.call.id, h.root);
    expect(result).toMatchObject({
      native_state: 'outcome_acknowledged',
      outcome: 'succeeded',
      source: 'operator-attestation',
      product_effect_verified: false,
      authority: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|explanation|workspace|args|path/);
  });
  it.each(['revision', 'request', 'root', 'receipt', 'context'] as const)(
    'rejects stale or changed %s',
    (field) => {
      const h = history();
      if (field === 'revision') h.call.revision++;
      if (field === 'request') h.call.request_digest = digest('other');
      if (field === 'receipt')
        h.row.native_receipt_json = canonical({ id: 'foreign', state: 'returned' });
      if (field === 'context') h.row.context_digest = digest('other');
      expect(() =>
        committedToolkitResolutionEvidence(
          h.store,
          h.call.id,
          field === 'root' ? digest('foreign') : h.root,
        ),
      ).toThrow('Toolkit evidence');
    },
  );
  it('requires a read snapshot and reports missing committed metadata as unknown', () => {
    const store = {
      db: { isTransaction: true, prepare: () => ({ get: () => undefined }) },
    } as unknown as Store;
    expect(committedToolkitResolutionEvidence(store, 'legacy', binding.root_digest)).toBeNull();
    const h = history();
    Object.assign(h.store.db, { isTransaction: false });
    expect(() => committedToolkitResolutionEvidence(h.store, h.call.id, h.root)).toThrow(
      'snapshot',
    );
  });
});
