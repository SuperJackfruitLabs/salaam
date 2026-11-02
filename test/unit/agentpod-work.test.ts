import { expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskDriver } from '../../src/tasks/driver.js';
import { digest } from '../../src/core/protocol.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { configurePermissions } from '../../src/local/autonomy.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { workTraceHeader } from '../../src/execution/trace.js';
import { planUpdate } from '../../src/core/outcome.js';
import { readinessFingerprint } from '../../src/core/readiness-fingerprint.js';
import { ChildWork } from '../../src/workers/children.js';
import { StationWork } from '../../src/agentpod/station-work.js';
import type { Supervisor } from '../../src/runtime/supervisor.js';
import { fixture, settlementDriver, expiredWorkFixture } from './agentpod-work-helpers.js';
import { characterizeEvidence } from '../agentpod-evidence-recorder.js';

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const { recordingCore } = await import('../agentpod-evidence-recorder.js');
  return recordingCore(await importOriginal());
});
vi.mock('node:crypto', async (importOriginal) => {
  const { countingCrypto } = await import('../agentpod-evidence-recorder.js');
  return countingCrypto(await importOriginal());
});
characterizeEvidence();

const executionSchema = JSON.parse(
  readFileSync(new URL('../fixtures/execution-evidence-v1.schema.json', import.meta.url), 'utf8'),
);

const evidenceAjv = new Ajv2020({ strict: false });

addFormats.default(evidenceAjv);

const validateEvidence = evidenceAjv.compile(executionSchema);

const validateArtifacts = evidenceAjv.compile(
  JSON.parse(
    readFileSync(
      new URL('../fixtures/execution-artifacts-v1.schema.json', import.meta.url),
      'utf8',
    ),
  ),
);

const assertEvidence = (value: unknown) =>
  expect(validateEvidence(value), JSON.stringify(validateEvidence.errors)).toBe(true);

test('source evidence uses the canonical AgentPod versioned success/rejection corpus', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('../fixtures/execution-evidence-v1.json', import.meta.url), 'utf8'),
  );
  for (const example of corpus.success) assertEvidence(example.value);
  for (const example of corpus.rejection)
    expect(validateEvidence(example.value), example.name).toBe(false);
});

test('selected source bytes conform to the shared artifact bundle success/rejection corpus', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('../fixtures/execution-artifacts-v1.json', import.meta.url), 'utf8'),
  );
  for (const example of corpus.success)
    expect(validateArtifacts(example.value), JSON.stringify(validateArtifacts.errors)).toBe(true);
  for (const example of corpus.rejection)
    expect(validateArtifacts(example.value), example.name).toBe(false);
});

test('work trace preserves the original parent across reconnect without renewing execution or charging usage', () => {
  const f = fixture();
  try {
    f.run();
    const parent = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01';
    expect(workTraceHeader(f.store, f.session, 'tool:one')).toBe(null);
    const original = f.work.trace(f.binding, parent);
    expect(original.authority).toBe(false);
    expect(original.traceparent.slice(3, 35)).toBe('a'.repeat(32));
    const tool = workTraceHeader(f.store, f.session, 'tool:one');
    expect(tool).not.toBe(original.traceparent);
    expect(workTraceHeader(f.store, f.session, 'tool:two')).not.toBe(tool);
    f.authority.revoke(f.binding, 'trace-revoke', 'Trace cannot renew execution');
    f.reopen();
    expect(f.work.trace(f.binding, '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(16) + '-00')).toEqual(
      original,
    );
    expect(workTraceHeader(f.store, f.session, 'tool:one')).toBe(tool);
    expect(f.store.usage.evidence(f.session).status).toBe('unreported');
    expect(f.authority.inspect(f.binding).authorized).toBe(false);
    expect(() =>
      f.work.trace({ ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }, parent),
    ).toThrow();
    expect(() =>
      f.work.trace(f.binding, '00-' + '0'.repeat(32) + '-' + 'b'.repeat(16) + '-01'),
    ).toThrow('nonzero');
    expect(() => f.work.trace(f.binding, 'Bearer should-never-be-a-trace')).toThrow('W3C');
  } finally {
    f.close();
  }
});

test('synthetic ready receipt is atomically scoped, digest checked, and historical after restart', () => {
  const f = fixture();
  try {
    f.run();
    const epoch = f.store.allocate(f.session, 'evidence-worker');
    const fingerprint = readinessFingerprint({
      version: 1,
      session_id: f.session,
      worker_epoch: epoch,
      harness: 'salaam',
      harness_version: 'fixture-version',
      pi_version: 'fixture-pi-version',
      bundle_digest: 'a'.repeat(64),
      policy_digest: 'b'.repeat(64),
      provider: 'fixture',
      model: 'fixture/model',
      context_digest: 'c'.repeat(64),
      context_admission_digest: null,
      verification: 'pinned-readiness-handshake',
    });
    expect(() =>
      f.store.state(f.session, epoch, 'ready', null, [], undefined, {
        ...fingerprint,
        worker_epoch: epoch + 1,
      }),
    ).toThrow('exact ready worker');
    expect(f.store.session(f.session).state).not.toBe('ready');
    f.store.state(f.session, epoch, 'ready', null, [], undefined, fingerprint);
    expect(f.work.evidence(f.binding).fingerprints).toEqual([fingerprint]);
    assertEvidence(f.work.evidence(f.binding));
    f.reopen();
    expect(f.work.evidence(f.binding).fingerprints).toEqual([fingerprint]);
    f.store.db
      .prepare(
        "UPDATE events SET payload=json_set(payload,'$.fingerprint.model','changed') WHERE session_id=? AND kind='worker.ready'",
      )
      .run(f.session);
    expect(() => f.work.evidence(f.binding)).toThrow('fingerprint is inconsistent');
  } finally {
    f.close();
  }
});

test('native child contributor follows its immutable delegation, while an unbound peer cannot close contributor coverage', async () => {
  const f = fixture();
  let children: ChildWork | undefined;
  try {
    const task = f.run(),
      step = f.tasks.get(task.task_id).steps[0]!;
    const submission = f.store.transaction(() =>
      f.store.enqueue(f.session, randomUUID(), 'Readonly child evidence', undefined, null, step.id),
    );
    const epoch = f.store.allocate(f.session, 'parent-evidence');
    f.store.state(f.session, epoch, 'ready');
    f.store.claim(f.session, epoch);
    f.store.running(submission.attempt_id);
    const supervisor = {
      assertActive() {},
      assertSessionProviderSupported() {},
      start: async () => {},
      failControl() {},
    } as unknown as Supervisor;
    children = new ChildWork(f.store, f.work.verification.artifacts, supervisor);
    const child = children.spawn(
      f.session,
      epoch,
      submission.attempt_id,
      'readonly-evidence',
      'Read-only diagnostic',
      1,
      ['salaam_probe'],
    );
    children.workerLost(child.child_session, 'Synthetic stopped worker');
    const evidence = f.work.evidence(f.binding);
    assertEvidence(evidence);
    expect(evidence.children).toMatchObject([
      { id: child.id, contributor_principal_id: f.binding.principal_id },
    ]);
    expect(evidence.contributors.closure).toBe('complete');
    const bundle = f.work.evidenceArtifacts(f.binding, [
      child.artifact_id ?? String(evidence.children[0]!.artifact_id),
    ]);
    expect(validateArtifacts(bundle), JSON.stringify(validateArtifacts.errors)).toBe(true);
    const selected = bundle.artifacts[0]!;
    const bytes = Buffer.from(String(selected.content_base64), 'base64');
    expect(digest(JSON.parse(bytes.toString()))).toBe(
      digest(JSON.parse(f.work.verification.artifacts.read(String(selected.id)))),
    );
    expect(selected.disposition).toBe('proposed');
    const saved = f.store.workerBoundary.view(child.id).binding;
    f.store.db
      .prepare('UPDATE child_workers SET binding=?,binding_digest=? WHERE child_id=?')
      .run(
        JSON.stringify({ ...saved, runtime: 'a2a' }),
        digest({ ...saved, runtime: 'a2a' }),
        child.id,
      );
    expect(f.work.evidence(f.binding).contributors.closure).toBe('incomplete');
    expect(() =>
      f.work.evidenceArtifacts(f.binding, [
        f.work.evidence(f.binding).artifacts.find((a) => a.disposition === 'observed')!.id,
      ]),
    ).toThrow('Only selected produced');
    expect(() =>
      f.work.evidenceArtifacts(f.binding, [String(selected.id), String(selected.id)]),
    ).toThrow('distinct');
    expect(() =>
      f.work.evidenceArtifacts({ ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }, [
        String(selected.id),
      ]),
    ).toThrow();
  } finally {
    await children?.close();
    f.close();
  }
});

test('execution evidence is a root-scoped historical snapshot, not a fresh grant or task success', () => {
  const f = fixture();
  try {
    const receipt = f.run();
    const before = f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    const evidence = f.work.evidence(f.binding);
    assertEvidence(evidence);
    expect(evidence).toMatchObject({
      schema_version: 'salaam-execution-evidence/v1',
      task: { task_id: receipt.task_id, state: 'accepted', ...f.expected },
      usage: { status: 'unreported', recorded_subtotal: null },
      contributors: { principal_ids: [f.binding.principal_id], closure: 'complete' },
      coverage: { truncated: [], unavailable: [] },
    });
    expect(evidence.attempts).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain(f.base);
    expect(JSON.stringify(evidence)).not.toContain('workspace');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n).toBe(before);
    f.authority.revoke(f.binding, 'revoke-evidence', 'Historical evidence test');
    f.reopen();
    const after = f.work.evidence(f.binding);
    expect({ ...after, as_of: evidence.as_of }).toEqual(evidence);
    expect(f.authority.inspect(f.binding).authorized).toBe(false);
    expect(() =>
      f.work.evidence({ ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }),
    ).toThrow();
    expect(() => f.work.evidence({ ...f.binding, run: { ...f.binding.run, epoch: 2 } })).toThrow();
  } finally {
    f.close();
  }
});

test('actual saved tool ownership survives revocation and cannot refer to another session attempt', async () => {
  const { f, managed } = await expiredWorkFixture();
  try {
    const evidence = f.work.evidence(f.binding);
    assertEvidence(evidence);
    expect(evidence.attempts).toHaveLength(1);
    expect(evidence.tools).toHaveLength(1);
    expect(evidence.tools[0]).toMatchObject({
      source: 'operation',
      session_id: f.session,
      receipt_digest: null,
    });
    expect(JSON.stringify(evidence)).not.toContain('library/fixture');
    const other = f.store.create(f.base, 'foreign-source');
    // A foreign attempt cannot be used to justify a root's tool receipt.
    f.store.db
      .prepare('UPDATE attempts SET session_id=? WHERE id=?')
      .run(other.id, evidence.attempts[0]!.id!);
    expect(() => f.work.evidence(f.binding)).toThrow('ownership is inconsistent');
  } finally {
    await managed.close();
    f.close();
  }
});

test('only a returned station patch with a matching succeeded receipt exports produced bytes', () => {
  const f = fixture();
  try {
    const task = f.run();
    const step = f.tasks.get(task.task_id).steps[0]!;
    const attempt = f.store.transaction(() =>
      f.store.enqueue(f.session, 'patch-attempt', 'fixture', undefined, null, step.id),
    ).attempt_id;
    const artifacts = f.work.verification.artifacts;
    const artifact = artifacts.put(f.session, 'reviewed applied patch receipt');
    const receipt = {
      scope: 'station-workspace',
      call_id: '22222222-2222-4222-8222-222222222222',
      artifact_id: artifact,
      root_digest: digest(f.binding),
      configuration_digest: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      input_digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    f.store.db
      .prepare(
        `INSERT INTO operations
      (id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,
       operation_digest,target,value,target_version,policy_digest,connector,replay,state,receipt)
      VALUES('11111111-1111-4111-8111-111111111111',?,?,0,'patch-tool','workspace','patch-action','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'station:test/example.ts','value','target','policy','station','never','succeeded',?)`,
      )
      .run(f.session, attempt, JSON.stringify(receipt));
    f.store.db
      .prepare(
        `INSERT INTO station_calls
      (id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,
       configuration_digest,args_json,operation_id,state,result_json)
      VALUES('22222222-2222-4222-8222-222222222222',?,0,?,'patch-tool','patch','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{}','11111111-1111-4111-8111-111111111111','returned','{}')`,
      )
      .run(f.session, attempt, digest(f.binding));
    const evidence = f.work.evidence(f.binding);
    assertEvidence(evidence);
    expect(evidence.artifacts.find((a) => a.id === artifact)?.disposition).toBe('produced');
    const bundle = f.work.evidenceArtifacts(f.binding, [artifact]);
    expect(Buffer.from(String(bundle.artifacts[0]!.content_base64), 'base64').toString()).toBe(
      'reviewed applied patch receipt',
    );
    f.reopen();
    expect(f.work.evidence(f.binding).artifacts.find((a) => a.id === artifact)?.disposition).toBe(
      'produced',
    );
    f.store.db
      .prepare(
        "UPDATE station_calls SET root_digest=? WHERE id='22222222-2222-4222-8222-222222222222'",
      )
      .run('f'.repeat(64));
    expect(() => f.work.evidenceArtifacts(f.binding, [artifact])).toThrow('Only selected produced');
    f.store.db
      .prepare(
        "UPDATE station_calls SET root_digest=? WHERE id='22222222-2222-4222-8222-222222222222'",
      )
      .run(digest(f.binding));
    f.store.db
      .prepare(
        "UPDATE operations SET state='outcome_unknown' WHERE id='11111111-1111-4111-8111-111111111111'",
      )
      .run();
    expect(() => f.work.evidenceArtifacts(f.binding, [artifact])).toThrow('Only selected produced');
    f.store.db
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE id='11111111-1111-4111-8111-111111111111'",
      )
      .run();
    for (const state of ['failed', 'outcome_unknown', 'cancelled']) {
      f.store.db
        .prepare("UPDATE station_calls SET state=? WHERE id='22222222-2222-4222-8222-222222222222'")
        .run(state);
      expect(f.work.evidence(f.binding).artifacts.find((a) => a.id === artifact)?.disposition).toBe(
        'observed',
      );
      expect(() => f.work.evidenceArtifacts(f.binding, [artifact])).toThrow(
        'Only selected produced',
      );
    }
    f.store.db
      .prepare(
        "UPDATE station_calls SET state='returned',kind='read' WHERE id='22222222-2222-4222-8222-222222222222'",
      )
      .run();
    expect(() => f.work.evidenceArtifacts(f.binding, [artifact])).toThrow('Only selected produced');
  } finally {
    f.close();
  }
});

test('execution evidence verifies artifact bytes and cannot upgrade a baseline to integrated work', () => {
  const f = fixture();
  try {
    f.run();
    const evidence = f.work.evidence(f.binding);
    expect(evidence.artifacts.length).toBeGreaterThan(0);
    expect(evidence.artifacts.every((a) => a.disposition === 'observed')).toBe(true);
    const artifact = evidence.artifacts[0]!;
    writeFileSync(join(f.state, 'artifacts', String(artifact.id)), 'corrupted immutable bytes');
    expect(() => f.work.evidence(f.binding)).toThrow('digest mismatch');
  } finally {
    f.close();
  }
});

test('execution evidence bounds details explicitly rather than pretending a truncated artifact set is complete', () => {
  const f = fixture();
  try {
    f.run();
    for (let i = 0; i < 257; i++)
      f.work.verification.artifacts.put(f.session, 'source artifact ' + i);
    const evidence = f.work.evidence(f.binding);
    expect(evidence.artifacts).toHaveLength(256);
    expect(evidence.coverage.truncated).toContain('artifacts');
  } finally {
    f.close();
  }
});

test('synthetic executor ownership: one durable run/task/request survives restart and revocation without regrant', () => {
  const f = fixture();
  try {
    const receipt = f.run();
    expect(receipt.state).toBe('admitted');
    expect(f.run()).toEqual(receipt);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get()!.n).toBe(1);
    expect(() => f.run({ ...f.request, request_id: randomUUID() })).toThrow(
      'original work request',
    );
    expect(() =>
      f.run({ ...f.request, work: { ...f.request.work, input_digest: 'c'.repeat(64) } }),
    ).toThrow('admitted bytes');
    expect(() => f.run(f.request, { title: 'changed' })).toThrow('admitted bytes');
    expect(() =>
      f.run({ ...f.request, binding: { ...f.binding, principal_id: 'prn_' + '3'.repeat(20) } }),
    ).toThrow();
    f.reopen();
    expect(f.run()).toEqual(receipt);
    expect(() => f.run({ ...f.request, request_id: randomUUID() })).toThrow('not fresh');
    f.authority.revoke(f.binding, 'revoke', 'Test root revocation');
    expect(f.run()).toEqual(receipt);
    expect(f.tasks.get(receipt.task_id).state).not.toBe('succeeded');
    expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(29);
    expect(
      f.store.events(f.session, 0).filter((e) => e.kind === 'agentpod.work_admitted'),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test.each([
  [false, true],
  [true, false],
])(
  'missing real verification boundary rolls back complete task admission (%s,%s)',
  (verifier, owned) => {
    const f = fixture(verifier, owned);
    try {
      expect(() => f.run()).toThrow();
      expect(f.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get()!.n).toBe(0);
      expect(
        f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agentpod_work'").get(),
      ).toBeUndefined();
      expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(27);
      expect(f.store.events(f.session, 0).some((e) => e.kind === 'agentpod.work_admitted')).toBe(
        false,
      );
    } finally {
      f.close();
    }
  },
);

test('admission journal failure rolls task, mapping, request receipt and schema back together', () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "CREATE TRIGGER fail_work_receipt BEFORE INSERT ON events WHEN NEW.kind='agentpod.work_admitted' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END;",
    );
    expect(() => f.run()).toThrow('fixture event failure');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get()!.n).toBe(0);
    expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(27);
    f.store.db.exec('DROP TRIGGER fail_work_receipt');
    expect(f.run().state).toBe('admitted');
  } finally {
    f.close();
  }
});

test('unconfirmed station resource and expired lease deny new task admission', () => {
  const f = fixture();
  try {
    f.store.db
      .prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES ('fixture',?,'digest','{}','/fixture','/fixture','unconfirmed')",
      )
      .run(f.session);
    expect(() => f.run()).toThrow('not reconciled');
    f.store.db.prepare("UPDATE station_units SET state='stopped'").run();
    f.store.db.prepare('UPDATE agentpod_admissions SET expires_at=0').run();
    expect(() => f.run()).toThrow('not fresh');
    expect(f.tasks.forSession(f.session)).toBeNull();
  } finally {
    f.close();
  }
});

test('permission configuration never downgrades a newer work schema fence', () => {
  const store = new Store(':memory:');
  try {
    const session = store.create(realpathSync('/tmp'), 'session', false, {
      workspace: true,
      route: OFFLINE_ROUTE,
    });
    store.db.exec('PRAGMA user_version=29');
    const lease = store.control(session.id, 'control', 'operator', 'acquire', 0);
    configurePermissions(
      store,
      session.id,
      'permissions',
      0,
      { mode: 'inspect', paths: [] },
      { client_id: 'operator', token: lease.token },
    );
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(29);
  } finally {
    store.close();
  }
});

test('independent work identity and normalized plan digests are required before creation', () => {
  const f = fixture();
  try {
    expect(() =>
      f.work.admit(
        f.session,
        f.request,
        { ...f.expected, card_id: 'card_Bb1Cc2' },
        f.input,
        f.plan,
      ),
    ).toThrow('admitted bytes');
    expect(() => f.run(f.request, f.input, { ...f.plan, objective: 'Changed work' })).toThrow(
      'admitted bytes',
    );
    expect(f.tasks.forSession(f.session)).toBeNull();
    expect(() =>
      f.run({ ...f.request, binding: { ...f.binding, run: { ...f.binding.run, epoch: 2 } } }),
    ).toThrow();
    expect(f.tasks.forSession(f.session)).toBeNull();
  } finally {
    f.close();
  }
});

test('lost mapping is not repaired by replay and partial schema29 is refused on reopen', () => {
  const f = fixture();
  try {
    f.run();
    f.store.db.exec('DELETE FROM agentpod_work');
    expect(() => f.run()).toThrow('mapping is unavailable');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get()!.n).toBe(1);
    f.store.db.exec('DROP TABLE agentpod_work');
    expect(() => new Store(join(f.base, 'state', 'journal.sqlite'))).toThrow('no such table');
  } finally {
    f.close();
  }
});

test('lease is checked again after actual workspace verification before durable admission', () => {
  const f = fixture();
  try {
    const verify = f.work.verification.binding.bind(f.work.verification);
    f.work.verification.binding = (task) => {
      const result = verify(task);
      f.store.db.exec('UPDATE agentpod_admissions SET expires_at=0');
      return result;
    };
    expect(() => f.run()).toThrow('not fresh');
    expect(f.tasks.forSession(f.session)).toBeNull();
    expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(27);
  } finally {
    f.close();
  }
});

test('private progression binds one original work grant, denies local competition, and recovers without regrant', () => {
  const f = fixture();
  try {
    const receipt = f.run();
    let grants = 0;
    const driver = {
      configureInTransaction: (
        _id: string,
        _revision: number,
        _steps: number,
        _compact: boolean,
        authorize: () => void,
      ) => {
        authorize();
        grants++;
      },
      kick: () => {},
    } as unknown as TaskDriver;
    const request = randomUUID();
    f.store.db
      .prepare("UPDATE durable_tasks SET objective='changed' WHERE id=?")
      .run(receipt.task_id);
    expect(() => f.work.progress(f.binding, request, receipt.request_id, 1, driver)).toThrow(
      'original work',
    );
    f.store.db
      .prepare('UPDATE durable_tasks SET objective=? WHERE id=?')
      .run(f.plan.objective, receipt.task_id);
    expect(() => f.work.progress(f.binding, request, receipt.request_id, 2, driver)).toThrow(
      'every admitted',
    );
    const control = f.store.control(f.session, 'local-control', 'terminal', 'acquire', 0);
    expect(() => f.work.progress(f.binding, request, receipt.request_id, 1, driver)).toThrow(
      'Local controller',
    );
    f.store.control(
      f.session,
      'local-release',
      'terminal',
      'release',
      control.epoch,
      control.token,
    );
    const granted = f.work.progress(f.binding, request, receipt.request_id, 1, driver);
    expect(grants).toBe(1);
    expect(f.work.progress(f.binding, request, receipt.request_id, 1, driver)).toEqual(granted);
    expect(grants).toBe(1);
    expect(() => f.work.progress(f.binding, randomUUID(), receipt.request_id, 1, driver)).toThrow();
    f.reopen();
    f.authority.revoke(f.binding, 'revoke-progression', 'fixture revocation');
    expect(f.work.progress(f.binding, request, receipt.request_id, 1, driver)).toEqual(granted);
    expect(grants).toBe(1);
  } finally {
    f.close();
  }
});

test('restart retains the original bounded grant while awaiting a fresh node lease, never granting execution', async () => {
  const f = fixture();
  let driver: TaskDriver | undefined;
  const make = () => {
    const v = f.work.verification;
    const d = new TaskDriver(
      f.store,
      f.tasks,
      v.budget,
      v,
      { inspect: () => ({ state: 'starting' }) } as never,
      {} as never,
      v.coding,
    );
    d.awaitingAuthorityRenewal = (s) => f.authority.awaitingRenewal(s);
    return d;
  };
  try {
    const receipt = f.run();
    driver = make();
    const request = randomUUID();
    f.work.progress(f.binding, request, receipt.request_id, 1, driver);
    await driver.close();
    f.reopen();
    driver = make();
    expect(f.authority.awaitingRenewal(f.session)).toBe(true);
    expect(() => f.store.execution.assert(f.session)).toThrow('not fresh');
    driver.start();
    await new Promise((r) => setTimeout(r, 450));
    expect(
      f.store.db.prepare('SELECT auto_enabled,remaining_steps,auto_error FROM task_runtime').get(),
    ).toMatchObject({ auto_enabled: 1, remaining_steps: 1, auto_error: null });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_grants').get()!.n).toBe(0);
    f.authority.renew(f.binding, 'renew-after-restart', 2);
    expect(f.authority.awaitingRenewal(f.session)).toBe(false);
    expect(f.work.progress(f.binding, request, receipt.request_id, 1, driver)).toMatchObject({
      request_id: request,
    });
    expect(f.store.db.prepare('SELECT auto_epoch FROM task_runtime').get()!.auto_epoch).toBe(1);
    f.authority.revoke(f.binding, 'revoke-after-renew', 'fixture');
    expect(f.authority.awaitingRenewal(f.session)).toBe(false);
  } finally {
    await driver?.close();
    f.close();
  }
});

test('explicit never-dispatched settlement preserves the revoked owner and survives restart', () => {
  const f = fixture();
  try {
    const admitted = f.run(),
      request = randomUUID(),
      terminal = 'a'.repeat(64);
    const settle = () =>
      f.work.settle(f.binding, request, admitted.request_id, terminal, settlementDriver(f));
    expect(settle).toThrow('revoked root');
    f.authority.revoke(f.binding, 'settle-revoke', 'Expired original owner');
    const receipt = settle();
    expect(receipt).toMatchObject({
      state: 'cancelled',
      effects: 'never_dispatched',
      task_id: admitted.task_id,
    });
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    expect(f.authority.inspect(f.binding)).toMatchObject({ revoked: true, authorized: false });
    expect(f.run()).toEqual(admitted);
    expect(settle()).toEqual(receipt);
    f.reopen();
    expect(settle()).toEqual(receipt);
    expect(() =>
      f.work.settle(f.binding, randomUUID(), admitted.request_id, terminal, settlementDriver(f)),
    ).toThrow();
    expect(() =>
      f.work.settle(f.binding, request, admitted.request_id, 'b'.repeat(64), settlementDriver(f)),
    ).toThrow();
    expect(() =>
      f.work.settle(
        { ...f.binding, run: { ...f.binding.run, epoch: 2 } },
        request,
        admitted.request_id,
        terminal,
        settlementDriver(f),
      ),
    ).toThrow();
    expect(
      f.store.events(f.session, 0).filter((e) => e.kind === 'agentpod.work_settled'),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test.each([
  'requests_spent',
  'reserved_requests',
  'reserved_tokens',
  'token_units',
  'verification_runs',
  'auto_enabled',
])('settlement refuses previously dispatched or reserved work (%s)', (column) => {
  const f = fixture();
  try {
    const admitted = f.run();
    f.authority.revoke(f.binding, 'settle-revoke', 'Expired original owner');
    f.store.db.prepare(`UPDATE task_runtime SET ${column}=1 WHERE task_id=?`).run(admitted.task_id);
    expect(() =>
      f.work.settle(
        f.binding,
        randomUUID(),
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow('never-dispatched');
    expect(f.tasks.get(admitted.task_id).state).toBe('accepted');
  } finally {
    f.close();
  }
});

test('settlement cancellation failure rolls back both disposition and receipt', () => {
  const f = fixture();
  try {
    const admitted = f.run(),
      request = randomUUID();
    f.authority.revoke(f.binding, 'settle-revoke', 'Expired original owner');
    const driver = settlementDriver(f);
    driver.children.cancelSessionInTransaction = () => {
      throw new Error('durable cancellation fault');
    };
    expect(() =>
      f.work.settle(f.binding, request, admitted.request_id, 'a'.repeat(64), driver),
    ).toThrow('durable cancellation fault');
    expect(f.tasks.get(admitted.task_id).state).toBe('accepted');
    expect(
      f.store.events(f.session, 0).filter((e) => e.kind === 'agentpod.work_settled'),
    ).toHaveLength(0);
    expect(
      f.work.settle(f.binding, request, admitted.request_id, 'a'.repeat(64), settlementDriver(f))
        .state,
    ).toBe('cancelled');
  } finally {
    f.close();
  }
});

test('settlement rechecks unconfirmed resource stop even when a receipt was saved', () => {
  let stopped = true;
  const f = fixture(true, true, () => stopped);
  try {
    const admitted = f.run(),
      request = randomUUID();
    f.authority.revoke(f.binding, 'settle-revoke', 'Expired original owner');
    const settle = () =>
      f.work.settle(f.binding, request, admitted.request_id, 'a'.repeat(64), settlementDriver(f));
    stopped = false;
    expect(settle).toThrow('confirmed stopped');
    expect(f.tasks.get(admitted.task_id).state).toBe('accepted');
    stopped = true;
    const receipt = settle();
    stopped = false;
    expect(settle).toThrow('confirmed stopped');
    stopped = true;
    expect(settle()).toEqual(receipt);
  } finally {
    f.close();
  }
});

test('actual settlement receipt conforms to the shared AgentPod v1 wire fixture', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('../fixtures/agentpod-work-settlement-v1.json', import.meta.url), 'utf8'),
  );
  const f = fixture();
  try {
    const admitted = f.run();
    f.authority.revoke(f.binding, 'fixture-revoke', 'Original owner expired');
    const request = { ...corpus.request, binding: f.binding, work_request_id: admitted.request_id };
    expect(
      f.work.settle(
        request.binding,
        request.request_id,
        request.work_request_id,
        request.producer_terminal_digest,
        settlementDriver(f),
      ),
    ).toEqual({
      ...corpus.receipt,
      work_request_id: admitted.request_id,
      session_id: f.session,
      task_id: admitted.task_id,
      binding_digest: digest(f.binding),
    });
  } finally {
    f.close();
  }
});

test('verified deliverable bytes named by the completion are produced and exportable', () => {
  const f = fixture();
  try {
    const admitted = f.run();
    const task = f.tasks.get(admitted.task_id);
    const artifacts = f.work.verification.artifacts;
    const content = 'the verified answer\n';
    const sha256 = createHash('sha256').update(content).digest('hex');
    const deliverable = artifacts.put(f.session, content),
      stray = artifacts.put(f.session, content);
    const record = (d: Record<string, unknown>) =>
      artifacts.put(f.session, JSON.stringify({ task_id: task.id, deliverables: [d] }));
    const complete = (id: string) =>
      f.store.db
        .prepare(
          "INSERT INTO task_completions VALUES (?,?,'station:x',0,?,?,'succeeded',NULL) ON CONFLICT(task_id) DO UPDATE SET artifact_id=excluded.artifact_id",
        )
        .run(task.id, task.plan_revision, 'a'.repeat(64), id);
    const disposition = (id: string) =>
      f.work.evidence(f.binding).artifacts.find((a) => a.id === id)?.disposition;
    complete(record({ path: 'answer.md', sha256, artifact_id: deliverable }));
    expect(disposition(deliverable)).toBe('produced');
    expect(disposition(stray)).toBe('observed');
    const bundle = f.work.evidenceArtifacts(f.binding, [deliverable]);
    expect(Buffer.from(String(bundle.artifacts[0]!.content_base64), 'base64').toString()).toBe(
      content,
    );
    expect(() => f.work.evidenceArtifacts(f.binding, [stray])).toThrow('Only selected produced');
    // A completion whose digest does not match the artifact's bytes proves nothing.
    complete(record({ path: 'answer.md', sha256: 'f'.repeat(64), artifact_id: deliverable }));
    expect(disposition(deliverable)).toBe('observed');
    // Another session's artifact cannot be claimed by a completion.
    const other = f.store.create('/tmp/other', randomUUID());
    const foreign = artifacts.put(other.id, content);
    complete(record({ path: 'answer.md', sha256, artifact_id: foreign }));
    expect(disposition(foreign)).toBeUndefined();
    expect(() => f.work.evidenceArtifacts(f.binding, [foreign])).toThrow();
  } finally {
    f.close();
  }
});

test('work status carries a bounded, ordered tail of tool activity for card activity', async () => {
  const f = fixture();
  try {
    const admitted = f.run();
    const attempt = randomUUID();
    const tool = (n: number, phase: 'started' | 'finished', extra: object = {}) =>
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.' + phase, {
          attempt_id: attempt,
          worker_epoch: 1,
          tool_call_id: 'call-' + n,
          tool: n % 2 ? 'salaam_operator_mcp' : 'salaam_station',
          phase,
          ...extra,
        }),
      );
    for (let n = 0; n < 40; n++) {
      tool(n, 'started', {
        input: JSON.stringify(
          n % 2
            ? { action: 'call', server: 'fetch', tool: 'fetch', arguments: { url: 'https://x' } }
            : { action: 'read', path: 'notes.md', pad: 'p'.repeat(5000) },
        ),
        kind: n % 2 ? 'fetch' : 'read',
      });
      tool(n, 'finished', { failed: n === 3, ...(n === 39 ? { output: 'HTTP/1.1 200 OK' } : {}) });
    }
    f.store.transaction(() => f.store.event(f.session, 'usage.observed', { attempt_id: attempt }));
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
      task_id: string;
    };
    const tail = status.activity;
    expect(tail.length).toBe(64);
    expect(tail.map((a) => a.seq)).toEqual(
      [...tail.map((a) => a.seq)].sort((a, b) => Number(a) - Number(b)),
    );
    expect(tail.at(-1)).toMatchObject({
      phase: 'finished',
      tool_call_id: 'call-39',
      failed: false,
      output: 'HTTP/1.1 200 OK',
    });
    // A finished step without output carries no output field; the hub's tail shape is strict.
    const quiet = tail.find((a) => a.tool_call_id === 'call-37' && a.phase === 'finished')!;
    // A finished step is titled like the call it finishes, not by its bare tool name.
    expect(tail.find((a) => a.tool_call_id === 'call-9' && a.phase === 'finished')!.title).toBe(
      'fetch: x',
    );
    expect(tail.find((a) => a.tool_call_id === 'call-8' && a.phase === 'finished')!.title).toBe(
      'read: notes.md',
    );
    expect('output' in quiet).toBe(false);
    const started = tail.find((a) => a.tool_call_id === 'call-9' && a.phase === 'started')!;
    expect(started).toMatchObject({ title: 'fetch: x', kind: 'fetch' });
    const read = tail.find((a) => a.tool_call_id === 'call-8' && a.phase === 'started')!;
    expect(read.title).toBe('read: notes.md');
    expect(String(read.input).length).toBeLessThanOrEqual(2048);
    expect(Object.keys(read).sort()).toEqual(
      ['failed', 'input', 'kind', 'phase', 'seq', 'title', 'tool_call_id'].sort(),
    );
    expect(admitted.task_id).toBe(status.task_id);
    // The plan rides along as the ACP plan update, so the owner can show it before work starts.
    expect((status as unknown as { plan: unknown }).plan).toEqual(
      planUpdate(f.tasks.get(admitted.task_id)),
    );
    expect((status as unknown as { plan: { entries: unknown[] } }).plan.entries.length).toBe(
      f.tasks.get(admitted.task_id).steps.length,
    );
  } finally {
    f.close();
  }
});

// The re-run allowance: a progression grant may be the plan's steps or the steps plus three, the
// capped allowance for re-running a rate-limited or reopened step. Nothing else.
test('a progression grant is the plan steps or the steps plus the re-run allowance, nothing else', () => {
  for (const [steps, ok] of [
    [1, true],
    [4, true],
    [2, false],
    [3, false],
    [5, false],
  ] as const) {
    const f = fixture();
    try {
      const receipt = f.run();
      let granted: number | null = null;
      const driver = {
        configureInTransaction: (
          _i: string,
          _r: number,
          n: number,
          _c: boolean,
          authorize: () => void,
        ) => {
          authorize();
          granted = n;
        },
        kick: () => {},
      } as unknown as TaskDriver;
      const call = () =>
        f.work.progress(f.binding, randomUUID(), receipt.request_id, steps, driver);
      if (ok) {
        call();
        expect(granted).toBe(steps);
      } else expect(call, String(steps)).toThrow('every admitted');
    } finally {
      f.close();
    }
  }
});

// Item 11: the owner reads a run's checkpoints and a checkpoint's diff; nothing changes.
test("work checkpoints list each completed step's checkpoint and its diff, read-only", async () => {
  const f = fixture();
  try {
    const admitted = f.run();
    const task = f.tasks.get(admitted.task_id),
      step = task.steps[0]!;
    expect(f.work.checkpoints(f.binding)).toEqual({
      version: 1,
      task_id: task.id,
      checkpoints: [],
    });
    f.store.db.exec('PRAGMA foreign_keys=OFF');
    f.store.db
      .prepare("INSERT INTO task_step_attempts VALUES ('att-1',?,?,'x')")
      .run(step.id, task.plan_revision);
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,result_json) VALUES ('c1',?,1,'att-1','t1','patch','i','r','c',?,NULL,'returned',?)",
      )
      .run(
        f.session,
        JSON.stringify({
          action: 'patch',
          path: 'runs/r/a.md',
          content: 'v1',
          expected_hash: null,
        }),
        JSON.stringify({ ok: true, before_tree_digest: 't0', tree_digest: 't1' }),
      );
    f.store.db.exec('PRAGMA foreign_keys=ON');
    f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE id=?").run(step.id);
    const listed = f.work.checkpoints(f.binding) as {
      checkpoints: { id: string; tree_digest: string; files_changed: string[] }[];
    };
    expect(listed.checkpoints).toHaveLength(1);
    expect(listed.checkpoints[0]).toMatchObject({
      tree_digest: 't1',
      files_changed: ['runs/r/a.md'],
    });
    // The diff reads the live workspace, so without the station boundary it says so.
    await expect(f.work.checkpointDiff(f.binding, listed.checkpoints[0]!.id)).rejects.toThrow(
      'station boundary',
    );
    await expect(f.work.checkpointDiff(f.binding, 'nope')).rejects.toThrow('No such checkpoint');
  } finally {
    f.close();
  }
});

// Item 11b: restore is only for a run that has ended, only exactly as reviewed, never on a busy station.
function restoreFixture() {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  f.store.db.exec('PRAGMA foreign_keys=OFF');
  f.store.db
    .prepare("INSERT INTO task_step_attempts VALUES ('att-r',?,?,'x')")
    .run(step.id, task.plan_revision);
  const patch = (
    id: string,
    content: string | null,
    before: string,
    after: string,
    hash: string | null,
    attempt = 'att-r',
  ) =>
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,result_json) VALUES (?,?,1,?,?,'patch','i','r','c',?,NULL,'returned',?)",
      )
      .run(
        id,
        f.session,
        attempt,
        'tool-' + id,
        JSON.stringify({ action: 'patch', path: 'runs/r/a.md', content, expected_hash: hash }),
        JSON.stringify({
          ok: true,
          before_tree_digest: before,
          tree_digest: after,
          sha256: content && 'h-' + content,
        }),
      );
  patch('c1', 'v1', 't0', 't1', null);
  f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE id=?").run(step.id);
  patch('c2', 'v2', 't1', 't2', 'h-v1', 'att-later');
  const restored: unknown[][] = [];
  f.work.verification.station = {
    station: {
      restore: async (...a: unknown[]) => (restored.push(a), { version: 1, state: 'restored' }),
      // The live workspace the diff reads: the run's last write, as the helper would report it.
      live: async () => ({
        tree: 't2',
        file: async () => ({ state: 'content', content: 'v2', sha256: 'h-v2' }),
      }),
    },
  } as never;
  const end = () => {
    f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
    f.authority.revoke(f.binding, 'end-' + randomUUID(), 'Run ended');
  };
  const checkpoint = () =>
    (f.work.checkpoints(f.binding) as { checkpoints: { id: string }[] }).checkpoints[0]!.id;
  const digestOf = async (id: string) =>
    ((await f.work.checkpointDiff(f.binding, id)) as { restore_digest: string }).restore_digest;
  return { f, restored, end, checkpoint, digestOf };
}

test('a restore of an ended run goes to the station exactly as reviewed', async () => {
  const x = restoreFixture();
  try {
    const id = x.checkpoint(),
      d = await x.digestOf(id);
    await expect(x.f.work.restore(x.f.binding, 'restore:1', id, d, 'prn_admin')).rejects.toThrow(
      'ended',
    );
    x.end();
    await expect(
      x.f.work.restore(x.f.binding, 'restore:1', id, 'e'.repeat(64), 'prn_admin'),
    ).rejects.toThrow('no longer matches');
    expect(x.restored).toHaveLength(0);
    expect(await x.f.work.restore(x.f.binding, 'restore:1', id, d, 'prn_admin')).toMatchObject({
      state: 'restored',
    });
    const [session, , plan, request, approver] = x.restored[0]! as [
      string,
      string,
      { writes: unknown[]; restore_digest: string },
      string,
      string,
    ];
    expect(session).toBe(x.f.session);
    expect(plan.restore_digest).toBe(d);
    expect(plan.writes).toEqual([{ path: 'runs/r/a.md', content: 'v1', expected_hash: 'h-v2' }]);
    expect([request, approver]).toEqual(['restore:1', 'prn_admin']);
  } finally {
    x.f.close();
  }
});

// Item 11b: a replay returns the same receipt. After a completed restore the live tree has moved,
// so the plan recomputed now would not match; the journal answers first.
test('a replay of a completed restore returns its saved receipt, though the workspace moved', async () => {
  const x = restoreFixture();
  try {
    let tree = 't2',
      content: string | null = 'v2';
    const real = Object.assign(Object.create(StationWork.prototype), {
      store: x.f.store,
      artifacts: new Artifacts(mkdtempSync('/tmp/sal-rr-'), x.f.store),
      configurationDigest: 'c'.repeat(64),
      helper: async (request: Record<string, unknown>) => {
        if (request.action === 'inspect') return { tree_digest: tree };
        tree = 'restored-' + String(request.path);
        content = request.content === null ? null : String(request.content);
        return {
          ok: true,
          path: request.path,
          before_tree_digest: request.expected_tree,
          tree_digest: tree,
          sha256: null,
        };
      },
      live: async () => ({
        tree,
        file: async () =>
          content === null
            ? { state: 'absent' as const }
            : { state: 'content' as const, content, sha256: 'h-' + content },
      }),
    }) as StationWork;
    x.f.work.verification.station = { station: real } as never;
    const id = x.checkpoint(),
      d = await x.digestOf(id);
    x.end();
    const first = await x.f.work.restore(x.f.binding, 'restore:1', id, d, 'prn_admin');
    expect(first).toMatchObject({ state: 'restored' });
    expect(content).toBe('v1');
    // The same approval again: the saved receipt, not a refusal, and nothing written twice.
    expect(await x.f.work.restore(x.f.binding, 'restore:1', id, d, 'prn_admin')).toEqual(first);
    expect(tree).toBe('restored-runs/r/a.md');
    // The same request id for a different digest is still a conflict.
    await expect(
      x.f.work.restore(x.f.binding, 'restore:1', id, 'e'.repeat(64), 'prn_admin'),
    ).rejects.toThrow('another restore');
  } finally {
    x.f.close();
  }
});

test('no restore while another run is active on the station', async () => {
  const x = restoreFixture();
  try {
    const id = x.checkpoint(),
      d = await x.digestOf(id);
    x.end();
    x.f.store.db
      .prepare(
        "INSERT INTO agentpod_admissions(id,session_id,hub_session_id,run_key,binding,digest,pins_digest,expires_at,state) VALUES ('other',?,'hub-other','k-other','{}','d','p',0,'active')",
      )
      .run(x.f.store.create('/tmp', 'other').id);
    await expect(x.f.work.restore(x.f.binding, 'restore:1', id, d, 'prn_admin')).rejects.toThrow(
      'Another run',
    );
    expect(x.restored).toHaveLength(0);
  } finally {
    x.f.close();
  }
});

// Board reads (operator ruling 2026-10-28, option iii): the owner sees what the agent is waiting
// to read in work status, and answers it through work-read, for this run only.
test('work status lists pending board reads, and only the owner of this run answers them', async () => {
  const f = fixture();
  try {
    f.run();
    const { BoardReads } = await import('../../src/runtime/board-reads.js');
    const read = new BoardReads(f.store).request(f.session, 'call-br', { action: 'card' });
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      board_reads?: unknown[];
    };
    expect(status.board_reads).toEqual([{ id: read.id, action: 'card', args: {} }]);
    expect(
      f.work.answerBoardRead(f.binding, { read_id: read.id, ok: true, text: 'the card' }),
    ).toMatchObject({
      state: 'answered',
      text: 'the card',
    });
    const after = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      board_reads?: unknown[];
    };
    expect(after.board_reads).toBeUndefined();
    // Another run's binding cannot answer this run's read.
    const other = new BoardReads(f.store).request(f.session, 'call-br2', { action: 'attempts' });
    expect(() =>
      f.work.answerBoardRead(
        { ...f.binding, run: { ...f.binding.run, id: 'run_Other1' } },
        { read_id: other.id, ok: true, text: 'x' },
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});

// The board-read contract the hub codes against (operator ruling 2026-10-28). Generated from what
// Salaam itself emits and accepts; the hub keeps a byte copy (packages/contract/src/fixtures/
// salaam-board-read-v1.json) and its tests fail when either side moves. Regenerate with
// SALAAM_WRITE_FIXTURES=1.
test('the board-read fixture is what Salaam emits in work status and accepts in work-read', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { BoardReads, BOARD_READ_MAX_BYTES } = await import('../../src/runtime/board-reads.js');
  const f = fixture();
  try {
    f.run();
    const before = (await f.work.status(f.binding, settlementDriver(f))) as unknown as Record<
      string,
      unknown
    >;
    const reads = new BoardReads(f.store);
    for (const [call, args] of [
      ['c1', { action: 'card' }],
      ['c2', { action: 'attempts' }],
      ['c3', { action: 'library_search', query: 'gateway timeout' }],
      ['c4', { action: 'library_get', item_id: 'itm_0123456789abcdef' }],
    ] as const)
      reads.request(f.session, call, args);
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as Record<
      string,
      unknown
    >;
    // Exactly what pending reads add to work status, under whatever key Salaam emits them.
    const added = Object.keys(status).filter((k) => !(k in before));
    expect(added).toHaveLength(1);
    const ids = (status as unknown as Record<string, { id: string }[]>)[added[0]!]!.map(
      (r) => r.id,
    );
    const named = (list: { id: string }[]) => list.map((r, i) => ({ ...r, id: 'read-' + (i + 1) }));
    const generated = {
      version: 1,
      // Ids are random per run; the fixture names them by position.
      status_excerpt: {
        [added[0]!]: named((status as unknown as Record<string, { id: string }[]>)[added[0]!]!),
      },
      answer_keys: { ok: ['ok', 'read_id', 'text'], refused: ['error', 'ok', 'read_id'] },
      max_text_bytes: BOARD_READ_MAX_BYTES,
      max_error_bytes: 2048,
      answers: [
        { read_id: 'read-1', ok: true, text: '{"card":{"id":"card_0123456789abcdef"}}' },
        { read_id: 'read-2', ok: false, error: 'That library item belongs to another board.' },
      ],
    };
    const url = new URL('../fixtures/agentpod-board-read-v1.json', import.meta.url);
    const text = JSON.stringify(generated, null, 2) + '\n';
    if (process.env.SALAAM_WRITE_FIXTURES === '1') writeFileSync(url, text);
    expect(readFileSync(url, 'utf8')).toBe(text);
    // Salaam accepts exactly the fixture's answers (ids mapped back), and refuses any other key.
    const fx = JSON.parse(text) as typeof generated;
    const real = (a: Record<string, unknown>) => ({
      ...a,
      read_id: ids[Number(String(a.read_id).slice(5)) - 1],
    });
    for (const a of fx.answers)
      expect(f.work.answerBoardRead(f.binding, real(a))).toMatchObject({ state: 'answered' });
    expect(() =>
      f.work.answerBoardRead(f.binding, { readId: ids[2], ok: true, text: 'x' }),
    ).toThrow();
    expect(() =>
      f.work.answerBoardRead(f.binding, { read_id: ids[2], ok: true, body: 'x' }),
    ).toThrow();
  } finally {
    f.close();
  }
});
