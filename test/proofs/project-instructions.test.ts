import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, sandboxFallback, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { ROOT } from '../../src/config.js';

async function turn(f: Awaited<ReturnType<typeof fixture>>, client: OperatorClient, text: string) {
  const request = await client.submit(text);
  const attempt = JSON.parse(
    String(
      f.service.store.db
        .prepare('SELECT response FROM requests WHERE actor=? AND id=?')
        .get('local-operator', request)!.response,
    ),
  ).attempt_id as string;
  const work = await until(
    () => f.service.store.attempt(attempt),
    (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
  );
  expect(work.state, work.error ?? '').toBe('completed');
}

test('an interactive session sends AGENTS.md to the model without review, and an edit reloads on the next turn', async () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-instr-proof-'));
  const user = join(root, 'user-AGENTS.md');
  writeFileSync(user, 'USER prefers short answers.\n');
  const f = await fixture({
    extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs'),
    userInstructions: user,
    ...sandboxFallback,
  });
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), 'Use the GREEN protocol.\n');
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(repo, false, undefined, true);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    await turn(f, client, 'Hello');
    expect(f.service.supervisor.inspect(id).project_instructions).toMatchObject({
      revision: 1,
      files: [
        { scope: 'user', path: user },
        { scope: 'project', path: 'AGENTS.md' },
      ],
    });
    writeFileSync(join(repo, 'AGENTS.md'), 'Use the BLUE protocol.\n');
    await turn(f, client, 'Again');
    const payloads = readFileSync(join(repo, 'task-payloads.jsonl'), 'utf8').trim().split('\n');
    expect(payloads[0]).toContain('SALAAM_PROJECT_INSTRUCTIONS_V1');
    expect(payloads[0]).toContain('GREEN');
    expect(payloads[0]).toContain('USER prefers short answers');
    expect(payloads.at(-1)).toContain('BLUE');
    expect(payloads.at(-1)).not.toContain('GREEN');
    expect(
      f.service.store
        .events(id, 0)
        .filter((e) => e.kind === 'instructions.loaded')
        .map((e) => (e.payload as { reason: string; revision: number }).reason),
    ).toEqual(['initial', 'changed']);
    // No review gate was involved: the reviewed-context admission stays empty.
    expect(f.service.tasks.admitted!.inspect(id).state).toBe('empty');
  } finally {
    await client.leave().catch(() => {});
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
