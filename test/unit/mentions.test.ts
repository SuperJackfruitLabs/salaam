import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  extractMentions,
  listWorkspaceFiles,
  rankFiles,
  resolveMentions,
  attachmentContext,
  isSensitivePath,
  MENTION_LIMITS,
  MAX_IMAGES,
  expandPrompt,
  storeImages,
  takeImages,
} from '../../src/runtime/mentions.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5a0a00000000049454e44ae426082',
  'hex',
);

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sal-mention-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'out.js'), 'x');
  writeFileSync(join(root, '.env'), 'TOKEN=abc\n');
  writeFileSync(join(root, 'logo.png'), PNG);
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
  return root;
}

test('mentions are @-tokens at a word start, quoted ones may hold spaces, emails are not mentions', () => {
  expect(extractMentions('look at @src/app.ts and @"docs/a b.md", mail me@x.com')).toEqual([
    'src/app.ts',
    'docs/a b.md',
  ]);
  expect(extractMentions('(@README.md) @@ x @')).toEqual(['README.md']);
  expect(extractMentions('trailing punctuation @src/app.ts, then.')).toEqual(['src/app.ts']);
});

test('the file list respects .gitignore, stays in the workspace and skips symlinks that leave it', () => {
  const root = repo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sal-out-')));
  writeFileSync(join(outside, 'secret.txt'), 's');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  const files = listWorkspaceFiles(root);
  expect(files).toContain('src/app.ts');
  expect(files).toContain('README.md');
  expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
  expect(files).not.toContain('escape.txt');
  expect(files.length).toBeLessThanOrEqual(MENTION_LIMITS.listing);
});

test('ranking prefers a basename match and keeps subsequence matches', () => {
  expect(rankFiles(['docs/app-notes.md', 'src/app.ts', 'src/other.ts'], 'app')[0]).toBe(
    'src/app.ts',
  );
  expect(rankFiles(['src/application.ts', 'zzz'], 'sap')).toEqual(['src/application.ts']);
  expect(rankFiles(['a', 'b'], '')).toEqual(['a', 'b']);
});

test('resolving attaches text, describes binaries, lists directories and refuses escapes', () => {
  const root = repo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sal-out-')));
  writeFileSync(join(outside, 'x.txt'), 'x');
  symlinkSync(join(outside, 'x.txt'), join(root, 'link.txt'));
  const got = resolveMentions(root, [
    'src/app.ts',
    'blob.bin',
    'src/',
    '../etc/passwd',
    'link.txt',
    'nope.ts',
  ]);
  const by = Object.fromEntries(got.map((a) => [a.path, a]));
  expect(by['src/app.ts']).toMatchObject({ kind: 'text', content: 'export const a = 1;\n' });
  expect(by['src/app.ts']!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(by['blob.bin']).toMatchObject({ kind: 'binary' });
  expect(by['blob.bin']!.content).toBeUndefined();
  expect(by['src/']).toMatchObject({ kind: 'listing' });
  expect(by['src/']!.content).toContain('app.ts');
  expect(by['../etc/passwd']).toMatchObject({ kind: 'refused' });
  expect(by['link.txt']).toMatchObject({ kind: 'refused' });
  expect(by['nope.ts']).toMatchObject({ kind: 'missing' });
});

test('attachments are bounded per file and in total, and truncation is said', () => {
  const root = repo();
  writeFileSync(join(root, 'big.txt'), 'y'.repeat(MENTION_LIMITS.perFile + 500));
  for (let i = 0; i < 8; i++)
    writeFileSync(join(root, `m${i}.txt`), 'z'.repeat(MENTION_LIMITS.perFile - 10));
  const one = resolveMentions(root, ['big.txt'])[0]!;
  expect(one.truncated).toBe(true);
  expect(Buffer.byteLength(one.content!)).toBeLessThanOrEqual(MENTION_LIMITS.perFile);
  const many = resolveMentions(
    root,
    Array.from({ length: 8 }, (_, i) => `m${i}.txt`),
  );
  const total = many.reduce((n, a) => n + Buffer.byteLength(a.content ?? ''), 0);
  expect(total).toBeLessThanOrEqual(MENTION_LIMITS.total);
  expect(many.some((a) => a.kind === 'skipped')).toBe(true);
});

test('secret-looking files are flagged so they need a confirm', () => {
  expect(isSensitivePath('.env')).toBe(true);
  expect(isSensitivePath('config/.env.local')).toBe(true);
  expect(isSensitivePath('keys/server.pem')).toBe(true);
  expect(isSensitivePath('id_ed25519')).toBe(true);
  expect(isSensitivePath('src/app.ts')).toBe(false);
  expect(isSensitivePath('docs/environment.md')).toBe(false);
  const env = resolveMentions(repo(), ['.env'])[0]!;
  expect(env.sensitive).toBe(true);
});

test('images are recognised by content, bounded, and never inlined as text', () => {
  const root = repo();
  writeFileSync(join(root, 'fake.png'), 'not really a png');
  const [img, fake] = resolveMentions(root, ['logo.png', 'fake.png']);
  expect(img).toMatchObject({ kind: 'image', mime: 'image/png' });
  expect(img!.data).toBe(PNG.toString('base64'));
  expect(img!.content).toBeUndefined();
  expect(fake!.kind).not.toBe('image');
  writeFileSync(
    join(root, 'huge.png'),
    Buffer.concat([PNG, Buffer.alloc(MENTION_LIMITS.image + 1)]),
  );
  expect(resolveMentions(root, ['huge.png'])[0]).toMatchObject({ kind: 'skipped' });
});

test('the context block names each attachment with its digest and leaves images out of the text', () => {
  const root = repo();
  const block = attachmentContext(resolveMentions(root, ['src/app.ts', 'logo.png', 'blob.bin']));
  expect(block).toContain('@src/app.ts');
  expect(block).toContain('export const a = 1;');
  expect(block).toMatch(/sha256 [a-f0-9]{12}/);
  expect(block).toContain('@logo.png (image, attached)');
  expect(block).toContain('@blob.bin (binary');
  expect(block).not.toContain(PNG.toString('base64'));
});

test('a prompt with a secret-looking mention is refused until confirmed', () => {
  const root = repo();
  expect(() => expandPrompt(root, 'read @.env', false)).toThrow(/Confirm attaching.*\.env/);
  expect(expandPrompt(root, 'read @.env', true).text).toContain('TOKEN=abc');
  expect(expandPrompt(root, 'no mentions', false)).toEqual({
    text: 'no mentions',
    images: [],
    attachments: [],
  });
});

test('images go out as image content, at most four, and are taken once', () => {
  const root = repo();
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `i${i}.png`), PNG);
  const out = expandPrompt(root, '@i0.png @i1.png @i2.png @i3.png @i4.png', false);
  expect(out.images).toHaveLength(MAX_IMAGES);
  expect(out.images[0]).toEqual({
    type: 'image',
    data: PNG.toString('base64'),
    mimeType: 'image/png',
  });
  expect(out.text).toContain('@i4.png (skipped: more than 4 images)');
  const db = new DatabaseSync(':memory:');
  storeImages(db, 's1', out.images);
  expect(takeImages(db, 's1')).toEqual(out.images);
  expect(takeImages(db, 's1')).toEqual([]);
});
