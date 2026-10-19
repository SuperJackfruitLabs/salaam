import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { ROOT } from '../dist/src/config.js';
import { digest } from '../dist/src/protocol.js';
import { hostDigests } from '../dist/src/host.js';
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';
import { AcceptanceChannel, AcceptanceModels } from './m18-host-channel.mjs';
const exec = promisify(execFile),
  quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const resumeIndex = process.argv.indexOf('--resume'),
  prior =
    resumeIndex < 0
      ? null
      : JSON.parse(fs.readFileSync(resolve(process.argv[resumeIndex + 1]), 'utf8'));
if (
  prior &&
  (!prior.failed_audit?.task || !/^mixed-runtime-[0-9a-f-]{36}$/.test(prior.run_id ?? ''))
)
  throw Error('Select an owned failed rehearsal report');
const prepareOnly = process.argv.includes('--prepare-only'),
  codexProbe = process.argv.includes('--codex-probe');
if (!prepareOnly && !codexProbe && !prior && !process.argv.includes('--run'))
  throw Error('Use --prepare-only or --run for the authorized live portfolio');
const remote = JSON.parse(fs.readFileSync(join(ROOT, '.state/m18-remote-context.json'), 'utf8')),
  runtime = JSON.parse(fs.readFileSync(join(ROOT, '.state/m18-vps-preparation.json'), 'utf8')),
  coding = JSON.parse(fs.readFileSync(join(ROOT, '.state/m18-vps-coding.json'), 'utf8'));
if (
  remote.host !== 'superprocess-remote-dev' ||
  !/^\/home\/hermes\/\.cache\/salaam-m10\.eByB1aeQ\/m18-[0-9a-f-]{36}$/.test(remote.root)
)
  throw Error('Select the already authorized owned VPS rehearsal');
const run = prior?.run_id ?? 'mixed-runtime-' + randomUUID(),
  local = join(ROOT, '.state', run),
  reportPath = join(ROOT, '.state/evidence/m18', run + (prior ? '.continued.json' : '.json'));
fs.mkdirSync(local, { recursive: true, mode: 0o700 });
const budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json')),
  report = {
    schema_version: 1,
    run_id: run,
    success: false,
    prepare_only: prepareOnly,
    observed_at: new Date().toISOString(),
    ...hostDigests(),
    runner_digest: createHash('sha256')
      .update(fs.readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    scope:
      'Actual installed Linux daemon, native specialists, isolated Codex builder, Mac A2A reviewer and bounded host-only Claude relay; fresh checks and explicit integration',
    model: 'claude-sonnet-4-6',
    output_cap: 4096,
    run_request_limit: 40,
    admissions: [],
    decisions: [],
    remote: {
      host: remote.host,
      ...runtime,
      package: JSON.parse(fs.readFileSync(join(ROOT, '.state/m18-release/release.json'), 'utf8')),
    },
  };
if (prior) {
  Object.assign(report, prior);
  report.resumed_from = resolve(process.argv[resumeIndex + 1]);
  report.prior_failure = report.failure;
  report.continuation_runner_digest = createHash('sha256')
    .update(fs.readFileSync(new URL(import.meta.url)))
    .digest('hex');
  delete report.failure;
  delete report.failed_audit;
  report.success = false;
  report.continued_candidate = JSON.parse(
    fs.readFileSync(join(ROOT, '.state/m18-release/release.json'), 'utf8'),
  );
  report.previous_service = prior.service;
}
const models = new AcceptanceModels(budget, run, report),
  proxyToken = 'salaam-acceptance-proxy-' + randomBytes(32).toString('base64url'),
  peerToken = 'salaam-peer-' + randomBytes(32).toString('base64url'),
  peerGatewayToken = randomBytes(48).toString('base64url');
const ssh = ['-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10'];
let peer, service, heartbeat, actor, session, task;
const until = async (fn, accept, timeout = 240000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Mixed acceptance deadline reached');
};
const progress = (phase) => process.stdout.write(JSON.stringify({ run_id: run, phase }) + '\n');
const upload = async (files, to) =>
  exec('scp', ['-q', ...ssh, ...files, remote.host + ':' + to], { maxBuffer: 1048576 });
async function remoteWrite(files) {
  const code =
    "import sys,json,base64,os\nfrom pathlib import Path\nv=json.load(sys.stdin);root=Path(v['root'])\nfor name,body in v['files'].items():\n p=root/name\n if '..' in Path(name).parts or Path(name).is_absolute():raise RuntimeError('Unsafe fixture path')\n p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)\n p.write_bytes(base64.b64decode(body));p.chmod(0o600)";
  await new Promise((resolve, reject) => {
    const child = spawn('ssh', [...ssh, remote.host, 'python3 -c ' + quote(code)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (b) => (error += b));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
    child.stdin.end(
      JSON.stringify({
        root: remote.root,
        files: Object.fromEntries(
          Object.entries(files).map(([path, body]) => [path, Buffer.from(body).toString('base64')]),
        ),
      }),
    );
  });
}
const api = (path, body) =>
  service.request('api', { path, ...(body === undefined ? {} : { body }) });
async function control(takeover = false) {
  clearInterval(heartbeat);
  const snapshot = await api(`/v1/sessions/${session.id}`),
    client_id = randomUUID(),
    lease = await api(`/v1/sessions/${session.id}/control`, {
      request_id: randomUUID(),
      client_id,
      action: takeover ? 'takeover' : 'acquire',
      expected_epoch:
        snapshot.control?.epoch ?? (await api(`/v1/sessions/${session.id}/snapshot`)).control.epoch,
    });
  actor = { client_id, token: lease.token };
  heartbeat = setInterval(() => {
    void api(`/v1/sessions/${session.id}/snapshot`)
      .then((s) =>
        api(`/v1/sessions/${session.id}/control`, {
          ...actor,
          request_id: randomUUID(),
          action: 'renew',
          expected_epoch: s.control.epoch,
        }),
      )
      .catch(() => {});
  }, 3000);
}
const current = () => api(`/v1/tasks/${task.id}`);
async function action(path, body = {}) {
  const now = await current();
  return api(`/v1/tasks/${task.id}/${path}`, {
    ...actor,
    request_id: randomUUID(),
    expected_revision: now.revision,
    ...body,
  });
}
async function child(id) {
  return (await api(`/v1/sessions/${session.id}/children`)).find((c) => c.id === id);
}
async function complete(index, review) {
  return action(`steps/${task.steps[index].id}/complete`, { review });
}
async function assign(index, profile, runtimeId) {
  return action('team/assign', {
    step_id: task.steps[index].id,
    profile_id: profile,
    ...(runtimeId ? { runtime: runtimeId, invocations: 1 } : { requests: 8 }),
  });
}
async function runAssignment(a, key, instruction) {
  const now = await current(),
    body = {
      ...actor,
      request_id: run + ':' + key,
      expected_revision: now.revision,
      generation: a.generation,
      ...(instruction ? { instruction } : {}),
    };
  const result = await api(`/v1/tasks/${task.id}/team/${a.id}/run`, body);
  return { result, body };
}
async function settle(id) {
  return until(
    () => child(id),
    (c) => c && c.state !== 'accepted',
  );
}
async function startService(peerPort) {
  const command = [
    '/usr/bin/env',
    '-i',
    'HOME=' + join(remote.root, 'service-home'),
    'PATH=' + dirname(runtime.node) + ':/usr/bin:/bin',
    'LANG=C.UTF-8',
    runtime.node,
    join(remote.root, 'uploads/m18-remote-service.mjs'),
    '--run',
    '--config',
    join(remote.root, 'service-config.json'),
  ]
    .map(quote)
    .join(' ');
  service = new AcceptanceChannel(
    spawn(
      'ssh',
      [
        ...ssh,
        '-o',
        'ExitOnForwardFailure=yes',
        '-R',
        `127.0.0.1:${peerPort}:127.0.0.1:${peerPort}`,
        remote.host,
        command,
      ],
      { stdio: 'pipe' },
    ),
    (frame, channel) => {
      if (frame.kind === 'harness_permission_observed') {
        report.harness_permissions ??= [];
        report.harness_permissions.push(frame);
      }
      if (codexProbe && frame.kind === 'model_request') {
        report.fixture_requests = (report.fixture_requests ?? 0) + 1;
        const index = report.fixture_requests,
          cmd = index === 1 ? repair : 'node --test app.test.js';
        const body = {
          id: 'msg_fixture_' + index,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: index <= 2 ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          content:
            index <= 2
              ? [
                  {
                    type: 'tool_use',
                    id: 'toolu_fixture_' + index,
                    name: 'exec_command',
                    input: { cmd, workdir: '/workspace', sandbox_permissions: 'require_escalated' },
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: 'Fixture protocol sequence finished; inspect actual receipts.',
                  },
                ],
        };
        channel.send({
          op: 'model_response',
          id: frame.id,
          status: 200,
          content_type: 'application/json',
          chunk: Buffer.from(JSON.stringify(body)).toString('base64'),
          end: true,
        });
        return;
      }
      return models.remote(frame, channel, proxyToken);
    },
  );
  return service.wait('ready');
}
const repair = `node -e 'require("node:fs").writeFileSync("app.js","export const answer = 42;\\n")'`;
try {
  progress('start-independent-mac-reviewer');
  const peerConfig = {
      schema: 1,
      host: '127.0.0.1',
      port: 0,
      token: peerToken,
      tenant: 'mixed-review',
      sdk: join(ROOT, 'node_modules/@a2a-js/sdk'),
      state: join(local, 'peer-state'),
    },
    peerFile = join(local, 'peer.json');
  fs.writeFileSync(peerFile, JSON.stringify(peerConfig), { mode: 0o600 });
  peer = new AcceptanceChannel(
    spawn(
      process.execPath,
      [join(ROOT, 'scripts/mixed-a2a-peer.mjs'), '--run', '--config', peerFile],
      {
        cwd: local,
        env: { HOME: local, PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
        stdio: 'pipe',
      },
    ),
    (frame, channel) => models.peer(frame, channel, peerGatewayToken),
  );
  const peerReady = await peer.wait('ready'),
    peerPort = Number(new URL(peerReady.endpoint).port),
    card = await (
      await fetch(peerReady.card_url, { headers: { Authorization: `Bearer ${peerToken}` } })
    ).json();
  await upload(
    [
      'scripts/m18-remote-service.mjs',
      'scripts/m18-provider-fetch.mjs',
      'scripts/m18-provider-preload.mjs',
    ],
    join(remote.root, 'uploads/'),
  );
  const credential = { peer: 'mac-reviewer', token: peerToken },
    pin = {
      id: 'mac-reviewer',
      endpoint: peerReady.endpoint,
      card_url: peerReady.card_url,
      card_digest: digest(card),
      tenant: 'mixed-review',
      skill: 'review',
      addresses: ['127.0.0.1'],
      local: true,
      credential_file: join(remote.root, 'peer-credential.json'),
      credential_digest: digest(credential),
      files: ['app.js', 'app.test.js'],
      retention: 'durable',
      cancel: false,
      streaming: false,
    };
  const sourceFiles = {
    'package.json': '{"type":"module"}\n',
    'app.js': 'export const answer = 41;\n',
    'human.txt': 'uncommitted human bytes\n',
    'app.test.js':
      "import{test}from'node:test';import assert from'node:assert/strict';import{answer}from'./app.js';test('answer',()=>assert.equal(answer,42));\n",
  };
  await remoteWrite({
    'service-config.json': JSON.stringify({
      root: remote.root,
      package_root: coding.package_root,
      model: 'claude-sonnet-4-6',
      proxy_token: proxyToken,
    }),
    'peer-credential.json': JSON.stringify(credential),
    'peers.json': JSON.stringify({ schema: 1, peers: [pin] }),
    ...Object.fromEntries(Object.entries(sourceFiles).map(([p, text]) => ['source/' + p, text])),
    'source/.salaam/agents/mixed-builder.md':
      '---\n{"role":"builder","max_requests":8}\n---\nUse the external harness command inventory in your private /workspace. Preserve tests, package metadata and human bytes. Do not delegate or install anything.\n',
  });
  progress('prove-real-linux-daemon-and-harness-readiness');
  report.service = await startService(peerPort);
  report.health = await api('/v1/health');
  assert.equal(report.health.service, 'healthy');
  if (prepareOnly) {
    report.success = true;
    report.scope =
      'Real Linux installed daemon and whole-harness readiness with the bounded acceptance relay; no live model request';
  } else if (codexProbe) {
    report.scope =
      'Actual installed Linux x64 Codex permission correlation with deterministic model frames; zero live API requests';
    session = await api('/v1/sessions', {
      request_id: run + '-session',
      cwd: join(remote.root, 'source'),
      coding: true,
    });
    await until(
      () => api(`/v1/sessions/${session.id}`),
      (s) => s.state === 'ready',
    );
    await control();
    const profile = await api(`/v1/sessions/${session.id}/agents?profile=project%2Fmixed-builder`);
    await api(`/v1/sessions/${session.id}/agents/admit`, {
      ...actor,
      request_id: randomUUID(),
      profile_id: 'project/mixed-builder',
      expected_digest: profile.digest,
      fact_ids: [],
    });
    task = await api('/v1/tasks', {
      ...actor,
      request_id: run + '-task',
      session_id: session.id,
      expected_revision: 0,
      plan: {
        objective: 'Observe actual Linux Codex permission correlation',
        constraints: ['Preserve protected fixture files'],
        steps: [
          {
            key: 'repair',
            title: 'Repair',
            instruction: 'Use the exact admitted fixture commands',
            depends_on: [],
            checks: ['suite'],
          },
        ],
        acceptance: [{ key: 'suite', command: 'node --test app.test.js', cwd: '.' }],
        deliverables: ['app.js'],
        limits: {
          invocations: 1,
          token_units: null,
          requests: 1,
          runtime_ms: 300000,
          concurrency: 1,
        },
      },
    });
    const a = await assign(0, 'project/mixed-builder', 'codex'),
      r = await runAssignment(a, 'fixture-run');
    await until(
      async () => {
        for (const approval of await api('/v1/approvals')) {
          const op = await api(`/v1/operations/${approval.operation_id}`),
            scope = JSON.parse(op.value).scope;
          const yes =
            scope?.kind === 'command' &&
            [repair, 'node --test app.test.js'].includes(scope.arguments.cmd);
          await api(`/v1/approvals/${approval.id}/decision`, {
            request_id: 'decision:' + approval.id,
            expected_revision: approval.revision,
            operation_digest: approval.operation_digest,
            decision: yes ? 'approve' : 'deny',
          });
          report.decisions.push({ id: approval.id, scope, decision: yes ? 'approve' : 'deny' });
        }
        return child(r.result.child_id);
      },
      (c) => c.state !== 'accepted',
    );
    report.proposal = await api(`/v1/workers/${r.result.child_id}/proposal`);
    assert(report.proposal.changes.some((c) => c.path === 'app.js'));
    assert.equal(report.decisions.filter((d) => d.decision === 'approve').length, 2);
    report.success = true;
  } else {
    models.enabled = true;
    let nativeReview;
    if (!prior) {
      progress('native-explorer');
      session = await api('/v1/sessions', {
        request_id: run + '-session',
        cwd: join(remote.root, 'source'),
        coding: true,
      });
      await until(
        () => api(`/v1/sessions/${session.id}`),
        (s) => s.state === 'ready',
      );
      await control();
      for (const id of ['salaam/explorer', 'salaam/reviewer', 'project/mixed-builder']) {
        const profile = await api(
          `/v1/sessions/${session.id}/agents?profile=${encodeURIComponent(id)}`,
        );
        await api(`/v1/sessions/${session.id}/agents/admit`, {
          ...actor,
          request_id: randomUUID(),
          profile_id: id,
          expected_digest: profile.digest,
          fact_ids: [],
        });
      }
      const instruction = `The admitted explorer has shown app.js exports answer=41. Do not run preliminary read commands. Repair ONLY app.js through exec_command with cmd exactly ${repair}, workdir=/workspace and sandbox_permissions=require_escalated. Then run exactly node --test app.test.js using exec_command with workdir=/workspace and sandbox_permissions=require_escalated. Preserve all other bytes. Do not install, delegate or use network.`;
      task = await api('/v1/tasks', {
        ...actor,
        request_id: run + '-task',
        session_id: session.id,
        expected_revision: 0,
        plan: {
          objective:
            'Explore, repair and independently review a guarded fixture across native, harness and A2A runtimes',
          constraints: [
            'Preserve human bytes and test files',
            'Only explicit integration changes the parent workspace',
          ],
          steps: [
            {
              key: 'explore',
              title: 'Native exploration',
              instruction:
                'Inspect app.js and app.test.js through salaam_repository. Explain the seeded contract mismatch with concrete file and line evidence. Do not execute or edit.',
              depends_on: [],
              checks: ['suite'],
            },
            {
              key: 'repair',
              title: 'Pinned Codex repair',
              instruction,
              depends_on: ['explore'],
              checks: ['suite'],
            },
            {
              key: 'review',
              title: 'Native review',
              instruction:
                'Review the integrated diff and app.js contract using salaam_repository. Publish actual correctness findings through salaam_findings, including an empty findings array if the repair is correct. Do not execute or edit.',
              depends_on: ['repair'],
              checks: ['suite'],
            },
            {
              key: 'peer',
              title: 'A2A review',
              instruction:
                'Review only the disclosed app.js and app.test.js. The exported answer must be 42. Return concise correctness analysis; do not claim execution, integration or human authority.',
              depends_on: ['review'],
              checks: ['suite'],
            },
          ],
          acceptance: [{ key: 'suite', command: 'node --test app.test.js', cwd: '.' }],
          deliverables: ['app.js', 'human.txt'],
          limits: {
            invocations: 2,
            token_units: null,
            requests: 40,
            runtime_ms: 900000,
            concurrency: 3,
          },
        },
      });
      const baseline = await action('verify', { check_key: 'suite' });
      report.baseline = await until(
        async () => (await current()).verification.checks.find((c) => c.id === baseline.id),
        (c) => c && ['passed', 'failed'].includes(c.state),
      );
      assert.equal(report.baseline.state, 'failed');
      const explorer = await assign(0, 'salaam/explorer'),
        exploration = await runAssignment(explorer, 'explore-once');
      assert.equal((await settle(exploration.result.child_id)).state, 'completed');
      let audit = await service.request('evidence', { session: session.id });
      const explored = audit.children.find((c) => c.child.id === exploration.result.child_id);
      assert(explored.reads > 0);
      assert.match(explored.result.result.text, /app\.js|answer|41|42/);
      report.explorer = explored;
      await complete(
        0,
        'Inspected actual immutable repository read receipts and bounded explorer evidence',
      );
      progress('isolated-codex-builder-shared-inbox-and-takeover');
      const builder = await assign(1, 'project/mixed-builder', 'codex'),
        built = await runAssignment(
          builder,
          'repair-once',
          instruction + '\nExplorer evidence: ' + explored.result.result.text.slice(0, 1200),
        );
      let tookOver = false;
      await until(
        async () => {
          const approvals = await api('/v1/approvals');
          for (const approval of approvals) {
            const details = await api(`/v1/operations/${approval.operation_id}`);
            if (details.kind !== 'harness') continue;
            const scope = JSON.parse(details.value).scope,
              a = scope.arguments,
              yes =
                scope.kind === 'command' &&
                [repair, 'node --test app.test.js'].includes(a.cmd ?? a.command);
            const inbox = await api('/v1/inbox');
            assert(inbox.items.some((i) => i.source_key === 'approval:' + approval.id));
            if (!tookOver) {
              const old = { ...actor };
              await control(true);
              const retry = await api(`/v1/tasks/${task.id}/team/${builder.id}/run`, {
                ...built.body,
                client_id: 'expired',
                token: 'expired',
              });
              assert.equal(retry.child_id, built.result.child_id);
              report.takeover = {
                same_child: retry.child_id,
                saved_request_replayed: true,
                old_client: old.client_id,
              };
              tookOver = true;
            }
            await api(`/v1/approvals/${approval.id}/decision`, {
              request_id: 'decision:' + approval.id,
              expected_revision: approval.revision,
              operation_digest: approval.operation_digest,
              decision: yes ? 'approve' : 'deny',
            });
            report.decisions.push({ id: approval.id, scope, decision: yes ? 'approve' : 'deny' });
          }
          return child(built.result.child_id);
        },
        (c) => c.state !== 'accepted',
      );
      assert.equal((await child(built.result.child_id)).state, 'completed');
      const proposal = await api(`/v1/workers/${built.result.child_id}/proposal`);
      assert(proposal.changes.length > 0 && proposal.changes.every((c) => c.path === 'app.js'));
      const workspace = await api(`/v1/sessions/${session.id}/workspace`);
      report.integration = await api(`/v1/workers/${built.result.child_id}/integrate`, {
        ...actor,
        request_id: run + ':integrate-once',
        workspace_revision: workspace.revision,
        workspace_digest: workspace.digest,
        patch_digest: proposal.patch_digest,
      });
      assert.equal(report.integration.state, 'applied');
      await complete(
        1,
        'Inspected stopped Codex proposal and applied its exact hash-bound integration receipt',
      );
      progress('selected-native-reviewer-cancellation');
      const reviewer = await assign(2, 'salaam/reviewer');
      models.holdNextLinux = true;
      const stopped = await runAssignment(reviewer, 'review-stop-once');
      await until(
        () => models.held.size,
        (n) => n === 1,
      );
      const selected = await child(stopped.result.child_id),
        selectedSnapshot = await api(`/v1/sessions/${selected.child_session}/snapshot`),
        selectedClient = randomUUID(),
        selectedLease = await api(`/v1/sessions/${selected.child_session}/control`, {
          request_id: randomUUID(),
          client_id: selectedClient,
          action: 'acquire',
          expected_epoch: selectedSnapshot.control.epoch,
        }),
        selectedSession = await api(`/v1/sessions/${selected.child_session}`),
        callsBeforeStop = report.admissions.length;
      report.selected_stop = await api(`/v1/attempts/${selected.child_attempt}/cancel`, {
        request_id: run + ':selected-stop-once',
        client_id: selectedClient,
        token: selectedLease.token,
        expected_revision: selectedSession.revision,
      });
      report.stopped_child = await settle(selected.id);
      assert.equal(report.stopped_child.state, 'cancelled');
      await until(
        async () => (await service.request('evidence', { session: session.id })).workers,
        (workers) =>
          workers
            .filter((w) => w.session_id === selected.child_session)
            .every((w) => w.state === 'exited'),
      );
      await until(
        () => models.held.size,
        (n) => n === 0,
      );
      assert.equal(report.admissions.length, callsBeforeStop);
      progress('explicit-new-generation-native-reviewer');
      const reviewed = await runAssignment(
        { ...reviewer, generation: 1 },
        'review-follow-up-once',
        'The operator cancelled the previous generation before provider forwarding. Review the integrated diff and app.js through salaam_repository. Publish actual findings with salaam_findings, including findings:[] if correct. Do not edit or execute.',
      );
      assert.notEqual(reviewed.result.child_id, selected.id);
      assert.equal((await settle(reviewed.result.child_id)).state, 'completed');
      audit = await service.request('evidence', { session: session.id });
      nativeReview = audit.children.find((c) => c.child.id === reviewed.result.child_id);
      assert(nativeReview.reads > 0);
      assert(nativeReview.findings);
      assert(nativeReview.findings.findings.every((f) => f.severity === 'low'));
      report.native_reviewer = nativeReview;
    } else {
      progress('resume-same-task-after-inspecting-informational-native-findings');
      task = prior.failed_audit.task;
      session = { id: task.session_id };
      await control();
      const reviewStep = task.steps[2];
      nativeReview = prior.failed_audit.children.find(
        (c) => c.child.child_attempt === reviewStep.attempt_id,
      );
      assert.equal(nativeReview.child.state, 'completed');
      assert(nativeReview.reads > 0);
      assert(nativeReview.findings.findings.every((f) => f.severity === 'low'));
      report.native_reviewer = nativeReview;
      report.predecessors_not_redispatched = prior.failed_audit.children.map((c) => c.child.id);
    }
    if ((await current()).steps[2].state !== 'completed')
      await complete(2, 'Inspected independent native findings and actual repository/diff reads');
    let peerAssignment, peerRun;
    if ((await current()).steps[3].state !== 'completed') {
      progress('mac-a2a-specialist-through-private-reverse-ssh');
      peerAssignment = await assign(3, 'salaam/reviewer', 'mac-reviewer');
      peerRun = await runAssignment(peerAssignment, 'peer-review-once');
      assert.equal((await settle(peerRun.result.child_id)).state, 'completed');
      assert.equal(report.peer_disclosure.contains_human_bytes, false);
      assert.equal((report.model_errors ?? []).length, 0);
      report.peer = await api(`/v1/harnesses/${peerRun.result.child_id}`);
      await complete(
        3,
        'Inspected the same peer/task/context and unverified independent analysis; no execution claim',
      );
    } else {
      models.enabled = false;
      progress('inspect-existing-peer-run-without-redispatch');
      peerAssignment = (await api(`/v1/tasks/${task.id}/team`)).assignments.find(
        (a) => a.step_id === task.steps[3].id,
      );
      peerRun = await service.request('saved_peer_run', {
        task: task.id,
        assignment: peerAssignment.id,
        request_id: run + ':peer-review-once',
      });
      report.peer = prior.peer;
    }
    if ((await current()).state !== 'succeeded') {
      progress('fresh-parent-checks');
      const check = await action('verify', { check_key: 'suite' });
      report.final_check = await until(
        async () => (await current()).verification.checks.find((c) => c.id === check.id),
        (c) => c && ['passed', 'failed'].includes(c.state),
      );
      assert.equal(report.final_check.state, 'passed');
      report.task = await action('finish');
    } else {
      report.task = await current();
      assert(report.task.verification.completion.fresh);
    }
    assert.equal(report.task.state, 'succeeded');
    let audit = await service.request('evidence', { session: session.id });
    for (const [path, bytes] of Object.entries(sourceFiles)) {
      assert.equal(Buffer.from(audit.source[path].content, 'base64').toString(), bytes);
      if (path !== 'app.js')
        assert.equal(Buffer.from(audit.tree[path].content, 'base64').toString(), bytes);
    }
    assert.equal(
      Buffer.from(audit.tree['app.js'].content, 'base64').toString(),
      'export const answer = 42;\n',
    );
    report.audit = audit;
    progress('installed-mac-terminal-disconnect-and-reattach');
    const macPrefix = join(local, 'mac-cli');
    await exec(
      'npm',
      [
        'install',
        '--prefix',
        macPrefix,
        '--ignore-scripts',
        '--offline',
        '--no-audit',
        '--no-fund',
        join(ROOT, '.state/m18-release/salaam-cli-0.0.1.tgz'),
      ],
      {
        env: { ...process.env, HOME: local, npm_config_cache: join(local, 'npm-empty-cache') },
        maxBuffer: 1048576,
      },
    );
    const terminalContext = join(local, 'terminal-context.json');
    fs.writeFileSync(
      terminalContext,
      JSON.stringify({
        host: remote.host,
        remote_bin: coding.remote_bin,
        state: join(remote.root, 's'),
        session: session.id,
        local,
        installed_cli: join(macPrefix, 'node_modules/@superjackfruitlabs/salaam/bin/salaam.mjs'),
      }),
      { mode: 0o600 },
    );
    const terminalRun = await exec(
      process.execPath,
      [
        join(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'vitest.real.config.ts',
        'test/acceptance/mixed-terminal.test.ts',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, SALAAM_M18_TERMINAL_CONTEXT: terminalContext },
        timeout: 180000,
        maxBuffer: 2097152,
      },
    );
    fs.writeFileSync(join(local, 'terminal-proof.log'), terminalRun.stdout + terminalRun.stderr);
    report.terminal = JSON.parse(fs.readFileSync(join(local, 'terminal-evidence.json'), 'utf8'));
    const afterTerminal = await service.request('evidence', { session: session.id });
    assert.equal(afterTerminal.children.length, audit.children.length);
    assert.equal(afterTerminal.workspace.digest, audit.workspace.digest);
    progress('actual-linux-daemon-sigkill-and-same-request-recovery');
    clearInterval(heartbeat);
    const beforeRestartCalls = report.admissions.length;
    models.enabled = false;
    const killCode = fs.readFileSync(join(ROOT, 'scripts/m18-remote-prepare.py'), 'utf8');
    await new Promise((resolve, reject) => {
      const killer = spawn('ssh', [...ssh, remote.host, 'python3 -c ' + quote(killCode)], {
        stdio: 'pipe',
      });
      let error = '';
      killer.stderr.on('data', (b) => (error += b));
      killer.once('error', reject);
      killer.once('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
      killer.stdin.end(JSON.stringify({ ...remote, phase: 'kill', pid: report.service.pid }));
    });
    await until(() => service.exit, Boolean);
    report.restarted_service = await startService(peerPort);
    assert.notEqual(report.restarted_service.pid, report.service.pid);
    const replay = await api(`/v1/tasks/${task.id}/team/${peerAssignment.id}/run`, {
      ...peerRun.body,
      client_id: 'expired',
      token: 'expired',
    });
    assert.equal(replay.child_id, peerRun.result.child_id);
    const recovered = await service.request('evidence', { session: session.id });
    assert.equal(recovered.task.state, 'succeeded');
    assert.deepEqual(
      recovered.children.map((c) => c.child.id),
      audit.children.map((c) => c.child.id),
    );
    assert.equal(recovered.workspace.digest, audit.workspace.digest);
    assert.deepEqual(recovered.commands, audit.commands);
    assert.deepEqual(recovered.task.runtime, audit.task.runtime);
    assert.deepEqual(recovered.task.verification, audit.task.verification);
    report.recovered_audit = recovered;
    assert.equal(report.admissions.length, beforeRestartCalls);
    assert.equal((report.model_errors ?? []).length, 0);
    report.restart = {
      signal: 'SIGKILL',
      same_task: recovered.task.id,
      same_external_child: replay.child_id,
      same_workspace_digest: recovered.workspace.digest,
      same_children: recovered.children.length,
      new_model_requests: 0,
    };
    report.success = true;
    fs.writeFileSync(
      join(ROOT, '.state/m18-live-context.json'),
      JSON.stringify(
        {
          run_id: run,
          remote,
          runtime,
          coding,
          local,
          peer_file: peerFile,
          peer_port: peerPort,
          session_id: session.id,
          task_id: task.id,
          service_config: join(remote.root, 'service-config.json'),
          report: reportPath,
        },
        null,
        2,
      ) + '\n',
    );
  }
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  if (session && service && !service.exit) {
    try {
      report.failed_audit = await service.request('evidence', { session: session.id });
    } catch {}
  }
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  models.enabled = false;
  await service?.close();
  await peer?.close('stop');
  models.close();
  report.budget = budget.snapshot();
  budget.export();
  budget.close();
  fs.mkdirSync(dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    JSON.stringify({
      report: reportPath,
      success: report.success,
      admitted_requests: report.admissions.length,
      remaining_requests: report.budget.remaining_requests,
      failure: report.failure ?? null,
    }) + '\n',
  );
}
