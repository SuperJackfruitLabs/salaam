import fs from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { DockerHarnessBoundary } from '../dist/src/harness/container.js';
import { DockerCodingExecutor } from '../dist/src/coding/executor.js';
import { engineRequest } from '../dist/src/execution/boundary.js';
import { HarnessRpc } from '../dist/src/harness/rpc.js';
import { AnthropicHarnessGateway } from '../dist/src/harness/model-gateway.js';
import { resolveProviderAuth, ProviderCredentialStore } from '../dist/src/providers/auth.js';
import { providerRoute } from '../dist/src/providers/config.js';
import { ROOT } from '../dist/src/core/config.js';
import { hostDigests } from '../dist/src/core/config.js';
import { digest } from '../dist/src/core/protocol.js';
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';
import { SalaamService } from '../dist/src/service/service.js';
import { call } from '../dist/src/core/transport.js';

const MODEL = 'claude-sonnet-4-6';
if (!process.argv.includes('--run'))
  throw Error('Use --run for the authorized live external-harness proof');
const target = process.argv[process.argv.indexOf('--target') + 1];
if (target !== 'claude-acp')
  throw Error('This runner currently admits only the pinned Claude ACP target');
const socket = process.env.SALAAM_TASK_REAL_SOCKET,
  scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
if (!socket || !scratch) throw Error('Select the proven backend and shared scratch');
const runtime = JSON.parse(
  fs.readFileSync(join(ROOT, '.state/m16-runtime-path.json'), 'utf8'),
).root;
const budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json'));
const run = target + '-' + randomUUID(),
  token = randomUUID() + randomUUID(),
  dir = fs.mkdtempSync(join(fs.realpathSync(scratch), 'm16-live-')),
  workspace = join(dir, 'workspace'),
  home = join(dir, 'home');
for (const p of [workspace, home]) fs.mkdirSync(p, { mode: 0o700 });
fs.writeFileSync(join(workspace, 'package.json'), '{"type":"module"}\n');
fs.writeFileSync(join(workspace, 'app.js'), 'export const answer = 41;\n');
fs.writeFileSync(
  join(workspace, 'app.test.js'),
  "import{test}from'node:test';import assert from'node:assert/strict';import{answer}from'./app.js';test('answer',()=>assert.equal(answer,42));\n",
);
fs.writeFileSync(join(workspace, 'human.txt'), 'existing human bytes\n');
const protectedFiles = Object.fromEntries(
  ['package.json', 'app.test.js', 'human.txt'].map((p) => [
    p,
    fs.readFileSync(join(workspace, p), 'utf8'),
  ]),
);
let rpc, boundary, receipt, sessionId;
const report = {
  schema_version: 1,
  runner_digest: createHash('sha256')
    .update(fs.readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  run_id: run,
  target,
  success: false,
  observed_at: new Date().toISOString(),
  ...hostDigests(),
  scope:
    'Real pinned Claude ACP harness, live Claude through a host-only capped gateway, private Linux draft; durable task integration is a separate gate',
  model: MODEL,
  output_tokens: 4096,
  run_requests: 12,
  permissions: [],
  updates: [],
  model_admissions: [],
};
const started = Date.now();
async function runtimeDigest(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = fs.lstatSync(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(path);
        if (!resolved.startsWith(root + '/'))
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
  const engine = engineRequest(socket),
    executor = new DockerCodingExecutor(engine);
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
  receipt = await boundary.prepare(
    run.slice(-36),
    workspace,
    runtime,
    home,
    ['/usr/local/bin/node', '/runtime/node_modules/@zed-industries/claude-agent-acp/dist/index.js'],
    {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47123',
      ANTHROPIC_API_KEY: token,
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  );
  report.receipt = receipt;
  const gateway = new AnthropicHarnessGateway({
    model: MODEL,
    output: 4096,
    token,
    credential: async () => {
      const auth = await resolveProviderAuth(
        providerRoute('anthropic', MODEL, 4096),
        new ProviderCredentialStore(),
        {},
      );
      if (!auth.auth.apiKey) throw Error('Claude API credential unavailable');
      return auth.auth.apiKey;
    },
    admit: (id, bytes, output) => {
      if (report.model_admissions.length >= report.run_requests)
        throw Error('Harness run request limit reached');
      budget.admit(run, output);
      report.model_admissions.push({ id, input_bytes: bytes, output_bound: output });
    },
  });
  await boundary.gateway(receipt, async (request) => {
    try {
      const response = await gateway.request(request);
      report.gateway_routes ??= [];
      report.gateway_routes.push({ path: request.path, status: response.status });
      return response;
    } catch (error) {
      report.gateway_denials ??= [];
      report.gateway_denials.push({ path: request.path, reason: error.message });
      throw error;
    }
  });
  rpc = new HarnessRpc(await boundary.launchHarness(receipt, 'acp'), {
    request: async (method, params) => {
      assert.equal(method, 'session/request_permission', 'Unexpected harness client authority');
      assert.equal(params.sessionId, sessionId, 'Permission belongs to another session');
      const call = params.toolCall,
        raw = call.rawInput ?? {},
        path = raw.file_path ?? raw.path;
      const allowed = path === '/workspace/app.js' || raw.command === 'node --test app.test.js';
      const choice = params.options.find(
        (o) => o.kind === (allowed ? 'allow_once' : 'reject_once'),
      );
      assert(choice, 'Missing exact once-only permission option');
      report.permissions.push({
        session_id: sessionId,
        tool_call_id: call.toolCallId,
        scope_digest: digest(call),
        raw_input: raw,
        decision: allowed ? 'approve' : 'deny',
      });
      return { outcome: { outcome: 'selected', optionId: choice.optionId } };
    },
    notification: (method, params) => {
      if (method === 'session/update') {
        if (sessionId)
          assert.equal(params.sessionId, sessionId, 'Update belongs to another session');
        report.updates.push({
          method,
          session_id: params.sessionId,
          kind: params.update?.sessionUpdate,
          status: params.update?.status,
          tool_call_id: params.update?.toolCallId,
        });
      }
    },
  });
  let stderr = '';
  rpc.process.stderr.on('data', (bytes) => {
    if (stderr.length < 32768) stderr += bytes.toString().replaceAll(token, '[redacted]');
  });
  report.initialize = await rpc.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'salaam', version: '0.0.1' },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { _meta: { gateway: true } },
    },
  });
  assert.equal(report.initialize.agentInfo.version, '0.23.1');
  await rpc.request('authenticate', {
    methodId: 'gateway',
    _meta: { gateway: { baseUrl: 'http://127.0.0.1:47123', headers: { 'x-api-key': token } } },
  });
  const options = {
    model: MODEL,
    settingSources: [],
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    disallowedTools: ['Skill', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'AskUserQuestion'],
    maxTurns: 8,
    maxThinkingTokens: 1024,
    plugins: [],
  };
  const created = await rpc.request(
    'session/new',
    { cwd: '/workspace', mcpServers: [], _meta: { claudeCode: { options } } },
    30000,
  );
  sessionId = created.sessionId;
  assert.equal(typeof sessionId, 'string');
  report.session_id = sessionId;
  try {
    report.prompt_result = await rpc.request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Repair ONLY /workspace/app.js so it exports answer=42. Inspect the actual file first. Preserve package.json, app.test.js and human.txt exactly. Use Edit or Write for the persistent repair, then run exactly node --test app.test.js (no shell prefix) through Bash. Do not run network commands, install anything, delegate, or change other files. Return concise actual outcomes. You have at most eight model turns.',
          },
        ],
      },
      180000,
    );
    assert.equal(report.prompt_result.stopReason, 'end_turn');
    assert.match(fs.readFileSync(join(workspace, 'app.js'), 'utf8'), /answer\s*=\s*42/);
    for (const [p, bytes] of Object.entries(protectedFiles))
      assert.equal(
        fs.readFileSync(join(workspace, p), 'utf8'),
        bytes,
        'Changed protected input ' + p,
      );
    assert(
      report.permissions.some((p) => p.decision === 'approve'),
      'No actual permission was approved',
    );
    assert(
      report.updates.some((u) => u.kind === 'tool_call_update' && u.status === 'completed'),
      'No completed tool receipt',
    );
    report.repaired = true;
    // History loading on this connection is separate from a transport reconnect.
    const before = report.model_admissions.length;
    const loaded = await rpc.request(
      'session/load',
      { sessionId, cwd: '/workspace', mcpServers: [], _meta: { claudeCode: { options } } },
      30000,
    );
    report.history_reload = {
      same_session: sessionId,
      loaded,
      model_requests: report.model_admissions.length - before,
    };
    assert.equal(report.history_reload.model_requests, 0);
    const checkState = fs.mkdtempSync('/tmp/sal-harness-check-');
    let verifier;
    try {
      verifier = await SalaamService.open({
        stateDir: checkState,
        codingRoot: join(dir, 'check-owned'),
        codingSocket: socket,
      });
      const checked = await call(verifier.socket, '/v1/sessions', {
        request_id: 'verification-session',
        cwd: workspace,
        coding: true,
      });
      const end = Date.now() + 30000;
      while (verifier.supervisor.inspect(checked.id).state !== 'ready') {
        if (Date.now() > end || verifier.supervisor.inspect(checked.id).state === 'unhealthy')
          throw Error('Independent verifier not ready');
        await new Promise((r) => setTimeout(r, 50));
      }
      const command = verifier.coding.start(
        checked.id,
        null,
        {
          step_key: 'fresh-after-harness',
          command: 'node --test app.test.js',
          cwd: '.',
          expected_revision: verifier.workspaces.get(checked.id).revision,
        },
        () => {},
      );
      while (
        ![
          'succeeded',
          'failed',
          'cancelled',
          'interrupted',
          'outcome_unknown',
          'timed_out',
          'output_limited',
        ].includes(verifier.coding.get(checked.id, command.id).state)
      ) {
        if (Date.now() > end) throw Error('Independent verification deadline');
        await new Promise((r) => setTimeout(r, 50));
      }
      report.independent_check = verifier.coding.get(checked.id, command.id);
      assert.equal(report.independent_check.state, 'succeeded');
      assert.equal(report.independent_check.exit_code, 0);
    } finally {
      await verifier?.close();
      fs.rmSync(checkState, { recursive: true, force: true });
    }
    report.success = true;
  } finally {
    report.stderr = stderr;
  }
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await rpc?.close();
  if (boundary && receipt) await boundary.cleanup(receipt);
  report.elapsed_ms = Date.now() - started;
  report.shared_budget = budget.snapshot();
  budget.export();
  budget.close();
  const path = resolve(ROOT, '.state/evidence/m16', run + '.json');
  fs.mkdirSync(resolve(path, '..'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        report: path,
        success: report.success,
        requests: report.model_admissions.length,
        shared_remaining: report.shared_budget.remaining_requests,
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
