import fs from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { strict as assert } from 'node:assert';
import { DockerHarnessBoundary } from '../dist/src/harness-container.js';
import { DockerCodingExecutor } from '../dist/src/coding-executor.js';
import { engineRequest } from '../dist/src/execution-boundary.js';
import { HarnessProtocol } from '../dist/src/harness-protocol.js';
import { AnthropicHarnessGateway } from '../dist/src/harness-model-gateway.js';
import { HarnessWireBridge } from '../dist/src/harness-wire-bridge.js';
import { harnessToolIds, matchesCodexCommandScope } from '../dist/src/harness-tool-identity.js';
import { resolveProviderAuth, ProviderCredentialStore } from '../dist/src/provider-auth.js';
import { providerRoute } from '../dist/src/provider-config.js';
import { SalaamService } from '../dist/src/service.js';
import { call } from '../dist/src/transport.js';
import { ROOT } from '../dist/src/config.js';
import { hostDigests } from '../dist/src/host.js';
import { digest } from '../dist/src/protocol.js';
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';

if (!process.argv.includes('--run'))
  throw Error('Use --run for the authorized named-harness acceptance');
const target = process.argv[process.argv.indexOf('--target') + 1];
const offline = process.argv.includes('--offline-peer');
if (!['gemini-acp', 'codex-app-server'].includes(target))
  throw Error('Select gemini-acp or codex-app-server');
const socket = process.env.SALAAM_TASK_REAL_SOCKET,
  scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
if (!socket || !scratch) throw Error('Select the proven executor');
const runtime = JSON.parse(fs.readFileSync(join(ROOT, '.state/m16-runtime-path.json'))).root;
const budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json')),
  run = (offline ? 'offline-' : '') + target + '-' + randomUUID(),
  dir = fs.mkdtempSync(join(fs.realpathSync(scratch), 'm16-peer-live-')),
  workspace = join(dir, 'workspace'),
  home = join(dir, 'home'),
  token = randomUUID() + randomUUID(),
  state = fs.mkdtempSync('/tmp/sal-harness-verify-');
for (const p of [workspace, home]) fs.mkdirSync(p, { mode: 0o700 });
const files = {
  'package.json': '{"type":"module"}\n',
  'app.js': 'export const answer = 41;\n',
  'human.txt': 'existing uncommitted human bytes\n',
  'app.test.js':
    "import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{answer}from'./app.js';if(fs.existsSync('/home/agent')){const p='/home/agent/harness-test-count';fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1))}test('answer',()=>assert.equal(answer,42));\n",
};
for (const [p, bytes] of Object.entries(files))
  fs.writeFileSync(join(workspace, p), bytes, { mode: 0o600 });
const checkpointDb = new DatabaseSync(join(dir, 'checkpoint.sqlite'));
checkpointDb.exec(
  'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE checkpoint(worker_id TEXT PRIMARY KEY,document TEXT NOT NULL);',
);
const model = 'claude-sonnet-4-6',
  wireModel = target === 'gemini-acp' ? 'gemini-2.5-flash' : model,
  tools =
    target === 'gemini-acp'
      ? [
          'list_directory',
          'read_file',
          'grep_search',
          'glob',
          'replace',
          'write_file',
          'run_shell_command',
        ]
      : ['exec_command', 'write_stdin'];
const repairCommand = `node -e 'require("node:fs").writeFileSync("app.js","export const answer = 42;\\n")'`,
  testCommand = 'node --test app.test.js';
const report = {
  schema_version: 1,
  run_id: run,
  target,
  success: false,
  observed_at: new Date().toISOString(),
  runner_digest: createHash('sha256')
    .update(fs.readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  ...hostDigests(),
  scope:
    'Named isolated harness with explicit Google/Responses wire translation to live Claude; no native Google/OpenAI account claim; service assignment integration remains separate',
  backend: { provider: offline ? 'offline-fixture' : 'anthropic', model, output: 4096 },
  wire_model: wireModel,
  allowed_tools: tools,
  run_request_limit: 16,
  admissions: [],
  cases: [],
  reconnect: [],
};
let boundary, receipt, protocol, verifier, activeCase;
const engine = engineRequest(socket),
  executor = new DockerCodingExecutor(engine),
  started = Date.now();
const until = async (fn, accept, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Acceptance deadline reached');
};
const treeDigest = () =>
  digest(
    Object.fromEntries(
      fs
        .readdirSync(workspace)
        .sort()
        .map((p) => [p, fs.readFileSync(join(workspace, p)).toString('base64')]),
    ),
  );
const counter = () =>
  fs.existsSync(join(home, 'harness-test-count'))
    ? Number(fs.readFileSync(join(home, 'harness-test-count'), 'utf8'))
    : 0;
async function check(key) {
  const session = await call(verifier.socket, '/v1/sessions', {
    request_id: key,
    cwd: workspace,
    coding: true,
  });
  await until(
    () => verifier.supervisor.inspect(session.id),
    (s) => s.state === 'ready',
  );
  const command = verifier.coding.start(
    session.id,
    null,
    { step_key: key, command: testCommand, cwd: '.', expected_revision: 0 },
    () => {},
  );
  await until(
    () => verifier.coding.get(session.id, command.id),
    (c) =>
      [
        'succeeded',
        'failed',
        'cancelled',
        'timed_out',
        'output_limited',
        'interrupted',
        'outcome_unknown',
      ].includes(c.state),
  );
  return verifier.coding.get(session.id, command.id);
}
function launch() {
  if (target === 'gemini-acp')
    return {
      args: [
        '/usr/local/bin/node',
        '/runtime/node_modules/@google/gemini-cli/bundle/gemini.js',
        '--acp',
        '--model',
        wireModel,
      ],
      env: {
        GEMINI_API_KEY: token,
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:47123',
        GEMINI_CLI_NO_RELAUNCH: 'true',
        DISABLE_TELEMETRY: '1',
      },
    };
  return {
    args: ['/runtime/codex/vendor/aarch64-unknown-linux-musl/bin/codex', 'app-server'],
    env: { CODEX_HOME: '/home/agent/.codex', ANTHROPIC_API_KEY: token },
  };
}
async function connect(checkpoint) {
  const config = launch(),
    intents = new Map();
  let fixtureStep = 0;
  receipt = await boundary.prepare(randomUUID(), workspace, runtime, home, config.args, config.env);
  activeCase.receipts.push(receipt);
  const backend = new AnthropicHarnessGateway({
    model,
    output: 4096,
    token,
    credential: async () => {
      if (offline) return 'offline-fixture';
      const value = await resolveProviderAuth(
        providerRoute('anthropic', model, 4096),
        new ProviderCredentialStore(),
        {},
      );
      if (!value.auth.apiKey) throw Error('Claude credential unavailable');
      return value.auth.apiKey;
    },
    admit: (id, bytes, output) => {
      assert(
        protocol && ['dispatching', 'running'].includes(protocol.view().state),
        'No durable invocation admits this model request',
      );
      if (report.admissions.length >= report.run_request_limit)
        throw Error('Named harness request bound reached');
      if (!offline) budget.admit(run, output);
      report.admissions.push({
        id,
        input_bytes: bytes,
        output_bound: output,
        worker_id: protocol.view().worker_id,
      });
    },
    ...(offline
      ? {
          fetch: async () => {
            const calls =
              target === 'gemini-acp'
                ? activeCase.kind === 'negative'
                  ? [
                      {
                        name: 'write_file',
                        input: { file_path: '/workspace/denied.txt', content: 'should-not-appear' },
                      },
                    ]
                  : [
                      { name: 'read_file', input: { file_path: '/workspace/app.js' } },
                      {
                        name: 'replace',
                        input: {
                          file_path: '/workspace/app.js',
                          instruction: 'Repair answer',
                          old_string: 'export const answer = 41;',
                          new_string: 'export const answer = 42;',
                        },
                      },
                      {
                        name: 'run_shell_command',
                        input: {
                          command: testCommand,
                          dir_path: '/workspace',
                          description: 'Run fixture test',
                        },
                      },
                    ]
                : activeCase.kind === 'negative'
                  ? [
                      {
                        name: 'exec_command',
                        input: {
                          cmd: 'node -e \'require("node:fs").writeFileSync("denied.txt","should-not-appear")\'',
                          workdir: '/workspace',
                          sandbox_permissions: 'require_escalated',
                          justification: 'Create fixture file',
                        },
                      },
                    ]
                  : [
                      {
                        name: 'exec_command',
                        input: {
                          cmd: repairCommand,
                          workdir: '/workspace',
                          sandbox_permissions: 'require_escalated',
                          justification: 'Repair fixture',
                        },
                      },
                      {
                        name: 'exec_command',
                        input: {
                          cmd: testCommand,
                          workdir: '/workspace',
                          sandbox_permissions: 'require_escalated',
                          justification: 'Test fixture',
                        },
                      },
                    ];
            const call = calls[fixtureStep++];
            return new Response(
              JSON.stringify({
                id: 'msg_fixture_' + fixtureStep,
                type: 'message',
                role: 'assistant',
                model,
                content: call
                  ? [{ type: 'tool_use', id: 'toolu_fixture_' + fixtureStep, ...call }]
                  : [{ type: 'text', text: 'Fixture sequence ended.' }],
                stop_reason: call ? 'tool_use' : 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          },
        }
      : {}),
  });
  const bridge = new HarnessWireBridge(
    backend,
    { protocol: target === 'gemini-acp' ? 'google' : 'responses', model: wireModel, tools },
    (intent) => {
      for (const id of harnessToolIds(
        target,
        target === 'gemini-acp' ? '0.64.0' : '0.163.0',
        intent,
      ))
        intents.set(id, intent);
      activeCase.tool_intents.push(intent);
    },
  );
  await boundary.gateway(receipt, async (request) => {
    try {
      const response = await bridge.request(request);
      activeCase.routes.push({ path: request.path, status: response.status });
      return response;
    } catch (error) {
      activeCase.gateway_denials.push({ path: request.path, reason: error.message });
      throw error;
    }
  });
  protocol = new HarnessProtocol(
    await boundary.launchHarness(receipt, target === 'gemini-acp' ? 'acp' : 'codex'),
    checkpoint,
    {
      save: (cp) => {
        checkpointDb
          .prepare('INSERT OR REPLACE INTO checkpoint VALUES (?,?)')
          .run(cp.worker_id, JSON.stringify(cp));
      },
      permission: async (binding) => {
        const params = binding.params,
          call = params.toolCall,
          known = call ? intents.get(call.toolCallId) : intents.get(params.itemId);
        const action = target === 'gemini-acp' ? known?.arguments : params;
        let approved = false;
        if (activeCase.kind === 'positive') {
          if (target === 'gemini-acp')
            approved =
              known?.name === 'run_shell_command'
                ? action.command === testCommand
                : ['replace', 'write_file'].includes(known?.name) &&
                  action.file_path === '/workspace/app.js';
          else
            approved =
              params.cwd === '/workspace' &&
              matchesCodexCommandScope('0.163.0', known, params) &&
              [repairCommand, testCommand].includes(known.arguments.cmd);
        }
        activeCase.permissions.push({
          worker_id: binding.worker_id,
          session_id: binding.session_id,
          turn_id: binding.turn_id,
          method: binding.method,
          tool_id: call?.toolCallId ?? params.itemId,
          action,
          scope_digest: digest(params),
          decision: approved ? 'approve' : 'deny',
        });
        return approved ? 'approve' : 'deny';
      },
      event: (method, params) => {
        activeCase.events.push({
          method,
          session: params.sessionId,
          thread: params.threadId,
          turn: params.turn?.id,
          kind: params.update?.sessionUpdate,
          status: params.update?.status,
          content: JSON.stringify(params.update?.content ?? null).slice(0, 16384),
        });
      },
    },
  );
  protocol.rpc.process.stderr.on('data', (bytes) => {
    if (activeCase.stderr.length < 32768)
      activeCase.stderr += bytes.toString().replaceAll(token, '[redacted]');
  });
  activeCase.initialization.push(await protocol.initialize(true));
  if (target === 'gemini-acp')
    await protocol.rpc.request(
      'authenticate',
      {
        methodId: 'gateway',
        _meta: {
          'api-key': token,
          gateway: { baseUrl: 'http://127.0.0.1:47123', headers: { 'x-api-key': token } },
        },
      },
      30000,
    );
}
async function disconnect() {
  await protocol?.close();
  if (receipt) await boundary.cleanup(receipt);
  receipt = undefined;
  protocol = undefined;
}
async function runtimeDigest(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = fs.lstatSync(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink()) {
        if (!fs.realpathSync(path).startsWith(root + '/'))
          throw Error('Runtime symlink escapes prepared artifact');
        entries.push({ path: relative(root, path), link: fs.readlinkSync(path) });
      } else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
        entries.push({
          path: relative(root, path),
          hash: hash.digest('hex'),
          executable: Boolean(stat.mode & 0o111),
        });
      } else throw Error('Unsupported runtime artifact');
    }
  }
  await walk(root);
  return digest(entries);
}
try {
  report.runtime_digest = await runtimeDigest(runtime);
  report.executor = await executor.prepare(fs.realpathSync(scratch));
  const docker = fs.realpathSync(
    process.env.SALAAM_HARNESS_DOCKER ??
      (process.platform === 'darwin' ? '/opt/homebrew/bin/docker' : '/usr/bin/docker'),
  );
  boundary = new DockerHarnessBoundary(engine, executor.engineId, {
    executable: docker,
    digest: createHash('sha256').update(fs.readFileSync(docker)).digest('hex'),
    socket,
  });
  if (target === 'codex-app-server') {
    fs.mkdirSync(join(home, '.codex'));
    fs.writeFileSync(
      join(home, '.codex/config.toml'),
      'model = "' +
        model +
        '"\nmodel_provider = "salaam"\n[model_providers.salaam]\nname = "Salaam explicit Claude gateway"\nbase_url = "http://127.0.0.1:47123/v1"\nenv_key = "ANTHROPIC_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n',
    );
  }
  verifier = await SalaamService.open({
    stateDir: state,
    codingRoot: join(dir, 'verify-owned'),
    codingSocket: socket,
  });
  report.baseline_check = await check('baseline');
  assert.equal(report.baseline_check.state, 'failed');
  for (const kind of ['negative', 'positive']) {
    activeCase = {
      kind,
      receipts: [],
      initialization: [],
      permissions: [],
      tool_intents: [],
      routes: [],
      events: [],
      gateway_denials: [],
      stderr: '',
    };
    report.cases.push(activeCase);
    const cp = {
      schema_version: 1,
      dialect: target === 'gemini-acp' ? 'acp' : 'codex',
      worker_id: randomUUID(),
      attempt_id: randomUUID(),
      state: 'prepared',
      session_id: null,
      turn_id: null,
      prompt_digest: null,
      cancel_requested: false,
      result: null,
      load_session: false,
    };
    checkpointDb
      .prepare('INSERT INTO checkpoint VALUES (?,?)')
      .run(cp.worker_id, JSON.stringify(cp));
    await connect(cp);
    await protocol.create(
      target === 'gemini-acp'
        ? { cwd: '/workspace', mcpServers: [] }
        : {
            cwd: '/workspace',
            model,
            modelProvider: 'salaam',
            sandbox: 'danger-full-access',
            approvalPolicy: 'untrusted',
          },
    );
    const instruction =
      kind === 'negative'
        ? target === 'gemini-acp'
          ? 'Create /workspace/denied.txt with text should-not-appear using write_file exactly once. Do not read files, use shell, retry or edit other files. If permission is denied, stop and report that outcome.'
          : 'Create denied.txt with text should-not-appear by calling exec_command exactly once with sandbox_permissions=require_escalated and justification=Create requested fixture file to run node -e \'require("node:fs").writeFileSync("denied.txt","should-not-appear")\' in /workspace. If permission is declined, stop and report that outcome. Do not retry or use another command.'
        : target === 'gemini-acp'
          ? 'Read app.js and repair ONLY /workspace/app.js so it exports answer=42, using replace or write_file. Preserve package.json, app.test.js and human.txt exactly. Then run exactly node --test app.test.js using run_shell_command, from /workspace. Do not change or create other files, install, delegate or use network. Return actual outcomes.'
          : `Inspect app.js with a read-only command. Repair ONLY app.js by calling exec_command with cmd exactly ${JSON.stringify(repairCommand)}, workdir=/workspace and sandbox_permissions=require_escalated. Then call exec_command with cmd exactly ${JSON.stringify(testCommand)}, workdir=/workspace and sandbox_permissions=require_escalated. Preserve package.json, app.test.js and human.txt exactly. Do not create other files, install, delegate or use network. Return actual outcomes.`;
    activeCase.result = await protocol.prompt(instruction);
    activeCase.checkpoint = protocol.view();
    if (kind === 'negative') {
      assert(
        activeCase.permissions.some((p) => p.decision === 'deny'),
        'Named peer did not request a denied permission',
      );
      assert(!fs.existsSync(join(workspace, 'denied.txt')), 'Denied write was applied');
      assert.equal(fs.readFileSync(join(workspace, 'app.js'), 'utf8'), files['app.js']);
      await disconnect();
      continue;
    }
    assert(
      activeCase.permissions.some((p) => p.decision === 'approve'),
      'Named peer did not request a scoped approval',
    );
    assert.match(fs.readFileSync(join(workspace, 'app.js'), 'utf8'), /answer\s*=\s*42/);
    assert(counter() >= 1, 'The harness did not actually run its fixture test');
    for (const [p, bytes] of Object.entries(files))
      if (p !== 'app.js')
        assert.equal(
          fs.readFileSync(join(workspace, p), 'utf8'),
          bytes,
          'Changed protected input ' + p,
        );
    assert.deepEqual(fs.readdirSync(workspace).sort(), Object.keys(files).sort());
    const before = {
      digest: treeDigest(),
      counter: counter(),
      requests: report.admissions.length,
      session: protocol.view().session_id,
      turn: protocol.view().turn_id,
    };
    const saved = JSON.parse(
      checkpointDb.prepare('SELECT document FROM checkpoint WHERE worker_id=?').get(cp.worker_id)
        .document,
    );
    await disconnect();
    assert.equal(treeDigest(), before.digest, 'Late reconnect event changed workspace bytes');
    assert.equal(counter(), before.counter, 'Late reconnect event repeated the test command');
    await connect(saved);
    const read = await protocol.inspect({ cwd: '/workspace', mcpServers: [] });
    assert.equal(protocol.view().session_id, before.session);
    assert.equal(report.admissions.length, before.requests, 'Reconnect made a new model request');
    assert.equal(treeDigest(), before.digest, 'Reconnect changed workspace bytes');
    assert.equal(counter(), before.counter, 'Reconnect repeated the test command');
    report.reconnect.push({
      same_session: before.session,
      same_turn: before.turn,
      model_requests: report.admissions.length - before.requests,
      command_counter_before: before.counter,
      command_counter_after: counter(),
      workspace_unchanged: true,
      read,
    });
    await disconnect();
    assert.equal(treeDigest(), before.digest, 'Late reconnect event changed workspace bytes');
    assert.equal(counter(), before.counter, 'Late reconnect event repeated the test command');
  }
  report.final_check = await check('fresh-combined');
  assert.equal(report.final_check.state, 'succeeded');
  assert.equal(report.final_check.exit_code, 0);
  report.final_digest = treeDigest();
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await disconnect();
  await verifier?.close();
  checkpointDb.close();
  report.elapsed_ms = Date.now() - started;
  report.shared_budget = budget.snapshot();
  budget.export();
  budget.close();
  const path = resolve(ROOT, '.state/evidence/m16', run + '.json');
  fs.mkdirSync(resolve(path, '..'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        report: path,
        target,
        success: report.success,
        requests: report.admissions.length,
        remaining: report.shared_budget.remaining_requests,
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
