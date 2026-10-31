import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { call } from '../../src/transport.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { Outbox } from '../../src/attach.js';
import { fixture } from '../helpers.js';

// Phase 3b: a desk prompt's @mentions reach the model as attached contents and images; board
// sessions are sent exactly what was typed.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5a0a00000000049454e44ae426082',
  'hex',
);

async function setup(coding: boolean) {
  const f = await fixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sal-mention-svc-')));
  writeFileSync(join(root, 'notes.md'), 'remember the milk\n');
  writeFileSync(join(root, 'shot.png'), PNG);
  writeFileSync(join(root, '.env'), 'TOKEN=abc\n');
  const session = coding
    ? f.service.store.create(root, 'create', false, {
        workspace: true,
        coding: true,
        route: OFFLINE_ROUTE,
      })
    : f.service.store.create(root, 'create', false);
  const lease = f.service.store.control(session.id, 'lease', 'operator', 'acquire', 0);
  const submit = (text: string, extra: Record<string, unknown> = {}) =>
    call<{ id: string }>(f.service.socket, `/v1/sessions/${session.id}/submissions`, {
      request_id: 'r-' + Math.random(),
      expected_revision: f.service.store.session(session.id).revision,
      text,
      client_id: 'operator',
      token: lease.token,
      ...extra,
    });
  const text = (id: string) =>
    (
      f.service.store.db.prepare('SELECT text FROM submissions WHERE id=?').get(id) as {
        text: string;
      }
    ).text;
  const images = (id: string) =>
    f.service.store.db.prepare('SELECT mime FROM submission_images WHERE submission_id=?').all(id);
  return { ...f, submit, text, images };
}

test('a desk submission carries the mentioned file and image', async () => {
  const s = await setup(true);
  try {
    const sub = await s.submit('summarise @notes.md and @shot.png');
    expect(s.text(sub.id)).toContain('remember the milk');
    expect(s.text(sub.id)).toContain('@shot.png (image, attached)');
    expect(s.images(sub.id)).toEqual([{ mime: 'image/png' }]);
  } finally {
    await s.close();
  }
});

test('a secret-looking mention is refused until the client confirms it', async () => {
  const s = await setup(true);
  try {
    await expect(s.submit('read @.env')).rejects.toMatchObject({ code: 'sensitive_attachment' });
    const sub = await s.submit('read @.env', { confirm_sensitive: true });
    expect(s.text(sub.id)).toContain('TOKEN=abc');
  } finally {
    await s.close();
  }
});

test('a board session submission is not expanded', async () => {
  const s = await setup(false);
  try {
    const sub = await s.submit('see @notes.md');
    expect(s.text(sub.id)).toBe('see @notes.md');
  } finally {
    await s.close();
  }
});

test('dispatch sends the stored images with the prompt', () => {
  const sup = readFileSync(new URL('../../src/supervisor.ts', import.meta.url), 'utf8');
  expect(sup).toMatch(
    /const images = takeImages\(this\.store\.db, work\.submission\.id\);\s*const response = await w\.pi\.command\('prompt', \{\s*message: work\.submission\.text,\s*\.\.\.\(images\.length \? \{ images \} : \{\}\)/,
  );
});

test('the outbox keeps the confirmation and gives up on a refused secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-outbox-'));
  const box = new Outbox(dir, '00000000-0000-4000-8000-000000000000');
  expect(box.enqueue('read @.env', 1, undefined, true).confirm_sensitive).toBe(true);
  expect(box.enqueue('plain', 1)).not.toHaveProperty('confirm_sensitive');
  expect(readFileSync(new URL('../../src/attach.ts', import.meta.url), 'utf8')).toContain(
    "'sensitive_attachment',",
  );
});
