import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SalaamService } from '../../src/service/service.js';
import { ROOT, bundleDigest } from '../../src/core/config.js';
import { digest } from '../../src/core/protocol.js';
import { call } from '../../src/core/transport.js';
import { ready, control, until } from '../helpers.js';
import { readTree } from '../../src/workers/workspaces.js';
import type { TeamAssignment } from '../../src/tasks/team-work.js';
import { hostDigests } from '../../src/host/host.js';

test('real proven executor: two private native builders, independent reviewer and fresh integrated acceptance preserve dirty bytes', async () => {
  const engineSocket = process.env.SALAAM_TASK_REAL_SOCKET,
    scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
  if (!engineSocket || !scratch)
    throw new Error(
      'Set SALAAM_TASK_REAL_SOCKET and SALAAM_TASK_REAL_SCRATCH to a pre-provisioned proven Docker backend',
    );
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(realpathSync(scratch), 'm15-')),
    source = join(dir, 'source'),
    owned = join(dir, 'owned'),
    state = mkdtempSync('/tmp/sal-m15-real-');
  mkdirSync(source);
  mkdirSync(owned, { mode: 0o700 });
  mkdirSync(join(source, '.salaam/agents'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(source, 'app.js'), 'export const answer = 41;\n');
  writeFileSync(join(source, 'notes.md'), '# Work in progress\n');
  writeFileSync(join(source, 'human.txt'), 'uncommitted human bytes predating both workers\n');
  writeFileSync(
    join(source, 'app.test.js'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {answer} from './app.js';test('answer',()=>assert.equal(answer,42));\n",
  );
  writeFileSync(
    join(source, 'notes.test.js'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('documentation',()=>assert.match(fs.readFileSync('notes.md','utf8'),/returns 42/));\n",
  );
  for (const name of ['builder-a', 'builder-b'])
    writeFileSync(
      join(source, '.salaam/agents', name + '.md'),
      '---\n{"role":"builder","max_requests":3}\n---\nImplement only your assigned change.',
    );
  let service: SalaamService | undefined;
  const report: Record<string, any> = {
    schema_version: 1,
    success: false,
    scope:
      'Real pinned native Pi with deterministic offline model and real Docker command executor; no live model usefulness claim',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    observed_at: new Date().toISOString(),
    bundle_digest: bundleDigest(),
    ...hostDigests(),
  };
  const reportPath = resolve(
    process.env.SALAAM_WORKER_REAL_REPORT ?? join(ROOT, '.state/evidence/m15/real-local.json'),
  );
  try {
    service = await SalaamService.open({
      stateDir: state,
      codingRoot: owned,
      codingSocket: engineSocket,
      extensionPath: join(ROOT, 'test/fixtures/writing-specialist-extension.mjs'),
    });
    report.executor = service.coding.executor!.evidence;
    const session = await call<{ id: string }>(service.socket, '/v1/sessions', {
      request_id: 'create',
      cwd: source,
      coding: true,
    });
    await ready(service, session.id);
    let actor = await control(service, session.id);
    const authorize = () => service!.store.authorizeControl(session.id, actor);
    const renew = async () => {
      const view = service!.store.controlView(session.id);
      await call(service!.socket, `/v1/sessions/${session.id}/control`, {
        ...actor,
        action: 'renew',
        expected_epoch: view.epoch,
        request_id: randomUUID(),
      });
    };
    for (const id of ['project/builder-a', 'project/builder-b', 'salaam/reviewer']) {
      const profile = service.agents.inspect(session.id, id);
      await service.agents.admit(session.id, 'admit-' + id, id, digest(profile), [], actor);
    }
    const plan = {
      objective: 'Repair the answer and its documentation without changing human work',
      constraints: ['Preserve human.txt'],
      steps: [
        {
          key: 'code',
          title: 'Repair code',
          instruction: 'Repair the answer.',
          depends_on: [],
          checks: ['suite'],
        },
        {
          key: 'docs',
          title: 'Repair documentation',
          instruction: 'Document the answer.',
          depends_on: [],
          checks: ['suite'],
        },
        {
          key: 'review',
          title: 'Independent review',
          instruction: 'Review the integrated change.',
          depends_on: ['code', 'docs'],
          checks: ['suite'],
        },
      ],
      acceptance: [{ key: 'suite', command: 'node --test', cwd: '.' }],
      deliverables: ['app.js', 'notes.md', 'human.txt'],
      limits: { concurrency: 4 },
    };
    const task = service.taskWork.create(session.id, 'task', 0, plan, actor);
    const baseline = service.taskVerification.start(
      task.id,
      'suite',
      null,
      'baseline',
      service.taskWork.get(task.id).revision,
      authorize,
    );
    await until(
      () => service!.taskVerification.get(baseline.id),
      (r) => r.state === 'failed',
      60000,
    );
    report.baseline_failed = true;
    const assignments: TeamAssignment[] = [];
    for (const [i, step] of task.steps.entries())
      assignments.push(
        service.team.assign(
          task.id,
          step.id,
          i === 2 ? 'salaam/reviewer' : 'project/builder-' + (i ? 'b' : 'a'),
          3,
          'assign-' + i,
          service.taskWork.get(task.id).revision,
          actor,
        ),
      );
    for (const a of assignments.slice(0, 2))
      service.team.run(
        a.id,
        'run-' + a.id,
        service.taskWork.get(task.id).revision,
        0,
        null,
        null,
        actor,
      );
    const builders = await until(
      () => service!.children.list(session.id),
      (cs) =>
        cs.length === 2 &&
        cs.every((c) => c.state !== 'accepted') &&
        cs.every(
          (c) =>
            !service!.store.db
              .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
              .get(c.child_session),
        ),
      60000,
    );
    expect(builders.every((c) => c.state === 'completed')).toBe(true);
    report.builders = builders.map((c) => ({
      worker_id: c.worker!.binding.worker_id,
      binding_digest: c.worker!.binding_digest,
      workspace: c.worker!.binding.isolation,
      commands: service!.coding.list(c.child_session).map((r) => ({
        id: r.id,
        state: r.state,
        exit_code: r.exit_code,
        workspace_digest: r.workspace_digest,
        engine_id: r.engine_id,
        profile_digest: r.profile_digest,
      })),
    }));
    expect(
      report.builders.every(
        (b: any) =>
          b.workspace.execution.evidence === 'proven' &&
          b.commands.length === 1 &&
          b.commands[0].state === 'succeeded' &&
          b.commands[0].exit_code === 0,
      ),
    ).toBe(true);
    await renew();
    report.integrations = [];
    for (const child of builders) {
      const proposal = service.workerWorkspaces.proposal(session.id, child.id) as {
          patch_digest: string;
        },
        root = service.workspaces.get(session.id);
      report.integrations.push(
        service.workerWorkspaces.integrate(
          session.id,
          child.id,
          'integrate-' + child.id,
          root.revision,
          root.digest,
          proposal.patch_digest,
          authorize,
        ),
      );
    }
    for (const step of task.steps.slice(0, 2))
      service.taskWork.complete(
        task.id,
        step.id,
        'review-' + step.id,
        service.taskWork.get(task.id).revision,
        'Operator inspected the exact applied proposal; final task checks remain required.',
        actor,
      );
    const reviewer = service.team.run(
      assignments[2]!.id,
      'reviewer',
      service.taskWork.get(task.id).revision,
      0,
      null,
      null,
      actor,
    );
    await until(
      () => service!.children.inspect(session.id, reviewer.child_id!),
      (c) => c.state === 'completed',
      30000,
    );
    const reviewChild = service.children.inspect(session.id, reviewer.child_id!),
      evidence = JSON.parse(
        readFileSync(join(source, 'review-evidence-' + reviewChild.child_session), 'utf8'),
      );
    expect(evidence.file.lines[0].text).toContain('42');
    expect(reviewChild.worker!.binding.tools).not.toContain('salaam_files');
    report.reviewer = {
      worker_id: reviewChild.worker!.binding.worker_id,
      snapshot_digest: reviewChild.worker!.binding.repository!.digest,
      findings: evidence.findings,
    };
    await renew();
    service.taskWork.complete(
      task.id,
      task.steps[2]!.id,
      'review-reviewer',
      service.taskWork.get(task.id).revision,
      'Operator inspected independent snapshot findings.',
      actor,
    );
    const check = service.taskVerification.start(
      task.id,
      'suite',
      null,
      'fresh-suite',
      service.taskWork.get(task.id).revision,
      authorize,
    );
    await until(
      () => service!.taskVerification.get(check.id),
      (r) => r.state === 'passed' || r.state === 'failed',
      60000,
    );
    expect(service.taskVerification.get(check.id).state).toBe('passed');
    service.taskVerification.finish(
      task.id,
      'finish',
      service.taskWork.get(task.id).revision,
      null,
      authorize,
    );
    expect(service.taskWork.get(task.id).state).toBe('succeeded');
    const root = service.workspaces.get(session.id),
      tree = readTree(root.root);
    expect(Buffer.from(tree['human.txt']!.content, 'base64').toString()).toBe(
      'uncommitted human bytes predating both workers\n',
    );
    expect(readFileSync(join(source, 'app.js'), 'utf8')).toContain('41');
    report.success = true;
    report.final_check = service.taskVerification.get(check.id);
    report.final_digest = root.digest;
    report.usage = service.store.usage.summary(session.id);
    report.source_untouched = true;
    const before = service.children
      .list(session.id)
      .map((c) => ({ id: c.id, result_id: c.result_id }));
    await service.close();
    service = await SalaamService.open({
      stateDir: state,
      codingRoot: owned,
      codingSocket: engineSocket,
      extensionPath: join(ROOT, 'test/fixtures/writing-specialist-extension.mjs'),
    });
    expect(
      service.children.list(session.id).map((c) => ({ id: c.id, result_id: c.result_id })),
    ).toEqual(before);
    expect(service.taskWork.get(task.id).state).toBe('succeeded');
    report.restart_preserved = true;
  } finally {
    await service?.close();
    mkdirSync(resolve(reportPath, '..'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
