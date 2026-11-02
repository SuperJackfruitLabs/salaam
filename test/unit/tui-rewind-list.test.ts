import { test, expect } from 'vitest';
import { rewindItems } from '../../src/tui/review.js';

// PR #103 live pass: /rewind listed raw ISO timestamps; it now says how long ago, newest first.
test('the rewind list shows turns newest first with relative times', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z');
  const items = rewindItems(
    [
      { attempt_id: 'a1', turn: 1, text: 'first\nmore', at: '2026-10-31T11:00:00.000Z' },
      { attempt_id: 'a2', turn: 2, text: 'second', at: '2026-10-31T11:58:00.000Z' },
    ],
    now,
  );
  expect(items).toEqual([
    { value: 'a2', label: 'Turn 2 · second', description: '2 min ago' },
    { value: 'a1', label: 'Turn 1 · first', description: '1 h ago' },
  ]);
});
