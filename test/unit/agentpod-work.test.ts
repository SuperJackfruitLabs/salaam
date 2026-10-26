import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { AgentPodAuthority } from '../../src/agentpod-authority.js';
import { ManagedWork } from '../../src/managed.js';
import { AgentPodWorkDecisions } from '../../src/agentpod-work-decisions.js';
import { AgentPodWork } from '../../src/agentpod-work.js';
import { Artifacts } from '../../src/artifacts.js';
import { TaskContext } from '../../src/task-context.js';
import { TaskWork } from '../../src/task-work.js';
import { TaskDriver } from '../../src/task-driver.js';
import { TaskBudget } from '../../src/task-budget.js';
import { TaskVerification } from '../../src/task-verification.js';
import { Workspaces } from '../../src/workspaces.js';
import { CodingWork } from '../../src/coding.js';
import { TaskFixtureBackend } from '../fixtures/task-backend.mjs';
import { canonical, digest, textDigest } from '../../src/protocol.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { configurePermissions } from '../../src/autonomy.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { workTraceHeader } from '../../src/execution-trace.js';
import { planUpdate } from '../../src/acp-outcome.js';
import { readinessFingerprint } from '../../src/readiness-fingerprint.js';
import { ChildWork } from '../../src/children.js';
import { StationWork } from '../../src/station-work.js';
import type { Supervisor } from '../../src/supervisor.js';

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

function fixture(
  verifier = true,
  owned = true,
  resourcesStopped = () => true,
  nativeStation = false,
) {
  const base = realpathSync(mkdtempSync('/tmp/sal-work-admit-'));
  const workspace = join(base, 'source'),
    state = join(base, 'state');
  mkdirSync(workspace);
  mkdirSync(state);
  writeFileSync(join(workspace, 'app.js'), 'fixture');
  const binding = {
    version: 1 as const,
    organization_id: 'org_' + '1'.repeat(20),
    principal_id: 'prn_' + '2'.repeat(20),
    node_id: 'node_fixture',
    station_id: 'station_fixture',
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
    occupancy_epoch: 1,
    hub_session_id: 'hub_fixture',
    workspace,
    run: { source: 'superpipeline' as const, id: 'run_Aa0Bb1', epoch: 1 },
  };
  const pins = join(base, 'pins.json');
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: binding.organization_id,
      node_id: binding.node_id,
      station_key: binding.station_key,
      workspace,
    }),
    { mode: 0o600 },
  );
  let store: Store, authority: AgentPodAuthority, tasks: TaskWork, work: AgentPodWork;
  const open = () => {
    store = new Store(join(state, 'journal.sqlite'));
    authority = new AgentPodAuthority(store, state, pins, () => {}, resourcesStopped);
    const artifacts = new Artifacts(join(state, 'artifacts'), store);
    tasks = new TaskWork(store, new TaskContext(store, artifacts));
    const budget = new TaskBudget(store, tasks);
    const workspaces = new Workspaces(store, artifacts, join(state, 'owned'));
    const backend = new TaskFixtureBackend();
    backend.profileDigest = digest('synthetic task fixture execution profile');
    const coding = new CodingWork(
      store,
      workspaces,
      artifacts,
      verifier ? backend : undefined,
      () => {},
    );
    work = new AgentPodWork(
      store,
      authority,
      tasks,
      new TaskVerification(store, tasks, budget, workspaces, coding, artifacts),
    );
    if (nativeStation)
      work.verification.station = {
        binding: () => ({
          version: 1,
          runner: 'linux-systemd-station-v1',
          root_digest: digest(binding),
          configuration_digest: digest({ fixture: true }),
          network: 'none',
          command_workspace: 'read-only-reviewed-snapshot',
        }),
        observing: () => false,
      } as never;
    return workspaces;
  };
  const workspaces = open();
  const admitted = authority!.admit(binding, 'admit');
  authority!.renew(binding, 'renew', 1);
  if (owned) workspaces.import(admitted.session_id, workspace);
  const input = { title: 'Inspect fixture', spec: 'No external effects' };
  const plan = {
    objective: 'Inspect fixture',
    constraints: [],
    steps: [
      {
        key: 'inspect',
        title: 'Inspect',
        instruction: 'Inspect',
        depends_on: [],
        checks: ['tests'],
      },
    ],
    acceptance: [{ key: 'tests', command: 'fixture-pass', cwd: '.' }],
    deliverables: [],
  };
  const expected = { board_id: 'brd_Aa0Bb1', card_id: 'card_Aa0Bb1', stage_key: 'implement' };
  const request = {
    version: 1,
    request_id: randomUUID(),
    binding,
    work: { ...expected, input_digest: digest(input), plan_digest: digest(tasks!.parse(plan)) },
  };
  return {
    base,
    binding,
    request,
    input,
    plan,
    expected,
    state,
    session: admitted.session_id,
    get store() {
      return store!;
    },
    get authority() {
      return authority!;
    },
    get work() {
      return work!;
    },
    get tasks() {
      return tasks!;
    },
    run(value: unknown = request, rawInput: unknown = input, rawPlan: unknown = plan) {
      return work.admit(admitted.session_id, value, expected, rawInput, rawPlan);
    },
    reopen() {
      store.close();
      open();
    },
    close() {
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

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

function settlementDriver(f: ReturnType<typeof fixture>) {
  const v = f.work.verification;
  return new TaskDriver(
    f.store,
    f.tasks,
    v.budget,
    v,
    {} as never,
    { cancelSessionInTransaction: () => {} } as never,
    v.coding,
  );
}

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

async function expiredWorkFixture() {
  const f = fixture(),
    admitted = f.run();
  const step = f.tasks.get(admitted.task_id).steps[0]!;
  const submission = f.store.transaction(() =>
    f.store.enqueue(f.session, randomUUID(), 'Test exact expiry', undefined, null, step.id),
  );
  const epoch = f.store.allocate(f.session, 'test');
  f.store.state(f.session, epoch, 'ready');
  f.store.claim(f.session, epoch);
  f.store.running(submission.attempt_id);
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    assertMcpOperation() {},
    reply() {},
    failed() {},
    approvalTtlMs: 1000,
  });
  await managed.prepareMcp(
    f.session,
    epoch,
    submission.attempt_id,
    'expiry-call',
    'library/fixture',
    '{}',
    'a'.repeat(64),
  );
  const offer = new AgentPodWorkDecisions(f.work, managed).list(f.binding).decisions[0]!;
  await new Promise((r) => setTimeout(r, 1010));
  managed.expire();
  await managed.close();
  f.store.db.prepare("UPDATE attempts SET state='cancelled' WHERE id=?").run(submission.attempt_id);
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(admitted.task_id);
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'expired-revoke', 'Expired decision stopped');
  return { f, admitted, offer, managed };
}

test('expired unanswered operation cancellation uses exact offer, preserves history and replays after restart', async () => {
  const { f, admitted, offer, managed } = await expiredWorkFixture();
  try {
    const request = randomUUID();
    const run = () =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(() =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        randomUUID(),
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow('saved decision');
    const receipt = run();
    expect(receipt).toMatchObject({
      state: 'cancelled',
      effects: 'expired_approval_unapplied',
      approval_id: offer.approval_id,
      operation_digest: offer.operation_digest,
    });
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-expiry-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...wire.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      decision_request_id: offer.request_id,
      approval_id: offer.approval_id,
      operation_digest: offer.operation_digest,
      session_id: f.session,
      task_id: admitted.task_id,
      binding_digest: digest(f.binding),
    });
    expect(managed.operation(offer.operation_id).state).toBe('cancelled_before_dispatch');
    expect(managed.approval(offer.approval_id).decision).toBeNull();
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        offer.request_id,
        'b'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});

test.each(['outcome_unknown', 'succeeded'])(
  'expired task settlement refuses operation state %s',
  async (state) => {
    const { f, admitted, offer } = await expiredWorkFixture();
    try {
      f.store.db.prepare('UPDATE operations SET state=? WHERE id=?').run(state, offer.operation_id);
      expect(() =>
        f.work.expire(
          f.binding,
          randomUUID(),
          admitted.request_id,
          offer.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        ),
      ).toThrow();
      expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    } finally {
      f.close();
    }
  },
);

// Journal conformance for the stopped native-child concurrency denial; no live provider.
function zeroEffectFailureFixture() {
  const f = fixture();
  const plan = { ...f.plan, limits: { ...f.tasks.parse(f.plan).limits, concurrency: 1 } };
  const admitted = f.run(
    { ...f.request, work: { ...f.request.work, plan_digest: digest(f.tasks.parse(plan)) } },
    f.input,
    plan,
  );
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const accepted = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES (?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db.prepare('UPDATE task_steps SET attempt_id=? WHERE id=?').run(a.attempt_id, step.id);
    return a;
  });
  const reason = 'Task concurrency limit reached';
  f.store.db.prepare('UPDATE attempts SET worker_epoch=1 WHERE id=?').run(accepted.attempt_id);
  f.store.transaction(() =>
    f.store.event(f.session, 'model.admitted', { attempt_id: accepted.attempt_id, epoch: 1 }),
  );
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.started', {
      tool: 'spawn_child',
      tool_call_id: 'child-call',
      attempt_id: accepted.attempt_id,
      worker_epoch: 1,
    }),
  );
  f.store.transaction(() =>
    f.store.event(f.session, 'policy.allowed', {
      tool: 'spawn_child',
      attempt_id: accepted.attempt_id,
      epoch: 1,
    }),
  );
  f.store.db
    .prepare("UPDATE attempts SET state='interrupted',error=? WHERE id=?")
    .run('Pi exited (0)', accepted.attempt_id);
  f.store.db.prepare("UPDATE task_steps SET state='interrupted' WHERE id=?").run(step.id);
  f.store.db.prepare('UPDATE task_runtime SET requests_spent=1 WHERE task_id=?').run(task.id);
  f.work.verification.budget.block(f.session, reason);
  f.store.transaction(() => {
    f.store.event(f.session, 'worker.unhealthy', {
      epoch: 1,
      error: 'Required control failed: ' + reason,
    });
    f.store.event(f.session, 'attempt.interrupted', {
      attempt_id: accepted.attempt_id,
      error: 'Pi exited (0)',
    });
  });
  f.authority.revoke(f.binding, 'zero-revoke', 'Original failed run stopped');
  return { f, admitted, accepted };
}

test('zero-effect concurrency retirement preserves the exact interrupted journal and replays', () => {
  const { f, admitted, accepted } = zeroEffectFailureFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'zero-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const unit = 'a'.repeat(64);
    f.store.db
      .prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state,stop_json) VALUES(?,NULL,?,'{}','/tmp/source','/tmp/output','stopped',?)",
      )
      .run(
        unit,
        'b'.repeat(64),
        JSON.stringify({
          version: 1,
          unit: `salaam-station-${unit}.service`,
          cgroup: `/system.slice/salaam-station-${unit}.service`,
          invocation: 'c'.repeat(32),
          observed_empty: true,
        }),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(accepted.attempt_id)).toMatchObject({
      state: 'interrupted',
      resolved_by: null,
    });
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM operations').get()!.n).toBe(0);
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    f.close();
  }
});

test.each([
  'foreign-binding',
  'active',
  'unknown-error',
  'wrong-budget',
  'missing-event',
  'changed-plan',
  'reservation',
  'checks',
  'operation',
  'mcp-call',
  'station-read',
  'toolkit-resource',
  'unbound-resource',
  'uncertain-child',
  'other-tool',
  'finished-tool',
  'unhealthy-mismatch',
  'spent-requests',
  'wrong-step-link',
  'orphan-child-worker',
  'orphan-external',
  'orphan-model-request',
])('zero-effect concurrency retirement rejects %s', (failure) => {
  const { f, admitted, accepted } = zeroEffectFailureFixture();
  try {
    const db = f.store.db;
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_repository') WHERE kind='tool.started'",
      ).run();
    if (failure === 'finished-tool')
      f.store.transaction(() => f.store.event(f.session, 'tool.finished', {}));
    if (failure === 'unhealthy-mismatch')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.error','unknown') WHERE kind='worker.unhealthy'",
      ).run();
    if (failure === 'spent-requests') db.prepare('UPDATE task_runtime SET requests_spent=2').run();
    if (failure === 'wrong-step-link')
      db.prepare('UPDATE task_step_attempts SET plan_revision=2').run();
    if (failure.startsWith('orphan-')) {
      db.exec('PRAGMA foreign_keys=OFF');
      if (failure === 'orphan-child-worker')
        db.prepare(
          "INSERT INTO child_workers(child_id,binding,binding_digest,dispatch_state) VALUES('missing','{}',?,'dispatching')",
        ).run('a'.repeat(64));
      if (failure === 'orphan-external')
        db.prepare(
          "INSERT INTO external_runs(child_id,run_id,state,epoch) VALUES('missing','run','running',1)",
        ).run();
      if (failure === 'orphan-model-request')
        db.prepare(
          "INSERT INTO external_model_requests(id,child_id,input_bytes,output_bound) VALUES('model','missing',1,1)",
        ).run();
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'active') db.prepare("UPDATE attempts SET state='running'").run();
    if (failure === 'unknown-error') db.prepare("UPDATE attempts SET error='unknown stop'").run();
    if (failure === 'wrong-budget')
      db.prepare("UPDATE task_runtime SET blocked_reason='different'").run();
    if (failure === 'missing-event')
      db.prepare("DELETE FROM events WHERE kind='work_task.budget_blocked'").run();
    if (failure === 'changed-plan') db.prepare("UPDATE task_steps SET instruction='changed'").run();
    if (failure === 'reservation') db.prepare('UPDATE task_runtime SET reserved_requests=1').run();
    if (failure === 'checks') db.prepare('UPDATE task_runtime SET verification_runs=1').run();
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'workspace',?,'outcome_unknown',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, accepted.attempt_id, 'a'.repeat(64));
    if (failure === 'mcp-call')
      db.prepare(
        "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,created_at) VALUES('mcp',?,1,?,'call',?,?,?, ?,1,'server','tool','read','{}','returned',1)",
      ).run(f.session, accepted.attempt_id, ...Array(4).fill('a'.repeat(64)));
    if (failure === 'station-read')
      db.prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES('read',?,1,?,'read','read',?,?,?,'{}','returned')",
      ).run(f.session, accepted.attempt_id, ...Array(3).fill('a'.repeat(64)));
    if (failure === 'toolkit-resource')
      db.prepare(
        "INSERT INTO toolkit_resources(id,session_id,root_digest,profile_digest,state_dir,input_digest,spec,owner_boot,state) VALUES('resource',?,?,?,'/tmp/fixture',?,'{}','boot','unconfirmed')",
      ).run(f.session, ...Array(3).fill('a'.repeat(64)));
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run('a'.repeat(64));
    if (failure === 'uncertain-child') {
      const child = f.store.create('/tmp/child', randomUUID());
      const a = accepted;
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, accepted.attempt_id, 'a'.repeat(64), child.id, a.attempt_id);
    }
    const binding =
      failure === 'foreign-binding'
        ? { ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }
        : f.binding;
    expect(() =>
      f.work.fail(binding, 'reject-zero', admitted.request_id, 'a'.repeat(64), settlementDriver(f)),
    ).toThrow();
    expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

// Historical journal conformance; the production child writer creates frozen
// diagnostic delegation and result artifacts. No model/provider is dispatched.
function addKnownReadOnlyReceipts(
  f: ReturnType<typeof fixture>,
  task: ReturnType<TaskWork['get']>,
  attempt: string,
) {
  const db = f.store.db,
    root = digest(f.binding),
    artifacts = f.work.verification.artifacts;
  const mcpId = randomUUID(),
    tool = 'readonly-mcp',
    args = { query: 'fixture' };
  const view = {
    version: 1,
    profile_digest: 'a'.repeat(64),
    assignment_digest: 'b'.repeat(64),
    binding_digest: root,
    credential_generation: 1,
    servers: [
      {
        name: 'superlibrary',
        endpoint_digest: 'c'.repeat(64),
        catalog_digest: 'd'.repeat(64),
        tools: [{ name: 'library_search', schema_digest: 'e'.repeat(64), policy: 'read' }],
      },
    ],
  };
  f.store.transaction(() => f.store.event(f.session, 'mcp.assigned', view));
  const result = artifacts.put(
    f.session,
    canonical({ protocol_result: 'returned', is_error: false, content: [] }),
  );
  db.prepare(
    "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,result_artifact,created_at) VALUES(?,?,1,?,?,?,?,?,?,1,'superlibrary','library_search','read',?,'returned',?,1)",
  ).run(
    mcpId,
    f.session,
    attempt,
    tool,
    digest({
      session: f.session,
      epoch: 1,
      attempt,
      call: tool,
      server: 'superlibrary',
      tool: 'library_search',
      arguments: args,
    }),
    root,
    view.profile_digest,
    view.assignment_digest,
    canonical(args),
    result,
  );
  const input = canonical({
    action: 'call',
    server: 'superlibrary',
    tool: 'library_search',
    arguments: args,
  });
  f.store.transaction(() => {
    f.store.event(f.session, 'tool.started', {
      attempt_id: attempt,
      worker_epoch: 1,
      tool_call_id: tool,
      tool: 'salaam_mcp',
      input,
      input_digest: textDigest(input),
      input_truncated: false,
    });
    f.store.event(f.session, 'tool.finished', {
      attempt_id: attempt,
      worker_epoch: 1,
      tool_call_id: tool,
      tool: 'salaam_mcp',
      failed: false,
    });
  });
  f.store.enableStationTaskChecks();
  const check = randomUUID(),
    call = randomUUID(),
    unit = 'a'.repeat(64),
    inspection = randomUUID(),
    tree = 'f'.repeat(64),
    config = { fixture: true };
  const station = f.work.verification.binding(task) as Record<string, unknown>;
  const command = task.acceptance[0]!.command;
  const callArgs = canonical({ action: 'check', command, expected_tree: tree });
  const cleanup = {
    version: 1,
    unit: `salaam-station-${unit}.service`,
    cgroup: `/system.slice/salaam-station-${unit}.service`,
    invocation: 'c'.repeat(32),
    observed_empty: true,
  };
  const nativeResult = {
    cleanup,
    exit_code: 0,
    expected_tree: tree,
    observed_tree: tree,
    network: 'none',
    workspace: 'read-only-reviewed-snapshot',
    verified_check: true,
    output: 'passed',
  };
  db.prepare("INSERT INTO task_checks VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'passed',NULL)").run(
    check,
    task.id,
    task.steps[0]!.id,
    task.acceptance[0]!.key,
    task.plan_revision,
    'station:' + root,
    0,
    tree,
    digest(config),
    'linux-systemd-station-v1',
  );
  const helper = (id: string) => ({
    version: 1,
    scope: 'local_process_group',
    method: 'observed_exit',
    pid: 42,
    identity: 'linux-proc-v1:' + id.repeat(64),
  });
  for (const [id, kind, toolCall, encoded, resultJson, identity] of [
    [call, 'check', 'task-check:' + check, callArgs, canonical(nativeResult), 'b'],
    [inspection, 'read', inspection, canonical({ action: 'inspect' }), null, 'c'],
  ] as const) {
    const stop = helper(identity);
    db.prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,result_json,helper_pid,helper_identity,helper_state,helper_stop_json,task_check_id) VALUES(?,?,0,NULL,?,?,?,?,?,?,'returned',?,42,?,'stopped',?,?)",
    ).run(
      id,
      f.session,
      toolCall,
      kind,
      digest(JSON.parse(encoded)),
      root,
      digest(config),
      encoded,
      resultJson,
      stop.identity,
      canonical(stop),
      check,
    );
  }
  db.prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    unit,
    f.session,
    call,
    digest({ id: call, root, configuration: digest(config), input: digest(JSON.parse(callArgs)) }),
    canonical(config),
    '/tmp/fixture-source',
    '/tmp/fixture-output',
    canonical({ id: cleanup.unit, cgroup: cleanup.cgroup, invocation: cleanup.invocation }),
    'stopped',
    canonical(cleanup),
  );
  const plan = digest({
    objective: task.objective,
    constraints: task.constraints,
    acceptance: task.acceptance,
    deliverables: task.deliverables,
    limits: task.limits,
    steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
      key,
      title,
      instruction,
      depends_on,
      checks,
    })),
  });
  const bound = {
    version: 1,
    check_id: check,
    check_digest: digest({
      id: check,
      task: task.id,
      key: task.acceptance[0]!.key,
      step: task.steps[0]!.id,
      plan_revision: task.plan_revision,
    }),
    task_id: task.id,
    plan_revision: task.plan_revision,
    plan_digest: plan,
    station,
    call_id: call,
    call_digest: digest({
      id: call,
      session: f.session,
      epoch: 0,
      attempt: null,
      tool: 'task-check:' + check,
      kind: 'check',
      input: digest(JSON.parse(callArgs)),
      root,
      configuration: digest(config),
      args: callArgs,
    }),
    tree_digest: tree,
  };
  const bindingArtifact = artifacts.put(f.session, canonical(bound));
  db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(
    'station-task-check',
    check,
    digest({ checkID: check, callID: call }),
    JSON.stringify(bindingArtifact),
  );
  const receipt = artifacts.put(
    f.session,
    canonical({
      version: 1,
      backend: 'linux-systemd-station-v1',
      binding_artifact: bindingArtifact,
      check_id: check,
      call_id: call,
      plan_revision: task.plan_revision,
      root_digest: root,
      configuration_digest: digest(config),
      tree_digest: tree,
      result_digest: digest(nativeResult),
    }),
  );
  db.prepare('UPDATE task_checks SET artifact_id=? WHERE id=?').run(receipt, check);
  db.prepare('UPDATE task_runtime SET verification_runs=1 WHERE task_id=?').run(task.id);
  f.store.transaction(() =>
    f.store.event(f.session, 'station.verification_observed', {
      source_call: call,
      inspection_call: inspection,
      tree_digest: tree,
    }),
  );
  return { mcpId, check, call, unit, inspection, bindingArtifact, receipt, result };
}

function knownReadOnlyFailureFixture(expiry = false) {
  const f = fixture(true, false, () => true, true);
  const plan = expiry
    ? {
        ...f.plan,
        steps: [
          ...f.plan.steps,
          {
            key: 'patch',
            title: 'Patch',
            instruction: 'Review one patch',
            depends_on: ['inspect'],
            checks: [],
          },
        ],
      }
    : f.plan;
  const admitted = f.run(
    { ...f.request, work: { ...f.request.work, plan_digest: digest(f.tasks.parse(plan)) } },
    f.input,
    plan,
  );
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const accepted = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES (?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='awaiting_review',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a;
  });
  f.store.bindRoute(f.session, OFFLINE_ROUTE);
  const epoch = f.store.allocate(f.session, 'readonly-history');
  f.store.state(f.session, epoch, 'ready');
  f.store.claim(f.session, epoch);
  f.store.running(accepted.attempt_id);
  const supervisor = {
    assertActive() {},
    assertSessionProviderSupported() {},
    start: async () => {},
    failControl() {},
  } as unknown as Supervisor;
  const children = new ChildWork(f.store, f.work.verification.artifacts, supervisor);
  const recordModel = (session: string, attempt: string) => {
    const key = 'salaam-request:' + randomUUID(),
      route = f.store.providerRoute(session)!;
    f.store.usage.admit(session, attempt, key, route.provider, route.model, {
      input: 0,
      output: 1,
    });
    f.store.transaction(() => {
      f.store.event(session, 'model.admitted', {
        attempt_id: attempt,
        epoch: 1,
        provider: route.provider,
        context_digest: 'a'.repeat(64),
        payload_digest: 'b'.repeat(64),
        task_version: 0,
      });
      f.store.usage.observe(session, key, route.provider, route.model, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0 },
      });
    });
  };
  recordModel(f.session, accepted.attempt_id);
  const childInput = canonical({
    step_key: 'diagnostic',
    prompt: 'Read-only diagnostic',
    budget: 2,
    wait: true,
  });
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.started', {
      attempt_id: accepted.attempt_id,
      worker_epoch: 1,
      tool_call_id: 'spawn-diagnostic',
      tool: 'spawn_child',
      input: childInput,
      input_digest: textDigest(childInput),
      input_truncated: false,
    }),
  );
  const child = children.spawn(
    f.session,
    epoch,
    accepted.attempt_id,
    'diagnostic',
    'Read-only diagnostic',
    2,
    ['salaam_probe'],
  );
  f.store.bindRoute(child.child_session, OFFLINE_ROUTE);
  f.store.db
    .prepare(
      "UPDATE child_workers SET generation=1,worker_epoch=1,dispatch_state='accepted' WHERE child_id=?",
    )
    .run(child.id);
  f.store.db
    .prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?")
    .run(child.child_attempt);
  recordModel(child.child_session, child.child_attempt);
  f.store.finish(child.child_attempt, 'completed', 'Diagnostic returned', null);
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.finished', {
      attempt_id: accepted.attempt_id,
      worker_epoch: 1,
      tool_call_id: 'spawn-diagnostic',
      tool: 'spawn_child',
      failed: false,
    }),
  );
  f.store.finish(accepted.attempt_id, 'completed', 'Read-only work returned', null);
  f.store.db
    .prepare("UPDATE durable_tasks SET state='partially_completed' WHERE id=?")
    .run(task.id);
  f.store.db.prepare("UPDATE task_steps SET state='awaiting_review' WHERE id=?").run(step.id);
  if (!expiry)
    f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  const receipts = addKnownReadOnlyReceipts(f, task, accepted.attempt_id);
  if (!expiry) f.authority.revoke(f.binding, 'readonly-revoke', 'Original partial run stopped');
  return { f, admitted, accepted, child, children, receipts, recordModel };
}

test('known readonly non-success retirement preserves completed diagnostic history without claiming verification', async () => {
  const { f, admitted, child, children } = knownReadOnlyFailureFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'readonly-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(child.child_attempt).state).toBe('completed');
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await children.close();
    f.close();
  }
});

test.each([
  'foreign-binding',
  'changed-plan',
  'auto-enabled',
  'unfinished-child',
  'child-coding',
  'child-binding',
  'child-result-bytes',
  'unknown-model',
  'orphan-budget',
  'unmatched-model',
  'mcp-approval',
  'mcp-unknown',
  'mcp-profile',
  'mcp-result-bytes',
  'unaccounted-mcp',
  'failed-check',
  'changed-command',
  'wrong-tree',
  'missing-unit-stop',
  'unit-uncertain',
  'unit-context',
  'helper-stop',
  'unaccounted-inspection',
  'write-call',
  'unknown-unit',
  'unaccounted-tool',
  'duplicate-tool-end',
  'orphan-external',
])('known readonly non-success retirement rejects %s', async (failure) => {
  const { f, admitted, accepted, child, children, receipts } = knownReadOnlyFailureFixture();
  try {
    const db = f.store.db;
    if (failure === 'changed-plan') db.prepare("UPDATE task_steps SET instruction='changed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'unfinished-child')
      db.prepare("UPDATE child_workers SET dispatch_state='dispatching' WHERE child_id=?").run(
        child.id,
      );
    if (failure === 'child-coding' || failure === 'child-binding') {
      const row = db.prepare('SELECT binding FROM child_workers WHERE child_id=?').get(child.id)!;
      const binding = JSON.parse(String(row.binding));
      if (failure === 'child-coding') {
        binding.capabilities.commands = true;
        binding.capability_digest = digest(binding.capabilities);
      } else binding.owner_task = 'foreign-task';
      db.prepare('UPDATE child_workers SET binding=?,binding_digest=? WHERE child_id=?').run(
        canonical(binding),
        digest(binding),
        child.id,
      );
    }
    if (failure === 'child-result-bytes') {
      const row = db.prepare('SELECT artifact_id FROM child_tasks WHERE id=?').get(child.id)!;
      writeFileSync(join(f.state, 'artifacts', String(row.artifact_id)), 'changed');
    }
    if (failure === 'unknown-model')
      db.prepare("UPDATE usage_observations SET status='unknown'").run();
    if (failure === 'orphan-budget' || failure === 'orphan-external') {
      db.exec('PRAGMA foreign_keys=OFF');
      if (failure === 'orphan-budget')
        db.prepare("INSERT INTO attempt_budgets VALUES('missing',1,0,0)").run();
      else
        db.prepare(
          "INSERT INTO external_runs(child_id,run_id,state,epoch) VALUES('missing','run','running',1)",
        ).run();
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'unmatched-model')
      f.store.transaction(() =>
        f.store.event(f.session, 'model.admitted', { attempt_id: accepted.attempt_id, epoch: 1 }),
      );
    if (failure === 'mcp-approval') db.prepare("UPDATE mcp_calls SET policy='approval'").run();
    if (failure === 'mcp-unknown') db.prepare("UPDATE mcp_calls SET state='outcome_unknown'").run();
    if (failure === 'mcp-profile')
      db.prepare('UPDATE mcp_calls SET profile_digest=?').run('f'.repeat(64));
    if (failure === 'mcp-result-bytes')
      writeFileSync(join(f.state, 'artifacts', receipts.result), 'changed');
    if (failure === 'unaccounted-mcp')
      db.prepare(
        "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool')='salaam_mcp'",
      ).run();
    if (failure === 'failed-check') db.prepare("UPDATE task_checks SET state='failed'").run();
    if (failure === 'changed-command')
      db.prepare(
        "UPDATE station_calls SET args_json=json_set(args_json,'$.command','different') WHERE kind='check'",
      ).run();
    if (failure === 'wrong-tree')
      db.prepare(
        "UPDATE station_calls SET result_json=json_set(result_json,'$.observed_tree',?) WHERE kind='check'",
      ).run('a'.repeat(64));
    if (failure === 'missing-unit-stop')
      db.prepare('UPDATE station_units SET stop_json=NULL').run();
    if (failure === 'unit-uncertain')
      db.prepare(
        "UPDATE station_units SET stop_json=json_set(stop_json,'$.observed_empty',json('false'))",
      ).run();
    if (failure === 'unit-context')
      db.prepare('UPDATE station_units SET context_digest=?').run('f'.repeat(64));
    if (failure === 'helper-stop')
      db.prepare(
        "UPDATE station_calls SET helper_stop_json=json_set(helper_stop_json,'$.pid',99) WHERE kind='read'",
      ).run();
    if (failure === 'unaccounted-inspection')
      db.prepare("DELETE FROM events WHERE kind='station.verification_observed'").run();
    if (failure === 'write-call')
      db.prepare(
        "UPDATE station_calls SET kind='patch',attempt_id=?,task_check_id=NULL WHERE id=?",
      ).run(accepted.attempt_id, receipts.inspection);
    if (failure === 'unknown-unit')
      db.prepare(
        "INSERT INTO station_units(id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',?,'{}','unused','unused','unconfirmed')",
      ).run('a'.repeat(64));
    if (failure === 'unaccounted-tool')
      f.store.transaction(() => {
        const input = '{}';
        f.store.event(f.session, 'tool.started', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'effect',
          tool: 'salaam_effect',
          input,
          input_digest: textDigest(input),
          input_truncated: false,
        });
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'effect',
          tool: 'salaam_effect',
          failed: false,
        });
      });
    if (failure === 'duplicate-tool-end')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'readonly-mcp',
          tool: 'salaam_mcp',
          failed: false,
        }),
      );
    const binding =
      failure === 'foreign-binding'
        ? { ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }
        : f.binding;
    expect(() =>
      f.work.fail(
        binding,
        'reject-readonly',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(
      f.store.db.prepare('SELECT state FROM durable_tasks WHERE id=?').get(admitted.task_id)!.state,
    ).toBe('partially_completed');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    await children.close();
    f.close();
  }
});

test.each([true, false])(
  'known readonly non-success catalog requires an admitted selection (%s)',
  async (admittedCatalog) => {
    const { f, admitted, accepted, children } = knownReadOnlyFailureFixture();
    try {
      const input = canonical({
        action: 'catalog',
        server: admittedCatalog ? 'superlibrary' : 'foreign-server',
      });
      f.store.transaction(() => {
        f.store.event(f.session, 'tool.started', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'catalog',
          tool: 'salaam_mcp',
          input,
          input_digest: textDigest(input),
          input_truncated: false,
        });
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'catalog',
          tool: 'salaam_mcp',
          failed: false,
        });
      });
      const run = () =>
        f.work.fail(
          f.binding,
          'catalog-retire',
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        );
      if (admittedCatalog)
        expect(run()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
      else expect(run).toThrow();
    } finally {
      await children.close();
      f.close();
    }
  },
);

function preparedReadOnlyPatchFixture(ttl = 1000) {
  const x = knownReadOnlyFailureFixture(true),
    { f, admitted, recordModel } = x;
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[1]!;
  f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE id=?").run(task.steps[0]!.id);
  const attempt = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='running',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a.attempt_id;
  });
  f.store.db.prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?").run(attempt);
  recordModel(f.session, attempt);
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    reply() {},
    failed() {},
    approvalTtlMs: ttl,
  });
  managed.registerMcpController('station-workspace-v1', {
    owns: () => true,
    assert() {},
    assertSettled() {},
  });
  const tool = 'expired-patch',
    call = digest(['station-work-v1', f.session, 1, tool]);
  const args = {
    action: 'patch',
    path: 'app.js',
    expected_tree: 'f'.repeat(64),
    expected_hash: 'a'.repeat(64),
    content: 'reviewed proposal',
  };
  const input = JSON.stringify(args),
    root = digest(f.binding),
    config = digest({ fixture: true });
  let approval: string = '';
  f.store.transaction(() => {
    f.store.event(f.session, 'tool.started', {
      attempt_id: attempt,
      worker_epoch: 1,
      tool_call_id: tool,
      tool: 'salaam_station',
      input,
      input_digest: textDigest(input),
      input_truncated: false,
    });
    f.store.event(f.session, 'policy.allowed', {
      attempt_id: attempt,
      epoch: 1,
      tool: 'salaam_station',
    });
    const prepared = managed.prepareWorkspaceInTransaction(
      f.session,
      1,
      attempt,
      tool,
      'station:' + args.path,
      canonical(args),
      digest({ id: call, root, configuration: config, args }),
    );
    approval = prepared.approval.id;
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state) VALUES(?,?,1,?,?,'patch',?,?,?,?,?,'prepared')",
      )
      .run(
        call,
        f.session,
        attempt,
        tool,
        digest(args),
        root,
        config,
        canonical(args),
        prepared.operation.id,
      );
    f.store.event(f.session, 'station.call.prepared', {
      call_id: call,
      attempt_id: attempt,
      kind: 'patch',
      input_digest: digest(args),
    });
  });
  managed.bindDialog(
    f.session,
    1,
    approval,
    managed.approval(approval).operation_digest,
    'expiry-dialog',
  );
  const offer = new AgentPodWorkDecisions(f.work, managed).list(f.binding).decisions[0]!;
  return { ...x, managed, offer, call, attempt, args, tool, task };
}
async function invalidatedReadOnlyFixture() {
  const x = preparedReadOnlyPatchFixture(60000),
    { f, managed, call, attempt, task, offer } = x;
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(
      f.session,
      'invalidated-owner-revoke',
      'Original owner stopped',
      (id) => {
        managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node');
        f.store.db
          .prepare("UPDATE station_calls SET state='cancelled',revision=revision+1 WHERE id=?")
          .run(call);
        f.store.event(f.session, 'station.call.cancelled', {
          call_id: call,
          attempt_id: attempt,
          kind: 'patch',
        });
      },
    ),
  );
  (managed as unknown as { deliver(id: string): void }).deliver(offer.approval_id);
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'invalidated-owner-revoke', 'Original owner stopped');
  return x;
}

test('invalidated unanswered history retires as non-success and preserves original offer', async () => {
  const { f, admitted, children, managed, offer } = await invalidatedReadOnlyFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'invalidated-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(
      f.store.db.prepare('SELECT state,decision FROM approvals WHERE id=?').get(offer.approval_id),
    ).toMatchObject({ state: 'invalidated', decision: null });
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each([
  ['answered', "UPDATE approvals SET decision='approve',decided_by='local-operator'"],
  ['pending', "UPDATE approvals SET state='pending'"],
  ['operation unknown', "UPDATE operations SET state='outcome_unknown'"],
  ['operation receipt', "UPDATE operations SET receipt='{}'"],
  ['helper started', "UPDATE station_calls SET helper_pid=42 WHERE kind='patch'"],
  ['foreign root', "UPDATE station_calls SET root_digest='foreign' WHERE kind='patch'"],
  ['missing offer', "DELETE FROM requests WHERE actor='agentpod-work-decision-offer'"],
  ['foreign cancellation actor', "UPDATE cancellations SET requested_by='unknown'"],
  [
    'malformed revocation arrays',
    "UPDATE session_revocations SET receipt=json_set(receipt,'$.session_ids',session_id,'$.unresolved_operations','')",
  ],
  ['missing root revocation', 'DELETE FROM session_revocations'],
  ['reordered root revocation', "UPDATE events SET seq=seq+1000 WHERE kind='execution.revoked'"],
  [
    'cancel provenance',
    "UPDATE events SET causation_id='unknown' WHERE kind='attempt.cancel_requested'",
  ],
  [
    'foreign revocation',
    "UPDATE session_revocations SET receipt=json_set(receipt,'$.session_id','foreign')",
  ],
  ['missing invalidation', "DELETE FROM events WHERE kind='approval.invalidated'"],
  ['unknown model', "UPDATE usage_observations SET status='unknown'"],
  ['prior failed check', "UPDATE task_checks SET state='failed'"],
  ['generic cancelled', "UPDATE durable_tasks SET state='cancelled'"],
])('invalidated history rejects %s', async (_name, sql) => {
  const { f, admitted, children, managed } = await invalidatedReadOnlyFixture();
  try {
    f.store.db.exec(sql);
    expect(() =>
      f.work.fail(
        f.binding,
        'invalidated-deny',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});
test('invalidated unanswered history cannot be labelled expired', async () => {
  const { f, admitted, children, managed, offer } = await invalidatedReadOnlyFixture();
  try {
    expect(() =>
      f.work.expire(
        f.binding,
        'not-expired',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

async function expiredReadOnlyFixture() {
  const x = preparedReadOnlyPatchFixture(),
    { f, managed, offer, call, attempt, task } = x;
  await new Promise((r) => setTimeout(r, 1010));
  managed.expire();
  f.store.transaction(() => {
    f.store.db
      .prepare("UPDATE station_calls SET state='cancelled',revision=revision+1 WHERE id=?")
      .run(call);
    f.store.event(f.session, 'station.call.cancelled', {
      call_id: call,
      attempt_id: attempt,
      kind: 'patch',
    });
    f.store.db.prepare("INSERT INTO cancellations VALUES(?,'expiry-test')").run(attempt);
  });
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'rich-expiry-revoke', 'Expired proposal stopped');
  return x;
}

test('expired unanswered patch retirement preserves prior native readonly receipts and replays', async () => {
  const { f, admitted, children, managed, offer, attempt } = await expiredReadOnlyFixture();
  try {
    const run = () =>
      f.work.expire(
        f.binding,
        'rich-expiry-retire',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'expired_approval_unapplied' });
    expect(f.store.attempt(attempt).state).toBe('cancelled');
    expect(
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each(['closed', 'unknown-effect', 'generic-failure'])(
  'cancelled expired history recovery %s',
  async (mode) => {
    const { f, admitted, children, managed, offer } = await expiredReadOnlyFixture();
    try {
      f.store.db
        .prepare("UPDATE durable_tasks SET state='cancelled' WHERE id=?")
        .run(admitted.task_id);
      if (mode === 'unknown-effect')
        f.store.db.prepare("UPDATE operations SET state='outcome_unknown'").run();
      let cancelCalls = 0;
      const driver = {
        cancelInTransaction: () => {
          cancelCalls++;
          throw Error('Already cancelled task must not be cancelled again');
        },
      } as unknown as TaskDriver;
      const run = () =>
        mode === 'generic-failure'
          ? f.work.fail(
              f.binding,
              'cancelled-expiry-generic',
              admitted.request_id,
              'a'.repeat(64),
              driver,
            )
          : f.work.expire(
              f.binding,
              'cancelled-expiry-close',
              admitted.request_id,
              offer.request_id,
              'a'.repeat(64),
              driver,
            );
      if (mode === 'closed') {
        const receipt = run();
        expect(receipt).toMatchObject({
          state: 'cancelled',
          effects: 'expired_approval_unapplied',
        });
        f.reopen();
        expect(run()).toEqual(receipt);
      } else expect(run).toThrow();
      expect(cancelCalls).toBe(0);
    } finally {
      await managed.close();
      await children.close();
      f.close();
    }
  },
);

test.each([
  'answered',
  'unexpired',
  'revision-drift',
  'operation-dispatched',
  'historical-dispatch',
  'helper-started',
  'result-present',
  'unknown-operation',
  'unknown-model',
  'prior-mcp-corrupt',
  'prior-check-corrupt',
  'prior-child-corrupt',
  'offer-drift',
  'extra-tool',
  'extra-operation',
])('expired readonly retirement rejects %s', async (failure) => {
  const { f, admitted, children, managed, offer, attempt, call, receipts, child } =
    await expiredReadOnlyFixture();
  try {
    const db = f.store.db;
    if (failure === 'extra-operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state) SELECT 'extra',session_id,attempt_id,worker_epoch,'extra-tool',kind,'extra-action',argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,'outcome_unknown' FROM operations WHERE id=?",
      ).run(offer.operation_id);

    if (failure === 'answered')
      db.prepare("UPDATE approvals SET decision='approve',decided_by='operator' WHERE id=?").run(
        offer.approval_id,
      );
    if (failure === 'unexpired')
      db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(
        Date.now() + 60000,
        offer.approval_id,
      );
    if (failure === 'revision-drift')
      db.prepare('UPDATE approvals SET revision=revision+1 WHERE id=?').run(offer.approval_id);
    if (failure === 'operation-dispatched')
      db.prepare("UPDATE operations SET state='dispatching' WHERE id=?").run(offer.operation_id);
    if (failure === 'historical-dispatch')
      f.store.transaction(() =>
        f.store.event(f.session, 'operation.dispatching', {
          operation_id: offer.operation_id,
          attempt_id: attempt,
        }),
      );
    if (failure === 'helper-started')
      db.prepare(
        "UPDATE station_calls SET helper_state='stopped',helper_pid=42,helper_identity='observed' WHERE id=?",
      ).run(call);
    if (failure === 'result-present')
      db.prepare("UPDATE station_calls SET result_json='{}' WHERE id=?").run(call);
    if (failure === 'unknown-operation')
      db.prepare("UPDATE operations SET state='outcome_unknown' WHERE id=?").run(
        offer.operation_id,
      );
    if (failure === 'unknown-model')
      db.prepare("UPDATE usage_observations SET status='unknown' WHERE attempt_id=?").run(attempt);
    if (failure === 'prior-mcp-corrupt')
      writeFileSync(join(f.state, 'artifacts', receipts.result), 'changed');
    if (failure === 'prior-check-corrupt')
      db.prepare("UPDATE task_checks SET state='failed'").run();
    if (failure === 'prior-child-corrupt')
      db.prepare("UPDATE child_workers SET dispatch_state='interrupted' WHERE child_id=?").run(
        child.id,
      );
    if (failure === 'offer-drift')
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.approval_revision',99) WHERE actor='agentpod-work-decision-offer'",
      ).run();
    if (failure === 'extra-tool')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.started', {
          attempt_id: attempt,
          worker_epoch: 1,
          tool_call_id: 'unknown',
          tool: 'salaam_effect',
          input: '{}',
          input_digest: textDigest('{}'),
          input_truncated: false,
        }),
      );
    expect(() =>
      f.work.expire(
        f.binding,
        'reject-rich-expiry',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-expiry'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM events WHERE kind='agentpod.work_expiry_evidence'").get(),
    ).toBeUndefined();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

async function approvedReadOnlyPatchFixture() {
  const x = preparedReadOnlyPatchFixture(60000),
    { f, managed, offer, call, attempt, args, tool, task } = x;
  const answer = {
    version: 1,
    request_id: randomUUID(),
    decision: offer,
    decision_digest: digest(offer),
    elicitation_id: 'elc_approvedfixture',
    option_id: 'approve',
    answered_by: 'operator',
    answered_at: new Date().toISOString(),
  };
  new AgentPodWorkDecisions(f.work, managed).answer(f.binding, answer);
  f.store.transaction(() => {
    expect(managed.takePermissionInTransaction(offer.operation_id)).toBe(true);
    f.store.db
      .prepare("UPDATE station_calls SET state='dispatching',revision=revision+1 WHERE id=?")
      .run(call);
    f.store.event(f.session, 'station.call.dispatching', {
      call_id: call,
      attempt_id: attempt,
      kind: 'patch',
    });
  });
  const result = {
    version: 1,
    ok: true,
    path: args.path,
    before_tree_digest: args.expected_tree,
    tree_digest: 'c'.repeat(64),
    sha256: textDigest(args.content),
    files: 1,
    root_identity: 'd'.repeat(64),
  };
  const stop = {
    version: 1,
    scope: 'local_process_group',
    method: 'observed_exit',
    pid: 43,
    identity: 'linux-proc-v1:' + 'e'.repeat(64),
  };
  const writer = Object.assign(Object.create(StationWork.prototype), {
    store: f.store,
    managed,
    artifacts: f.work.verification.artifacts,
    get: () => f.store.db.prepare('SELECT * FROM station_calls WHERE id=?').get(call),
    guard: () => {},
    authority: { leaseWindow: () => 5000 },
    helper: async () => {
      f.store.db
        .prepare(
          "UPDATE station_calls SET helper_state='stopped',helper_pid=43,helper_identity=?,helper_stop_json=? WHERE id=?",
        )
        .run(stop.identity, canonical(stop), call);
      return result;
    },
  }) as { perform(id: string): Promise<void> };
  await writer.perform(call);
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.finished', {
      attempt_id: attempt,
      worker_epoch: 1,
      tool_call_id: tool,
      tool: 'salaam_station',
      failed: false,
    }),
  );
  f.store.finish(attempt, 'completed', 'Approved patch returned', null);
  f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE task_id=?").run(task.id);
  f.store.db
    .prepare(
      "UPDATE durable_tasks SET state='partially_completed',reason='Stopped before final completion' WHERE id=?",
    )
    .run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'approved-history-revoke', 'Original known-effect work stopped');
  const effect = JSON.parse(
    String(
      f.store.db.prepare('SELECT receipt FROM operations WHERE id=?').get(offer.operation_id)!
        .receipt,
    ),
  );
  return { ...x, answer, effect };
}

test('approved patch with closed readonly history retires without changing its produced artifact or success', async () => {
  const { f, admitted, children, managed, offer, effect } = await approvedReadOnlyPatchFixture();
  try {
    const bytes = f.work.verification.artifacts.read(effect.artifact_id);
    const run = () =>
      f.work.fail(
        f.binding,
        'applied-history-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(run()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.work.verification.artifacts.read(effect.artifact_id)).toBe(bytes);
    expect(
      f.store.db.prepare('SELECT state FROM operations WHERE id=?').get(offer.operation_id)!.state,
    ).toBe('succeeded');
    const receipt = run();
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each([
  [
    'missing patch tool pair',
    "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool')='salaam_station'",
  ],
  [
    'produced artifact digest',
    "UPDATE artifacts SET digest='changed' WHERE id=(SELECT json_extract(receipt,'$.artifact_id') FROM operations LIMIT 1)",
  ],
  ['approval decision', "UPDATE approvals SET decision='deny'"],
  ['approval actor', "UPDATE approvals SET decided_by='scoped-policy'"],
  ['missing human answer', "DELETE FROM requests WHERE actor='agentpod-work-decision-answer'"],
  [
    'changed offer',
    "UPDATE requests SET hash='changed' WHERE actor='agentpod-work-decision-offer'",
  ],
  ['operator provenance', "DELETE FROM requests WHERE actor='local-operator'"],
  ['unknown helper', "UPDATE station_calls SET helper_state='running' WHERE kind='patch'"],
  ['unconfirmed operation', "UPDATE operations SET state='dispatching'"],
  ['foreign root', "UPDATE station_calls SET root_digest='foreign' WHERE kind='patch'"],
  ['foreign patch args', "UPDATE operations SET value='{}'"],
  ['changed produced receipt', "UPDATE operations SET receipt='{}'"],
  ['unknown native grant', "UPDATE usage_observations SET status='unknown'"],
  ['prior failed check', "UPDATE task_checks SET state='failed'"],
])('approved history rejects %s', async (_name, sql) => {
  const { f, admitted, children, managed } = await approvedReadOnlyPatchFixture();
  try {
    f.store.db.exec(sql);
    expect(() =>
      f.work.fail(
        f.binding,
        'applied-history-denied',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(
      f.store.db.prepare('SELECT state FROM durable_tasks WHERE id=?').get(admitted.task_id)!.state,
    ).toBe('partially_completed');
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each(['known-stale', 'third-tree', 'before-patch', 'missing-terminal'])(
  'approved history audits %s inspection without refreshing its check',
  async (mode) => {
    const { f, admitted, children, managed, effect, receipts } =
      await approvedReadOnlyPatchFixture();
    try {
      const old = f.store.db
        .prepare("SELECT * FROM events WHERE kind='station.verification_observed' LIMIT 1")
        .get()!;
      const payload = JSON.parse(String(old.payload));
      payload.tree_digest = mode === 'third-tree' ? '9'.repeat(64) : effect.result.tree_digest;
      const check = f.store.db.prepare('SELECT * FROM task_checks WHERE id=?').get(receipts.check)!;
      const bytes = f.work.verification.artifacts.read(String(check.artifact_id));
      f.store.db.prepare('DELETE FROM events WHERE id=?').run(String(old.id));
      if (mode === 'before-patch')
        f.store.db
          .prepare('INSERT INTO events VALUES(?,?,?,?,?,?)')
          .run(
            String(old.session_id),
            Number(old.seq),
            String(old.id),
            String(old.kind),
            old.causation_id === null ? null : String(old.causation_id),
            canonical(payload),
          );
      else
        f.store.transaction(() =>
          f.store.event(f.session, 'station.verification_observed', payload),
        );
      if (mode === 'missing-terminal')
        f.store.db.prepare("DELETE FROM events WHERE kind='operation.succeeded'").run();
      const retire = () =>
        f.work.fail(
          f.binding,
          'stale-history-retire',
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        );
      if (mode === 'known-stale')
        expect(retire()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
      else expect(retire).toThrow();
      expect(f.work.verification.artifacts.read(String(check.artifact_id))).toBe(bytes);
      expect(
        f.store.db
          .prepare('SELECT workspace_digest FROM task_checks WHERE id=?')
          .get(receipts.check)!.workspace_digest,
      ).toBe(check.workspace_digest);
    } finally {
      await managed.close();
      await children.close();
      f.close();
    }
  },
);

async function knownEffectFailureFixture() {
  const x = await expiredWorkFixture(),
    { f, admitted, offer } = x;
  const op = f.store.db.prepare('SELECT * FROM operations WHERE id=?').get(offer.operation_id)!;
  const callId = 'known-native-call',
    result = { version: 1, ok: true, path: 'app.js', sha256: 'a'.repeat(64) };
  const receipt = {
    version: 1,
    scope: 'station-workspace',
    call_id: callId,
    root_digest: digest(f.binding),
    configuration_digest: 'b'.repeat(64),
    input_digest: 'c'.repeat(64),
    result,
  };
  f.store.db
    .prepare(
      "UPDATE operations SET kind='workspace',state='succeeded',receipt=?,resolution='workspace-content-receipt-v1' WHERE id=?",
    )
    .run(JSON.stringify(receipt), offer.operation_id);
  f.store.db
    .prepare("UPDATE approvals SET state='decided',decision='approve' WHERE id=?")
    .run(offer.approval_id);
  f.store.db
    .prepare("UPDATE attempts SET state='interrupted',resolved_by=NULL WHERE id=?")
    .run(String(op.attempt_id));
  f.store.db
    .prepare("UPDATE task_steps SET state='interrupted',attempt_id=? WHERE task_id=?")
    .run(String(op.attempt_id), admitted.task_id);
  f.store.db
    .prepare(
      "UPDATE task_runtime SET blocked_reason='Provider payload exceeds declared per-request token bounds' WHERE task_id=?",
    )
    .run(admitted.task_id);
  f.store.db
    .prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,result_json,helper_state) VALUES(?,?,1,?,?,'patch',?,?,?,'{}',?,'returned',?,'stopped')",
    )
    .run(
      callId,
      f.session,
      String(op.attempt_id),
      callId,
      receipt.input_digest,
      receipt.root_digest,
      receipt.configuration_digest,
      offer.operation_id,
      JSON.stringify(result),
    );
  f.store.db
    .prepare('UPDATE attempts SET error=? WHERE id=?')
    .run(
      'Required control failed: Provider payload exceeds declared per-request token bounds',
      String(op.attempt_id),
    );
  f.store.transaction(() =>
    f.store.event(f.session, 'work_task.budget_blocked', {
      task_id: admitted.task_id,
      reason: 'Provider payload exceeds declared per-request token bounds',
    }),
  );
  return x;
}

test('known-effect retirement preserves interrupted history and effect receipt without another grant', async () => {
  const { f, admitted, offer } = await knownEffectFailureFixture();
  try {
    const request = randomUUID(),
      run = () =>
        f.work.fail(f.binding, request, admitted.request_id, 'a'.repeat(64), settlementDriver(f));
    const effect = f.store.db
      .prepare('SELECT receipt FROM operations WHERE id=?')
      .get(offer.operation_id)!.receipt;
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-failure-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...wire.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      task_id: admitted.task_id,
      session_id: f.session,
      binding_digest: digest(f.binding),
      evidence_digest: receipt.evidence_digest,
    });
    expect(f.store.db.prepare('SELECT state,resolved_by FROM attempts').get()).toMatchObject({
      state: 'interrupted',
      resolved_by: null,
    });
    expect(
      f.store.db.prepare('SELECT receipt FROM operations WHERE id=?').get(offer.operation_id)!
        .receipt,
    ).toBe(effect);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() =>
      f.work.fail(f.binding, request, admitted.request_id, 'b'.repeat(64), settlementDriver(f)),
    ).toThrow();
  } finally {
    f.close();
  }
});

test.each(['unknown', 'receipt-drift', 'unconfirmed', 'wrong-budget'])(
  'known-effect retirement rejects %s',
  async (failure) => {
    const { f, admitted, offer } = await knownEffectFailureFixture();
    try {
      if (failure === 'unknown')
        f.store.db
          .prepare("UPDATE operations SET state='outcome_unknown' WHERE id=?")
          .run(offer.operation_id);
      if (failure === 'receipt-drift')
        f.store.db.prepare("UPDATE station_calls SET result_json='{}'").run();
      if (failure === 'unconfirmed')
        f.store.db.prepare("UPDATE station_calls SET helper_state='unconfirmed'").run();
      if (failure === 'wrong-budget')
        f.store.db.prepare("UPDATE task_runtime SET blocked_reason='different failure'").run();
      expect(() =>
        f.work.fail(
          f.binding,
          randomUUID(),
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        ),
      ).toThrow();
      expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    } finally {
      f.close();
    }
  },
);

test('known-effect retirement retains original budget evidence after later elapsed runtime block', async () => {
  const { f, admitted } = await knownEffectFailureFixture();
  try {
    f.store.db
      .prepare(
        "UPDATE task_runtime SET blocked_reason='Task runtime limit reached',started_at=? WHERE task_id=?",
      )
      .run(Date.now(), admitted.task_id);
    const run = () =>
      f.work.fail(
        f.binding,
        'elapsed-failure',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(run).toThrow();
    f.store.db
      .prepare('UPDATE task_runtime SET started_at=? WHERE task_id=?')
      .run(Date.now() - f.tasks.get(admitted.task_id).limits.runtime_ms - 1, admitted.task_id);
    expect(run().effects).toBe('known_effects_preserved');
  } finally {
    f.close();
  }
});

// Journal conformance fixture, not a native process or live producer proof.
async function unreportedSuccessFixture() {
  const x = await knownEffectFailureFixture(),
    { f, admitted } = x;
  const artifacts = new Artifacts(join(f.state, 'artifacts'), f.store);
  f.store.db.prepare("UPDATE attempts SET state='completed',error=NULL").run();
  f.store.db
    .prepare("UPDATE task_steps SET state='completed' WHERE task_id=?")
    .run(admitted.task_id);
  f.store.db.prepare("UPDATE durable_tasks SET state='succeeded' WHERE id=?").run(admitted.task_id);
  const task = f.tasks.get(admitted.task_id),
    root = digest(f.binding),
    tree = 'd'.repeat(64),
    configuration = 'b'.repeat(64);
  f.store.transaction(() => {
    const result = { ok: true, exit_code: 0 };
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,result_json,helper_state) VALUES('historical-check',?,1,(SELECT id FROM attempts LIMIT 1),'historical-check','check',?,?,?,'{}','returned',?,'stopped')",
      )
      .run(f.session, 'c'.repeat(64), root, configuration, JSON.stringify(result));
    const artifact = artifacts.prepare(
      f.session,
      JSON.stringify({
        version: 1,
        backend: 'linux-systemd-station-v1',
        check_id: 'historical-check-id',
        call_id: 'historical-check',
        plan_revision: 1,
        root_digest: root,
        configuration_digest: configuration,
        tree_digest: tree,
        result_digest: digest(result),
      }),
    );
    artifact.commit();
    f.store.db
      .prepare('INSERT INTO task_checks VALUES (?,?,NULL,?,1,?,0,?,?,?,NULL,?,?)')
      .run(
        'historical-check-id',
        task.id,
        task.acceptance[0]?.key ?? 'check',
        'station:' + root,
        tree,
        'profile',
        'linux-systemd-station-v1',
        'passed',
        artifact.id,
      );
    const completion = artifacts.prepare(
      f.session,
      JSON.stringify({
        task_id: task.id,
        plan_revision: 1,
        workspace: { id: 'station:' + root, revision: 0, digest: tree },
        checks: ['historical-check-id'],
        deliverables: [],
        diff: {
          backend: 'linux-systemd-station-v1',
          root_digest: root,
          configuration_digest: configuration,
          workspace_digest: tree,
        },
        exception: null,
        missing_requirements: [],
        verified: true,
      }),
    );
    completion.commit();
    f.store.db
      .prepare('INSERT INTO task_completions VALUES(?,1,?,0,?,?,?,NULL)')
      .run(task.id, 'station:' + root, tree, completion.id, 'succeeded');
  });
  return x;
}

test('unreported local success retires only producer ownership and preserves success across replay/restart', async () => {
  const { f, admitted } = await unreportedSuccessFixture();
  try {
    const request = randomUUID(),
      run = () => f.work.abandon(f.binding, request, admitted.request_id, 'a'.repeat(64));
    const before = JSON.stringify(f.store.db.prepare('SELECT * FROM task_completions').all());
    const receipt = run();
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-abandon-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...fixture.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      session_id: f.session,
      task_id: admitted.task_id,
      binding_digest: digest(f.binding),
      evidence_digest: receipt.evidence_digest,
    });
    expect(f.tasks.get(admitted.task_id).state).toBe('succeeded');
    expect(JSON.stringify(f.store.db.prepare('SELECT * FROM task_completions').all())).toBe(before);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() => f.work.abandon(f.binding, request, admitted.request_id, 'b'.repeat(64))).toThrow();
    await expect(f.work.completion(f.binding)).rejects.toThrow();
  } finally {
    f.close();
  }
});

test.each(['interrupted', 'unknown', 'check-drift', 'exception', 'unconfirmed', 'incomplete'])(
  'unreported local success refuses %s',
  async (failure) => {
    const { f, admitted } = await unreportedSuccessFixture();
    try {
      if (failure === 'interrupted')
        f.store.db.prepare("UPDATE attempts SET state='interrupted'").run();
      if (failure === 'unknown')
        f.store.db.prepare("UPDATE operations SET state='outcome_unknown'").run();
      if (failure === 'check-drift')
        f.store.db.prepare("UPDATE task_checks SET workspace_digest='changed'").run();
      if (failure === 'exception')
        f.store.db.prepare("UPDATE task_completions SET exception='{}'").run();
      if (failure === 'unconfirmed')
        f.store.db.prepare("UPDATE station_calls SET helper_state='unconfirmed'").run();
      if (failure === 'incomplete')
        f.store.db.prepare("UPDATE durable_tasks SET state='blocked'").run();
      expect(() =>
        f.work.abandon(f.binding, randomUUID(), admitted.request_id, 'a'.repeat(64)),
      ).toThrow();
      expect(
        f.store.db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-abandonment'").get(),
      ).toBeUndefined();
    } finally {
      f.close();
    }
  },
);

test.each(['stopped-inspection', 'unconfirmed', 'mutation', 'unknown'])(
  'historical success retirement treats cancelled read as %s',
  async (variant) => {
    const { f, admitted } = await unreportedSuccessFixture();
    try {
      f.store.db
        .prepare(
          "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,helper_state) VALUES('cancelled-inspection',?,1,(SELECT id FROM attempts LIMIT 1),'cancelled-inspection','read',?,?,?,?,'cancelled',?)",
        )
        .run(
          f.session,
          'c'.repeat(64),
          digest(f.binding),
          'b'.repeat(64),
          JSON.stringify({ action: variant === 'mutation' ? 'patch' : 'inspect' }),
          variant === 'unconfirmed' ? 'unconfirmed' : 'stopped',
        );
      if (variant === 'unknown')
        f.store.db
          .prepare(
            "UPDATE station_calls SET state='outcome_unknown' WHERE id='cancelled-inspection'",
          )
          .run();
      const run = () =>
        f.work.abandon(f.binding, randomUUID(), admitted.request_id, 'a'.repeat(64));
      if (variant === 'stopped-inspection') expect(run().state).toBe('retired');
      else expect(run).toThrow();
      expect(f.tasks.get(admitted.task_id).state).toBe('succeeded');
    } finally {
      f.close();
    }
  },
);

// A strict attempt stopped by its owner revoking authority (for example a hub restart):
// the revocation cancelled the attempt, and nothing but journaled operator MCP calls ran.
function revokeCancelledFixture(calls = 2) {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const attempt = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='running',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a.attempt_id;
  });
  f.store.db.prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?").run(attempt);
  const tool = (id: string, call: boolean) =>
    f.store.transaction(() => {
      f.store.event(f.session, 'model.admitted', { attempt_id: attempt, epoch: 1 });
      f.store.event(f.session, 'tool.started', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: 'salaam_operator_mcp',
        phase: 'started',
      });
      f.store.event(f.session, 'policy.allowed', {
        attempt_id: attempt,
        epoch: 1,
        tool: 'salaam_operator_mcp',
      });
      if (call)
        f.store.event(f.session, 'operator_mcp.call', {
          attempt_id: attempt,
          server: 'fetch',
          tool: 'fetch',
          argument_digest: 'a'.repeat(64),
          outcome: 'returned',
          result_digest: 'b'.repeat(64),
        });
      f.store.event(f.session, 'tool.finished', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: 'salaam_operator_mcp',
        phase: 'finished',
        failed: false,
      });
    });
  tool('catalog', false);
  for (let i = 0; i < calls; i++) tool('fetch-' + i, true);
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    reply() {},
    failed() {},
    approvalTtlMs: 60000,
  });
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(
      f.session,
      'restart-revoke',
      'Hub restarted; owner stopped',
      (id) => managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node'),
    ),
  );
  void managed.close();
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.work.verification.budget.block(f.session, 'Task runtime limit reached');
  f.authority.revoke(f.binding, 'restart-revoke', 'Hub restarted; owner stopped');
  return { f, admitted, attempt, task };
}

test('revoke-cancelled attempt with only journaled operator MCP calls retires and replays', () => {
  const { f, admitted, attempt } = revokeCancelledFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'revoke-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(attempt)).toMatchObject({ state: 'cancelled', resolved_by: null });
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    expect(
      f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='operator_mcp.call'").get()!
        .n,
    ).toBe(2);
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    f.close();
  }
});

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'two-attempts',
  'attempt-not-cancelled',
  'local-cancel',
  'not-in-revocation',
  'unresolved-in-revocation',
  'cancel-after-revoke',
  'tool-after-cancel',
  'open-tool',
  'other-tool',
  'two-mcp-calls-in-one-tool',
  'mcp-call-outside-tool',
  'step-not-cancelled',
  'checks',
  'completion',
  'operation',
  'local-call',
  'command-run',
  'unbound-resource',
  'child',
])('revoke-cancelled retirement rejects %s', (failure) => {
  const { f, admitted, attempt, task } = revokeCancelledFixture();
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const event = (kind: string, payload: object) =>
      f.store.transaction(() => f.store.event(f.session, kind, payload));
    const fill = (table: string) => {
      db.exec('PRAGMA foreign_keys=OFF');
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const names = cols
        .filter((c) => c.notnull || c.pk || c.name === 'session_id')
        .map((c) => c.name);
      db.prepare(
        `INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
      ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      db.exec('PRAGMA foreign_keys=ON');
    };
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_tokens=1').run();
    if (failure === 'two-attempts') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('other',?,'other-submission','cancelled',1)",
      ).run(f.session);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'attempt-not-cancelled')
      db.prepare("UPDATE attempts SET state='interrupted' WHERE id=?").run(attempt);
    if (failure === 'local-cancel')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'not-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.attempt_ids',json('[]'))",
      ).run();
    if (failure === 'unresolved-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.unresolved_operations',json('[\"op\"]'))",
      ).run();
    if (failure === 'cancel-after-revoke') {
      db.prepare("DELETE FROM events WHERE kind='attempt.cancel_requested'").run();
      f.store.transaction(() =>
        f.store.event(
          f.session,
          'attempt.cancel_requested',
          { attempt_id: attempt },
          'agentpod-revocation',
        ),
      );
    }
    if (failure === 'tool-after-cancel')
      for (const kind of ['tool.started', 'tool.finished'])
        event(kind, { attempt_id: attempt, tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','bash') WHERE kind='tool.started' AND json_extract(payload,'$.tool_call_id')='fetch-0'",
      ).run();
    if (failure === 'two-mcp-calls-in-one-tool')
      (db
        .prepare(
          "DELETE FROM events WHERE kind IN ('tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-0'",
        )
        .run(),
        db
          .prepare(
            "DELETE FROM events WHERE kind IN ('tool.started') AND json_extract(payload,'$.tool_call_id')='fetch-1'",
          )
          .run(),
        db
          .prepare(
            "UPDATE events SET payload=json_set(payload,'$.tool_call_id','fetch-0') WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
          )
          .run());
    if (failure === 'mcp-call-outside-tool')
      db.prepare(
        "DELETE FROM events WHERE kind IN ('tool.started','tool.finished','policy.allowed') AND seq IN (SELECT seq FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0' OR (kind='policy.allowed' AND seq BETWEEN (SELECT min(seq) FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0') AND (SELECT max(seq) FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0')))",
      ).run();
    if (failure === 'step-not-cancelled')
      db.prepare("UPDATE task_steps SET state='completed'").run();
    if (failure === 'checks') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
      ).run(task.id, task.steps[0]!.id, a64, a64);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'completion') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO task_completions(task_id,plan_revision,workspace_id,workspace_revision,workspace_digest,artifact_id,state) VALUES(?,1,'ws',0,?,'art','verified')",
      ).run(task.id, a64);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'workspace',?,'succeeded',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, attempt, a64);
    if (failure === 'local-call') fill('local_calls');
    if (failure === 'command-run') {
      fill('command_runs');
      db.prepare("UPDATE command_runs SET state='succeeded'").run();
    }
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run(a64);
    if (failure === 'child') {
      const child = f.store.create('/tmp/child', randomUUID());
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, attempt, a64, child.id, attempt);
    }
    expect(() =>
      f.work.fail(
        f.binding,
        'reject-revoke',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow('revoke-cancelled operator MCP reads');
    expect(f.tasks.get(admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
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
      tool(n, 'finished', { failed: n === 3 });
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
    });
    const started = tail.find((a) => a.tool_call_id === 'call-9' && a.phase === 'started')!;
    expect(started).toMatchObject({ title: 'fetch · fetch', kind: 'fetch' });
    const read = tail.find((a) => a.tool_call_id === 'call-8' && a.phase === 'started')!;
    expect(read.title).toBe('salaam_station');
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

// Two review offers in one attempt: the first expired unanswered, the agent asked again, and the
// owner's revocation (a hub restart) invalidated the second before anyone answered it.
async function multiOfferFixture() {
  const f = fixture(),
    admitted = f.run();
  const step = f.tasks.get(admitted.task_id).steps[0]!;
  const submission = f.store.transaction(() =>
    f.store.enqueue(f.session, randomUUID(), 'Review twice', undefined, null, step.id),
  );
  const epoch = f.store.allocate(f.session, 'test');
  f.store.state(f.session, epoch, 'ready');
  f.store.claim(f.session, epoch);
  f.store.running(submission.attempt_id);
  const attempt = submission.attempt_id;
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    reply() {},
    failed() {},
    approvalTtlMs: 1000,
  });
  const tool = (phase: 'started' | 'finished', id: string) =>
    f.store.transaction(() =>
      f.store.event(f.session, 'tool.' + phase, {
        attempt_id: attempt,
        worker_epoch: epoch,
        tool_call_id: id,
        tool: 'salaam_review',
        phase,
      }),
    );
  // A closed station read, as the real run made before asking.
  f.store.db
    .prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES('read-1',?,?,?,'read-1','read',?,?,?,'{}','returned')",
    )
    .run(f.session, epoch, attempt, ...Array(3).fill('a'.repeat(64)));
  tool('started', 'review-1');
  await managed.prepare(f.session, epoch, attempt, 'review-1', 'review', 'write answer.md', 'v1');
  const offer = new AgentPodWorkDecisions(f.work, managed).list(f.binding).decisions[0]!;
  await new Promise((r) => setTimeout(r, 1010));
  managed.expire();
  tool('finished', 'review-1');
  tool('started', 'review-2');
  await managed.prepare(f.session, epoch, attempt, 'review-2', 'review', 'write files', 'v2');
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(f.session, 'restart-revoke', 'Hub restarted', (id) =>
      managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node'),
    ),
  );
  await managed.close();
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(admitted.task_id);
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.work.verification.budget.block(f.session, 'Task runtime limit reached');
  f.authority.revoke(f.binding, 'restart-revoke', 'Hub restarted');
  return { f, admitted, offer, attempt, step };
}
const expireMulti = (x: Awaited<ReturnType<typeof multiOfferFixture>>, request = 'multi-expire') =>
  x.f.work.expire(
    x.f.binding,
    request,
    x.admitted.request_id,
    x.offer.request_id,
    'a'.repeat(64),
    settlementDriver(x.f),
  );

test('several unanswered review offers, expired or invalidated by the revoke, retire and replay', async () => {
  const x = await multiOfferFixture();
  try {
    const approvals = x.f.store.db
      .prepare('SELECT state FROM approvals ORDER BY rowid')
      .all()
      .map((r) => r.state);
    expect(approvals).toEqual(['expired', 'invalidated']);
    const receipt = expireMulti(x);
    expect(receipt).toMatchObject({
      state: 'cancelled',
      effects: 'expired_approval_unapplied',
      approval_id: x.offer.approval_id,
    });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    expect(
      x.f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
    x.f.reopen();
    expect(expireMulti(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'running-step',
  'two-attempts',
  'attempt-not-cancelled',
  'local-cancel',
  'not-in-revocation',
  'effect-operation',
  'operation-not-cancelled',
  'operation-other-attempt',
  'approval-decided',
  'expired-not-yet',
  'invalidated-before-revoke',
  'offer-not-expired',
  'patch-call',
  'local-call',
  'tool-after-revoke',
  'unbound-resource',
  'child',
  'checks',
])('several-offer expiry rejects %s', async (failure) => {
  const x = await multiOfferFixture();
  const { f, attempt } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_requests=1').run();
    if (failure === 'running-step') db.prepare("UPDATE task_steps SET state='running'").run();
    if (failure === 'two-attempts')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('other',?,'other-submission','cancelled',1)",
          )
          .run(f.session),
      );
    if (failure === 'attempt-not-cancelled')
      db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(attempt);
    if (failure === 'local-cancel')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'not-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.attempt_ids',json('[]'))",
      ).run();
    if (failure === 'effect-operation')
      db.prepare("UPDATE operations SET kind='effect' WHERE tool_call_id='review-2'").run();
    if (failure === 'operation-not-cancelled')
      db.prepare(
        "UPDATE operations SET state='failed_definite' WHERE tool_call_id='review-2'",
      ).run();
    if (failure === 'operation-other-attempt')
      withoutKeys(() =>
        db.prepare("UPDATE operations SET attempt_id='other' WHERE tool_call_id='review-2'").run(),
      );
    if (failure === 'approval-decided')
      db.prepare(
        "UPDATE approvals SET decision='approve' WHERE operation_id=(SELECT id FROM operations WHERE tool_call_id='review-2')",
      ).run();
    if (failure === 'expired-not-yet') {
      // Offer and approval agree, so only the expiry itself is wrong.
      const later = Date.now() + 60000;
      db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(later, x.offer.approval_id);
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.expires_at',?) WHERE actor='agentpod-work-decision-offer'",
      ).run(later);
    }
    if (failure === 'invalidated-before-revoke')
      // Something else happened between the invalidation and the revocation's cancel request.
      db.prepare(
        "UPDATE events SET kind='inbox.changed' WHERE seq=(SELECT seq-1 FROM events WHERE kind='attempt.cancel_requested')",
      ).run();
    if (failure === 'offer-not-expired') {
      // The settled offer is the one the revocation invalidated, not one that expired.
      const second = db
        .prepare(
          "SELECT a.id,a.operation_digest,a.expires_at,o.id AS op FROM approvals a JOIN operations o ON o.id=a.operation_id WHERE o.tool_call_id='review-2'",
        )
        .get()!;
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.approval_id',?,'$.operation_id',?,'$.operation_digest',?,'$.expires_at',?) WHERE actor='agentpod-work-decision-offer'",
      ).run(
        String(second.id),
        String(second.op),
        String(second.operation_digest),
        Number(second.expires_at),
      );
    }
    if (failure === 'patch-call')
      db.prepare("UPDATE station_calls SET kind='patch' WHERE id='read-1'").run();
    if (failure === 'local-call')
      withoutKeys(() => {
        const cols = db.prepare('PRAGMA table_info(local_calls)').all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];
        const names = cols
          .filter((c) => c.notnull || c.pk || c.name === 'session_id')
          .map((c) => c.name);
        db.prepare(
          `INSERT INTO local_calls(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
        ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      });
    if (failure === 'tool-after-revoke')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.started', {
          attempt_id: attempt,
          tool_call_id: 'late',
          tool: 'salaam_review',
        }),
      );
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run(a64);
    if (failure === 'child') {
      const child = f.store.create('/tmp/child', randomUUID());
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, attempt, a64, child.id, attempt);
    }
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
          )
          .run(x.admitted.task_id, x.step.id, a64, a64),
      );
    expect(() => expireMulti(x, 'reject-multi')).toThrow();
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-expiry'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

// A strict attempt whose operator MCP calls kept failing until the request budget ran out: the
// budget control interrupted it, and nothing but those failed calls and a closed read ran.
const BUDGET_STOP = 'Required control failed: No model request budget remains';
function budgetStopFixture(parallel = false) {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const attempt = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='running',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a.attempt_id;
  });
  f.store.db.prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?").run(attempt);
  const tool = (id: string, name: string, call: string | null) =>
    f.store.transaction(() => {
      f.store.event(f.session, 'tool.started', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: name,
        phase: 'started',
      });
      f.store.event(f.session, 'policy.allowed', { attempt_id: attempt, epoch: 1, tool: name });
      if (call)
        f.store.event(f.session, 'operator_mcp.call', {
          attempt_id: attempt,
          server: 'fetch',
          tool: 'fetch',
          argument_digest: 'a'.repeat(64),
          outcome: call,
        });
      f.store.event(f.session, 'tool.finished', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: name,
        phase: 'finished',
        failed: call !== null,
      });
    });
  tool('catalog', 'salaam_operator_mcp', null);
  f.store.db
    .prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES('inspect-1',?,1,?,'inspect-1','read',?,?,?,'{}','returned')",
    )
    .run(f.session, attempt, ...Array(3).fill('a'.repeat(64)));
  tool('inspect-1', 'salaam_station', null);
  if (parallel) {
    // Two fetches start together; their journaled calls cannot be told apart by tool.
    const ev = (kind: string, payload: object) =>
      f.store.transaction(() =>
        f.store.event(f.session, kind, { attempt_id: attempt, ...payload }),
      );
    for (const id of ['fetch-1', 'fetch-2'])
      ev('tool.started', { worker_epoch: 1, tool_call_id: id, tool: 'salaam_operator_mcp' });
    for (const outcome of ['tool_error', 'failed'])
      ev('operator_mcp.call', { server: 'fetch', tool: 'fetch', outcome });
    for (const id of ['fetch-2', 'fetch-1'])
      ev('tool.finished', { worker_epoch: 1, tool_call_id: id, tool: 'salaam_operator_mcp' });
  } else {
    tool('fetch-1', 'salaam_operator_mcp', 'tool_error');
    tool('fetch-2', 'salaam_operator_mcp', 'failed');
  }
  f.store.db
    .prepare("UPDATE attempts SET state='interrupted',error=? WHERE id=?")
    .run(BUDGET_STOP, attempt);
  f.store.db.prepare("UPDATE task_steps SET state='interrupted' WHERE id=?").run(step.id);
  f.store.transaction(() => {
    f.store.event(f.session, 'worker.unhealthy', { epoch: 1, error: BUDGET_STOP });
    f.store.event(f.session, 'attempt.interrupted', { attempt_id: attempt, error: BUDGET_STOP });
  });
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'budget-revoke', 'Bounded progression stopped');
  f.work.verification.budget.block(f.session, 'Task runtime limit reached');
  return { f, admitted, attempt, task };
}
const failBudget = (x: ReturnType<typeof budgetStopFixture>, request = 'budget-retire') =>
  x.f.work.fail(x.f.binding, request, x.admitted.request_id, 'a'.repeat(64), settlementDriver(x.f));

test('an attempt the request budget stopped, with only failed operator MCP calls, retires and replays', () => {
  const x = budgetStopFixture();
  try {
    const receipt = failBudget(x);
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.store.attempt(x.attempt)).toMatchObject({ state: 'interrupted', resolved_by: null });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failBudget(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test('parallel operator MCP tools with failed calls also retire', () => {
  const x = budgetStopFixture(true);
  try {
    expect(failBudget(x)).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
  } finally {
    x.f.close();
  }
});

test.each(['call-in-station-tool', 'more-calls-than-tools'])(
  'request-budget retirement with parallel tools rejects %s',
  (failure) => {
    const x = budgetStopFixture(true);
    const { f, attempt } = x;
    try {
      const db = f.store.db;
      if (failure === 'call-in-station-tool') {
        // The only open tool is a station read, so the call belongs to no operator MCP tool.
        db.prepare(
          "UPDATE events SET payload=json_set(payload,'$.tool','salaam_station') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id') IN ('fetch-1','fetch-2')",
        ).run();
      }
      if (failure === 'more-calls-than-tools')
        db.prepare(
          "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-2'",
        ).run();
      expect(attempt).toBeTruthy();
      expect(() => failBudget(x, 'reject-parallel')).toThrow(
        'request budget stopped operator MCP reads',
      );
      expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    } finally {
      f.close();
    }
  },
);

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'two-attempts',
  'other-error',
  'not-interrupted',
  'step-not-interrupted',
  'unhealthy-other-error',
  'missing-interrupted-event',
  'cancelled-by-someone',
  'tool-after-stop',
  'open-tool',
  'other-tool',
  'returned-call',
  'two-calls-in-one-tool',
  'operation',
  'patch-call',
  'local-call',
  'unbound-resource',
  'child',
  'checks',
])('request-budget retirement rejects %s', (failure) => {
  const x = budgetStopFixture();
  const { f, attempt, task } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    const event = (kind: string, payload: object) =>
      f.store.transaction(() => f.store.event(f.session, kind, payload));
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_tokens=1').run();
    if (failure === 'two-attempts')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff',?,'other-submission','failed',1)",
          )
          .run(f.session),
      );
    if (failure === 'other-error')
      db.prepare(
        "UPDATE attempts SET error='Required control failed: something else' WHERE id=?",
      ).run(attempt);
    if (failure === 'not-interrupted')
      db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(attempt);
    if (failure === 'step-not-interrupted')
      db.prepare("UPDATE task_steps SET state='completed'").run();
    if (failure === 'unhealthy-other-error')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.error','unknown') WHERE kind='worker.unhealthy'",
      ).run();
    if (failure === 'missing-interrupted-event')
      db.prepare("DELETE FROM events WHERE kind='attempt.interrupted'").run();
    if (failure === 'cancelled-by-someone')
      withoutKeys(() =>
        db.prepare("INSERT INTO cancellations VALUES(?,'local-operator')").run(attempt),
      );
    if (failure === 'tool-after-stop')
      for (const kind of ['tool.started', 'tool.finished'])
        event(kind, { attempt_id: attempt, tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_files') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='inspect-1'",
      ).run();
    if (failure === 'returned-call')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.outcome','returned') WHERE kind='operator_mcp.call' AND seq=(SELECT min(seq) FROM events WHERE kind='operator_mcp.call')",
      ).run();
    if (failure === 'two-calls-in-one-tool') {
      // Both journaled calls fall inside one closed tool.
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
      db.prepare(
        "DELETE FROM events WHERE kind='tool.started' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool_call_id','fetch-1') WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
    }
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'review',?,'cancelled_before_dispatch',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, attempt, a64);
    if (failure === 'patch-call')
      db.prepare("UPDATE station_calls SET kind='patch' WHERE id='inspect-1'").run();
    if (failure === 'local-call')
      withoutKeys(() => {
        const cols = db.prepare('PRAGMA table_info(local_calls)').all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];
        const names = cols
          .filter((c) => c.notnull || c.pk || c.name === 'session_id')
          .map((c) => c.name);
        db.prepare(
          `INSERT INTO local_calls(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
        ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      });
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run(a64);
    if (failure === 'child') {
      const child = f.store.create('/tmp/child', randomUUID());
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, attempt, a64, child.id, attempt);
    }
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
          )
          .run(task.id, task.steps[0]!.id, a64, a64),
      );
    expect(() => failBudget(x, 'reject-budget')).toThrow(
      'request budget stopped operator MCP reads',
    );
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

// A strict attempt the task runtime limit stopped while every approved workspace write was refused
// by the protected filesystem before its mutation boundary (and the last, still waiting, was
// cancelled before dispatch). Besides those writes only closed reads and fetches ran.
const RUNTIME_STOP = 'Task runtime limit reached';
const WRITE_REFUSED = 'Protected filesystem refused before its mutation boundary';
const WRITE_NOT_SENT = 'Workspace apply was cancelled before dispatch';
function refusedWritesFixture() {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const attempt = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='running',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a.attempt_id;
  });
  f.store.db.prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?").run(attempt);
  const a64 = 'a'.repeat(64);
  const ev = (kind: string, payload: object) =>
    f.store.transaction(() => f.store.event(f.session, kind, { attempt_id: attempt, ...payload }));
  const started = (id: string, tool: string) =>
    ev('tool.started', { worker_epoch: 1, tool_call_id: id, tool });
  const finished = (id: string, tool: string) =>
    ev('tool.finished', { worker_epoch: 1, tool_call_id: id, tool });
  const call = (
    id: string,
    kind: string,
    state: string,
    op: string | null,
    helper: string,
    result: string | null,
  ) =>
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,helper_state,result_json) VALUES(?,?,1,?,?,?,?,?,?,'{}',?,?,?,?)",
      )
      .run(id, f.session, attempt, id, kind, a64, a64, a64, op, state, helper, result);
  const write = (n: number, refused: boolean) => {
    const op = `op-${n}`,
      opDigest = n.toString(16).repeat(64).slice(0, 64);
    f.store.db
      .prepare(
        "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state,error) VALUES(?,?,?,1,?,'workspace',?,?,?,'station:runs/answer.md','v','t','policy','station','never','failed_definite',?)",
      )
      .run(
        op,
        f.session,
        attempt,
        `write-${n}`,
        `action-${n}`,
        a64,
        opDigest,
        refused ? WRITE_REFUSED : WRITE_NOT_SENT,
      );
    f.store.db
      .prepare(
        "INSERT INTO approvals(id,operation_id,session_id,worker_epoch,operation_digest,actor_scope,policy_digest,expires_at,state,decision,decided_by) VALUES(?,?,?,1,?,'owner','policy',0,?,?,?)",
      )
      .run(
        `ap-${n}`,
        op,
        f.session,
        opDigest,
        refused ? 'decided' : 'invalidated',
        refused ? 'approve' : null,
        refused ? 'owner' : null,
      );
    call(
      `write-${n}`,
      'patch',
      refused ? 'failed' : 'cancelled',
      op,
      refused ? 'stopped' : 'none',
      refused ? '{"code":"station_files_changed"}' : null,
    );
  };
  started('fetch-1', 'salaam_operator_mcp');
  ev('operator_mcp.call', {
    server: 'fetch',
    tool: 'fetch',
    argument_digest: a64,
    outcome: 'returned',
  });
  finished('fetch-1', 'salaam_operator_mcp');
  call('read-1', 'read', 'returned', null, 'stopped', null);
  started('read-1', 'salaam_station');
  finished('read-1', 'salaam_station');
  for (const n of [1, 2]) {
    started(`write-${n}`, 'salaam_station');
    write(n, true);
    finished(`write-${n}`, 'salaam_station');
  }
  // The last write still waits for its approval when the runtime limit stops the attempt.
  started('write-3', 'salaam_station');
  write(3, false);
  f.store.db.prepare('UPDATE task_runtime SET started_at=0 WHERE task_id=?').run(task.id);
  f.work.verification.budget.block(f.session, RUNTIME_STOP);
  ev('attempt.cancel_requested', {});
  f.store.db.prepare("INSERT INTO cancellations VALUES(?,'task-stop')").run(attempt);
  finished('write-3', 'salaam_station');
  f.store.db
    .prepare("UPDATE attempts SET state='cancelled',error='Attempt aborted' WHERE id=?")
    .run(attempt);
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  ev('attempt.cancelled', {});
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'runtime-revoke', 'Bounded progression stopped');
  return { f, admitted, attempt, task };
}
const failRefused = (x: ReturnType<typeof refusedWritesFixture>, request = 'refused-retire') =>
  x.f.work.fail(x.f.binding, request, x.admitted.request_id, 'a'.repeat(64), settlementDriver(x.f));

test('a runtime-stopped attempt whose approved writes were all refused before the boundary retires and replays', () => {
  const x = refusedWritesFixture();
  try {
    const receipt = failRefused(x);
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failRefused(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'runtime-not-exceeded',
  'other-block',
  'not-cancelled',
  'other-error',
  'cancelled-by-someone',
  'write-succeeded',
  'write-failed-otherwise',
  'refused-without-approval',
  'refused-but-denied',
  'mcp-call-in-station-tool',
  'tool-started-during-stop',
  'refused-call-returned',
  'refused-call-other-code',
  'refused-call-unstopped',
  'not-sent-call-dispatched',
  'other-operation-kind',
  'other-station-call',
  'returned-mcp-outside-tool',
  'tool-after-cancel',
  'open-tool',
  'other-tool',
  'mcp-ledger-row',
  'checks',
])('runtime-stopped refused-write retirement rejects %s', (failure) => {
  const x = refusedWritesFixture();
  const { f, attempt, task } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    const ev = (kind: string, payload: object) =>
      f.store.transaction(() =>
        f.store.event(f.session, kind, { attempt_id: attempt, ...payload }),
      );
    if (failure === 'runtime-not-exceeded')
      db.prepare('UPDATE task_runtime SET started_at=?').run(Date.now());
    if (failure === 'other-block')
      db.prepare("UPDATE task_runtime SET blocked_reason='Task request limit reached'").run();
    if (failure === 'not-cancelled')
      db.prepare("UPDATE attempts SET state='interrupted' WHERE id=?").run(attempt);
    if (failure === 'other-error')
      db.prepare("UPDATE attempts SET error='Pi exited (1)' WHERE id=?").run(attempt);
    if (failure === 'cancelled-by-someone')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'write-succeeded')
      db.prepare("UPDATE operations SET state='succeeded' WHERE id='op-1'").run();
    if (failure === 'write-failed-otherwise')
      db.prepare("UPDATE operations SET error='Station helper exited (1)' WHERE id='op-2'").run();
    if (failure === 'refused-without-approval')
      db.prepare("UPDATE approvals SET state='invalidated',decision=NULL WHERE id='ap-1'").run();
    if (failure === 'refused-but-denied')
      db.prepare("UPDATE approvals SET decision='deny' WHERE id='ap-2'").run();
    if (failure === 'mcp-call-in-station-tool')
      // The fetch's journaled call then sits inside a station tool, not an operator MCP one.
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_station') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
    if (failure === 'tool-started-during-stop') {
      // A tool that starts after the stop was requested, closed before the cancellation.
      ev('tool.started', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      ev('tool.finished', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      db.prepare(
        "UPDATE events SET seq=(SELECT max(seq) FROM events)+10 WHERE session_id=? AND kind='attempt.cancelled'",
      ).run(f.session);
    }
    if (failure === 'refused-call-returned')
      db.prepare("UPDATE station_calls SET state='returned' WHERE id='write-1'").run();
    if (failure === 'refused-call-other-code')
      db.prepare(
        'UPDATE station_calls SET result_json=\'{"code":"station_execution_unconfirmed"}\' WHERE id=\'write-2\'',
      ).run();
    if (failure === 'refused-call-unstopped')
      db.prepare("UPDATE station_calls SET helper_state='running' WHERE id='write-1'").run();
    if (failure === 'not-sent-call-dispatched')
      db.prepare("UPDATE station_calls SET state='failed' WHERE id='write-3'").run();
    if (failure === 'other-operation-kind')
      db.prepare("UPDATE operations SET kind='command' WHERE id='op-1'").run();
    if (failure === 'other-station-call')
      db.prepare("UPDATE station_calls SET kind='check' WHERE id='read-1'").run();
    if (failure === 'returned-mcp-outside-tool')
      ev('operator_mcp.call', { server: 'fetch', tool: 'fetch', outcome: 'returned' });
    if (failure === 'tool-after-cancel') {
      ev('tool.started', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      ev('tool.finished', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    }
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='write-3'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_files') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='read-1'",
      ).run();
    if (failure === 'mcp-ledger-row')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,revision,created_at) VALUES('m',?,1,?,'m',?,?,?,?,1,'s','t','p','{}','returned',1,0)",
          )
          .run(f.session, attempt, a64, a64, a64, a64),
      );
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,state) VALUES('c',?,?,'k',1,'w',1,?,?,'e','passed')",
          )
          .run(task.id, task.steps[0]!.id, a64, a64),
      );
    expect(() => failRefused(x, 'reject-refused')).toThrow(
      'runtime-stopped refused workspace writes',
    );
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
  } finally {
    f.close();
  }
});

// The request budget stopped an attempt after its approved workspace writes and its review had
// succeeded: the writes are known effects, recorded against their returned patch calls.
function budgetStopKnownEffectsFixture() {
  const x = budgetStopFixture();
  const { f, attempt } = x;
  const db = f.store.db,
    a64 = 'a'.repeat(64),
    c64 = 'c'.repeat(64),
    root = digest(f.binding);
  db.exec('PRAGMA foreign_keys=OFF');
  for (const n of [1, 2]) {
    const op = `00000000-0000-4000-8000-00000000000${n}`,
      call = `call-${n}`,
      result = { version: 1, ok: true, path: `runs/r/f${n}.md`, sha256: a64 };
    const receipt = {
      version: 1,
      scope: 'station-workspace',
      artifact_id: `artifact-${n}`,
      call_id: call,
      root_digest: root,
      configuration_digest: c64,
      input_digest: a64,
      result,
    };
    db.prepare(
      "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state,receipt,resolution) VALUES(?,?,?,1,?,'workspace',?,?,?,'station:runs/r','v','t','policy','station-workspace-v1','opaque','succeeded',?,'workspace-content-receipt-v1')",
    ).run(
      op,
      f.session,
      attempt,
      call,
      `write-${n}`,
      a64,
      `${n}`.repeat(64),
      JSON.stringify(receipt),
    );
    db.prepare(
      "INSERT INTO approvals(id,operation_id,session_id,worker_epoch,operation_digest,actor_scope,policy_digest,expires_at,state,decision,decided_by) VALUES(?,?,?,1,?,'owner','policy',0,'decided','approve','owner')",
    ).run(`ap-${n}`, op, f.session, `${n}`.repeat(64));
    db.prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,helper_state,result_json) VALUES(?,?,1,?,?,'patch',?,?,?,'{}',?,'returned','stopped',?)",
    ).run(call, f.session, attempt, call, a64, root, c64, op, JSON.stringify(result));
  }
  db.prepare(
    "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state,receipt,resolution) VALUES('00000000-0000-4000-8000-000000000009',?,?,1,'review','review','review-1',?,?,'review','v','t','policy','local-review-v1','read-only','succeeded','{}','local-review-receipt')",
  ).run(f.session, attempt, a64, '9'.repeat(64));
  db.prepare(
    "INSERT INTO approvals(id,operation_id,session_id,worker_epoch,operation_digest,actor_scope,policy_digest,expires_at,state,decision,decided_by) VALUES('ap-9','00000000-0000-4000-8000-000000000009',?,1,?,'owner','policy',0,'decided','approve','owner')",
  ).run(f.session, '9'.repeat(64));
  // A checked command ran in its own station unit, now stopped with a complete stop proof.
  db.prepare(
    "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,helper_state) VALUES('check-1',?,1,?,'check-1','check',?,?,?,'{}','returned','stopped')",
  ).run(f.session, attempt, a64, root, c64);
  const unit = 'b'.repeat(16),
    name = `salaam-station-${unit}.service`;
  db.prepare(
    "INSERT INTO station_units(id,session_id,call_id,context_digest,config_json,snapshot_path,output_path,state,stop_json) VALUES(?,?,'check-1','digest','{}','/s','/o','stopped',?)",
  ).run(
    unit,
    f.session,
    JSON.stringify({
      version: 1,
      observed_empty: true,
      unit: name,
      cgroup: `/system.slice/${name}`,
      invocation: 'd'.repeat(32),
    }),
  );
  db.exec('PRAGMA foreign_keys=ON');
  return x;
}

test('a request-budget stop after approved writes and a review retires with them as known effects', () => {
  const x = budgetStopKnownEffectsFixture();
  try {
    const receipt = failBudget(x, 'known-retire');
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failBudget(x, 'known-retire')).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'write-not-succeeded',
  'write-not-approved',
  'write-approval-pending',
  'write-digest-mismatch',
  'write-without-call',
  'write-call-not-returned',
  'write-effect-other-call',
  'write-effect-other-root',
  'write-effect-other-result',
  'write-effect-not-ok',
  'write-other-resolution',
  'review-not-succeeded',
  'review-not-approved',
  'review-not-read-only',
  'other-operation-kind',
  'check-not-returned',
  'unit-not-stopped',
  'unit-without-proof',
  'unit-for-other-call',
  'cancelled-by-someone',
  'other-error',
  'tool-after-stop',
  'other-ledger',
])('request-budget known-effects retirement rejects %s', (failure) => {
  const x = budgetStopKnownEffectsFixture();
  const { f, attempt } = x;
  try {
    const db = f.store.db,
      w1 = '00000000-0000-4000-8000-000000000001',
      rv = '00000000-0000-4000-8000-000000000009';
    const set = (sql: string, ...args: unknown[]) => {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(sql).run(...(args as never[]));
      db.exec('PRAGMA foreign_keys=ON');
    };
    const effect = (path: string, value: string) =>
      set(
        `UPDATE operations SET receipt=json_set(receipt,'${path}',json(?)) WHERE id=?`,
        value,
        w1,
      );
    if (failure === 'write-not-succeeded')
      set("UPDATE operations SET state='failed_definite' WHERE id=?", w1);
    if (failure === 'write-not-approved')
      set("UPDATE approvals SET decision='deny' WHERE id='ap-1'");
    if (failure === 'write-approval-pending')
      set("UPDATE approvals SET state='pending' WHERE id='ap-1'");
    if (failure === 'write-digest-mismatch')
      set("UPDATE approvals SET operation_digest=? WHERE id='ap-1'", '0'.repeat(64));
    if (failure === 'write-without-call')
      set("UPDATE station_calls SET operation_id=NULL WHERE id='call-1'");
    if (failure === 'write-call-not-returned')
      set("UPDATE station_calls SET state='outcome_unknown' WHERE id='call-1'");
    if (failure === 'write-effect-other-call') effect('$.call_id', '"call-2"');
    if (failure === 'write-effect-other-root')
      effect('$.root_digest', JSON.stringify('0'.repeat(64)));
    if (failure === 'write-effect-other-result') effect('$.result.path', '"elsewhere.md"');
    if (failure === 'write-effect-not-ok') {
      effect('$.result.ok', 'false');
      set(
        "UPDATE station_calls SET result_json=json_set(result_json,'$.ok',json('false')) WHERE id='call-1'",
      );
    }
    if (failure === 'write-other-resolution')
      set("UPDATE operations SET resolution='other' WHERE id=?", w1);
    if (failure === 'review-not-succeeded')
      set("UPDATE operations SET state='failed_definite' WHERE id=?", rv);
    if (failure === 'review-not-approved')
      set("UPDATE approvals SET state='invalidated',decision=NULL WHERE id='ap-9'");
    if (failure === 'review-not-read-only')
      set("UPDATE operations SET replay='opaque' WHERE id=?", rv);
    if (failure === 'other-operation-kind') set("UPDATE operations SET kind='mcp' WHERE id=?", rv);
    if (failure === 'check-not-returned')
      set("UPDATE station_calls SET state='failed' WHERE id='check-1'");
    if (failure === 'unit-not-stopped')
      set("UPDATE station_units SET state='unconfirmed' WHERE call_id='check-1'");
    if (failure === 'unit-without-proof')
      set("UPDATE station_units SET stop_json=NULL WHERE call_id='check-1'");
    if (failure === 'unit-for-other-call')
      set("UPDATE station_units SET call_id='call-1' WHERE call_id='check-1'");
    if (failure === 'cancelled-by-someone')
      set("INSERT INTO cancellations VALUES(?,'local-operator')", attempt);
    if (failure === 'other-error')
      set(
        "UPDATE attempts SET error='Required control failed: something else' WHERE id=?",
        attempt,
      );
    if (failure === 'tool-after-stop')
      for (const kind of ['tool.started', 'tool.finished'])
        f.store.transaction(() =>
          f.store.event(f.session, kind, {
            attempt_id: attempt,
            tool_call_id: 'late',
            tool: 'salaam_station',
          }),
        );
    if (failure === 'other-ledger')
      set(
        "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,revision,created_at) VALUES('m',?,1,?,'m',?,?,?,?,1,'s','t','p','{}','returned',1,0)",
        f.session,
        attempt,
        ...Array(4).fill('a'.repeat(64)),
      );
    expect(() => failBudget(x, 'reject-known')).toThrow();
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
  } finally {
    f.close();
  }
});

// Approval scopes: an operation the run grant answered is recorded on the card with the grant.
test('work status shows a write the run grant approved, and which grant allowed it', async () => {
  const f = fixture();
  try {
    f.run();
    f.store.transaction(() =>
      f.store.event(f.session, 'permission.auto-approved', {
        rule: 'run-grant',
        grant_id: 'grant-1',
        granted_by: 'prn_human',
        operation_id: 'op-1',
        operation_digest: 'd'.repeat(64),
      }),
    );
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
    };
    expect(status.activity.at(-1)).toEqual({
      seq: expect.any(Number),
      phase: 'finished',
      tool_call_id: 'approval:op-1',
      title: 'Approved by the run grant (granted by prn_human)',
      kind: null,
      input: null,
      failed: false,
    });
  } finally {
    f.close();
  }
});

test('work status shows a write an agent rule allowed, and who set the rule', async () => {
  const f = fixture();
  try {
    f.run();
    f.store.transaction(() =>
      f.store.event(f.session, 'permission.auto-approved', {
        rule: 'agent-rule',
        rule_id: 'r1',
        set_by: 'prn_owner',
        operation_id: 'op-2',
        operation_digest: 'd'.repeat(64),
      }),
    );
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
    };
    expect(status.activity.at(-1)).toMatchObject({
      tool_call_id: 'approval:op-2',
      title: "Allowed by the agent's standing rule (set by prn_owner)",
    });
  } finally {
    f.close();
  }
});
