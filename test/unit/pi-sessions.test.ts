import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { forkPiSession } from '../../src/runtime/pi-sessions.js';

function source() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-pi-fork-'));
  const manager = SessionManager.create(dir, join(dir, 'source'));
  const say = (role: 'user' | 'assistant', text: string) =>
    manager.appendMessage(
      role === 'user'
        ? { role, content: text, timestamp: Date.now() }
        : ({
            role,
            content: [{ type: 'text', text }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'm',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: Date.now(),
          } as never),
    );
  say('user', 'turn one');
  const leaf = say('assistant', 'answer one');
  say('user', 'turn two');
  say('assistant', 'answer two');
  return { dir, file: manager.getSessionFile()!, leaf };
}
const texts = (entries: readonly object[]) =>
  entries
    .filter(
      (e): e is { type: string; message: { content: unknown } } =>
        (e as { type: string }).type === 'message',
    )
    .map((e) => {
      const c = e.message.content;
      return typeof c === 'string' ? c : (c as { text: string }[])[0]!.text;
    });

test('a plain fork keeps the whole conversation', () => {
  const { dir, file } = source();
  const forked = SessionManager.open(forkPiSession(file, dir, join(dir, 'f'), 'fork-a'));
  expect(texts(forked.getBranch())).toEqual(['turn one', 'answer one', 'turn two', 'answer two']);
});

test('a rewind fork continues from the earlier leaf with a note, and the source is unchanged', () => {
  const { dir, file, leaf } = source();
  const path = forkPiSession(file, dir, join(dir, 'f'), 'fork-b', {
    leaf,
    summary: 'Rewound to before turn 2',
  });
  const forked = SessionManager.open(path);
  const tip = forked.getLeafEntry()!;
  expect(tip.type).toBe('branch_summary');
  expect(tip.parentId).toBe(leaf);
  expect(texts(forked.getBranch())).toEqual(['turn one', 'answer one']);
  expect(forked.getSessionId()).toBe('fork-b');
  expect(texts(SessionManager.open(file).getBranch())).toHaveLength(4);
});

test('rewinding before the first turn starts the fork from an empty conversation', () => {
  const { dir, file } = source();
  const forked = SessionManager.open(
    forkPiSession(file, dir, join(dir, 'f'), 'fork-c', { leaf: null, summary: 'Rewound' }),
  );
  expect(texts(forked.getBranch())).toEqual([]);
});
