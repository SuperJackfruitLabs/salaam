import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

function fixture() {
  const dir = mkdtempSync('/tmp/sal-usage-evidence-');
  const path = join(dir, 'journal.sqlite');
  const store = new Store(path);
  const session = store.create(dir, 'create');
  return { dir, path, store, session };
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };

test('unreported, unknown and recorded zero remain distinct after journal reopen', () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    expect(f.store.usage.evidence(f.session.id)).toMatchObject({
      status: 'unreported',
      recorded_subtotal: null,
      observations: [],
    });
    f.store.usage.admit(f.session.id, undefined, 'request', 'test-provider', 'test-model');
    const unknown = f.store.usage.evidence(f.session.id);
    expect(unknown).toMatchObject({
      status: 'unknown',
      recorded_subtotal: null,
      cost_provenance: 'unknown',
      observations: [{ recorded_values: null, observation_digest: null, digest_verified: null }],
    });
    f.store.transaction(() =>
      f.store.usage.observe(f.session.id, 'request', 'test-provider', 'test-model', zero),
    );
    const recorded = f.store.usage.evidence(f.session.id);
    expect(recorded).toMatchObject({
      status: 'known',
      recorded_subtotal: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      cost_provenance: 'ledger-recorded-not-provider-bill',
      observations: [{ digest_verified: true, token_provenance: 'ledger-recorded' }],
    });
    f.store.close();
    reopened = new Store(f.path);
    expect(reopened.usage.evidence(f.session.id)).toEqual(recorded);
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('partial evidence exposes only a labelled recorded subtotal; replay does not add observations', () => {
  const f = fixture();
  try {
    const usage = { ...zero, input: 12, output: 3, cost: { total: 0.01 } };
    f.store.usage.admit(f.session.id, undefined, 'missing', 'test-provider', 'test-model');
    for (let i = 0; i < 2; i++)
      f.store.transaction(() =>
        f.store.usage.observe(
          f.session.id,
          'recorded',
          'test-provider',
          'test-model',
          usage,
          'estimated',
        ),
      );
    const before = f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    expect(f.store.usage.evidence(f.session.id)).toMatchObject({
      status: 'partial',
      coverage: { observations: 2, unknown: 1, recorded: 1, estimated: 1 },
      recorded_subtotal: { input_tokens: 12, output_tokens: 3, cost_usd: 0.01 },
    });
    expect(f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n).toBe(before);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('bounded observation details cannot masquerade as a complete record or include another session', () => {
  const f = fixture();
  try {
    const other = f.store.create(f.dir, 'other');
    f.store.usage.admit(other.id, undefined, 'foreign', 'test-provider', 'test-model');
    for (const key of ['one', 'two', 'three'])
      f.store.usage.admit(f.session.id, undefined, key, 'test-provider', 'test-model');
    const result = f.store.usage.evidence(f.session.id, 2);
    expect(result).toMatchObject({
      truncated: true,
      coverage: { observations: 3 },
      recorded_subtotal: null,
    });
    expect(result.observations).toHaveLength(2);
    expect(result.observations.every((row) => row.session_id === f.session.id)).toBe(true);
    expect(() => f.store.usage.evidence(f.session.id, 0)).toThrow('1–256');
    expect(() => f.store.usage.evidence(f.session.id, 257)).toThrow('1–256');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('changed recorded amounts cannot retain a verified usage fingerprint', () => {
  const f = fixture();
  try {
    f.store.transaction(() =>
      f.store.usage.observe(f.session.id, 'request', 'test-provider', 'test-model', zero),
    );
    f.store.db.prepare('UPDATE usage_observations SET input=9 WHERE source_key=?').run('request');
    expect(() => f.store.usage.evidence(f.session.id)).toThrow('digest mismatch');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
