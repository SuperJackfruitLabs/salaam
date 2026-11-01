import { test, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';

// Phase 4b through the real service: a PreToolUse hook blocks before any approval exists, a hook's
// "allow" never approves, a repository's hooks run only once trusted, and UserPromptSubmit can stop
// a prompt.
const command = (text: string) => '[local] ' + JSON.stringify({ action: 'command', command: text });
const hookRuns = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.service.store
    .events(id, 0, 1000)
    .filter((e) => e.kind === 'hook.run')
    .map((e) => e.payload as Record<string, unknown>);

async function desk(hooks: unknown) {
  const userFile = join(realpathSync(mkdtempSync('/tmp/sal-hooksfile-')), 'hooks.json');
  writeFileSync(userFile, JSON.stringify(hooks));
  const f = await fixture({ hooksFile: userFile });
  const client = new OperatorClient(f.dir);
  const root = join(realpathSync(f.dir), 'project');
  mkdirSync(root);
  const id = await client.create(root, false, undefined, true);
  await ready(f.service, id);
  return { f, client, root, id };
}

test('a blocking PreToolUse hook stops a command before any approval, and the model is told', async () => {
  const { f, client, id } = await desk({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "no pushes" >&2; exit 2' }] },
      ],
    },
  });
  try {
    await client.submit(command('git push'));
    const done = await until(
      () => f.service.store.snapshot(id),
      (s) =>
        s.attempts.length === 1 &&
        ['completed', 'failed', 'interrupted'].includes(s.attempts[0]!.state),
    );
    expect(done.attempts[0]!.state).toBe('completed');
    expect(f.service.store.approvals(id)).toEqual([]);
    expect(hookRuns(f, id)).toMatchObject([{ event: 'PreToolUse', scope: 'user', blocked: true }]);
    // The model reads the hook's reason as the tool's result.
    const finished = f.service.store
      .events(id, 0, 1000)
      .filter((e) => e.kind === 'tool.finished')
      .map((e) => e.payload as { output?: string; failed?: boolean });
    expect(finished).toMatchObject([
      { failed: true, output: expect.stringContaining('Blocked by a PreToolUse hook: no pushes') },
    ]);
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);

test('a hook that answers "allow" does not approve: the request still waits for you', async () => {
  const { f, client, id } = await desk({
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'',
            },
          ],
        },
      ],
    },
  });
  try {
    await client.submit(command('echo hi'));
    const approval = await until(
      () => f.service.store.approvals(id).find((a) => a.state === 'pending'),
      Boolean,
    );
    expect(approval).toBeTruthy();
    expect(hookRuns(f, id)).toMatchObject([{ ignored_decision: 'allow', blocked: false }]);
    await client.decide(approval!, 'deny');
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);

test('a repository hooks file runs only after you trust it, and editing it revokes that', async () => {
  const { f, client, id, root } = await desk({ hooks: {} });
  try {
    mkdirSync(join(root, '.salaam'));
    const file = (marker: string) =>
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] },
      });
    writeFileSync(join(root, '.salaam/hooks.json'), file('ran-1'));
    const turn = async (n: number) => {
      await client.submit('hello ' + n);
      await until(
        () => f.service.store.snapshot(id),
        (s) => s.attempts.length === n && s.attempts.every((a) => a.state === 'completed'),
      );
    };
    await turn(1);
    expect(existsSync(join(root, 'ran-1'))).toBe(false);
    const listed = await client.hooks();
    const repo = listed.sources.find((s) => s.scope === 'repo')!;
    expect(repo.trusted).toBe(false);
    await client.trustHooks(repo.digest!);
    await turn(2);
    expect(existsSync(join(root, 'ran-1'))).toBe(true);
    writeFileSync(join(root, '.salaam/hooks.json'), file('ran-2'));
    await turn(3);
    expect(existsSync(join(root, 'ran-2'))).toBe(false);
    expect((await client.hooks()).sources.find((s) => s.scope === 'repo')!.trusted).toBe(false);
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);

test('a UserPromptSubmit hook can stop a prompt with its reason', async () => {
  const { f, client, id } = await desk({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'echo "not on main" >&2; exit 2' }] },
      ],
    },
  });
  try {
    await client.submit('do something');
    const s = await until(
      () => f.service.store.snapshot(id),
      (x) => x.attempts.length === 1 && x.attempts[0]!.state === 'failed',
    );
    expect(JSON.stringify(s.attempts[0])).toContain(
      'Blocked by a UserPromptSubmit hook: not on main',
    );
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);

test('a session that is not your own desk coding session runs no hooks', async () => {
  const userFile = join(realpathSync(mkdtempSync('/tmp/sal-hooksfile-')), 'hooks.json');
  writeFileSync(
    userFile,
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] },
    }),
  );
  const f = await fixture({ hooksFile: userFile });
  const client = new OperatorClient(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    const id = await client.create(root, false);
    await ready(f.service, id);
    await client.submit('hello');
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts.length === 1 && s.attempts[0]!.state === 'completed',
    );
    expect(hookRuns(f, id)).toEqual([]);
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);
