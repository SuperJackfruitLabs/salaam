import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SalaamService } from '../dist/src/service/service.js';
import { call } from '../dist/src/core/transport.js';
import { digest } from '../dist/src/core/protocol.js';
import { readTree } from '../dist/src/workers/workspaces.js';
import { commandTerminal } from '../dist/src/coding/coding.js';
import { providerRoute } from '../dist/src/providers/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const dockerSocket = option('--docker-socket'),
  scratchRoot = option('--scratch-root');
if (!dockerSocket || !scratchRoot)
  throw Error('Supply --docker-socket and an existing VM-shared --scratch-root');
const liveOnly = process.argv.includes('--live-only');
const live = process.argv.includes('--live-claude') || liveOnly;
const liveRequests = Number(option('--live-requests') ?? 8),
  providedPatch = process.argv.includes('--provided-patch');
if (!Number.isInteger(liveRequests) || liveRequests < 1 || liveRequests > 8)
  throw Error('Live request limit must be 1-8');
const fixturePath = join(root, 'test/fixtures/coding-tasks.json'),
  fixtures = JSON.parse(readFileSync(fixturePath));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8),
  evidence = join(root, '.state/evidence/coding', runId);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(resolve(scratchRoot), 'acceptance-')),
  state = join(temp, 'state'),
  owned = join(temp, 'owned');
const report = {
  schema: 1,
  run_id: runId,
  started_at: new Date().toISOString(),
  operator: { platform: process.platform, arch: process.arch, node: process.version },
  fixture_version: fixtures.version,
  fixture_digest: hash(readFileSync(fixturePath)),
  compiled_digest: digest(
    [
      'coding',
      'coding-executor',
      'workspaces',
      'supervisor',
      'house-extension',
      'service',
      'protocol',
      'config',
    ].map((name) => readFileSync(join(root, `dist/src/${name}.js`), 'utf8')),
  ),
  tasks: [],
  success: false,
  live_requested: live,
  mode: liveOnly ? 'live-only' : live ? 'combined' : 'offline',
  live_budget: live ? { requests: liveRequests, max_output_tokens: 1024 } : null,
  live_evaluation: providedPatch ? 'provided-patch-integration' : 'autonomous-clamp-fix',
};
const save = () =>
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
save();
let service, child;
const until = async (fn, predicate, ms = 20_000) => {
  const end = Date.now() + ms;
  let value;
  do {
    value = await fn();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error('Acceptance condition timed out: ' + JSON.stringify(value));
};
const open = async () =>
  (service = await SalaamService.open({
    stateDir: state,
    codingRoot: owned,
    codingSocket: dockerSocket,
  }));
const sourceFor = (id, files) => {
  const dir = join(temp, 'cases', id, 'source');
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync('git', ['init', '--template=', '--initial-branch=main', dir], {
    stdio: 'ignore',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  writeFileSync(join(dir, '.git/salaam-host-canary'), 'protected-host-metadata');
  return dir;
};
const create = async (socket, source, key) => {
  const session = await call(socket, '/v1/sessions', {
    cwd: source,
    request_id: key,
    coding: true,
  });
  await until(
    () => call(socket, `/v1/sessions/${session.id}`),
    (x) => {
      if (x.state === 'unhealthy') throw Error(x.error);
      return x.state === 'ready';
    },
  );
  return session.id;
};
const controller = async (socket, id) => {
  const snapshot = await call(socket, `/v1/sessions/${id}/snapshot`);
  const client_id = randomUUID();
  const lease = await call(socket, `/v1/sessions/${id}/control`, {
    request_id: randomUUID(),
    action: 'takeover',
    client_id,
    expected_epoch: snapshot.control.epoch,
  });
  return { client_id, token: lease.token };
};
const start = async (socket, session, command, key, revision = 0) =>
  call(socket, `/v1/sessions/${session}/commands`, {
    ...(await controller(socket, session)),
    step_key: key,
    command,
    expected_revision: revision,
  });
const settled = async (socket, session, id, ms = 40_000) =>
  until(
    () => call(socket, `/v1/sessions/${session}/commands/${id}`),
    (x) => {
      if (x.state === 'outcome_unknown') throw Error(x.error);
      return commandTerminal(x.state);
    },
    ms,
  );
const recordCommand = (item, run, owner = service) => {
  item.commands ??= [];
  item.commands.push({
    ...run,
    input_snapshot: JSON.parse(owner.artifacts.read(run.snapshot_artifact)),
    output_artifact: run.result_artifact
      ? JSON.parse(owner.artifacts.read(run.result_artifact))
      : null,
  });
};
const patch = (session, path, content, key) => {
  const w = service.workspaces.get(session),
    tree = readTree(w.root);
  return service.workspaces.patch(session, key, {
    path,
    content,
    expected_revision: w.revision,
    expected_hash: tree[path] ? digest(tree[path]) : null,
  });
};
const capture = (item, session) => {
  const w = service.workspaces.get(session);
  item.workspace = { id: w.id, revision: w.revision, digest: w.digest };
  item.final_tree = readTree(w.root);
  item.events = service.store
    .events(session, 0)
    .map((event) => ({ seq: event.seq, kind: event.kind, payload: event.payload }));
};
const stopChild = async (signal) => {
  if (!child) return;
  const current = child;
  child = undefined;
  if (current.exitCode === null && current.signalCode === null) {
    const done = once(current, 'exit');
    current.kill(signal);
    await done;
  }
};
const startChild = async () => {
  child = spawn(
    process.execPath,
    [join(root, 'test/fixtures/coding-service.mjs'), state, owned, dockerSocket],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH } },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  const socket = join(state, 'operator.sock');
  await until(async () => {
    if (child.exitCode !== null) throw Error('Recovery service failed: ' + stderr);
    try {
      return await call(socket, '/v1/health');
    } catch {
      return null;
    }
  }, Boolean);
  return socket;
};
try {
  await open();
  report.backend = service.coding.executor.evidence;
  save();
  for (const task of liveOnly ? [] : fixtures.tasks) {
    console.log(task.id);
    const item = { id: task.id, started_at: new Date().toISOString(), passed: false },
      source = sourceFor(task.id, task.files);
    report.tasks.push(item);
    save();
    const session = await create(service.socket, source, task.id),
      w = service.workspaces.get(session);
    item.session_id = session;
    if (task.id === 'discovery') {
      assert(
        service.workspaces
          .read(session, { action: 'list' })
          .files.some((file) => file.path === 'math.js'),
      );
      assert.equal(
        service.workspaces.read(session, { action: 'search', query: 'add' }).matches[0].line,
        1,
      );
      assert.equal(
        service.workspaces.read(session, { action: 'read', path: 'math.js' }).lines[0].line,
        1,
      );
    } else if (task.id === 'precise-edit-crash') {
      await service.close();
      service = undefined;
      const crash = spawn(
        process.execPath,
        [join(root, 'test/fixtures/coding-crash-patch.mjs'), state, owned, session],
        { stdio: 'ignore', env: { PATH: process.env.PATH } },
      );
      const [code, signal] = await once(crash, 'exit');
      assert.equal(signal, 'SIGKILL');
      assert.equal(code, null);
      await open();
      assert.equal(service.workspaces.get(session).revision, 1);
      assert.match(
        readFileSync(join(service.workspaces.get(session).root, 'math.js'), 'utf8'),
        /a \+ b/,
      );
      assert.equal(
        service.store
          .events(session, 0)
          .filter((event) => event.kind === 'workspace.mutation_applied').length,
        1,
      );
    } else if (task.id === 'multi-file') {
      patch(session, 'value.js', 'export const value = 21;\n', 'value');
      patch(
        session,
        'client.js',
        "import {value} from './value.js'; export const answer = value * 2;\n",
        'client',
      );
      const run = await start(service.socket, session, 'node --test', 'multi-test', 2),
        result = await settled(service.socket, session, run.id);
      assert.equal(result.state, 'succeeded');
      recordCommand(item, result);
    } else if (task.id === 'failure-repair') {
      const bad = await start(service.socket, session, 'node --test', 'expected-failure'),
        failed = await settled(service.socket, session, bad.id);
      assert.equal(failed.state, 'failed');
      assert.notEqual(failed.exit_code, 0);
      recordCommand(item, failed);
      patch(session, 'math.js', 'export const add = (a, b) => a + b;\n', 'repair');
      const good = await start(service.socket, session, 'node --test', 'repaired-test', 1),
        passed = await settled(service.socket, session, good.id);
      assert.equal(passed.state, 'succeeded');
      recordCommand(item, passed);
    } else if (task.id === 'new-module') {
      patch(session, 'new.js', 'export const twice = n => n * 2;\n', 'create-file');
      const run = await start(service.socket, session, 'node --test', 'new-module-test', 1),
        result = await settled(service.socket, session, run.id);
      assert.equal(result.state, 'succeeded');
      recordCommand(item, result);
    } else if (task.id === 'deletion') {
      patch(session, 'obsolete.js', null, 'delete-file');
      assert(!Object.hasOwn(readTree(service.workspaces.get(session).root), 'obsolete.js'));
    } else if (task.id === 'human-conflict') {
      const before = readTree(w.root);
      writeFileSync(join(w.root, 'math.js'), '// human kept\nexport const value = 1;\n');
      assert.throws(() =>
        service.workspaces.patch(session, 'stale', {
          path: 'math.js',
          expected_revision: 0,
          expected_hash: digest(before['math.js']),
          content: 'overwrite',
        }),
      );
      assert.match(readFileSync(join(w.root, 'math.js'), 'utf8'), /human kept/);
      service.workspaces.refresh(session, 'reviewed-human', 0, digest(readTree(w.root)), () => {});
      patch(session, 'math.js', '// human kept\nexport const value = 2;\n', 'integrate');
    } else if (task.id === 'authority-boundary') {
      for (const path of ['../credential', '.git/config', 'nested/.salaam/control'])
        assert.throws(() =>
          service.workspaces.patch(session, path, {
            path,
            expected_revision: 0,
            expected_hash: null,
            content: 'bad',
          }),
        );
      const code =
        "const fs=require('node:fs'),assert=require('node:assert/strict'); assert.throws(()=>fs.writeFileSync('/source/math.js','bad'));assert.throws(()=>fs.statSync('/var/run/docker.sock'));assert.equal(process.env.ANTHROPIC_API_KEY,undefined);assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);console.log('boundary-ok');";
      const run = await start(
          service.socket,
          session,
          'node -e ' + JSON.stringify(code),
          'authority',
        ),
        result = await settled(service.socket, session, run.id);
      assert.equal(result.state, 'succeeded');
      recordCommand(item, result);
      assert.equal(
        readFileSync(join(source, '.git/salaam-host-canary'), 'utf8'),
        'protected-host-metadata',
      );
    } else if (task.id === 'reconnect') {
      await service.close();
      service = undefined;
      let socket = await startChild();
      await call(socket, `/v1/sessions/${session}/resume`, await controller(socket, session));
      await until(
        () => call(socket, `/v1/sessions/${session}`),
        (value) => value.state === 'ready',
      );
      const command = "node -e \"console.log('once'); setTimeout(()=>console.log('done'),3000)\"",
        run = await start(socket, session, command, 'one-execution');
      const before = await until(
        () => call(socket, `/v1/sessions/${session}/commands/${run.id}`),
        (x) => x.state === 'running',
      );
      await stopChild('SIGKILL');
      socket = await startChild();
      const after = await settled(socket, session, run.id);
      assert.equal(after.state, 'succeeded');
      assert.equal(after.container_id, before.container_id);
      assert.equal(after.exec_id, before.exec_id);
      assert.equal(Buffer.from(after.output, 'base64').toString().split('once').length - 1, 1);
      const duplicate = await call(socket, `/v1/sessions/${session}/commands`, {
        step_key: 'one-execution',
        command,
        expected_revision: 0,
      });
      assert.equal(duplicate.id, run.id);
      await call(socket, '/v1/shutdown', {});
      await once(child, 'exit');
      child = undefined;
      await open();
      recordCommand(item, after);
      item.same_execution_after_sigkill = true;
    } else if (task.id === 'cancellation-and-limits') {
      const run = await start(
        service.socket,
        session,
        "node -e \"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();console.log('spawned');setInterval(()=>{},1000)\"",
        'cancel-tree',
      );
      await until(
        () => service.coding.get(session, run.id),
        (x) => x.state === 'running' && x.output.length > 0,
      );
      service.coding.cancel(session, run.id, 'cancel-owned-tree', () => {});
      const cancelled = await settled(service.socket, session, run.id);
      assert.equal(cancelled.state, 'cancelled');
      recordCommand(item, cancelled);
      const noisy = await start(
          service.socket,
          session,
          'node -e "process.stdout.write(\'x\'.repeat(100000))"',
          'bounded-output',
        ),
        limited = await settled(service.socket, session, noisy.id);
      assert.equal(limited.state, 'output_limited');
      assert(Buffer.from(limited.output, 'base64').length <= 65536);
      recordCommand(item, limited);
      const long = await start(service.socket, session, 'while true; do sleep 1; done', 'deadline'),
        timed = await settled(service.socket, session, long.id);
      assert.equal(timed.state, 'timed_out');
      recordCommand(item, timed);
    }
    capture(item, session);
    assert.equal(
      digest(readTree(source, true)),
      digest(
        Object.fromEntries(
          Object.entries(task.files).map(([path, text]) => [
            path,
            { content: Buffer.from(text).toString('base64'), executable: false },
          ]),
        ),
      ),
    );
    item.passed = true;
    item.finished_at = new Date().toISOString();
    save();
  }
  if (live) {
    console.log('budgeted-live-claude');
    await service.close();
    service = undefined;
    const liveState = join(temp, 'live-state'),
      source = sourceFor('live', {
        'math.js': 'export const clamp = (value, min, max) => value;\n',
        'math.test.js':
          "import {test} from 'node:test';import assert from 'node:assert/strict';import {clamp} from './math.js';test('clamp',()=>{assert.equal(clamp(-2,0,10),0);assert.equal(clamp(12,0,10),10);assert.equal(clamp(3,0,10),3)});\n",
      });
    service = await SalaamService.open({
      stateDir: liveState,
      codingRoot: owned,
      codingSocket: dockerSocket,
      providerRoute: providerRoute('anthropic', undefined, 1024),
    });
    const session = await create(service.socket, source, 'live'),
      lease = await controller(service.socket, session);
    const task =
      'Fix clamp in math.js so values below min return min, above max return max, and values inside the interval stay unchanged. Keep the tests unchanged. Use salaam_files to inspect/read then persist one precise patch. Inspect revision before patching. Run node --test using salaam_command with step_key live-clamp-verification and the new workspace revision. Commands run disposable copies; use the patch tool for durable edits. You have at most 8 model requests and 1024 output tokens per request. Give a brief final result.';
    const suppliedHash = digest(readTree(service.workspaces.get(session).root)['math.js']);
    const text = providedPatch
      ? `Validate the live coding integration in exactly three responses: first call salaam_files with action patch, path math.js, expected_revision 0, expected_hash ${suppliedHash}, content "export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\\n" (use a real final newline). Then call salaam_command with action start, command node --test, expected_revision 1, step_key live-clamp-verification. Then give a brief final result. All current file facts are supplied; do not inspect/read or use extra tools. Keep math.test.js unchanged. There are at most ${liveRequests} requests, 1024 output tokens each.`
      : task.replace('at most 8 model requests', `at most ${liveRequests} model requests`);
    // The dispatcher uses setImmediate. Install the persisted cap synchronously before it can admit HTTP.
    const accepted = service.store.accept(
      session,
      'live-prompt',
      service.store.session(session).revision,
      text,
      lease,
    );
    service.store.transaction(() => service.store.usage.budget(accepted.attempt_id, liveRequests));
    const attempt = await until(
      () => service.store.attempt(accepted.attempt_id),
      (value) => ['completed', 'failed', 'interrupted'].includes(value.state),
      120_000,
    );
    const budget = service.store.db
      .prepare('SELECT * FROM attempt_budgets WHERE attempt_id=?')
      .get(attempt.id);
    assert.equal(budget.limit_requests, liveRequests);
    assert(Number(budget.spent_requests) <= liveRequests);
    const w = service.workspaces.get(session),
      tree = readTree(w.root);
    assert.equal(
      Buffer.from(tree['math.test.js'].content, 'base64').toString(),
      readFileSync(join(source, 'math.test.js'), 'utf8'),
    );
    const verify =
      "node --input-type=module -e \"import {clamp} from './math.js';import assert from 'node:assert/strict';for(const [v,lo,hi,want] of [[-5,-2,3,-2],[4,-2,3,3],[0,-2,3,0]])assert.equal(clamp(v,lo,hi),want);console.log('independent-clamp-check-ok');\"";
    const check = await start(
        service.socket,
        session,
        verify,
        'independent-live-check',
        w.revision,
      ),
      result = await settled(service.socket, session, check.id);
    report.live = {
      session_id: session,
      provider: service.supervisor.route,
      attempt,
      budget,
      usage: service.store.usage.summary(session),
      verification: result,
      final_tree: tree,
    };
    save();
    assert.equal(result.state, 'succeeded');
    assert.equal(attempt.state, 'completed');
    report.live.passed = true;
  }
  report.success = true;
} catch (error) {
  report.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  await stopChild('SIGKILL');
  if (!service) {
    try {
      await open();
    } catch {
      report.cleanup_confirmed = false;
    }
  }
  if (service) {
    const runs = service.store.db.prepare('SELECT id FROM command_runs').all();
    await service.close();
    try {
      for (const row of runs) await service.coding.executor.cleanup(String(row.id));
      report.cleanup_confirmed = true;
    } catch {
      report.cleanup_confirmed = false;
      report.success = false;
      process.exitCode = 1;
    }
  }
  report.finished_at = new Date().toISOString();
  save();
  if (report.cleanup_confirmed) rmSync(temp, { recursive: true, force: true });
  else report.retained_scratch = temp;
  save();
  console.log(
    JSON.stringify({
      success: report.success,
      tasks: report.tasks.filter((task) => task.passed).length,
      evidence: join(evidence, 'report.json'),
      live: report.live?.passed ?? false,
    }),
  );
}
