import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { ServiceError } from './protocol.js';

export interface CheckpointChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Line counts; null for a binary file. */
  added: number | null;
  removed: number | null;
}
export interface CheckpointHunk {
  /** The `@@` header and its lines, as shown to a person. */
  text: string;
  /** The file header plus this one hunk: what is applied. */
  patch: string;
}

/** What a checkpoint never holds: dependencies and environment files are rebuilt or private. */
const EXCLUDE = ['node_modules/', '.env', '.env.*', '.salaam/', '*.pem', '*.key'].join('\n') + '\n';

/** Turn checkpoints for one local folder, kept in a shadow Git repository under Salaam's state
 * directory. The user's own `.git` is never read or written: the shadow has its own object store,
 * index and refs, and runs with no global or system config, hooks or attributes from the user. */
export class ShadowCheckpoints {
  readonly dir: string;
  constructor(
    readonly stateDir: string,
    readonly root: string,
  ) {
    this.dir = join(
      stateDir,
      'checkpoints',
      createHash('sha256').update(root).digest('hex').slice(0, 32) + '.git',
    );
  }
  private git(args: string[], options: { input?: string; index?: string } = {}): string {
    if (!existsSync(join(this.dir, 'HEAD'))) {
      mkdirSync(dirname(this.dir), { recursive: true, mode: 0o700 });
      const bare = { ...this.env(), GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
      execFileSync('git', ['init', '-q', '--bare', this.dir], { env: bare, stdio: 'pipe' });
      for (const [key, value] of [
        ['core.bare', 'false'],
        ['core.autocrlf', 'false'],
        ['core.fileMode', 'true'],
        ['core.symlinks', 'true'],
        ['gc.auto', '0'],
      ])
        execFileSync('git', ['config', key!, value!], { env: bare, stdio: 'pipe' });
      mkdirSync(join(this.dir, 'info'), { recursive: true });
      // Salaam's own state (the journal, and these checkpoints) is never part of a checkpoint,
      // even when the service keeps it inside the folder it is working on.
      const own = relative(this.root, this.stateDir);
      const inside = own && !own.startsWith('..') && !isAbsolute(own);
      writeFileSync(
        join(this.dir, 'info', 'exclude'),
        EXCLUDE + (inside ? '/' + own.split(sep).join('/') + '/\n' : ''),
      );
      rmSync(join(this.dir, 'hooks'), { recursive: true, force: true });
    }
    return execFileSync('git', args, {
      cwd: this.root,
      env: this.env(options.index),
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  private env(index?: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'C',
      GIT_DIR: this.dir,
      GIT_WORK_TREE: this.root,
      GIT_INDEX_FILE: index ?? join(this.dir, 'index'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      // Checkpoint commits only name a tree; they are never shared.
      GIT_AUTHOR_NAME: 'Salaam',
      GIT_AUTHOR_EMAIL: 'checkpoints@salaam.invalid',
      GIT_COMMITTER_NAME: 'Salaam',
      GIT_COMMITTER_EMAIL: 'checkpoints@salaam.invalid',
    };
  }
  /** A scratch index for building a tree without touching the capture index or the files. */
  private scratch<T>(tree: string, work: (index: string) => T): T {
    const index = join(this.dir, 'scratch-' + randomUUID());
    try {
      this.git(['read-tree', tree], { index });
      return work(index);
    } finally {
      rmSync(index, { force: true });
    }
  }
  /** The tree of the folder as it is now. Equal trees mean equal content and modes. */
  capture(): string {
    if (resolve(this.stateDir) === resolve(this.root))
      throw new ServiceError(
        'checkpoint_unavailable',
        "Salaam's state folder is this folder, so turns are not checkpointed",
      );
    this.git(['add', '-A', '--', '.']);
    return this.git(['write-tree']).trim();
  }
  /** Keeps a captured tree reachable under a name, so it survives any later cleanup. */
  keep(ref: string, tree: string): void {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes('..'))
      throw new ServiceError('invalid_field', 'Invalid checkpoint name');
    const commit = this.git(['commit-tree', tree, '-m', ref], {}).trim();
    this.git(['update-ref', 'refs/salaam/' + ref, commit]);
  }
  files(tree: string): { path: string }[] {
    return this.git(['ls-tree', '-r', '-z', '--name-only', tree])
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path }));
  }
  changes(from: string, to: string): CheckpointChange[] {
    const status = this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])
      .split('\0')
      .filter(Boolean);
    const counts = new Map<string, [number | null, number | null]>();
    for (const row of this.git(['diff-tree', '-r', '-z', '--no-renames', '--numstat', from, to])
      .split('\0')
      .filter(Boolean)) {
      const [added, removed, path] = row.split('\t');
      counts.set(path!, [
        added === '-' ? null : Number(added),
        removed === '-' ? null : Number(removed),
      ]);
    }
    const out: CheckpointChange[] = [];
    for (let i = 0; i + 1 < status.length; i += 2) {
      const path = status[i + 1]!,
        [added, removed] = counts.get(path) ?? [null, null];
      out.push({
        path,
        status: status[i] === 'A' ? 'added' : status[i] === 'D' ? 'deleted' : 'modified',
        added,
        removed,
      });
    }
    return out;
  }
  hunks(from: string, to: string, path: string): CheckpointHunk[] {
    checkedPath(path);
    const patch = this.git(['diff-tree', '-p', '--no-renames', '-U3', from, to, '--', path]);
    const at = patch.search(/^@@ /m);
    if (at < 0) return [];
    const header = patch.slice(0, at);
    return patch
      .slice(at)
      .split(/^(?=@@ )/m)
      .map((text) => ({ text, patch: header + text }));
  }
  /** Every mutation of the folder is bound to the tree the person reviewed. */
  private assertCurrent(reviewed: string): void {
    if (this.capture() !== reviewed)
      throw new ServiceError(
        'review_changed',
        'Files changed since you reviewed them; review again before restoring',
      );
  }
  private assertHunk(from: string, to: string, path: string, hunk: CheckpointHunk): void {
    if (!this.hunks(from, to, path).some((h) => h.patch === hunk.patch))
      throw new ServiceError(
        'review_changed',
        'That change changed since you reviewed it; review again',
      );
  }
  /** Puts the folder back to `target`, writing only the files that differ. */
  restore(reviewed: string, target: string): void {
    this.assertCurrent(reviewed);
    const changes = this.changes(target, reviewed);
    const write = changes.filter((c) => c.status !== 'added').map((c) => c.path);
    if (write.length)
      this.scratch(target, (index) =>
        this.git(['checkout-index', '-f', '-z', '--stdin'], { index, input: write.join('\0') }),
      );
    for (const change of changes) if (change.status === 'added') this.remove(change.path);
    if (this.capture() !== target)
      throw new ServiceError(
        'restore_incomplete',
        'Files did not match the checkpoint after restoring; inspect them before continuing',
      );
  }
  revertFile(reviewed: string, base: string, path: string): void {
    checkedPath(path);
    this.assertCurrent(reviewed);
    if (this.git(['ls-tree', base, '--', path]).trim())
      this.scratch(base, (index) => this.git(['checkout-index', '-f', '--', path], { index }));
    else this.remove(path);
  }
  revertHunk(reviewed: string, base: string, path: string, hunk: CheckpointHunk): void {
    checkedPath(path);
    this.assertCurrent(reviewed);
    this.assertHunk(base, reviewed, path, hunk);
    this.git(['apply', '-R', '--whitespace=nowarn', '-'], { input: hunk.patch });
  }
  /** A new review base with `path` as it is in `current`. The folder is not touched. */
  acceptFile(base: string, current: string, path: string): string {
    checkedPath(path);
    const entry = this.git(['ls-tree', current, '--', path]).trim();
    return this.scratch(base, (index) => {
      if (entry) {
        const [mode, , object] = entry.split(/\s+/);
        this.git(['update-index', '--add', '--cacheinfo', `${mode},${object},${path}`], { index });
      } else this.git(['update-index', '--force-remove', '--', path], { index });
      return this.git(['write-tree'], { index }).trim();
    });
  }
  acceptHunk(base: string, current: string, path: string, hunk: CheckpointHunk): string {
    checkedPath(path);
    this.assertHunk(base, current, path, hunk);
    return this.scratch(base, (index) => {
      this.git(['apply', '--cached', '--whitespace=nowarn', '-'], { index, input: hunk.patch });
      return this.git(['write-tree'], { index }).trim();
    });
  }
  private remove(path: string): void {
    const full = join(this.root, path);
    rmSync(full, { force: true });
    for (let dir = dirname(full); dir.startsWith(this.root + '/'); dir = dirname(dir))
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
  }
}

/** A path inside the folder, as Git names it. */
function checkedPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.split('/').includes('..')
  )
    throw new ServiceError('unsafe_path', 'Path is outside the workspace');
  if (path === '.git' || path.startsWith('.git/') || path.includes('/.git/'))
    throw new ServiceError('unsafe_path', 'That is not a reviewable file');
}
