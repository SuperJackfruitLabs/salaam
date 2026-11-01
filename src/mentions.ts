import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ServiceError } from './protocol.js';

/** `@path` mentions attach workspace files to a desk prompt (Phase 3b). */
export const MENTION_LIMITS = {
  perFile: 64 * 1024,
  total: 256 * 1024,
  image: 512 * 1024,
  listing: 5000,
  entries: 200,
} as const;

export interface Attachment {
  path: string;
  kind: 'text' | 'binary' | 'image' | 'listing' | 'missing' | 'refused' | 'skipped';
  content?: string;
  data?: string;
  mime?: string;
  sha256?: string;
  bytes?: number;
  truncated?: boolean;
  sensitive?: boolean;
  reason?: string;
}

const SENSITIVE = [
  /(^|\/)\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.(netrc|npmrc|pypirc)$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(path));
}

/** `@token` at a word start; `@"a b"` may hold spaces; trailing punctuation is dropped. */
export function extractMentions(text: string): string[] {
  const found: string[] = [];
  const pattern = /(^|[\s([{])@(?:"([^"]+)"|([^\s"]+))/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[2] ?? match[3]!.replace(/[.,;:!?)\]}]+$/, '');
    if (value && !value.startsWith('@') && !found.includes(value)) found.push(value);
  }
  return found;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Tracked and untracked-but-not-ignored files; a symlink is listed only if it stays inside. */
export function listWorkspaceFiles(root: string): string[] {
  let names: string[];
  try {
    names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    names = walk(root, root);
  }
  const real = realpathSync(root);
  const kept: string[] = [];
  for (const name of names) {
    if (kept.length >= MENTION_LIMITS.listing) break;
    try {
      if (
        lstatSync(resolve(root, name)).isSymbolicLink() &&
        !inside(real, realpathSync(resolve(root, name)))
      )
        continue;
    } catch {
      continue;
    }
    kept.push(name);
  }
  return kept;
}

function walk(root: string, dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MENTION_LIMITS.listing) break;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** Basename hits first, then path substrings, then in-order subsequences. */
export function rankFiles(files: string[], query: string): string[] {
  if (!query) return files;
  const q = query.toLowerCase();
  const score = (file: string) => {
    const f = file.toLowerCase();
    const base = basename(f);
    if (base.startsWith(q)) return 4;
    if (base.includes(q)) return 3;
    if (f.includes(q)) return 2;
    let i = 0;
    for (const ch of f) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  };
  return files
    .map((file) => ({ file, s: score(file) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .map((x) => x.file);
}

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

function truncate(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  // Cut on a character boundary so the byte bound holds.
  return buf.subarray(0, limit).toString('utf8').replace(/�$/, '');
}

/** Read each mention under the workspace; nothing outside it, through a symlink or not. */
export function resolveMentions(root: string, mentions: string[]): Attachment[] {
  const real = realpathSync(root);
  let budget: number = MENTION_LIMITS.total;
  return mentions.map((path): Attachment => {
    const target = resolve(real, path);
    if (isAbsolute(path) || !inside(real, target))
      return { path, kind: 'refused', reason: 'outside the workspace' };
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      return { path, kind: 'missing' };
    }
    if (!inside(real, resolved))
      return { path, kind: 'refused', reason: 'links outside the workspace' };
    const sensitive = isSensitivePath(path) || undefined;
    const stat = lstatSync(resolved);
    if (stat.isDirectory()) {
      const names = readdirSync(resolved, { withFileTypes: true })
        .filter((e) => e.name !== '.git')
        .slice(0, MENTION_LIMITS.entries)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const content = truncate(names.join('\n'), Math.min(MENTION_LIMITS.perFile, budget));
      budget -= Buffer.byteLength(content);
      return { path, kind: 'listing', content };
    }
    if (!stat.isFile()) return { path, kind: 'refused', reason: 'not a regular file' };
    const bytes = readFileSync(resolved);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mime = imageMime(bytes);
    if (mime) {
      if (bytes.length > MENTION_LIMITS.image)
        return {
          path,
          kind: 'skipped',
          reason: 'image larger than 512 KiB',
          bytes: bytes.length,
          sha256,
        };
      return {
        path,
        kind: 'image',
        mime,
        data: bytes.toString('base64'),
        sha256,
        bytes: bytes.length,
        sensitive,
      };
    }
    if (bytes.subarray(0, 8192).includes(0))
      return { path, kind: 'binary', sha256, bytes: bytes.length, sensitive };
    if (budget <= 0)
      return {
        path,
        kind: 'skipped',
        reason: 'attachment budget used up',
        sha256,
        bytes: bytes.length,
        sensitive,
      };
    const limit = Math.min(MENTION_LIMITS.perFile, budget);
    const content = truncate(bytes.toString('utf8'), limit);
    budget -= Buffer.byteLength(content);
    return {
      path,
      kind: 'text',
      content,
      sha256,
      bytes: bytes.length,
      ...(Buffer.byteLength(content) < bytes.length ? { truncated: true } : {}),
      ...(sensitive ? { sensitive } : {}),
    };
  });
}

/** The text the model reads; image bytes travel separately as image content. */
export function attachmentContext(attachments: Attachment[]): string {
  if (!attachments.length) return '';
  const parts = attachments.map((a) => {
    const digest = a.sha256 ? `, sha256 ${a.sha256.slice(0, 12)}` : '';
    switch (a.kind) {
      case 'text':
        return `@${a.path} (${a.bytes} bytes${digest}${a.truncated ? ', truncated' : ''})\n\`\`\`\n${a.content}\n\`\`\``;
      case 'listing':
        return `@${a.path} (directory)\n\`\`\`\n${a.content}\n\`\`\``;
      case 'image':
        return `@${a.path} (image, attached)${digest ? ` [${digest.slice(2)}]` : ''}`;
      case 'binary':
        return `@${a.path} (binary, ${a.bytes} bytes${digest}; not attached)`;
      default:
        return `@${a.path} (${a.kind}${a.reason ? `: ${a.reason}` : ''})`;
    }
  });
  return `<attached-files>\n${parts.join('\n\n')}\n</attached-files>`;
}

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export const MAX_IMAGES = 4;

/** An image pasted into the composer: the bytes travel with the prompt, named by its marker. */
export interface PastedPromptImage {
  /** The marker in the prompt text, without brackets: `image #2`. */
  label: string;
  mime: string;
  /** base64 */
  data: string;
}
/** Providers take about 5 MB of base64 per image; this raw size stays under it. */
export const PASTED_IMAGE_LIMIT = 3_750_000;

/** Check a submission's pasted images: real images of the type they claim, within the limits. */
export function pastedImages(value: unknown): PastedPromptImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    throw new ServiceError('invalid_field', `images is a list of at most ${MAX_IMAGES}`, 400);
  return value.map((item) => {
    const i = item as Partial<PastedPromptImage>;
    if (
      !i ||
      typeof i.label !== 'string' ||
      !/^image #\d{1,4}$/.test(i.label) ||
      typeof i.mime !== 'string' ||
      typeof i.data !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)
    )
      throw new ServiceError(
        'invalid_field',
        'Each image needs a label, a mime type and base64 data',
        400,
      );
    const bytes = Buffer.from(i.data, 'base64');
    if (bytes.length > PASTED_IMAGE_LIMIT)
      throw new ServiceError(
        'invalid_field',
        `A pasted image is larger than ${PASTED_IMAGE_LIMIT / 1e6} MB`,
        400,
      );
    if (imageMime(bytes) !== i.mime)
      throw new ServiceError(
        'invalid_field',
        'A pasted image is not the PNG, JPEG, GIF or WebP it claims',
        400,
      );
    return { label: i.label, mime: i.mime, data: i.data };
  });
}

/**
 * Expand a desk prompt's mentions and pasted images. A secret-looking file is attached only after
 * the user confirms it; the refusal names the files so the client can ask. Pasted images come
 * first; mentioned images fill what is left of the per-prompt limit.
 */
export function expandPrompt(
  root: string,
  text: string,
  confirmSensitive: boolean,
  pasted: PastedPromptImage[] = [],
): { text: string; images: PromptImage[]; attachments: Attachment[] } {
  const mentions = extractMentions(text);
  if (!mentions.length && !pasted.length) return { text, images: [], attachments: [] };
  const attachments = mentions.length ? resolveMentions(root, mentions) : [];
  const sensitive = attachments
    .filter((a) => a.sensitive && a.kind !== 'binary')
    .map((a) => a.path);
  if (sensitive.length && !confirmSensitive)
    throw new ServiceError(
      'sensitive_attachment',
      `Confirm attaching secret-looking files: ${sensitive.join(', ')}`,
      409,
    );
  const images: PromptImage[] = pasted.map((p) => ({
    type: 'image',
    data: p.data,
    mimeType: p.mime,
  }));
  for (const a of attachments) {
    if (a.kind !== 'image') continue;
    if (images.length >= MAX_IMAGES) {
      a.kind = 'skipped';
      a.reason = `more than ${MAX_IMAGES} images`;
      delete a.data;
      continue;
    }
    images.push({ type: 'image', data: a.data!, mimeType: a.mime! });
  }
  const pastedContext = pasted.map((p) => {
    const sha = createHash('sha256').update(Buffer.from(p.data, 'base64')).digest('hex');
    return `[${p.label}] (pasted image, attached) [sha256 ${sha.slice(0, 12)}]`;
  });
  const context = [
    ...(pastedContext.length
      ? [`<pasted-images>\n${pastedContext.join('\n')}\n</pasted-images>`]
      : []),
    ...(attachments.length ? [attachmentContext(attachments)] : []),
  ];
  return { text: `${text}\n\n${context.join('\n\n')}`, images, attachments };
}

function imageTable(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS submission_images(submission_id TEXT NOT NULL,position INTEGER NOT NULL,mime TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(submission_id,position))',
  );
}

export function storeImages(db: DatabaseSync, submissionId: string, images: PromptImage[]): void {
  if (!images.length) return;
  imageTable(db);
  const insert = db.prepare('INSERT INTO submission_images VALUES (?,?,?,?)');
  images.forEach((image, i) => insert.run(submissionId, i, image.mimeType, image.data));
}

/** Images ride with their submission once; they are dropped after dispatch. */
export function takeImages(db: DatabaseSync, submissionId: string): PromptImage[] {
  imageTable(db);
  const rows = db
    .prepare('SELECT mime,data FROM submission_images WHERE submission_id=? ORDER BY position')
    .all(submissionId) as { mime: string; data: string }[];
  if (rows.length)
    db.prepare('DELETE FROM submission_images WHERE submission_id=?').run(submissionId);
  return rows.map((r) => ({ type: 'image', data: r.data, mimeType: r.mime }));
}
