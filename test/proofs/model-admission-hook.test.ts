import { test, expect } from 'vitest';
import { fixture, create, ready, until } from '../helpers.js';
import { submit } from '../managed-helpers.js';

test('trusted host admission observes every root and child model request without adding another allowance', async () => {
  const admissions: { session: string; attempt: string | undefined }[] = [];
  const f = await fixture({
    admitModelRequest: (session, attempt) => {
      admissions.push({ session, attempt });
    },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await submit(f.service, session.id, '[children] one');
    await until(
      () => f.service.children.list(session.id),
      (cs) => cs.length === 1 && cs[0]!.state === 'completed',
    );
    await until(
      () => f.service.store.snapshot(session.id).attempts,
      (as) => as[0]?.state === 'completed',
    );
    const rows = f.service.store.db
      .prepare('SELECT session_id,attempt_id FROM usage_observations ORDER BY rowid')
      .all();
    expect(admissions.map((a) => ({ session_id: a.session, attempt_id: a.attempt }))).toEqual(rows);
    expect(new Set(admissions.map((a) => a.session)).size).toBe(2);
  } finally {
    await f.close();
  }
});

test('a failed host admission records no provider grant and invalidates worker readiness', async () => {
  const f = await fixture({
    admitModelRequest: () => {
      throw new Error('fixture shared allowance exhausted');
    },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await submit(f.service, session.id, 'Do not forward this request');
    const state = await until(
      () => f.service.store.snapshot(session.id),
      (s) => s.attempts[0]?.state === 'interrupted',
    );
    expect(state.attempts[0]!.error).toContain('allowance exhausted');
    expect(state.state).not.toBe('ready');
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM usage_observations').get()!.n,
    ).toBe(0);
    expect(
      f.service.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='model.admitted'")
        .get()!.n,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
