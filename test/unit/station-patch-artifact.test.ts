import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { StationWork } from '../../src/agentpod/station-work.js';
import { canonical, textDigest } from '../../src/core/protocol.js';

// Controlled helper completion: filesystem protocol validation has its own corpus.
function fixture(
  content: string | null = 'reviewed test source\n',
  extra: Record<string, unknown> = {},
) {
  const dir = mkdtempSync('/tmp/sal-patch-artifact-');
  let store = new Store(join(dir, 'journal.sqlite'));
  const artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const session = store.create(dir, 'create');
  const args = {
    action: 'patch',
    path: 'test/example.ts',
    content,
    expected_tree: 'a'.repeat(64),
    expected_hash: 'b'.repeat(64),
    ...extra,
  };
  const attempt = store.accept(session.id, 'attempt', session.revision, 'fixture').attempt_id;
  store.db
    .prepare(
      `INSERT INTO operations
    (id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,
     operation_digest,target,value,target_version,policy_digest,connector,replay,state)
    VALUES('operation',?,?,0,'tool','workspace','action','input','operation-digest',
    'station:test/example.ts','value','target','policy','station','never','dispatching')`,
    )
    .run(session.id, attempt);
  store.db
    .prepare(
      `INSERT INTO station_calls
    (id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,
     configuration_digest,args_json,operation_id,state)
    VALUES('call',?,0,?,'tool','patch','input','root','configuration',?,'operation','dispatching')`,
    )
    .run(session.id, attempt, canonical(args));
  const call = () => store.db.prepare("SELECT * FROM station_calls WHERE id='call'").get()!;
  const result = {
    ok: true,
    path: args.path,
    before_tree_digest: args.expected_tree,
    tree_digest: 'c'.repeat(64),
    sha256: content === null ? null : textDigest(content),
  };
  const receipt = vi.fn((_id: string, _receipt: unknown) => {
    expect(store.db.isTransaction).toBe(true);
    store.db
      .prepare("UPDATE operations SET state='succeeded',receipt=? WHERE id=?")
      .run(canonical(_receipt), _id);
  });
  const helper = vi.fn(async (_request: Record<string, unknown>) => result);
  const work = Object.assign(Object.create(StationWork.prototype), {
    store,
    artifacts,
    jobs: new Map(),
    authority: { leaseWindow: () => 5000 },
    managed: { workspaceResultInTransaction: receipt },
    get: call,
    guard: () => {
      if (call().root_digest !== 'root') throw Error('foreign root');
    },
    helper,
    change: (_: unknown, state: string, value: unknown) => {
      store.db
        .prepare("UPDATE station_calls SET state=?,result_json=? WHERE id='call'")
        .run(state, canonical(value));
    },
    view: call,
  }) as any;
  return {
    get store() {
      return store;
    },
    artifacts,
    work,
    helper,
    receipt,
    args,
    result,
    call,
    restart: () => {
      store.close();
      store = new Store(join(dir, 'journal.sqlite'));
      work.store = store;
      work.artifacts = new Artifacts(join(dir, 'artifacts'), store);
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const content of ['reviewed test source\n', null])
  test(
    'verified patch completion produces exact immutable content and replay has no effect: ' +
      content,
    async () => {
      const f = fixture(content);
      try {
        await f.work.perform('call');
        const row = f.store.db.prepare('SELECT * FROM artifacts').get()!;
        const bytes = f.artifacts.read(String(row.id));
        expect(row.digest).toBe(textDigest(bytes));
        expect(JSON.parse(bytes)).toEqual({
          version: 1,
          kind: 'station-applied-patch-receipt',
          call_id: 'call',
          operation_id: 'operation',
          session_id: f.call().session_id,
          attempt_id: f.call().attempt_id,
          root_digest: 'root',
          configuration_digest: 'configuration',
          input_digest: 'input',
          patch: {
            path: f.args.path,
            content,
            expected_tree: f.args.expected_tree,
            expected_hash: f.args.expected_hash,
          },
          result: f.result,
        });
        expect(f.receipt.mock.calls[0]![1]).toMatchObject({
          artifact_id: row.id,
          result: f.result,
        });
        f.restart();
        f.work.run('call');
        expect(f.work.artifacts.read(String(row.id))).toBe(bytes);
        expect(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n).toBe(1);
        expect(f.helper).toHaveBeenCalledTimes(1);
      } finally {
        f.close();
      }
    },
  );

for (const failure of ['helper uncertain', 'foreign root', 'transaction rejected'])
  test('no exportable patch receipt when ' + failure, async () => {
    const f = fixture();
    try {
      if (failure === 'helper uncertain') f.helper.mockRejectedValue(Error('uncertain'));
      if (failure === 'foreign root')
        f.store.db.prepare("UPDATE station_calls SET root_digest='foreign' WHERE id='call'").run();
      if (failure === 'transaction rejected')
        f.receipt.mockImplementation(() => {
          throw Error('rejected');
        });
      await expect(f.work.perform('call')).rejects.toThrow();
      expect(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n).toBe(0);
      expect(f.call().state).toBe('dispatching');
      if (failure === 'foreign root') expect(f.helper).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

// The station helper decodes its request with DisallowUnknownFields: a field it does not know refuses
// the whole patch as station_request_invalid, which Salaam can only record as an unconfirmed
// outcome. #65 added the agent's `reason` to the patch arguments and perform() forwarded every
// argument, so the first approved write after it (run_b304a14ad7454fda) became outcome_unknown.
const HELPER_PATCH_FIELDS = [
  'action',
  'path',
  'expected_tree',
  'expected_hash',
  'content',
  'request_id',
  'deadline_ms',
];
test("a patch forwards only the helper's own fields; the agent's reason never reaches it", async () => {
  const f = fixture('reviewed test source\n', {
    reason: 'Write the quoted sentence the card asks for.',
  });
  try {
    // A fake helper as strict as the real one.
    f.helper.mockImplementation(async (request: Record<string, unknown>) => {
      const unknown = Object.keys(request).filter((k) => !HELPER_PATCH_FIELDS.includes(k));
      if (unknown.length) throw Error('station_request_invalid: ' + unknown.join(','));
      return f.result;
    });
    await f.work.perform('call');
    const sent = f.helper.mock.calls[0]![0];
    expect(Object.keys(sent).sort()).toEqual([...HELPER_PATCH_FIELDS].sort());
    expect(sent).toMatchObject({
      action: 'patch',
      path: f.args.path,
      expected_tree: f.args.expected_tree,
      expected_hash: f.args.expected_hash,
      content: f.args.content,
      request_id: 'call',
    });
    expect(f.call().state).toBe('returned');
  } finally {
    f.close();
  }
});

// Fix 2: a helper refusal of the request itself, before it executes anything, records the write as
// a definite failure with that reason; an unconfirmed helper still leaves the outcome unknown.
for (const [refusal, definite] of [
  ['station_request_invalid', true],
  ['uncertain', false],
] as const)
  test(
    'run records a ' +
      refusal +
      ' helper failure as ' +
      (definite ? 'failed_definite' : 'outcome_unknown'),
    async () => {
      const f = fixture();
      try {
        f.store.db
          .prepare('UPDATE station_calls SET state=\x27prepared\x27 WHERE id=\x27call\x27')
          .run();
        const known = vi.fn(),
          unknown = vi.fn();
        Object.assign(f.work, {
          managed: {
            takePermissionInTransaction: () => true,
            workspaceDefiniteFailureInTransaction: known,
            workspaceUnknownInTransaction: unknown,
          },
          options: { failed: () => {} },
          unconfirmed: () => [],
          change: (_: unknown, state: string, value?: unknown) =>
            f.store.db
              .prepare(
                "UPDATE station_calls SET state=?,result_json=coalesce(?,result_json) WHERE id='call'",
              )
              .run(state, value === undefined ? null : canonical(value)),
          stopUnit: async () => {},
        });
        f.helper.mockImplementation(async () => {
          if (!definite) throw Error('uncertain');
          const { definiteHelperRefusal } = await import('../../src/agentpod/station-work.js');
          const code = definiteHelperRefusal(1, false, { version: 1, ok: false, code: refusal });
          const failure = Object.assign(
            Object.create(
              (await import('../../src/agentpod/station-work.js')).StationFilesDefiniteFailure
                .prototype,
            ),
            { code },
          );
          throw failure;
        });
        f.work.run('call');
        await f.work.jobs.get('call');
        expect(f.call().state).toBe(definite ? 'failed' : 'outcome_unknown');
        expect(JSON.parse(String(f.call().result_json))).toEqual({
          code: definite ? refusal : 'station_execution_unconfirmed',
        });
        expect(known).toHaveBeenCalledTimes(definite ? 1 : 0);
        expect(unknown).toHaveBeenCalledTimes(definite ? 0 : 1);
      } finally {
        f.close();
      }
    },
  );
