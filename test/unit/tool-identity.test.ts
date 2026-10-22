import { test, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  chownSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import { localHash } from '../../src/local-edits.js';
import { localDiff } from '../../src/local-diff.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { probeToolsUser, serviceToolIdentity, type ToolIdentity } from '../../src/tool-identity.js';
import { fixture, fake, until } from '../helpers.js';
import { call } from '../../src/transport.js';

const linux = process.platform === 'linux';

/** A launcher that records each invocation, answers the probe as uid 4242, then runs the argv. */
function fakeLauncher() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-fake-tools-'));
  const log = join(dir, 'log');
  const launcher = join(dir, 'launch');
  writeFileSync(
    launcher,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  /usr/bin/id) echo 4242; exit 0 ;;
  /usr/bin/test) exit 1 ;;
esac
export SALAAM_FAKE_TOOLS=via-launcher
exec "$@"
`,
  );
  chmodSync(launcher, 0o755);
  return { dir, log, launcher };
}

function setup(tools?: ToolIdentity, root = realpathSync(mkdtempSync('/tmp/sal-tools-'))) {
  const store = new Store(':memory:');
  if (tools) store.toolExecution = { mode: tools.mode, user: tools.user, uid: tools.uid };
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const submission = store.accept(session.id, 'submit', session.revision, 'code');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const active = () => {};
  const managed = new ManagedWork(store, {
    assertActive: active,
    reply: () => {},
    failed: () => {},
  });
  const local = new LocalCoding(store, managed, active, tools);
  const run = async (id: string, args: Record<string, unknown>) => {
    const c = local.prepare(session.id, epoch, submission.attempt_id, id, args);
    managed.decide(
      c.approval.id,
      'approve-' + c.call.id,
      c.approval.revision,
      c.operation.operation_digest,
      'approve',
    );
    local.run(c.call.id);
    return until(
      () => local.view(c.call.id),
      (v) => !['prepared', 'running'].includes(v.call.state),
    );
  };
  return {
    root,
    store,
    session,
    run,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('unset tools user keeps single-user execution and warns that tools share the credential user', async () => {
  const identity = serviceToolIdentity();
  expect(identity.mode).toBe('service-user');
  expect(identity.warning).toMatch(/same OS user that holds the provider credential/);
  const f = await fixture(fake());
  try {
    const health = await call<{ tool_execution: { mode: string; warning: string } }>(
      f.service.socket,
      '/v1/health',
    );
    expect(health.tool_execution.mode).toBe('service-user');
    expect(health.tool_execution.warning).toMatch(/--tools-user/);
  } finally {
    await f.close();
  }
});

test.skipIf(!linux)(
  'a configured tools user is probed, reported in health and fails closed',
  async () => {
    const fl = fakeLauncher();
    try {
      const f = await fixture({ ...fake(), toolsUser: 'tools', toolsLauncher: [fl.launcher] });
      try {
        const health = await call<{ tool_execution: Record<string, unknown> }>(
          f.service.socket,
          '/v1/health',
        );
        expect(health.tool_execution).toMatchObject({
          mode: 'tools-user',
          user: 'tools',
          uid: 4242,
          warning: null,
        });
        expect(readFileSync(fl.log, 'utf8')).toMatch(/\/usr\/bin\/test -r /);
      } finally {
        await f.close();
      }
      // A launcher that cannot switch user (sudo -n failing) must refuse startup.
      expect(() => probeToolsUser('tools', fl.dir, ['/bin/false'])).toThrow(
        /Cannot run as tools user/,
      );
      expect(() => probeToolsUser('Bad User', fl.dir, [fl.launcher])).toThrow(/plain Unix user/);
    } finally {
      rmSync(fl.dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!linux)(
  'local commands and edits run through the tools launcher and record its uid',
  async () => {
    const fl = fakeLauncher();
    const tools: ToolIdentity = {
      mode: 'tools-user',
      user: 'tools',
      uid: 4242,
      prefix: [fl.launcher],
      warning: null,
    };
    const f = setup(tools);
    try {
      const created = f.store
        .events(f.session.id, 0)
        .find((e: { kind: string }) => e.kind === 'session.created') as { payload: unknown };
      expect(JSON.stringify(created.payload)).toContain('"tool_execution":{"mode":"tools-user"');
      const cmd = await f.run('cmd', { action: 'command', command: 'printf "$SALAAM_FAKE_TOOLS"' });
      expect(cmd.call.state).toBe('succeeded');
      expect(cmd.result).toMatchObject({
        output: 'via-launcher',
        isolation: 'tools-user-no-os-sandbox',
        tool_uid: 4242,
      });
      expect(readFileSync(fl.log, 'utf8')).toMatch(/\/usr\/bin\/setsid -w \/bin\/sh -c/);
      const edit = await f.run('edit', {
        action: 'edit',
        edits: [{ path: 'new.txt', sha256: null, content: 'hello' }],
      });
      expect(edit.call.state).toBe('succeeded');
      expect(edit.result).toMatchObject({ applied: ['new.txt'], tool_uid: 4242 });
      expect(readFileSync(join(f.root, 'new.txt'), 'utf8')).toBe('hello');
      expect(readFileSync(fl.log, 'utf8')).toMatch(/local-edit-helper\.js /);
      // A timeout kills the tool's own process group through the launcher.
      const slow = await f.run('slow', { action: 'command', command: 'sleep 30', timeout_ms: 200 });
      expect(slow.call.state).toBe('timed_out');
      expect(readFileSync(fl.log, 'utf8')).toMatch(/\/bin\/kill -KILL -- -\d+/);
    } finally {
      await f.close();
      rmSync(fl.dir, { recursive: true, force: true });
    }
  },
);

// Real uid switching: needs Linux, a tools user and `<service> ALL=(<tools>) NOPASSWD: ALL`.
// CI's tool-user job and the staging host set SALAAM_TEST_TOOLS_USER (+ _GROUP for the shared workspace group).
const realUser = process.env.SALAAM_TEST_TOOLS_USER;
const realGroup = process.env.SALAAM_TEST_TOOLS_GROUP;
test.skipIf(!linux || !realUser || !realGroup)(
  'real tools user: runs as its uid, cannot read service-only files, writes shared workspace files Salaam can diff',
  async () => {
    const state = realpathSync(mkdtempSync('/tmp/sal-tools-state-'));
    chmodSync(state, 0o700);
    const tools = probeToolsUser(realUser!, state);
    const gid = Number(
      execFileSync('getent', ['group', realGroup!], { encoding: 'utf8' }).split(':')[2],
    );
    const root = realpathSync(mkdtempSync('/tmp/sal-tools-work-'));
    chownSync(root, process.getuid!(), gid);
    chmodSync(root, 0o2770);
    const secret = join(state, 'kimi.env');
    writeFileSync(secret, 'KIMI_API_KEY=not-a-real-key\n', { mode: 0o600 });
    const outside = realpathSync(mkdtempSync('/tmp/sal-tools-secret-'));
    const private600 = join(outside, 'secret');
    writeFileSync(private600, 'private', { mode: 0o600 });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const f = setup(tools, root);
    try {
      const who = await f.run('who', { action: 'command', command: 'id -un; id -u' });
      expect(who.result).toMatchObject({ output: `${realUser}\n${tools.uid}\n` });
      const denied = await f.run('cat', { action: 'command', command: `cat ${private600}` });
      expect(denied.call.state).toBe('failed');
      expect(String(denied.result?.output)).toMatch(/Permission denied/);
      const environ = await f.run('environ', {
        action: 'command',
        command: `cat /proc/${process.pid}/environ`,
      });
      expect(environ.call.state).toBe('failed');
      expect(String(environ.result?.output)).toMatch(/Permission denied/);
      const wrote = await f.run('write', { action: 'command', command: 'printf made > made.txt' });
      expect(wrote.call.state).toBe('succeeded');
      expect(statSync(join(root, 'made.txt')).uid).toBe(tools.uid);
      expect(readFileSync(join(root, 'made.txt'), 'utf8')).toBe('made');
      const edit = await f.run('edit', {
        action: 'edit',
        edits: [{ path: 'reviewed.txt', sha256: null, content: 'reviewed' }],
      });
      expect(edit.call.state).toBe('succeeded');
      expect(statSync(join(root, 'reviewed.txt')).uid).toBe(tools.uid);
      const replaced = await f.run('replace', {
        action: 'edit',
        edits: [{ path: 'reviewed.txt', sha256: localHash('reviewed'), content: 'again' }],
      });
      expect(replaced.call.state).toBe('succeeded');
      expect(readFileSync(join(root, 'reviewed.txt'), 'utf8')).toBe('again');
      expect(await localDiff(root)).toMatch(/Untracked paths[^]*made\.txt[^]*reviewed\.txt/);
      const slow = await f.run('slow', { action: 'command', command: 'sleep 30', timeout_ms: 300 });
      expect(slow.call.state).toBe('timed_out');
      expect(spawnSync('pgrep', ['-u', realUser!, '-f', 'sleep 30']).status).toBe(1);
    } finally {
      await f.close();
      rmSync(state, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
  },
);
