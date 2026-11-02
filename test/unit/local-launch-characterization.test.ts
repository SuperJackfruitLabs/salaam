import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { Store } from '../../src/store/store.js';
import { ManagedWork } from '../../src/execution/managed.js';
import { LocalCoding, type LocalSandbox } from '../../src/local/coding.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { until } from '../helpers.js';

// Phase 7a (modularity): how a desk session launches each kind of local command (foreground,
// background, hook) under each host sandbox: the exact argv, cwd, environment and stdio it spawns,
// the approval text it shows and the result it records. Pinned before local/coding.ts splits by
// concern: the split must not change one of them.

const launched: { argv: string[]; options: SpawnOptions }[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  return {
    ...real,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      launched.push({ argv: [command, ...args], options });
      // A sandbox this host lacks is not run: a shell that honours the start gate stands in.
      return command === '/bin/sh'
        ? real.spawn(command, args, options)
        : real.spawn(
            '/bin/sh',
            // A background command keeps running until it is stopped, as the real one would.
            [
              '-c',
              'IFS= read -r gate; echo stand-in' +
                (args.join(' ').includes('sleep 5') ? '; sleep 5' : ''),
            ],
            options,
          );
    },
  };
});

// A fixed git identity, so a sandboxed command's GIT_* environment is the same on every host.
const gitHome = mkdtempSync('/tmp/sal-launch-git-');
writeFileSync(
  join(gitHome, 'gitconfig'),
  '[user]\n\tname = Fixture\n\temail = fixture@example.com\n',
);
process.env.GIT_CONFIG_GLOBAL = join(gitHome, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
afterAll(() => rmSync(gitHome, { recursive: true, force: true }));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  launched.length = 0;
});

function setup(sandbox: LocalSandbox) {
  const root = realpathSync(mkdtempSync('/tmp/sal-launch-'));
  const store = new Store(':memory:');
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
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    reply: () => {},
    failed: () => {},
  });
  const local = new LocalCoding(store, managed, () => {}, undefined, sandbox);
  local.interactive = () => true;
  cleanups.push(async () => {
    await local.close();
    await managed.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, session, epoch, attempt: submission.attempt_id, local, managed };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Paths and values that differ between hosts and runs, as placeholders. */
function normal(value: unknown, root: string): unknown {
  const tmp = [...new Set([realpathSync(tmpdir()), tmpdir()])].map(escape).join('|');
  const scratch = new RegExp(`(?:${tmp})/salaam-(cmd|hook)-[A-Za-z0-9]+`, 'g');
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => {
      if (key === 'tool_uid' || key === 'pid') return '<n>';
      if (typeof v !== 'string') return v;
      return v
        .replaceAll(root, '<root>')
        .replace(scratch, '<tmp>/salaam-$1-<x>')
        .replaceAll(homedir(), '<home>')
        .replaceAll(process.execPath, '<node>')
        .replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:<port>')
        .replace(/task_[0-9a-f]{8}/g, 'task_<x>')
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');
    }),
  );
}

const seatbelt: LocalSandbox = {
  kind: 'seatbelt',
  level: 'workspace-write',
  bwrap: null,
  seatbelt: { path: '/nonexistent/sandbox-exec' },
  readPaths: ['/opt/shared'],
};
const bwrap: LocalSandbox = {
  kind: 'bwrap',
  level: 'workspace-write',
  bwrap: { path: '/nonexistent/bwrap', version: 'bubblewrap 0.11.1' },
};
const HOSTS: [string, LocalSandbox][] = [
  ['full access', { kind: 'none', level: 'full-access', bwrap: null }],
  [
    'unsandboxed by operator',
    { kind: 'none', level: 'workspace-write', bwrap: null, allowUnsandboxed: true },
  ],
  ['seatbelt', seatbelt],
  ['seatbelt read-only', { ...seatbelt, level: 'read-only' }],
  ['seatbelt broker without socket', { ...seatbelt, network: { socket: '/nonexistent/stk.sock' } }],
  ['bubblewrap', bwrap],
];
const INPUTS: [string, Record<string, unknown>][] = [
  ['command', { action: 'command', command: 'echo hi', timeout_ms: 5000 }],
  ['outside', { action: 'command', command: 'echo out', outside_sandbox: 'needs the keychain' }],
  ['listen', { action: 'command', command: 'echo serve', listen: true }],
  ['background', { action: 'command', command: 'echo bg; sleep 5', background: true }],
];

test.each(HOSTS)('a %s host launches each kind of command the same way', async (_name, sandbox) => {
  const f = setup(sandbox);
  const record: Record<string, unknown> = {};
  for (const [label, input] of INPUTS) {
    launched.length = 0;
    try {
      const created = f.local.prepare(f.session.id, f.epoch, f.attempt, label, input);
      f.managed.decide(
        created.approval.id,
        'approve-' + label,
        created.approval.revision,
        created.operation.operation_digest,
        'approve',
      );
      f.local.run(created.call.id);
      await until(
        () => f.local.get(created.call.id).state,
        (state) => !['prepared', 'running'].includes(state),
      );
      const tasks = f.local.tasks(f.session.id);
      // Stop a background task only once it has said something, so its kept output is fixed.
      for (const t of tasks) {
        await until(
          () => f.local.taskOutput(f.session.id, t.id).output,
          (output) => output.length > 0,
        );
        f.local.stopTask(f.session.id, t.id);
      }
      await until(
        () => f.local.tasks(f.session.id),
        (all) => all.every((t) => t.state !== 'running'),
      );
      record[label] = {
        approval: created.operation.value,
        args: JSON.parse(f.local.get(created.call.id).args),
        view: f.local.view(created.call.id).result,
        launched: launched.map((l) => ({
          argv: l.argv,
          cwd: l.options.cwd,
          env: l.options.env,
          detached: l.options.detached,
          stdio: l.options.stdio,
        })),
        tasks: f.local
          .tasks(f.session.id)
          .map((t) => ({ ...t, ...f.local.taskOutput(f.session.id, t.id) })),
      };
    } catch (error) {
      record[label] = { error: String(error) };
    }
  }
  launched.length = 0;
  const hook = await f.local.runHook(
    f.session.id,
    'cat; echo "$SALAAM_PROJECT_DIR"',
    '{"a":1}',
    5000,
  );
  record.hook = {
    result: hook,
    launched: launched.map((l) => ({
      argv: l.argv,
      cwd: l.options.cwd,
      env: l.options.env,
      detached: l.options.detached,
      stdio: l.options.stdio,
    })),
  };
  record.status = f.local.commandSandbox(f.session.id);
  expect(normal(record, f.root)).toMatchSnapshot();
});
