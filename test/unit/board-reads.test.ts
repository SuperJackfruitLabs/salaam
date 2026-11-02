import { test, expect } from 'vitest';
import { Store } from '../../src/store/store.js';
import { BoardReads } from '../../src/runtime/board-reads.js';

// Operator ruling 2026-10-28 (option iii): the agent reads its own card, run and the library while
// it works, served by the hub. Salaam only records the read and hands back what the hub answered;
// it holds no SuperPipeline or SuperLibrary credential and names no card or board.
const fixture = () => {
  const store = new Store(':memory:');
  const session = store.create('/tmp', 'create').id;
  return { store, reads: new BoardReads(store), session };
};

test('a read waits as pending until the hub answers it, then returns exactly that answer', () => {
  const f = fixture();
  const r = f.reads.request(f.session, 'call-1', {
    action: 'library_search',
    query: 'gateway timeout',
  });
  expect(r).toMatchObject({ state: 'pending', action: 'library_search' });
  expect(f.reads.pending(f.session)).toEqual([
    { id: r.id, action: 'library_search', args: { query: 'gateway timeout' } },
  ]);
  f.reads.answer(f.session, { read_id: r.id, ok: true, text: 'two items' });
  expect(f.reads.get(f.session, r.id)).toMatchObject({
    state: 'answered',
    ok: true,
    text: 'two items',
  });
  expect(f.reads.pending(f.session)).toEqual([]);
  // A second answer to the same read changes nothing.
  expect(() => f.reads.answer(f.session, { read_id: r.id, ok: true, text: 'other' })).toThrow();
});

test('the same tool call is one read (a retried call does not ask the hub twice)', () => {
  const f = fixture();
  const a = f.reads.request(f.session, 'call-1', { action: 'card' });
  const b = f.reads.request(f.session, 'call-1', { action: 'card' });
  expect(b.id).toBe(a.id);
  expect(f.reads.pending(f.session)).toHaveLength(1);
});

test('only the four read actions, with closed arguments; no card, board or credential can be named', () => {
  const f = fixture();
  for (const bad of [
    { action: 'write' },
    { action: 'card', card_id: 'card_other' },
    { action: 'attempts', board: 'brd_other' },
    { action: 'library_search' },
    { action: 'library_search', query: 'x'.repeat(501) },
    { action: 'library_get', item_id: 'not-an-item' },
    { action: 'library_get', item_id: 'itm_0123456789abcdef', token: 'secret' },
  ])
    expect(
      () => f.reads.request(f.session, 'call-' + JSON.stringify(bad), bad),
      JSON.stringify(bad),
    ).toThrow();
  expect(
    f.reads.request(f.session, 'ok', { action: 'library_get', item_id: 'itm_0123456789abcdef' })
      .state,
  ).toBe('pending');
});

test('a refusal from the hub comes back as an error in plain words, and the answer is bounded', () => {
  const f = fixture();
  const r = f.reads.request(f.session, 'call-1', { action: 'attempts' });
  f.reads.answer(f.session, {
    read_id: r.id,
    ok: false,
    error: 'That card is not this run’s card.',
  });
  expect(f.reads.get(f.session, r.id)).toMatchObject({
    state: 'answered',
    ok: false,
    error: 'That card is not this run’s card.',
  });
  const s = f.reads.request(f.session, 'call-2', { action: 'card' });
  expect(() =>
    f.reads.answer(f.session, { read_id: s.id, ok: true, text: 'x'.repeat(256 * 1024 + 1) }),
  ).toThrow();
});

test('another session cannot see or answer this session’s reads', () => {
  const f = fixture();
  const other = f.store.create('/tmp', 'create-2').id;
  const r = f.reads.request(f.session, 'call-1', { action: 'card' });
  expect(f.reads.pending(other)).toEqual([]);
  expect(() => f.reads.answer(other, { read_id: r.id, ok: true, text: 'x' })).toThrow();
  expect(f.reads.get(f.session, r.id).state).toBe('pending');
});
