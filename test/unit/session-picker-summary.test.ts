import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { pickerSummary } from '../../src/session-pick.js';

// Trial polish C (2026-10-31): the session list says what you last asked and when, for desk
// sessions only; board and station sessions list as before.
test('a desk session lists its newest prompt and when its transcript last changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-pick-'));
  try {
    const store = new Store(join(dir, 'journal.sqlite'));
    const s = store.create(dir, 'r1');
    const db = (store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } })
      .db;
    const add = (id: string, text: string) =>
      db.prepare('INSERT INTO submissions(id,session_id,text) VALUES (?,?,?)').run(id, s.id, text);
    add('a', 'first ask');
    add('b', 'x'.repeat(500));
    add('c', 'run the tests');
    expect(store.lastPrompt(s.id)).toBe('run the tests');
    const file = join(dir, 'pi.jsonl');
    writeFileSync(file, '{}\n');
    utimesSync(file, new Date('2026-10-31T10:00:00Z'), new Date('2026-10-31T10:00:00Z'));
    const desk = { ...s, capabilities: ['local-coding-reviewed'], pi_session_file: file };
    expect(pickerSummary(desk, store)).toEqual({
      last_prompt: 'run the tests',
      last_active_at: '2026-10-31T10:00:00.000Z',
    });
    add('d', 'y'.repeat(500));
    expect(pickerSummary(desk, store).last_prompt).toHaveLength(200);
    expect(pickerSummary({ ...s, pi_session_file: file }, store)).toEqual({});
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
