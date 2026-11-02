import { test, expect, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { TurnCheckpoints } from '../../src/runtime/turn-rewind.js';

function setup(coding = true, restorable = true) {
  const root = realpathSync(mkdtempSync('/tmp/sal-rewind-')),
    state = realpathSync(mkdtempSync('/tmp/sal-rewind-state-')),
    store = new Store(':memory:');
  writeFileSync(join(root, 'a.txt'), 'start\n');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding,
    route: OFFLINE_ROUTE,
  });
  const lease = store.control(session.id, 'lease', 'operator', 'acquire', 0),
    actor = { client_id: 'operator', token: lease.token };
  const checkpoints = new TurnCheckpoints(store, state, restorable);
  let n = 0;
  /** One turn: checkpoint before it, then the turn's file effect. */
  const turn = (text: string, effect: () => void, leaf: string | null = null) => {
    const submission = store.accept(
      session.id,
      'submit-' + ++n,
      store.session(session.id).revision,
      text,
    );
    store.db.prepare('UPDATE sessions SET pi_leaf=? WHERE id=?').run(leaf, session.id);
    checkpoints.capture(session.id, submission.attempt_id);
    effect();
    store.db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(submission.attempt_id);
    return submission.attempt_id;
  };
  return { root, store, session, actor, checkpoints, turn };
}

test('every turn records a checkpoint of the folder before it ran, with its instruction and leaf', () => {
  const f = setup();
  const one = f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  f.turn('second', () => writeFileSync(join(f.root, 'b.txt'), 'two\n'), 'leaf-1');
  const list = f.checkpoints.list(f.session.id);
  expect(list.map((c) => [c.turn, c.text, c.leaf])).toEqual([
    [1, 'first', null],
    [2, 'second', 'leaf-1'],
  ]);
  expect(list[0]!.attempt_id).toBe(one);
  expect(list[0]!.tree).not.toBe(list[1]!.tree);
});

test('a session that is not local coding gets no checkpoints', () => {
  const f = setup(false);
  const s = f.store.accept(f.session.id, 'x', f.store.session(f.session.id).revision, 'hi');
  f.checkpoints.capture(f.session.id, s.attempt_id);
  expect(f.store.events(f.session.id, 0).some((e) => e.kind.startsWith('checkpoint.'))).toBe(false);
});

test('a checkpoint that cannot be taken is recorded and never stops the turn', () => {
  const f = setup();
  rmSync(f.root, { recursive: true });
  const s = f.store.accept(f.session.id, 'x', f.store.session(f.session.id).revision, 'hi');
  expect(() => f.checkpoints.capture(f.session.id, s.attempt_id)).not.toThrow();
  expect(f.store.events(f.session.id, 0).map((e) => e.kind)).toContain('checkpoint.skipped');
  expect(f.checkpoints.list(f.session.id)).toEqual([]);
});

test('rewinding files restores the folder to before the chosen turn and keeps the conversation', () => {
  const f = setup();
  f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const second = f.turn('second', () => {
    writeFileSync(join(f.root, 'a.txt'), 'two\n');
    writeFileSync(join(f.root, 'new.txt'), 'made\n');
  });
  const review = f.checkpoints.reviewRewind(f.session.id, second, 'files');
  expect(review.turn).toBe(2);
  expect(review.changes).toEqual([
    { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
    { path: 'new.txt', status: 'deleted', added: 0, removed: 1 },
  ]);
  const fork = vi.fn();
  const result = f.checkpoints.rewind(
    f.session.id,
    'rw',
    second,
    'files',
    review.digest,
    f.actor,
    () => {},
    fork,
  );
  expect(result).toEqual({ state: 'completed', session_id: f.session.id, text: 'second' });
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('one\n');
  expect(existsSync(join(f.root, 'new.txt'))).toBe(false);
  expect(fork).not.toHaveBeenCalled();
  // The same request is answered from the record and not repeated.
  writeFileSync(join(f.root, 'a.txt'), 'later\n');
  expect(
    f.checkpoints.rewind(
      f.session.id,
      'rw',
      second,
      'files',
      review.digest,
      f.actor,
      () => {},
      fork,
    ),
  ).toEqual(result);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('later\n');
});

test('rewinding the conversation forks from the leaf before the turn and leaves files alone', () => {
  const f = setup();
  f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const second = f.turn('second', () => writeFileSync(join(f.root, 'a.txt'), 'two\n'), 'leaf-1');
  const review = f.checkpoints.reviewRewind(f.session.id, second, 'conversation');
  expect(review.changes).toEqual([]);
  const fork = vi.fn(() => ({ id: 'forked' }) as never);
  const result = f.checkpoints.rewind(
    f.session.id,
    'rw',
    second,
    'conversation',
    review.digest,
    f.actor,
    () => {},
    fork,
  );
  expect(fork).toHaveBeenCalledWith('leaf-1', 'Rewound to before turn 2');
  expect(result.session_id).toBe('forked');
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('two\n');
});

test('both restores the files and forks the conversation', () => {
  const f = setup();
  const first = f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const review = f.checkpoints.reviewRewind(f.session.id, first, 'both');
  const fork = vi.fn(() => ({ id: 'forked' }) as never);
  f.checkpoints.rewind(f.session.id, 'rw', first, 'both', review.digest, f.actor, () => {}, fork);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('start\n');
  expect(fork).toHaveBeenCalledWith(null, 'Rewound to before turn 1');
});

test('a rewind is refused when the folder changed after review, and nothing is written', () => {
  const f = setup();
  const first = f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const review = f.checkpoints.reviewRewind(f.session.id, first, 'files');
  writeFileSync(join(f.root, 'a.txt'), 'edited by hand\n');
  expect(() =>
    f.checkpoints.rewind(
      f.session.id,
      'rw',
      first,
      'files',
      review.digest,
      f.actor,
      () => {},
      vi.fn(),
    ),
  ).toThrow(/changed since you reviewed/);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('edited by hand\n');
  // A review for one mode does not authorise another.
  const files = f.checkpoints.reviewRewind(f.session.id, first, 'files');
  expect(() =>
    f.checkpoints.rewind(
      f.session.id,
      'rw2',
      first,
      'both',
      files.digest,
      f.actor,
      () => {},
      vi.fn(),
    ),
  ).toThrow(/changed since you reviewed/);
});

test('a rewind needs the controller lease and an idle session', () => {
  const f = setup();
  const first = f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const review = f.checkpoints.reviewRewind(f.session.id, first, 'files');
  expect(() =>
    f.checkpoints.rewind(
      f.session.id,
      'rw',
      first,
      'files',
      review.digest,
      { client_id: 'operator', token: 'wrong' },
      () => {},
      vi.fn(),
    ),
  ).toThrow(/controller lease/);
  expect(() =>
    f.checkpoints.rewind(
      f.session.id,
      'rw2',
      first,
      'files',
      review.digest,
      f.actor,
      () => {
        throw new Error('busy');
      },
      vi.fn(),
    ),
  ).toThrow(/busy/);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('one\n');
});

test('files written as another user can only rewind the conversation', () => {
  const f = setup(true, false);
  const first = f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const review = f.checkpoints.reviewRewind(f.session.id, first, 'files');
  expect(() =>
    f.checkpoints.rewind(
      f.session.id,
      'rw',
      first,
      'files',
      review.digest,
      f.actor,
      () => {},
      vi.fn(),
    ),
  ).toThrow(/conversation only/);
});

test('the review base starts at the first checkpoint and moves only when a change is accepted', () => {
  const f = setup();
  expect(f.checkpoints.review(f.session.id)).toBeNull();
  f.turn('first', () => {
    writeFileSync(join(f.root, 'a.txt'), 'one\n');
    writeFileSync(join(f.root, 'b.txt'), 'b\n');
  });
  let review = f.checkpoints.review(f.session.id)!;
  expect(review.files.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
  review = f.checkpoints.act(
    f.session.id,
    { action: 'accept', path: 'b.txt', base: review.base, current: review.current },
    f.actor,
    () => {},
  )!;
  expect(review.files.map((c) => c.path)).toEqual(['a.txt']);
  expect(readFileSync(join(f.root, 'b.txt'), 'utf8')).toBe('b\n');
  // A later turn does not reset what was accepted.
  f.turn('second', () => writeFileSync(join(f.root, 'c.txt'), 'c\n'));
  expect(f.checkpoints.review(f.session.id)!.files.map((c) => c.path)).toEqual(['a.txt', 'c.txt']);
});

test('reverting a reviewed file writes the base back; a stale base or folder is refused', () => {
  const f = setup();
  f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const review = f.checkpoints.review(f.session.id)!;
  expect(() =>
    f.checkpoints.act(
      f.session.id,
      { action: 'revert', path: 'a.txt', base: 'f'.repeat(40), current: review.current },
      f.actor,
      () => {},
    ),
  ).toThrow(/review moved on/);
  writeFileSync(join(f.root, 'a.txt'), 'hand edit\n');
  expect(() =>
    f.checkpoints.act(
      f.session.id,
      { action: 'revert', path: 'a.txt', base: review.base, current: review.current },
      f.actor,
      () => {},
    ),
  ).toThrow(/changed since you reviewed/);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('hand edit\n');
  const fresh = f.checkpoints.review(f.session.id)!;
  expect(() =>
    f.checkpoints.act(
      f.session.id,
      { action: 'revert', path: 'a.txt', base: fresh.base, current: fresh.current },
      { client_id: 'x', token: 'y' },
      () => {},
    ),
  ).toThrow(/controller lease/);
  const after = f.checkpoints.act(
    f.session.id,
    { action: 'revert', path: 'a.txt', base: fresh.base, current: fresh.current },
    f.actor,
    () => {},
  )!;
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('start\n');
  expect(after.files).toEqual([]);
});

test('reverting waits for an idle session; accepting does not touch files so it does not', () => {
  const f = setup();
  f.turn('first', () => writeFileSync(join(f.root, 'a.txt'), 'one\n'));
  const r = f.checkpoints.review(f.session.id)!;
  const busy = () => {
    throw new Error('busy');
  };
  expect(() =>
    f.checkpoints.act(
      f.session.id,
      { action: 'revert', path: 'a.txt', base: r.base, current: r.current },
      f.actor,
      busy,
    ),
  ).toThrow(/busy/);
  expect(
    f.checkpoints.act(
      f.session.id,
      { action: 'accept', path: 'a.txt', base: r.base, current: r.current },
      f.actor,
      busy,
    )!.files,
  ).toEqual([]);
});

test('a rewind fork starts its conversation at the earlier leaf until its worker reports', () => {
  const f = setup();
  f.store.db
    .prepare("UPDATE sessions SET pi_session_file='source.jsonl', pi_leaf='latest' WHERE id=?")
    .run(f.session.id);
  const revision = f.store.session(f.session.id).revision;
  const fork = f.store.forkLocal(f.session.id, 'fork-at', revision, f.actor, () => 'fork.jsonl', {
    leaf: 'earlier',
  });
  expect(fork.pi_leaf).toBe('earlier');
  const forked = f.store.events(fork.id, 0).find((e) => e.kind === 'session.forked')!;
  expect(forked.payload).toMatchObject({ leaf: 'earlier', rewound: true });
  const plain = f.store.forkLocal(f.session.id, 'fork-plain', revision, f.actor, () => 'p.jsonl');
  expect(plain.pi_leaf).toBe('latest');
});
