import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localHash } from './edits.js';
import { ServiceError, integer, string } from '../core/protocol.js';

const excluded = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'credentials',
  'secrets',
]);
function allowed(path: string): boolean {
  return path
    .split(/[\\/]/)
    .every(
      (p) =>
        p &&
        p !== '..' &&
        !p.startsWith('.') &&
        !excluded.has(p) &&
        !/\.(pem|key|p12|pfx|sqlite|db)$/i.test(p),
    );
}
/** An explicit local inspection profile, not a command sandbox. Never follows symlinks. */
export function readLocalWorkspace(root: string, args: Record<string, unknown>): unknown {
  const action = string(args.action, 'action');
  if (!['list', 'read', 'search'].includes(action))
    throw new ServiceError('invalid_field', 'Choose list, read or search');
  const requested =
    args.path === undefined || args.path === '.' ? '' : string(args.path, 'path', 1024);
  if (requested && (isAbsolute(requested) || !allowed(requested)))
    throw new ServiceError('unsafe_path', 'Path is outside the local inspection profile');
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== resolve(root))
    throw new ServiceError('workspace_changed', 'Workspace root changed');
  const target = resolve(root, requested);
  const check = (path: string) => {
    const rel = relative(root, path);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
      throw new ServiceError('unsafe_path', 'Path escapes workspace');
    let current = root;
    for (const part of rel ? rel.split(sep) : []) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink())
        throw new ServiceError('unsafe_path', 'Symlinks are excluded');
    }
    if (realpathSync(root) !== canonicalRoot || realpathSync(path) !== path)
      throw new ServiceError('workspace_changed', 'Workspace path changed');
  };
  const read = (path: string) => {
    check(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144)
        throw new ServiceError(
          'workspace_limit',
          'Only single-link text files up to 256 KiB are readable',
        );
      const buffer = Buffer.alloc(262145);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 262144)
        throw new ServiceError('workspace_limit', 'File grew beyond the read limit');
      const bytes = buffer.subarray(0, length);
      check(path);
      const after = lstatSync(path);
      if (
        after.nlink !== 1 ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new ServiceError('workspace_changed', 'File changed while reading');
      if (bytes.includes(0)) throw new ServiceError('binary_file', 'Binary files are excluded');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      closeSync(fd);
    }
  };
  try {
    check(target);
    const offset = args.offset === undefined ? 0 : integer(args.offset, 'offset');
    if (action === 'read') {
      const contents = read(target);
      const lines = contents.split('\n');
      let text = '',
        count = 0;
      for (let i = offset; i < lines.length && count < 200; i++) {
        const line = `${i + 1}: ${lines[i]}\n`;
        if (Buffer.byteLength(text + line) > 16384) break;
        text += line;
        count++;
      }
      if (!count && offset < lines.length)
        throw new ServiceError('line_limit', 'Line exceeds the 16 KiB response limit');
      return {
        path: requested,
        sha256: localHash(contents),
        text,
        next_offset: offset + count < lines.length ? offset + count : null,
      };
    }
    const query = action === 'search' ? string(args.query, 'query', 256) : undefined;
    const matches: unknown[] = [];
    const deadline = performance.now() + 750;
    let visited = 0,
      matched = 0,
      truncated = false;
    const walk = (dir: string) => {
      check(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++visited > 50000 || matches.length >= 100 || performance.now() > deadline) {
          truncated = true;
          return;
        }
        const path = join(dir, entry.name),
          rel = relative(root, path);
        if (!allowed(rel) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(path);
          if (truncated) return;
        } else if (entry.isFile()) {
          if (!query) {
            if (matched++ >= offset) matches.push(rel);
          } else {
            let contents: string;
            try {
              contents = read(path);
            } catch {
              continue;
            }
            for (const [index, line] of contents.split('\n').entries()) {
              if (!line.includes(query)) continue;
              if (matched++ >= offset)
                matches.push({ path: rel, line: index + 1, text: line.slice(0, 256) });
              if (matches.length >= 100) {
                truncated = true;
                return;
              }
            }
          }
        }
      }
    };
    walk(target);
    return {
      matches,
      visited,
      truncated,
      next_offset: truncated && matches.length ? offset + matches.length : null,
      exclusions:
        'Hidden paths, dependency/build directories, symlinks, keys and databases are excluded; search skips unreadable/binary/oversized files.',
    };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'workspace_read_failed',
      'Workspace path is missing, changed, or not readable',
    );
  }
}
