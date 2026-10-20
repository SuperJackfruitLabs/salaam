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
import { digest } from '../../src/protocol.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { configurePermissions } from '../../src/autonomy.js';

function fixture(verifier = true, owned = true, resourcesStopped = () => true) {
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
    const coding = new CodingWork(
      store,
      workspaces,
      artifacts,
      verifier ? new TaskFixtureBackend() : undefined,
      () => {},
    );
    work = new AgentPodWork(
      store,
      authority,
      tasks,
      new TaskVerification(store, tasks, budget, workspaces, coding, artifacts),
    );
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
