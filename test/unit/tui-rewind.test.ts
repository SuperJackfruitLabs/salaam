import { test, expect, vi } from 'vitest';
import { SalaamApp } from '../../src/tui.js';
import { ChoiceModal, ConfirmModal } from '../../src/tui-modals.js';
import { rewindSummary } from '../../src/tui-review.js';
import type { SessionSnapshot } from '../../src/protocol.js';
import type { ChangeReview, RewindReview, TurnCheckpoint } from '../../src/turn-rewind.js';

const point = (turn: number, text: string): TurnCheckpoint => ({
  turn,
  attempt_id: 'attempt-' + turn,
  text,
  tree: 't' + turn,
  leaf: null,
  at: '2026-10-31T12:00:00.000Z',
});
const rewindReview = (mode: RewindReview['mode']): RewindReview => ({
  turn: 2,
  attempt_id: 'attempt-2',
  mode,
  current: 'c',
  target: 't2',
  changes: [
    { path: 'src/a.ts', status: 'modified', added: 3, removed: 1 },
    { path: 'gone.ts', status: 'added', added: 4, removed: 0 },
    { path: 'new.ts', status: 'deleted', added: 0, removed: 9 },
  ],
  digest: 'd',
});
function app(rows = 40) {
  const a = new SalaamApp({ state: '/tmp/salaam-rewind-proof' });
  Object.defineProperty(a.terminal, 'rows', { get: () => rows });
  a.client.snapshot = {
    id: 's1',
    capabilities: ['local-coding-reviewed'],
    submissions: [],
    attempts: [],
    operations: [],
    messages: [],
  } as unknown as SessionSnapshot;
  const shown: unknown[] = [];
  const show = (a as unknown as { showModal: (c: unknown, w?: number) => void }).showModal.bind(a);
  (a as unknown as { showModal: (c: unknown, w?: number) => void }).showModal = (c, w) => {
    shown.push(c);
    show(c, w);
  };
  const internal = a as unknown as {
    submit(): Promise<void>;
    input(key: string): unknown;
  };
  const top = () => shown.at(-1);
  return { a, internal, top };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the rewind summary says what happens to files and to the conversation', () => {
  const both = rewindSummary(rewindReview('both'));
  expect(both).toContain('restore src/a.ts');
  expect(both).toContain('bring back gone.ts');
  expect(both).toContain('remove new.ts');
  expect(both).toContain('continues in a new session from before turn 2');
  const files = rewindSummary(rewindReview('files'));
  expect(files).toContain('The conversation is kept');
  expect(rewindSummary({ ...rewindReview('conversation'), changes: [] })).toContain(
    'Files are not changed',
  );
  expect(rewindSummary({ ...rewindReview('files'), changes: [] })).toContain('already match');
  const many = rewindSummary({
    ...rewindReview('files'),
    changes: Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      added: 1,
      removed: 1,
    })),
  });
  expect(many).toContain('… and 18 more files');
});

test('/rewind picks a turn, then what to restore, reviews it and needs one confirm', async () => {
  const { a, internal, top } = app();
  a.client.checkpoints = async () => [point(1, 'first'), point(2, 'second\nmore')];
  const asked = vi.fn(async (_attempt: string, mode: RewindReview['mode']) => rewindReview(mode));
  a.client.rewindReview = asked;
  const rewound = vi.fn(async () => 'second\nmore');
  a.client.rewind = rewound;
  a.editor.setText('/rewind');
  await internal.submit();
  await settle();
  const turns = top() as ChoiceModal;
  expect(turns).toBeInstanceOf(ChoiceModal);
  expect(turns.title).toContain('which turn');
  expect(turns.list.render(80).join('\n')).toMatch(/Turn 2 · second[\s\S]*Turn 1 · first/);
  turns.onSelect({ value: 'attempt-2', label: '' });
  const modes = top() as ChoiceModal;
  expect(modes.title).toContain('what to restore');
  modes.onSelect({ value: 'both', label: '' });
  await settle();
  expect(asked).toHaveBeenCalledWith('attempt-2', 'both');
  expect(rewound).not.toHaveBeenCalled();
  const confirm = top() as ConfirmModal;
  expect(confirm).toBeInstanceOf(ConfirmModal);
  expect(confirm.description).toContain('restore src/a.ts');
  confirm.confirm();
  await settle();
  expect(rewound).toHaveBeenCalledWith(rewindReview('both'));
  // The rewound instruction comes back so it can be edited and sent again.
  expect(a.editor.getExpandedText()).toBe('second\nmore');
});

test('/rewind N goes straight to that turn; an unknown turn says how to list them', async () => {
  const { a, internal, top } = app();
  a.client.checkpoints = async () => [point(1, 'first')];
  a.editor.setText('/rewind 1');
  await internal.submit();
  expect((top() as ChoiceModal).title).toContain('what to restore');
  a.editor.setText('/rewind 7');
  await expect(internal.submit()).rejects.toThrow(/No checkpoint for turn 7/);
});

test('/rewind with no checkpoints explains why', async () => {
  const { a, internal, top } = app();
  a.client.checkpoints = async () => [];
  a.editor.setText('/rewind');
  await expect(internal.submit()).rejects.toThrow(/No turn has been checkpointed/);
});

test('files-only rewind keeps whatever the person had typed', async () => {
  const { a, internal, top } = app();
  a.client.checkpoints = async () => [point(1, 'first')];
  a.client.rewindReview = async (_x, mode) => rewindReview(mode);
  a.client.rewind = async () => 'first';
  a.editor.setText('/rewind 1');
  await internal.submit();
  (top() as ChoiceModal).onSelect({ value: 'files', label: '' });
  await settle();
  a.editor.setText('draft');
  (top() as ConfirmModal).confirm();
  await settle();
  expect(a.editor.getExpandedText()).toBe('draft');
});

const review: ChangeReview = {
  base: 'b',
  current: 'c',
  files: [
    { path: 'a.txt', status: 'modified', added: 2, removed: 2 },
    { path: 'img.png', status: 'added', added: null, removed: null },
  ],
};
const hunks = [
  { text: '@@ -1 +1 @@\n-one\n+ONE\n', patch: 'h1' },
  { text: '@@ -9 +9 @@\n-ten\n+TEN\n', patch: 'h2' },
];
async function reviewing() {
  const { a, internal, top } = app();
  a.client.changeReview = async () => review;
  const loaded = vi.fn(async () => hunks);
  a.client.changeHunks = loaded;
  const act = vi.fn(async () => ({ ...review, files: review.files.slice(1) }));
  a.client.changeAct = act;
  a.setTab('changes');
  await settle();
  await settle();
  return { a, internal, top, act, loaded };
}

test('the Changes tab of a local session is a per-file review of what changed', async () => {
  const { a, loaded } = await reviewing();
  const text = a.document
    .render(100)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
  expect(text).toContain('a.txt');
  expect(text).toContain('+2 −2');
  expect(text).toContain('img.png');
  expect(text).toContain('binary');
  expect(text).toContain('+ONE');
  expect(text).toMatch(/a accept.*r revert.*i instruct/s);
  expect(loaded).toHaveBeenCalledWith(review, 'a.txt');
});

test('alt+arrows move between files and hunks; a accepts the selection', async () => {
  const { a, internal, act, loaded } = await reviewing();
  internal.input('\x1b[1;3B'); // alt+down: first hunk
  expect(a.document.render(100).join('\n')).toContain('hunk 1 of 2');
  expect(internal.input('a')).toEqual({ consume: true });
  await settle();
  expect(act).toHaveBeenCalledWith(review, 'accept', 'a.txt', hunks[0]);
  internal.input('\x1b[1;3C'); // alt+right: next file
  await settle();
  expect(loaded).toHaveBeenLastCalledWith(expect.anything(), 'img.png');
});

test('r asks once before reverting the selected file', async () => {
  const { internal, top, act } = await reviewing();
  internal.input('r');
  expect(act).not.toHaveBeenCalled();
  const confirm = top() as ConfirmModal;
  expect(confirm.title).toContain('Revert a.txt');
  confirm.confirm();
  await settle();
  expect(act).toHaveBeenCalledWith(review, 'revert', 'a.txt', undefined);
});

test('i starts a follow-up instruction about the selected file', async () => {
  const { a, internal } = await reviewing();
  internal.input('i');
  expect(a.view.tab).toBe('conversation');
  expect(a.editor.getExpandedText()).toBe('In a.txt: ');
});

test('review letters are ordinary typing once the editor has text', async () => {
  const { a, internal, act } = await reviewing();
  a.editor.setText('x');
  expect(internal.input('a')).toBeUndefined();
  expect(act).not.toHaveBeenCalled();
});
