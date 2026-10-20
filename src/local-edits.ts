import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ServiceError, object, string } from './protocol.js';

export const localHash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface LocalEdit {
  path: string;
  before: string | null;
  after: string;
  mode: number;
}
/** Optimistic local-user editing, not an adversarial OS filesystem sandbox. */
export function localPath(root: string, path: string): string {
  if (
    realpathSync(root) !== resolve(root) ||
    isAbsolute(path) ||
    !path ||
    path
      .split(/[\\/]/)
      .some(
        (p) =>
          !p ||
          p === '..' ||
          p.startsWith('.') ||
          ['credentials', 'secrets', 'node_modules', 'vendor'].includes(p),
      ) ||
    /\.(key|pem|p12|pfx|sqlite|db)$/i.test(path)
  )
    throw new ServiceError(
      'unsafe_path',
      'Local edits require a regular project path; private paths and symlinks are excluded',
    );
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep))
    throw new ServiceError('unsafe_path', 'Path escapes workspace');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new ServiceError('unsafe_path', 'Symlinks are excluded');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || current !== target) throw e;
    }
  }
  if (realpathSync(dirname(target)) !== dirname(target))
    throw new ServiceError('unsafe_path', 'Parent changed');
  return target;
}
function contents(path: string): { text: string | null; mode: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode: 0o644 };
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144)
      throw new ServiceError('workspace_limit', 'Edit only single-link UTF-8 files up to 256 KiB');
    const bytes = readFileSync(fd);
    if (bytes.length > 262144 || bytes.includes(0))
      throw new ServiceError('workspace_limit', 'File is binary or too large');
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new ServiceError('workspace_changed', 'File changed while reading');
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      mode: stat.mode & 0o777,
    };
  } finally {
    closeSync(fd);
  }
}
export function prepareLocalEdits(root: string, input: unknown): LocalEdit[] {
  if (!Array.isArray(input) || !input.length || input.length > 8)
    throw new ServiceError('invalid_field', 'Provide one to eight edits');
  const seen = new Set<string>();
  const edits = input.map((raw) => {
    const item = object(raw),
      path = string(item.path, 'path', 1024),
      target = localPath(root, path);
    if (seen.has(target)) throw new ServiceError('invalid_field', 'Use one edit per path');
    seen.add(target);
    const original = contents(target);
    const expected = item.sha256;
    if (expected !== (original.text === null ? null : localHash(original.text)))
      throw new ServiceError(
        'workspace_changed',
        'Read the file first and supply its current sha256; null is only for a new file',
      );
    if (
      typeof item.content !== 'string' ||
      Buffer.byteLength(item.content) > 262144 ||
      item.content.includes('\0')
    )
      throw new ServiceError('invalid_field', 'Provide UTF-8 replacement content up to 256 KiB');
    return { path, before: original.text, after: item.content, mode: original.mode };
  });
  if (Buffer.byteLength(JSON.stringify(edits)) > 32768)
    throw new ServiceError(
      'workspace_limit',
      'Split this edit into smaller reviewable changes (32 KiB per review)',
    );
  return edits;
}
export function verifyLocalEdits(root: string, edits: LocalEdit[]): void {
  for (const edit of edits) {
    const actual = contents(localPath(root, edit.path));
    if (actual.text !== edit.before || actual.mode !== edit.mode)
      throw new ServiceError('workspace_changed', `File changed since review: ${edit.path}`);
  }
}
/** Each file is atomic; a crash between files is deliberately not reported as all-or-nothing. */
export function applyLocalEdits(
  root: string,
  edits: LocalEdit[],
  applied: (path: string) => void,
): void {
  verifyLocalEdits(root, edits);
  for (const edit of edits) {
    verifyLocalEdits(root, [edit]);
    const target = localPath(root, edit.path),
      temporary = join(dirname(target), '.salaam-' + randomUUID());
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        edit.mode,
      );
      fchmodSync(fd, edit.mode);
      writeFileSync(fd, edit.after);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      verifyLocalEdits(root, [edit]);
      if (edit.before === null) linkSync(temporary, target);
      else renameSync(temporary, target);
      const dir = openSync(dirname(target), constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      applied(edit.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}
