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
import { ServiceError, object, string } from '../core/protocol.js';

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
    // An existing file changes by exact replacements; whole content is for new files (or a
    // deliberate rewrite). Either way the edit resolves to the exact before and after texts, so
    // the approval binding, apply, verify and undo paths are unchanged.
    let after: string;
    if (item.replacements !== undefined) {
      if (item.content !== undefined)
        throw new ServiceError('invalid_field', 'Use replacements or content for a file, not both');
      if (original.text === null)
        throw new ServiceError(
          'invalid_field',
          'Replacements edit an existing file; give a new file its whole content',
        );
      after = applyReplacements(path, original.text, item.replacements);
    } else after = item.content as string;
    if (typeof after !== 'string' || Buffer.byteLength(after) > 262144 || after.includes('\0'))
      throw new ServiceError('invalid_field', 'Provide UTF-8 file content up to 256 KiB');
    return { path, before: original.text, after, mode: original.mode };
  });
  // What a person reviews is the change, so the change is what is bounded, not the files.
  if (Buffer.byteLength(reviewLocalEdits(edits, Infinity)) > 32768)
    throw new ServiceError(
      'workspace_limit',
      'Split this edit into smaller reviewable changes (32 KiB per review)',
    );
  return edits;
}

/** Applies exact replacements in order. Each `old` must occur exactly once in the text as it is
 * at that point; the message tells the model how to fix a miss. */
function applyReplacements(path: string, text: string, input: unknown): string {
  if (!Array.isArray(input) || !input.length || input.length > 20)
    throw new ServiceError('invalid_field', 'Provide one to twenty replacements');
  input.forEach((raw, i) => {
    const r = object(raw),
      n = `Replacement ${i + 1} in ${path}`;
    if (typeof r.old !== 'string' || typeof r.new !== 'string')
      throw new ServiceError('invalid_field', `${n}: give old and new as text`);
    if (!r.old)
      throw new ServiceError(
        'invalid_field',
        `${n}: old is empty; quote the exact lines to change`,
      );
    let count = 0;
    for (let at = text.indexOf(r.old); at !== -1; at = text.indexOf(r.old, at + r.old.length))
      count++;
    if (count === 0)
      throw new ServiceError(
        'edit_mismatch',
        `${n}: old text not found. Read the file again and copy the exact lines, including whitespace`,
      );
    if (count > 1)
      throw new ServiceError(
        'edit_mismatch',
        `${n}: old text occurs ${count} times. Include more surrounding lines so it matches exactly once`,
      );
    if (r.old === r.new) throw new ServiceError('invalid_field', `${n}: changes nothing`);
    text = text.replace(r.old, () => r.new as string);
  });
  return text;
}

const CONTEXT = 3,
  REVIEW_LINES = 200;

/** A unified diff of each file's change with a few lines of context: what an approval shows.
 * Long reviews stop at `limit` lines and say how much they left out; the approval still binds
 * the exact full change. */
export function reviewLocalEdits(edits: LocalEdit[], limit = REVIEW_LINES): string {
  const out: string[] = [];
  let hidden = 0;
  for (const edit of edits) {
    const lines =
      edit.before === null
        ? [`+++ ${edit.path} (new file)`, ...split(edit.after).map((l) => '+' + l)]
        : [`--- ${edit.path}`, `+++ ${edit.path}`, ...hunks(split(edit.before), split(edit.after))];
    for (const line of lines) {
      if (out.length < limit) out.push(line);
      else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) hidden++;
    }
  }
  if (hidden)
    out.push(`… ${hidden} more changed lines not shown; the approval covers the exact full change`);
  return out.join('\n');
}
function split(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
/** Unified-diff hunks from a line-level Myers diff (prefix and suffix trimmed first, so a small
 * change to a big file stays cheap). A diff too large to compute in budget is shown whole. */
function hunks(a: string[], b: string[]): string[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const ops = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  // Full op list over the whole file: equal prefix, the diffed middle, equal suffix.
  const all: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = [];
  for (let i = 0; i < pre; i++) all.push({ t: ' ', s: a[i]!, ai: i, bi: i });
  let ai = pre,
    bi = pre;
  for (const o of ops) {
    all.push({ ...o, ai, bi });
    if (o.t !== '+') ai++;
    if (o.t !== '-') bi++;
  }
  for (let i = 0; i < suf; i++) all.push({ t: ' ', s: a[ai + i]!, ai: ai + i, bi: bi + i });
  const out: string[] = [];
  let i = 0;
  while (i < all.length) {
    if (all[i]!.t === ' ') {
      i++;
      continue;
    }
    let start = Math.max(0, i - CONTEXT),
      end = i;
    // Extend while the next change is within 2*CONTEXT equal lines.
    for (;;) {
      while (end < all.length && all[end]!.t !== ' ') end++;
      let gap = end;
      while (gap < all.length && all[gap]!.t === ' ' && gap - end < 2 * CONTEXT) gap++;
      if (gap < all.length && all[gap]!.t !== ' ' && gap - end < 2 * CONTEXT) end = gap;
      else break;
    }
    const stop = Math.min(all.length, end + CONTEXT),
      part = all.slice(start, stop),
      aStart = part.find((o) => o.t !== '+')?.ai ?? part[0]!.ai,
      bStart = part.find((o) => o.t !== '-')?.bi ?? part[0]!.bi,
      aLen = part.filter((o) => o.t !== '+').length,
      bLen = part.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`, ...part.map((o) => o.t + o.s));
    i = stop;
  }
  return out;
}
function myers(a: string[], b: string[]): { t: ' ' | '-' | '+'; s: string }[] {
  const n = a.length,
    m = b.length,
    max = n + m;
  if (max > 20000)
    return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  const v = new Map<number, number>([[1, 0]]),
    trace: Map<number, number>[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? v.get(k + 1)!
          : v.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(a, b, trace, n, m);
    }
    if (d > 2000) break;
  }
  return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
}
function backtrack(
  a: string[],
  b: string[],
  trace: Map<number, number>[],
  n: number,
  m: number,
): { t: ' ' | '-' | '+'; s: string }[] {
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let x = n,
    y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!,
      k = x - y,
      prevK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1,
      prevX = v.get(prevK) ?? 0,
      prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', s: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', s: b[y - 1]! });
      else ops.push({ t: '-', s: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
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
