import { test, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';

/** One local edit turn through the real service, approved. */
async function edit(
  f: Awaited<ReturnType<typeof fixture>>,
  client: OperatorClient,
  id: string,
  n: number,
  edits: unknown[],
) {
  await client.submit('[local] ' + JSON.stringify({ action: 'edit', edits }));
  const approval = await until(
    () => f.service.store.approvals(id).find((a) => a.state === 'pending'),
    Boolean,
  );
  await client.decide(approval!, 'approve');
  await until(
    () => f.service.store.snapshot(id),
    (s) => s.attempts.length === n && s.attempts.every((a) => a.state === 'completed'),
  );
}

test('rewind restores files to before any turn and forks the conversation from there', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'kept.txt'), 'original\n');
    const id = await client.create(root, false, undefined, true);
    await ready(f.service, id);
    await edit(f, client, id, 1, [{ path: 'one.txt', sha256: null, content: 'turn one\n' }]);
    await edit(f, client, id, 2, [{ path: 'two.txt', sha256: null, content: 'turn two\n' }]);
    const points = await client.checkpoints();
    expect(points.map((p) => p.turn)).toEqual([1, 2]);
    // Only the turn's file shows: the journal and checkpoints in the state folder never do.
    const review = await client.rewindReview(points[1]!.attempt_id, 'both');
    expect(review.changes).toEqual([{ path: 'two.txt', status: 'deleted', added: 0, removed: 1 }]);
    const text = await client.rewind(review);
    expect(text).toContain('two.txt');
    expect(existsSync(join(root, 'two.txt'))).toBe(false);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('turn one\n');
    expect(readFileSync(join(root, 'kept.txt'), 'utf8')).toBe('original\n');
    const forked = client.snapshot!.id;
    expect(forked).not.toBe(id);
    await ready(f.service, forked);
    const said = f.service.store
      .snapshot(forked)
      .messages.map((m) => m.text)
      .join('\n');
    expect(said).toContain('one.txt');
    expect(said).not.toContain('two.txt');
    // The source conversation is unchanged.
    expect(f.service.store.snapshot(id).attempts).toHaveLength(2);
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);

test('the change review reverts a file and accepts another through the service', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    const id = await client.create(root, false, undefined, true);
    await ready(f.service, id);
    await edit(f, client, id, 1, [
      { path: 'a.txt', sha256: null, content: 'a\n' },
      { path: 'b.txt', sha256: null, content: 'b\n' },
    ]);
    let review = (await client.changeReview())!;
    expect(review.files.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    const hunks = await client.changeHunks(review, 'a.txt');
    expect(hunks[0]!.text).toContain('+a');
    review = (await client.changeAct(review, 'revert', 'a.txt'))!;
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    review = (await client.changeAct(review, 'accept', 'b.txt'))!;
    expect(review.files).toEqual([]);
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b\n');
    // A review from before a hand edit is refused and writes nothing.
    writeFileSync(join(root, 'b.txt'), 'hand\n');
    await expect(client.changeAct(review, 'revert', 'b.txt')).rejects.toThrow(
      /changed since you reviewed/,
    );
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('hand\n');
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);
