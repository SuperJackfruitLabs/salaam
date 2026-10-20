/** Explicit live acceptance, never part of the default/offline test suite. */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { SalaamService } from '../dist/src/service.js';
import { OperatorClient } from '../dist/src/tui-client.js';
import { PiProcess } from '../dist/src/pi.js';
import { ROOT, PI_CLI } from '../dist/src/config.js';
import { providerRoute, DEFAULT_CLAUDE_MODEL } from '../dist/src/provider-config.js';
import { resolveProviderAuth } from '../dist/src/provider-auth.js';
import { digest } from '../dist/src/protocol.js';
if (!process.argv.includes('--run'))
  throw new Error('Use --run to authorize live provider requests on synthetic fixtures');
const route = providerRoute('anthropic', DEFAULT_CLAUDE_MODEL, 4096);
const auth = await resolveProviderAuth(route, undefined, {});
const key = auth.auth.apiKey;
if (typeof key !== 'string') throw new Error('This acceptance requires an Anthropic API key');
const dir = realpathSync(mkdtempSync('/tmp/salaam-pi-parity-'));
const reportDir = join(ROOT, '.state', 'local-coding');
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, new Date().toISOString().replaceAll(':', '-') + '.json');
const files = {
  'calc.mjs':
    'export function sum(values) { return values.reduce((total, value) => total + value, 1); }\n',
  'test.mjs':
    "import { strict as assert } from 'node:assert'; import { sum } from './calc.mjs'; assert.equal(sum([2,3]),5); assert.equal(sum([]),0); console.log('all tests passed');\n",
};
const cases = [
  {
    prompt:
      'Fix the bug in calc.mjs and verify the result. Read both files first. Do not change test.mjs. Run the verification using exactly `node test.mjs`; no other shell command is needed or approved. Make the smallest correct change and report the test outcome.',
    expected: [],
    read: true,
  },
];
const report = {
  schema_version: 1,
  scope:
    'Synthetic bug repair with actual file changes and tests. Same Claude model/provider, low reasoning and 4096 output cap. One sample per harness; not a general coding benchmark.',
  fixture_digest: digest(files),
  cases,
  runtime_digest: digest(
    Object.fromEntries(
      readdirSync(join(ROOT, 'dist/src'))
        .filter((name) => name.endsWith('.js'))
        .sort()
        .map((name) => [name, digest(readFileSync(join(ROOT, 'dist/src', name), 'utf8'))]),
    ),
  ),
  route,
  trials: [],
  success: false,
};
const save = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const until = async (fn, predicate) => {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const v = await fn();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Acceptance timeout');
};
try {
  for (let trial = 0; trial < 1; trial++) {
    for (const mode of ['salaam', 'pi']) {
      const base = join(dir, `${mode}-${trial}`),
        workspace = join(base, 'project'),
        state = join(base, 'state');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(state, { mode: 0o700 });
      const actualFiles = { ...files };
      for (const [path, content] of Object.entries(actualFiles)) {
        mkdirSync(join(workspace, path, '..'), { recursive: true });
        writeFileSync(join(workspace, path), content);
      }
      const result = { mode, trial, requests: 0, cases: [] };
      report.trials.push(result);
      save();
      let service, client, pi;
      try {
        let id;
        if (mode === 'salaam') {
          service = await SalaamService.open({
            stateDir: state,
            providerRoute: route,
            anthropicApiKey: key,
            providerEnvironment: {},
            admitModelRequest: () => {
              if (++result.requests > 12) throw new Error('Acceptance request ceiling');
              save();
            },
          });
          client = new OperatorClient(state);
          id = await client.create(workspace, false, undefined, true);
          await until(
            () => service.supervisor.inspect(id),
            (s) => {
              if (s.state === 'unhealthy') throw new Error(s.error);
              return s.state === 'ready';
            },
          );
        } else {
          const extension = join(base, 'bounds.mjs');
          writeFileSync(
            extension,
            `import {appendFileSync} from 'node:fs';\nexport default function(pi) { let n=0; pi.on('tool_call', e=>{if(e.toolName==='bash' && e.input.command.trim()!=='node test.mjs')return {block:true,reason:'Only node test.mjs is approved for this fixture'};}); pi.on('before_provider_request', e=>{if(++n>12)throw new Error('Acceptance request ceiling');appendFileSync(${JSON.stringify(join(base, 'requests.jsonl'))},JSON.stringify({max_tokens:4096,thinking:e.payload.thinking,output_config:e.payload.output_config})+'\\n');return {...e.payload,max_tokens:4096};});}\n`,
          );
          pi = new PiProcess(
            process.execPath,
            [
              PI_CLI,
              '--mode',
              'rpc',
              '--provider',
              route.provider,
              '--model',
              route.model,
              '--thinking',
              'low',
              '--no-approve',
              '--no-extensions',
              '--extension',
              extension,
              '--no-mcp',
              '--no-skills',
              '--no-prompt-templates',
              '--no-themes',
              '--no-context-files',
              '--tools',
              'read,edit,write,bash',
              '--session-dir',
              state,
            ],
            workspace,
            {
              PATH: process.env.PATH,
              HOME: base,
              PI_CODING_AGENT_DIR: join(base, 'agent'),
              ANTHROPIC_API_KEY: key,
            },
          );
          pi.on('fault', () => {});
          await pi.command('get_state', {}, 15000);
          await pi.command('set_auto_retry', { enabled: false });
          await pi.command('set_auto_compaction', { enabled: false });
        }
        for (const c of cases) {
          if (c.update) {
            actualFiles['notes/decision.md'] = files['notes/decision.md'].replace(
              'CANARY-4826',
              'ORBIT-9137',
            );
            writeFileSync(join(workspace, 'notes/decision.md'), actualFiles['notes/decision.md']);
          }
          const start = Date.now();
          let answer = '',
            tools = [];
          if (mode === 'salaam') {
            const before = service.store.session(id).seq;
            await client.submit(c.prompt);
            const attempt = await until(
              async () => {
                for (const approval of service.store
                  .approvals(id)
                  .filter((a) => a.state === 'pending')) {
                  const row = service.store.db
                    .prepare('SELECT args FROM local_calls WHERE operation_id=?')
                    .get(approval.operation_id);
                  const args = row ? JSON.parse(row.args) : null;
                  const approved =
                    args &&
                    (args.action === 'edit'
                      ? args.edits.every((e) => e.path === 'calc.mjs' && e.after.length < 4096)
                      : args.command.trim() === 'node test.mjs');
                  await client.decide(approval, approved ? 'approve' : 'deny');
                }
                return service.store.snapshot(id).attempts[0];
              },
              (a) => a && !['accepted', 'dispatching', 'running', 'delegated'].includes(a.state),
            );
            assert.equal(attempt.state, 'completed', attempt.error ?? 'attempt did not complete');
            answer = attempt.result ?? '';
            tools = service.store
              .events(id, before)
              .filter((e) => e.kind === 'tool.started')
              .map((e) => e.payload.tool);
          } else {
            const records = [];
            const collect = (r) => records.push(r);
            pi.on('record', collect);
            const settled = pi.waitFor('agent_settled', 180000);
            void settled.catch(() => {});
            await pi.command('prompt', { message: c.prompt }, 180000);
            await settled;
            pi.off('record', collect);
            const messages = records
              .filter((r) => r.type === 'message_end')
              .map((r) => r.message)
              .filter((m) => m?.role === 'assistant');
            const last = messages.at(-1);
            assert(last && last.stopReason !== 'error', last?.errorMessage ?? 'Missing Pi answer');
            answer = (last.content ?? [])
              .filter((x) => x.type === 'text')
              .map((x) => x.text)
              .join('\n');
            tools = records.filter((r) => r.type === 'tool_execution_start').map((r) => r.toolName);
            result.requests = readFileSync(join(base, 'requests.jsonl'), 'utf8')
              .trim()
              .split('\n').length;
          }
          const checks = c.expected.map((text) => ({
            text,
            pass: answer.toLowerCase().includes(text.toLowerCase()),
          }));
          assert.equal(readFileSync(join(workspace, 'test.mjs'), 'utf8'), files['test.mjs']);
          const verification = execFileSync(process.execPath, ['test.mjs'], {
            cwd: workspace,
            timeout: 5000,
            encoding: 'utf8',
          });
          const success =
            verification.includes('all tests passed') &&
            readFileSync(join(workspace, 'calc.mjs'), 'utf8') !== files['calc.mjs'];
          checks.push({
            text: 'actual unchanged test suite passes against modified source',
            pass: success,
          });
          result.cases.push({
            prompt: c.prompt,
            answer,
            tools,
            checks,
            success,
            elapsed_ms: Date.now() - start,
          });
          save();
          assert(success, `${mode} trial ${trial}: task acceptance failed; inspect ${reportPath}`);
        }
        assert.equal(readFileSync(join(workspace, 'test.mjs'), 'utf8'), files['test.mjs']);
      } finally {
        await client?.leave();
        await service?.close();
        await pi?.stop();
      }
    }
  }
  report.success = true;
} finally {
  save();
  rmSync(dir, { recursive: true, force: true });
  console.log(reportPath);
}
