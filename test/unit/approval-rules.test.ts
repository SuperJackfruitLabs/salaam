import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { localHash } from '../../src/local-edits.js';
import {
  ApprovalRules,
  commandArgv,
  evaluateRules,
  validateRule,
  type StoredRule,
} from '../../src/approval-rules.js';

// Operator plan 2026-10-31, phase 2a: desk sessions get OpenCode-style allow/ask/deny rules. Commands are
// matched on their parsed words, never on a substring, so `npm test; rm -rf /` can never ride on an
// `npm test` rule: anything the parser cannot read cleanly is asked about.
test('a command is read word by word, and anything a shell would reinterpret is not readable', () => {
  expect(commandArgv('npm test')).toEqual(['npm', 'test']);
  expect(commandArgv("git commit -m 'fix the thing'")).toEqual([
    'git',
    'commit',
    '-m',
    'fix the thing',
  ]);
  expect(commandArgv('echo "plain words"')).toEqual(['echo', 'plain words']);
  for (const unsafe of [
    'npm test; rm -rf /',
    'npm test && rm -rf /',
    'npm test || true',
    'npm test | sh',
    'npm test > out.txt',
    'cat < /etc/passwd',
    'echo $(whoami)',
    'echo `whoami`',
    'echo $HOME',
    'echo "$HOME"',
    'npm test &',
    'ls *.ts',
    'ls ~',
    'FOO=1 npm test',
    "echo 'unterminated",
    'npm test\nrm -rf /',
    'npm\\ test',
    '(npm test)',
    '',
  ])
    expect(commandArgv(unsafe), unsafe).toBeNull();
});
const rule = (r: Partial<StoredRule>): StoredRule =>
  ({
    id: 'r' + Math.random(),
    source: 'session',
    tool: 'command',
    effect: 'allow',
    ...r,
  }) as StoredRule;
test('rules match words; a trailing * takes any further words; deny beats ask beats allow', () => {
  const allowTests = rule({ command: 'npm test *' });
  expect(evaluateRules([allowTests], { tool: 'command', argv: ['npm', 'test'] }).effect).toBe(
    'allow',
  );
  expect(
    evaluateRules([allowTests], { tool: 'command', argv: ['npm', 'test', '--', 'a.ts'] }).effect,
  ).toBe('allow');
  expect(evaluateRules([allowTests], { tool: 'command', argv: ['npm', 'testx'] }).effect).toBe(
    'ask',
  );
  expect(
    evaluateRules([allowTests], { tool: 'command', argv: ['npm', 'run', 'build'] }).effect,
  ).toBe('ask');
  // A word may carry its own *, matching within that word only.
  const word = rule({ command: 'npm test:*' });
  expect(evaluateRules([word], { tool: 'command', argv: ['npm', 'test:unit'] }).effect).toBe(
    'allow',
  );
  expect(evaluateRules([word], { tool: 'command', argv: ['npm', 'test:unit', 'x'] }).effect).toBe(
    'ask',
  );
  // An unreadable command can only be denied, never allowed.
  expect(evaluateRules([rule({ command: '*' })], { tool: 'command', argv: null }).effect).toBe(
    'ask',
  );
  expect(
    evaluateRules([rule({ effect: 'deny', command: undefined })], { tool: 'command', argv: null })
      .effect,
  ).toBe('deny');
  const git = [
    rule({ command: 'git *' }),
    rule({ effect: 'ask', command: 'git push *' }),
    rule({ effect: 'deny', command: 'git push --force *' }),
  ];
  expect(evaluateRules(git, { tool: 'command', argv: ['git', 'status'] }).effect).toBe('allow');
  expect(evaluateRules(git, { tool: 'command', argv: ['git', 'push', 'origin'] }).effect).toBe(
    'ask',
  );
  const forced = evaluateRules(git, {
    tool: 'command',
    argv: ['git', 'push', '--force', 'origin'],
  });
  expect(forced.effect).toBe('deny');
  expect(forced.rule?.command).toBe('git push --force *');
});
test('edit rules match project paths by glob; every edited path must be allowed, any denied path denies', () => {
  const r = [
    rule({ tool: 'edit', paths: ['src/**', 'docs/*.md'] }),
    rule({ tool: 'edit', effect: 'deny', paths: ['src/secrets/**'] }),
  ];
  expect(evaluateRules(r, { tool: 'edit', paths: ['src/a/b.ts', 'docs/x.md'] }).effect).toBe(
    'allow',
  );
  expect(evaluateRules(r, { tool: 'edit', paths: ['docs/deep/x.md'] }).effect).toBe('ask');
  expect(evaluateRules(r, { tool: 'edit', paths: ['src/a.ts', 'README.md'] }).effect).toBe('ask');
  expect(evaluateRules(r, { tool: 'edit', paths: ['src/a.ts', 'src/secrets/k'] }).effect).toBe(
    'deny',
  );
});
test('a rule is validated: plain words only, no shell characters, project-relative globs, no private paths', () => {
  expect(validateRule({ effect: 'allow', tool: 'command', command: 'npm test *' })).toMatchObject({
    command: 'npm test *',
  });
  for (const bad of [
    { effect: 'allow', tool: 'command', command: 'npm test; rm *' },
    { effect: 'allow', tool: 'command', command: 'echo $(x)' },
    { effect: 'maybe', tool: 'command', command: 'ls' },
    { effect: 'allow', tool: 'shell', command: 'ls' },
    { effect: 'allow', tool: 'edit', paths: ['../x'] },
    { effect: 'allow', tool: 'edit', paths: ['/etc/passwd'] },
    { effect: 'allow', tool: 'edit', paths: ['.git/**'] },
    { effect: 'allow', tool: 'edit', paths: [] },
    { effect: 'allow', tool: 'command', command: 'ls', extra: 1 },
  ])
    expect(() => validateRule(bad), JSON.stringify(bad)).toThrow();
});

function setup() {
  const root = realpathSync(mkdtempSync('/tmp/sal-rules-')),
    home = realpathSync(mkdtempSync('/tmp/sal-rules-home-')),
    store = new Store(':memory:');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'before');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const submission = store.accept(session.id, 'submit', store.session(session.id).revision, 'go');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const active = (id: string, e: number, attempt: string) => {
    store.execution.assert(id);
    store.assertEpoch(id, e);
    if (store.cancelled(attempt) || store.attempt(attempt).state !== 'running')
      throw Error('inactive');
  };
  const managed = new ManagedWork(store, {
    assertActive: active,
    reply: () => {},
    failed: () => {},
  });
  const userFile = join(home, 'permissions.json');
  const rules = new ApprovalRules(store, userFile);
  const local = new LocalCoding(store, managed, active);
  local.rules = rules;
  const command = (tool: string, text: string) =>
    local.prepare(session.id, epoch, submission.attempt_id, tool, {
      action: 'command',
      command: text,
    });
  return {
    root,
    home,
    store,
    session,
    managed,
    local,
    rules,
    userFile,
    command,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
test('in a desk session, a matching allow rule approves and is recorded; deny refuses; others still ask', async () => {
  const f = setup();
  try {
    expect(f.command('c1', 'npm test').approval.state).toBe('pending');
    f.rules.add(
      f.session.id,
      'session',
      { effect: 'allow', tool: 'command', command: 'npm test *' },
      'r1',
    );
    f.rules.add(
      f.session.id,
      'session',
      { effect: 'deny', tool: 'command', command: 'rm *' },
      'r2',
    );
    const allowed = f.command('c2', 'npm test -- a.ts');
    expect(allowed.approval).toMatchObject({
      state: 'decided',
      decision: 'approve',
      decided_by: 'rule:session',
    });
    const auto = f.store
      .events(f.session.id, 0)
      .filter((e) => e.kind === 'permission.auto-approved');
    expect(auto).toHaveLength(1);
    expect(auto[0]!.payload).toMatchObject({ rule: { command: 'npm test *', source: 'session' } });
    const denied = f.command('c3', 'rm -rf build');
    expect(denied.approval).toMatchObject({ state: 'decided', decision: 'deny' });
    expect(f.store.events(f.session.id, 0).some((e) => e.kind === 'permission.rule-denied')).toBe(
      true,
    );
    // Chaining never rides on the allow rule.
    expect(f.command('c4', 'npm test; rm -rf /').approval.state).toBe('pending');
  } finally {
    await f.close();
  }
});
test('"for this session" lasts for this session only; "always" is kept for the repo outside the workspace', async () => {
  const f = setup();
  try {
    const first = f.command('c1', 'git status');
    f.rules.addFromOperation(f.session.id, first.call.operation_id, 'session', 's1');
    expect(f.command('c2', 'git status').approval.state).toBe('decided');
    expect(f.command('c3', 'git status --short').approval.state).toBe('pending');
    const other = f.store.create(f.root, 'create-2', false, {
      workspace: true,
      coding: true,
      route: OFFLINE_ROUTE,
    });
    expect(f.rules.list(other.id).filter((r) => r.source === 'session')).toHaveLength(0);
    const third = f.command('c4', 'npm run lint');
    f.rules.addFromOperation(f.session.id, third.call.operation_id, 'repo', 's2');
    // The repo rule applies to other sessions on the same repo, and lives in Salaam's state, not the repo.
    expect(
      f.rules.list(other.id).some((r) => r.source === 'repo' && r.command === 'npm run lint'),
    ).toBe(true);
    expect(() => readFileSync(join(f.root, '.salaam/permissions.json'))).toThrow();
    // A command that cannot be read cleanly cannot become a rule.
    const odd = f.command('c5', 'npm test | tee log');
    expect(() =>
      f.rules.addFromOperation(f.session.id, odd.call.operation_id, 'session', 's3'),
    ).toThrow(/approve it once/);
  } finally {
    await f.close();
  }
});
test('user rules come from the user file; a broken file allows nothing but keeps working', async () => {
  const f = setup();
  try {
    writeFileSync(
      f.userFile,
      JSON.stringify({
        version: 1,
        rules: [{ effect: 'allow', tool: 'command', command: 'ls *' }],
      }),
    );
    expect(f.command('c1', 'ls -la').approval.decided_by).toBe('rule:user');
    writeFileSync(f.userFile, '{not json');
    expect(f.command('c2', 'ls -la').approval.state).toBe('pending');
    expect(f.rules.problems(f.session.id).join(' ')).toMatch(/permissions\.json/);
  } finally {
    await f.close();
  }
});
test('rules never apply to sessions with host-managed authority', async () => {
  const f = setup();
  try {
    expect(f.rules.applies(f.session.id)).toBe(true);
    f.store.db
      .prepare(
        "INSERT INTO agentpod_admissions(id,session_id,hub_session_id,run_key,binding,digest,pins_digest,expires_at) VALUES('adm',?,'hub','run','{}','d','p',0)",
      )
      .run(f.session.id);
    expect(f.rules.applies(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});
