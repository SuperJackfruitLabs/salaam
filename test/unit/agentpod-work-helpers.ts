// Fixtures the AgentPod work tests share: the admitted-work fixture, the settlement driver and
// the journal fixtures more than one test file builds on.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { AgentPodAuthority } from '../../src/agentpod/authority.js';
import { ManagedWork } from '../../src/execution/managed.js';
import { AgentPodWorkDecisions } from '../../src/agentpod/work-decisions.js';
import { AgentPodWork } from '../../src/agentpod/work.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/runtime/task-context.js';
import { TaskWork } from '../../src/tasks/work.js';
import { TaskDriver } from '../../src/tasks/driver.js';
import { TaskBudget } from '../../src/tasks/budget.js';
import { TaskVerification } from '../../src/tasks/verification.js';
import { Workspaces } from '../../src/coding/workspaces.js';
import { CodingWork } from '../../src/coding/coding.js';
import { TaskFixtureBackend } from '../fixtures/task-backend.mjs';
import { canonical, digest, textDigest } from '../../src/core/protocol.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { ChildWork } from '../../src/workers/children.js';
import type { Supervisor } from '../../src/runtime/supervisor.js';

export function fixture(
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

export function settlementDriver(f: ReturnType<typeof fixture>) {
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

export async function expiredWorkFixture() {
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

// Historical journal conformance; the production child writer creates frozen
// diagnostic delegation and result artifacts. No model/provider is dispatched.
export function addKnownReadOnlyReceipts(
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

export function knownReadOnlyFailureFixture(expiry = false) {
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

export function preparedReadOnlyPatchFixture(ttl = 1000) {
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

export async function knownEffectFailureFixture() {
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

// A strict attempt whose operator MCP calls kept failing until the request budget ran out: the
// budget control interrupted it, and nothing but those failed calls and a closed read ran.
export const BUDGET_STOP = 'Required control failed: No model request budget remains';

export function budgetStopFixture(parallel = false) {
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

export const failBudget = (x: ReturnType<typeof budgetStopFixture>, request = 'budget-retire') =>
  x.f.work.fail(x.f.binding, request, x.admitted.request_id, 'a'.repeat(64), settlementDriver(x.f));

// A strict attempt the task runtime limit stopped while every approved workspace write was refused
// by the protected filesystem before its mutation boundary (and the last, still waiting, was
// cancelled before dispatch). Besides those writes only closed reads and fetches ran.
export const RUNTIME_STOP = 'Task runtime limit reached';

export const WRITE_REFUSED = 'Protected filesystem refused before its mutation boundary';

export const WRITE_NOT_SENT = 'Workspace apply was cancelled before dispatch';

export function refusedWritesFixture() {
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

export const failRefused = (
  x: ReturnType<typeof refusedWritesFixture>,
  request = 'refused-retire',
) =>
  x.f.work.fail(x.f.binding, request, x.admitted.request_id, 'a'.repeat(64), settlementDriver(x.f));

// A run stopped by its verification budget after every step completed (staging run_54648a07):
// everything is closed and definite, so it retires with its known effects, unattended.
export const VERIFICATION_STOP = 'Task verification run limit reached';

export function verificationStopFixture() {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id);
  for (const step of task.steps) {
    const attempt = f.store.transaction(() => {
      const a = f.store.enqueue(
        f.session,
        randomUUID(),
        step.instruction,
        undefined,
        null,
        step.id,
      );
      f.store.db
        .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
        .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
      return a.attempt_id;
    });
    f.store.db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(attempt);
    f.store.db.prepare("UPDATE submissions SET state='completed' WHERE attempt_id=?").run(attempt);
    f.store.db
      .prepare("UPDATE task_steps SET state='completed',attempt_id=? WHERE id=?")
      .run(attempt, step.id);
  }
  f.work.verification.budget.block(f.session, VERIFICATION_STOP);
  f.store.db.prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?').run(task.id);
  f.store.db
    .prepare("UPDATE durable_tasks SET state='partially_completed' WHERE id=?")
    .run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'verification-revoke', 'Bounded progression stopped');
  return { f, admitted, task };
}
