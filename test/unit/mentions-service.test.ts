import { expect, test } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { call } from '../../src/core/transport.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { Outbox } from '../../src/tui/attach.js';
import { fixture } from '../helpers.js';

// Phase 3b: a desk prompt's @mentions reach the model as attached contents and images; board
// sessions are sent exactly what was typed.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5a0a00000000049454e44ae426082',
  'hex',
);

async function setup(coding: boolean, workspace = coding) {
  const f = await fixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sal-mention-svc-')));
  writeFileSync(join(root, 'notes.md'), 'remember the milk\n');
  writeFileSync(join(root, 'shot.png'), PNG);
  writeFileSync(join(root, '.env'), 'TOKEN=abc\n');
  const session = workspace
    ? f.service.store.create(root, 'create', false, {
        workspace: true,
        coding,
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
  const sup = readFileSync(new URL('../../src/runtime/supervisor.ts', import.meta.url), 'utf8');
  expect(sup).toMatch(
    /const images = takeImages\(this\.store\.db, work\.submission\.id\);\s*const response = await w\.pi\.command\('prompt', \{\s*message,\s*\.\.\.\(images\.length \? \{ images \} : \{\}\)/,
  );
  // The message is the submission's text (plus any UserPromptSubmit hook context, Phase 4b).
  expect(sup).toMatch(/let message = work\.submission\.text;/);
});

test('the outbox keeps the confirmation and gives up on a refused secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-outbox-'));
  const box = new Outbox(dir, '00000000-0000-4000-8000-000000000000');
  expect(box.enqueue('read @.env', 1, undefined, true).confirm_sensitive).toBe(true);
  expect(box.enqueue('plain', 1)).not.toHaveProperty('confirm_sensitive');
  expect(readFileSync(new URL('../../src/tui/attach.ts', import.meta.url), 'utf8')).toContain(
    "'sensitive_attachment',",
  );
});

// Ctrl+V: an image pasted into the composer rides with its prompt, named by its marker.
const pasted = (label = 'image #1') => ({ label, mime: 'image/png', data: PNG.toString('base64') });

test('a pasted image is stored with the prompt and named in its text', async () => {
  const s = await setup(true);
  try {
    const sub = await s.submit('what is wrong here [image #1]', { images: [pasted()] });
    expect(s.images(sub.id)).toEqual([{ mime: 'image/png' }]);
    expect(s.text(sub.id)).toMatch(
      /<pasted-images>\n\[image #1\] \(pasted image, attached\) \[sha256 [0-9a-f]{12}\]\n<\/pasted-images>/,
    );
  } finally {
    await s.close();
  }
});

test('pasted images come first and share the four-image limit with mentioned ones', async () => {
  const s = await setup(true);
  try {
    const four = [1, 2, 3, 4].map((n) => pasted('image #' + n));
    const sub = await s.submit('compare these with @shot.png', { images: four });
    expect(s.images(sub.id)).toHaveLength(4);
    expect(s.text(sub.id)).toContain('@shot.png (skipped: more than 4 images)');
    await expect(
      s.submit('too many', { images: [...four, pasted('image #5')] }),
    ).rejects.toMatchObject({ code: 'invalid_field' });
  } finally {
    await s.close();
  }
});

test('a pasted image must be the image it claims, within the size limit', async () => {
  const s = await setup(true);
  try {
    for (const bad of [
      { ...pasted(), mime: 'image/jpeg' },
      { ...pasted(), data: Buffer.from('not an image').toString('base64') },
      { ...pasted(), label: 'whatever' },
      { ...pasted(), data: Buffer.alloc(3_750_001, 0).toString('base64') },
    ])
      await expect(s.submit('look [image #1]', { images: [bad] })).rejects.toMatchObject({
        code: 'invalid_field',
      });
  } finally {
    await s.close();
  }
});

test('a read-only workspace session takes pasted images and mentions too', async () => {
  const s = await setup(false, true);
  try {
    const sub = await s.submit('compare [image #1] with @shot.png', { images: [pasted()] });
    expect(s.images(sub.id)).toEqual([{ mime: 'image/png' }, { mime: 'image/png' }]);
    expect(s.text(sub.id)).toContain('[image #1] (pasted image, attached)');
  } finally {
    await s.close();
  }
});

test('a board session refuses pasted images', async () => {
  const s = await setup(false);
  try {
    await expect(s.submit('look', { images: [pasted()] })).rejects.toMatchObject({
      code: 'invalid_field',
    });
  } finally {
    await s.close();
  }
});

test('the submission route takes a prompt with a pasted image past 1 MiB', async () => {
  const s = await setup(true);
  try {
    const big = pasted();
    big.data = Buffer.concat([PNG, Buffer.alloc(2_000_000)]).toString('base64');
    const sub = await s.submit('big [image #1]', { images: [big] });
    expect(s.images(sub.id)).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('the outbox saves pasted images with the prompt, so a retry sends them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-outbox-'));
  const box = new Outbox(dir, '00000000-0000-4000-8000-000000000000');
  const record = box.enqueue('look [image #1]', 1, undefined, false, [pasted()]);
  const saved = JSON.parse(readFileSync(join(box.dir, record.request_id + '.json'), 'utf8'));
  expect(saved.images).toEqual([pasted()]);
  expect(box.enqueue('plain', 1)).not.toHaveProperty('images');
});

test('every other route keeps the 1 MiB body limit', async () => {
  const { Readable } = await import('node:stream');
  const { readJson } = await import('../../src/core/transport.js');
  const body = () =>
    Readable.from([Buffer.from(JSON.stringify({ padding: 'x'.repeat(1_100_000) }))]) as never;
  await expect(readJson(body())).rejects.toMatchObject({ code: 'body_too_large' });
  await expect(readJson(body(), 2 * 1024 * 1024)).resolves.toHaveProperty('padding');
  // The service module's controllers: the submission route is the only one with a larger limit.
  const dir = new URL('../../src/service/', import.meta.url);
  const service = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
    .join('\n');
  expect(service.match(/readJson\(req, SUBMISSION_BODY_LIMIT\)/g)).toHaveLength(1);
  expect(service.match(/readJson\(req, /g)).toHaveLength(1);
});
